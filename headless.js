import {makeManager} from './core.js';

const board=window.miro?.board;
if(board?.ui) {
  const manager=makeManager(board);
  board.ui.on('icon:click',async()=>board.ui.openPanel({url:'panel.html'}));

  // Miro update events do not cost SDK credits. Inspect only moved cards;
  // keep a rare full scan in case the experimental event was missed.
  const pending=new Map();
  let timer=null,busy=false,fullPending=false;
  function schedule(items=[],full=false) {
    if(full)fullPending=true;
    for(const item of items)if(item?.id)pending.set(item.id,item);
    clearTimeout(timer);
    timer=setTimeout(flush,1500);
  }
  async function flush() {
    if(busy) {timer=setTimeout(flush,2500);return;}
    if(!fullPending && !pending.size)return;
    busy=true;
    const full=fullPending,items=[...pending.values()];
    fullPending=false;pending.clear();
    try {
      if(full)await manager.syncLevels(()=>{},true);
      else await manager.syncChanged(items,()=>{},true);
    } catch(err) {
      console.warn('DBU Card Manager Auto Level',err);
      // The next fallback scan catches interrupted or missed operations.
    } finally {
      busy=false;
      if(fullPending||pending.size)schedule();
    }
  }
  board.ui.on('experimental:items:update',event=>schedule(event?.items||[]));
  // Do not scan the whole board after selections or every 15 seconds.
  setInterval(()=>schedule([],true),120000);
  setTimeout(()=>schedule([],true),3000);
}
