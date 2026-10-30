import {makeManager} from './core.js';

const board=window.miro?.board;
if(board?.ui) {
  const manager=makeManager(board);
  board.ui.on('icon:click', async () => {
    await board.ui.openPanel({url:'panel.html'});
  });

  let debounce=null, busy=false;
  function schedule() {
    clearTimeout(debounce);
    debounce=setTimeout(async()=>{
      if(busy) {schedule();return;}
      busy=true;
      try {
        await manager.syncLevels(()=>{},true);
      } catch(err) {
        // The experimental event can be missed/rejected; Sync Levels in the panel is the fallback.
        console.warn('DBU Auto Level: manual Sync Levels may be needed',err);
      } finally {busy=false;}
    },1500);
  }
  board.ui.on('experimental:items:update',schedule);
  // Miro's experimental item-update event isn't guaranteed on every drag.
  // Selection changes offer another chance to detect a completed move.
  board.ui.on('selection:update',schedule);
  // Event-independent safety net; syncLevels itself skips work if Auto Level
  // is disabled or the panel is currently editing board items.
  setInterval(schedule,15000);
  // Also synchronize on board load to catch movements missed between sessions.
  setTimeout(schedule,3000);
}
