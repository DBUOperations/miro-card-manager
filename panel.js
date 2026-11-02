import {makeManager} from './core.js?v=1.9.0';
import {AWARDS,awardAssetUrl} from './awards.js';

const $=id=>document.getElementById(id);
const board=window.miro?.board;
if(!board) {
  document.body.textContent='Diese App muss in Miro geöffnet werden.';
  throw new Error('Miro Web SDK unavailable');
}
const manager=makeManager(board);
let levelCount=6;
let busy=false;
let toastTimer;
// The panel must still render if a browser temporarily has an older core.js
// in its cache. Warn instead of stopping execution before the award gallery.
const coreCompatible=manager.version==='1.9.0';
manager.setStatusHandler?.(message=>{
  if(busy)$('busy-text').textContent=message;
});

function toast(text,error=false) {
  const el=$('message');
  el.textContent=text;
  el.className='message visible'+(error?' error':'');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.className='message',error?15000:6000);
}

function preview() {
  $('level-count-value').textContent=String(levelCount);
  const parent=$('level-preview');
  parent.replaceChildren();
  const compact=levelCount>6;
  const gap=compact?3:5;
  const height=28;
  const width=compact?Math.min(height,(255-(levelCount-1)*gap)/levelCount):Math.min(31,Math.floor(255/levelCount)-4);
  for(let i=1;i<=levelCount;i++) {
    const el=document.createElement('span');
    el.className='circle'+(compact&&levelCount>7?' compact':'')+(i<=Math.min(3,levelCount)?' active':'');
    el.textContent=String(i);
    el.style.width=width+'px';el.style.height=(compact?height:width)+'px';
    parent.append(el);
  }
  parent.style.gap=gap+'px';
  const buttons=$('level-buttons');
  buttons.replaceChildren();
  buttons.className='level-buttons'+(levelCount>6?' many':'');
  for(let i=1;i<=levelCount;i++) {
    const button=document.createElement('button');
    button.className='level-button';
    button.textContent=String(i);
    button.title=`Level ${i} auf ausgewählte Karten anwenden`;
    button.setAttribute('aria-label',`Level ${i} zuweisen`);
    button.addEventListener('click',()=>run(`Level ${i} setzen`,async(progress)=>{
      const res=await manager.setSelectedLevel(i,progress);
      toast(`Level ${i}: ${res.updated} von ${res.total} Karten aktualisiert.`);
    }));
    buttons.append(button);
  }
}

async function run(label,fn) {
  if(busy)return;
  busy=true;
  $('level-count').disabled=true;
  $('busy').hidden=false;
  $('busy-text').textContent=label;
  for(const button of document.querySelectorAll('button')) button.disabled=true;
  try {
    const result=await fn((done,total)=>{
      $('busy-text').textContent=`${label} ${done}/${total}`;
      if(Number.isFinite(total))$('selected-count').textContent=String(total);
    });
    return result;
  } catch(e) {
    console.error('DBU Card Manager',e);
    toast(e?.message||'Ein Fehler ist aufgetreten. Bitte erneut versuchen.',true);
  } finally {
    busy=false;
    $('level-count').disabled=false;
    $('busy').hidden=true;
    for(const button of document.querySelectorAll('button')) button.disabled=false;
  }
}

function awardGallery() {
  const list=$('award-list');
  for(const award of AWARDS) {
    const tile=document.createElement('article');
    tile.className='award';
    const icon=document.createElement('img');
    icon.src=awardAssetUrl(award);
    icon.alt=award.name;
    const title=document.createElement('strong');
    title.textContent=award.name;
    const actions=document.createElement('div');
    actions.className='actions';
    const add=document.createElement('button');
    add.textContent='+ Award';
    add.title='Zu ausgewählten Karten hinzufügen';
    add.addEventListener('click',()=>run(`${award.name} hinzufügen`,async(progress)=>{
      const res=await manager.changeAward(award.id,false,progress);
      const skipped=res.skippedLimit?` · ${res.skippedLimit} Karten bereits bei 4 Awards.`:'';
      toast(`${res.changed} von ${res.total} Karten aktualisiert.${skipped}`);
    }));
    const remove=document.createElement('button');
    remove.className='remove';
    remove.textContent='−';
    remove.title='Award von ausgewählten Karten entfernen';
    remove.addEventListener('click',()=>run(`${award.name} entfernen`,async(progress)=>{
      const res=await manager.changeAward(award.id,true,progress);
      toast(`${res.changed} von ${res.total} Karten aktualisiert.`);
    }));
    actions.append(add,remove);
    tile.append(icon,title,actions);
    list.append(tile);
  }
}

$('level-count').addEventListener('input',e=>{
  levelCount=Number(e.target.value);
  preview();
});

$('check-selection').addEventListener('click',()=>run('Auswahl prüfen',async()=>{
  const cards=await manager.selectedCards();
  $('selected-count').textContent=String(cards.length);
  toast(`${cards.length} Avatar-Karte(n) ausgewählt.`);
}));

$('initialize').addEventListener('click',()=>run('Karten vorbereiten',async(progress)=>{
  const selected=await manager.selectedCards();
  if(!selected.length) throw new Error('Bitte Avatar-Karten auswählen.');
  const changing=selected.some(x=>x.meta && x.meta.count!==levelCount);
  if(changing && !window.confirm(`Du änderst die Anzahl der Level auf ${levelCount}. Die bisherigen Level-Kreise der ausgewählten Karten werden ersetzt. Fortfahren?`))return;
  const res=await manager.initializeSelected(levelCount,progress,false,selected);
  toast(`${res.updated} Karten vorbereitet · ${res.unchanged} bereits fertig.`);
}));

$('reset-cards').addEventListener('click',()=>run('Full Reset',async(progress)=>{
  const cards=await manager.selectedCards({allowNew:true});
  if(!cards.length)throw new Error('Bitte Avatar-Karten auswählen.');
  if(!window.confirm(`${cards.length} Karte(n) vollständig zurücksetzen? Alle Manager-Level, Awards und Manager-Daten werden entfernt. Nur die originalen SVG-Avatare bleiben erhalten.`))return;
  const res=await manager.resetSelected(levelCount,progress,cards);
  toast(`${res.reset} Karten vollständig zurückgesetzt · nur SVG-Avatare bleiben.`);
}));

$('grid-cards').addEventListener('click',()=>run('Grid anordnen',async(progress)=>{
  const res=await manager.arrangeSelectedGrid(4,progress);
  toast(`${res.total} Karten in einem Raster mit ${res.columns} Spalten angeordnet.`);
}));

$('check-repair').addEventListener('click',()=>run('Karten prüfen & reparieren',async(progress)=>{
  const res=await manager.checkAndRepairSelected(progress);
  toast(`${res.total} geprüft · ${res.updated} repariert · ${res.healthy} bereits in Ordnung · ${res.awardsRepaired} Awards korrigiert.`);
}));

$('fix-layers').addEventListener('click',()=>run('Karten-Ebenen korrigieren',async(progress)=>{
  const res=await manager.layersSelected(progress);
  toast(`${res.updated} Karte(n) inklusive Kreise und Awards nach vorne geholt.`);
}));

$('rearrange-awards').addEventListener('click',()=>run('Awards anordnen',async(progress)=>{
  const res=await manager.rearrangeSelectedAwards(progress);
  toast(`${res.updated} von ${res.total} Karten vertikal angeordnet.`);
}));

preview();
awardGallery();
window.__dbuPanelReady=true;
if(!coreCompatible)toast('Miro hat alte App-Dateien geladen. Bitte Board mit Strg+Shift+R neu laden.',true);
