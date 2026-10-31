import {makeManager} from './core.js?v=1.7.0';
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
const coreCompatible=typeof manager.syncSelectedLevels==='function';
manager.setStatusHandler?.(message=>{
  if(busy)$('busy-text').textContent=message;
});

function toast(text,error=false) {
  const el=$('message');
  el.textContent=text;
  el.className='message visible'+(error?' error':'');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.className='message',6000);
}

function options(current,includeZero=false) {
  const levels=Array.from({length:levelCount},(_,i)=>i+1);
  if(includeZero) levels.unshift(0);
  return levels.map(n=>`<option value="${n}" ${Number(current)===n?'selected':''}>${n===0?'Level 0':'Level '+n}</option>`).join('');
}

function preview() {
  $('level-count-value').textContent=String(levelCount);
  const parent=$('level-preview');
  parent.replaceChildren();
  const size=Math.min(31,Math.floor(255/levelCount)-4);
  for(let i=1;i<=levelCount;i++) {
    const el=document.createElement('span');
    el.className='circle'+(i<=Math.min(3,levelCount)?' active':'');
    el.textContent=String(i);
    el.style.width=size+'px';el.style.height=size+'px';
    parent.append(el);
  }
  const previousZone=$('zone-level').value;
  const previousManual=$('manual-level').value;
  $('zone-level').innerHTML=options(previousZone||1);
  $('manual-level').innerHTML=options(previousManual||1,true);
}

async function run(label,fn) {
  if(busy)return;
  busy=true;
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
      toast(`${res.changed} von ${res.total} Karten aktualisiert.`);
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
  const cards=await manager.selectedCards({allowNew:false});
  if(!cards.length)throw new Error('Bitte vorbereitete Karten auswählen.');
  if(!window.confirm(`${cards.length} Karte(n) zurücksetzen? Alle Awards werden gelöscht, Level wird 0 und die Karte erhält ${levelCount} graue Kreise. Die Avatarbilder bleiben erhalten.`))return;
  const res=await manager.resetSelected(levelCount,progress,cards);
  toast(`${res.reset} Karten zurückgesetzt · Level 0 · ${res.count} graue Kreise.`);
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

$('assign-zone').addEventListener('click',()=>run('Feld verbinden',async()=>{
  const zone=await manager.assignSelectedZone($('zone-level').value);
  $('zone-summary').textContent=`Level ${zone.level} zugewiesen`;
  toast(`Feld mit Level ${zone.level} verbunden.`);
}));

$('remove-zone').addEventListener('click',()=>run('Feld lösen',async()=>{
  const changed=await manager.unassignSelectedZone();
  if(changed)$('zone-summary').textContent='Zuweisung entfernt';
  toast(changed?'Level-Zuweisung entfernt.':'Dieses Feld war nicht zugewiesen.');
}));

$('set-level').addEventListener('click',()=>run('Level setzen',async(progress)=>{
  const res=await manager.setSelectedLevel($('manual-level').value,progress);
  toast(`${res.updated} von ${res.total} Karten aktualisiert.`);
}));

$('sync-levels').addEventListener('click',()=>run('Auswahl-Level abgleichen',async(progress)=>{
  const res=await manager.syncSelectedLevels(progress);
  toast(`${res.updated} von ${res.total} Karten aktualisiert · ${res.zones} Level-Felder erkannt.`);
}));

$('rearrange-awards').addEventListener('click',()=>run('Awards anordnen',async(progress)=>{
  const res=await manager.rearrangeSelectedAwards(progress);
  toast(`${res.updated} von ${res.total} Karten vertikal angeordnet.`);
}));

preview();
awardGallery();
window.__dbuPanelReady=true;
if(!coreCompatible)toast('Miro hat alte App-Dateien geladen. Bitte Board mit Strg+Shift+R neu laden.',true);
