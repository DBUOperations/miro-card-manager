import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {makeManager} from '../core.js';
import {AWARDS} from '../awards.js';
import {duplicateAvatar} from './mock-sdk.mjs';
import {instrumentBoard,prepared,selectImages,snapshot,CARD,CIRCLE,AWARD} from './instrumented-sdk.mjs';

const meta=(s,image)=>s.raw.items.get(image.id).meta.get(CARD);
const noScans=s=>assert.equal(s.events.filter(e=>e.method==='board.get').length,0);
const noWrites=s=>assert.equal(s.events.filter(e=>e.mutation).length,0);
const calls=(s,name)=>s.events.filter(e=>e.method===name);
function assertLevels(s,image,level) {
  const m=meta(s,image);
  assert.equal(m.level,level);
  for(let i=0;i<m.count;i++) {
    const shape=s.raw.items.get(m.badgeIds[i]);
    assert.equal(shape.style.fillColor,i<level?'#FFEC00':'#514663');
    assert.equal(shape.style.color,i<level?'#201833':'#FFFFFF');
  }
}

test('20 healthy Level 3 cards: zero writes, no full-board scan, 41 calls / 2500 credits',async()=>{
  const s=await prepared(makeManager),before=snapshot(s.raw);
  assert.deepEqual(await s.manager.setSelectedLevel(3),{updated:0,total:20});
  assert.deepEqual(snapshot(s.raw),before);
  noScans(s);noWrites(s);
  assert.equal(s.summary().credits,2500);
  assert.equal(s.summary().calls,41);
  assert.equal(calls(s,'shape.getMetadata').length,0,'current group IDs validate healthy badges without metadata calls');
  assert.equal(s.manager.getUsage().lastAction,s.summary().credits);
});

test('15 at Level 3 + 3 at Level 2 + 2 at Level 1: only seven colors and five metadata writes',async()=>{
  const s=await prepared(makeManager);
  selectImages(s.raw,s.images.slice(15,18));await s.manager.setSelectedLevel(2);
  selectImages(s.raw,s.images.slice(18));await s.manager.setSelectedLevel(1);
  selectImages(s.raw,s.images);s.clear();
  const originalGroups=s.images.map(image=>s.raw.items.get(image.id).groupId);
  assert.deepEqual(await s.manager.setSelectedLevel(3),{updated:5,total:20});
  assert.equal(calls(s,'shape.sync').length,7);
  assert.equal(calls(s,'image.setMetadata').length,5);
  assert.equal(s.summary().mutations,12);
  assert.equal(s.summary().credits,3100);
  assert.deepEqual(s.images.map(image=>s.raw.items.get(image.id).groupId),originalGroups);
  for(const image of s.images)assertLevels(s,image,3);
  noScans(s);
});

for(const [name,action] of [
  ['adding an existing award',m=>m.changeAward(AWARDS[0].id)],
  ['removing an absent award',m=>m.changeAward(AWARDS[5].id,true)],
  ['arranging already aligned awards',m=>m.rearrangeSelectedAwards()],
  ['preparing healthy cards',m=>m.initializeSelected(6)],
])test(`20 cards: ${name} makes zero mutations`,async()=>{
  const s=await prepared(makeManager,{awards:4}),before=snapshot(s.raw);
  await action(s.manager);
  assert.deepEqual(snapshot(s.raw),before);noWrites(s);noScans(s);
  assert.equal(s.summary().credits,2500);
});

test('Arrange Awards syncs only one misplaced icon and leaves an aligned Frame child untouched',async()=>{
  const s=await prepared(makeManager,{count:2,awards:4});
  const frame=s.raw.add('frame',{x:1000,y:800,width:2000,height:1600});
  const first=s.raw.items.get(meta(s,s.images[0]).awards[0].itemId);
  first.parentId=frame.id;first.relativeTo='parent_top_left';
  const moved=s.raw.items.get(meta(s,s.images[1]).awards[2].itemId);moved.x+=60;
  s.clear();
  assert.equal((await s.manager.rearrangeSelectedAwards()).updated,1);
  assert.deepEqual(calls(s,'image.sync').map(e=>e.id),[moved.id]);
  assert.equal(s.raw.items.get(first.id).parentId,frame.id);
  assert.equal(calls(s,'group.ungroup').length,1);
  noScans(s);
});

test('a moved group and edits between commands are read afresh; no persistent card cache',async()=>{
  const s=await prepared(makeManager,{count:1,awards:1});
  await s.manager.setSelectedLevel(3);
  const image=s.raw.items.get(s.images[0].id),group=s.raw.items.get(image.groupId);
  group.move(370,90);
  const badge=s.raw.items.get(meta(s,image).badgeIds[0]);badge.style.fillColor='#514663';
  s.clear();
  assert.equal((await s.manager.setSelectedLevel(3)).updated,1);
  assert.deepEqual(calls(s,'shape.sync').map(e=>e.id),[badge.id]);
  s.clear();await s.manager.rearrangeSelectedAwards();noWrites(s);
  assert.equal(s.raw.items.get(image.id).x,370);
});

test('healthy Repair scans explicitly but never rebuilds or mutates 20 cards',async()=>{
  const s=await prepared(makeManager,{awards:2}),before=snapshot(s.raw);
  assert.equal((await s.manager.checkAndRepairSelected()).healthy,20);
  noWrites(s);assert.deepEqual(snapshot(s.raw),before);
  assert.equal(calls(s,'board.get').length,2);
});

test('Repair replaces only a missing circle and award; correct badge IDs survive',async()=>{
  const s=await prepared(makeManager,{count:1,awards:2}),image=s.images[0];
  const before=structuredClone(meta(s,image));
  s.raw.items.delete(before.badgeIds[2]);s.raw.items.delete(before.awards[0].itemId);
  await s.manager.checkAndRepairSelected();
  const after=meta(s,image);
  assert.equal(calls(s,'board.createShape').length,1);
  assert.equal(calls(s,'board.createImage').length,1);
  for(let i=0;i<6;i++)if(i!==2)assert.equal(after.badgeIds[i],before.badgeIds[i]);
  assertLevels(s,image,3);
});

test('Repair repositions a badge without recreating correct numbers',async()=>{
  const s=await prepared(makeManager,{count:1}),image=s.images[0];
  const before=[...meta(s,image).badgeIds];s.raw.items.get(before[2]).y+=30;
  await s.manager.checkAndRepairSelected();
  assert.deepEqual(meta(s,image).badgeIds,before);
  assert.equal(calls(s,'board.createShape').length,0);
  assert.equal(calls(s,'shape.sync').length,1);
});

for(const cut of [false,true])test(`${cut?'Cut/Paste with deleted IDs':'Copied card with inherited IDs'} uses only local children`,async()=>{
  const s=await prepared(makeManager,{count:1,awards:2}),source=s.images[0];
  const original=structuredClone(meta(s,source));
  const copy=await duplicateAvatar(s.raw,source);
  if(cut) {
    for(const id of [source.id,...original.badgeIds,...original.awards.map(a=>a.itemId)])s.raw.items.delete(id);
    s.raw.items.delete(source.groupId);
  }
  selectImages(s.raw,[copy.image]);s.clear();
  await s.manager.setSelectedLevel(5);
  assertLevels(s,copy.image,5);
  assert.ok(meta(s,copy.image).badgeIds.every(id=>!original.badgeIds.includes(id)));
  for(const id of meta(s,copy.image).badgeIds)assert.equal(s.raw.items.get(id).meta.get(CIRCLE).cardId,copy.image.id);
  assert.equal(calls(s,'board.createShape').length,0,'copied physical numbers are reused and rebound');
  if(!cut)assertLevels(s,source,3);
  noScans(s);
});

for(const kind of ['levels','awards','full'])test(`${kind} Reset: multiple originals and copies preserve the other card data`,async()=>{
  const s=await prepared(makeManager,{count:2,awards:2});
  const source=s.images[0],copy=await duplicateAvatar(s.raw,source);
  const selected=[copy.image,s.images[1]];
  const originalBefore=snapshot(s.raw).filter(x=>[source.id,...meta(s,source).badgeIds,...meta(s,source).awards.map(a=>a.itemId)].includes(x.id));
  const before=new Map(selected.map(image=>{
    const members=image===copy.image?copy.cloned:s.raw.items.get(s.raw.items.get(image.id).groupId).ids.map(id=>s.raw.items.get(id));
    return [image.id,members.map(item=>({id:item.id,type:item.type,style:structuredClone(item.style),x:item.x,y:item.y,url:item.url}))];
  }));
  selectImages(s.raw,selected);s.clear();
  if(kind==='levels')await s.manager.resetSelectedLevels();
  if(kind==='awards')await s.manager.resetSelectedAwards();
  if(kind==='full')await s.manager.resetSelected(6);
  for(const image of selected) {
    assert.ok(s.raw.items.has(image.id));
    const items=before.get(image.id);
    if(kind==='full') {
      assert.equal(meta(s,image),null);
      for(const item of items)if(item.id!==image.id)assert.ok(!s.raw.items.has(item.id));
    }
    if(kind==='levels') {
      assertLevels(s,image,0);
      for(const item of items.filter(x=>x.type==='image'&&x.id!==image.id)) {
        const live=s.raw.items.get(item.id);assert.ok(live);assert.equal(live.x,item.x);assert.equal(live.y,item.y);
      }
      assert.equal(calls(s,'image.sync').length,0);
    }
    if(kind==='awards') {
      assert.deepEqual(meta(s,image).awards,[]);
      for(const item of items.filter(x=>x.type==='shape'))assert.deepEqual(s.raw.items.get(item.id).style,item.style);
      for(const item of items.filter(x=>x.type==='image'&&x.id!==image.id))assert.ok(!s.raw.items.has(item.id));
      assert.equal(calls(s,'shape.sync').length,0);
      assertLevels(s,image,3);
    }
    assert.equal(s.raw.items.get(image.id).url,items.find(x=>x.id===image.id).url);
  }
  const sourceAfter=snapshot(s.raw).filter(x=>originalBefore.some(b=>b.id===x.id));
  assert.deepEqual(sourceAfter,originalBefore);
});

test('usage counts successful and failed attempts, reset per action, combined UI action, no extra calls',async()=>{
  const s=await prepared(makeManager,{count:1}),manager=s.manager;
  const sessionBefore=manager.getUsage().sessionTotal;
  let notifications=0;manager.setUsageHandler(()=>notifications++);
  manager.beginAction();
  await manager.selectedCards();await manager.setSelectedLevel(4);
  manager.endAction();
  assert.equal(manager.getUsage().lastAction,s.summary().credits);
  assert.equal(manager.getUsage().sessionTotal,sessionBefore+s.summary().credits);
  assert.ok(notifications>0);
  const before=s.events.length;manager.getUsage();assert.equal(s.events.length,before);
  s.clear();s.failWith(e=>e.method==='board.getSelection'?new Error('Access denied'):null);
  await assert.rejects(()=>manager.selectedCards(),/Access denied/);
  assert.equal(manager.getUsage().lastAction,500);
  assert.equal(manager.getUsage().failedCalls,1);
  assert.equal(manager.getUsage().failedCredits,500);
  const fresh=makeManager(s.board);assert.equal(fresh.getUsage().sessionTotal,0);
});

for(const unit of ['minute','hour'])test(`real Miro ${unit} limit stops without a sleep, retry or background call`,async()=>{
  const trace=instrumentBoard();
  const manager=makeManager(trace.board,{sleep:()=>{throw Error('Waiting is forbidden');},creditMinute:1,creditHour:1});
  const image=trace.raw.add('image',{width:170,height:295,x:0,y:0});selectImages(trace.raw,[image]);
  trace.failWith(e=>e.method==='board.createShape'?new Error(`The API rate limit was exceeded. Requests can use up to 100000 credits in total per ${unit}.`):null);
  await assert.rejects(()=>manager.initializeSelected(6),/Miro API-Limit erreicht.*kein automatischer Neuversuch/);
  assert.equal(calls(trace,'board.createShape').length,1);
  assert.equal(trace.raw.items.size,1);
  assert.equal(manager.getUsage().lastAction,trace.summary().credits);
  const n=trace.events.length;await new Promise(resolve=>setTimeout(resolve,10));assert.equal(trace.events.length,n);
});

test('real limit mid-Level preserves group and manual retry fixes partial colors correctly',async()=>{
  const s=await prepared(makeManager,{count:1,level:1}),group=s.raw.items.get(s.images[0].id).groupId;
  let syncs=0;s.failWith(e=>e.method==='shape.sync'&&++syncs===2?Object.assign(new Error('Quota'),{status:429}):null);
  await assert.rejects(()=>s.manager.setSelectedLevel(5),/Miro API-Limit erreicht/);
  assert.equal(s.raw.items.get(s.images[0].id).groupId,group);
  assert.equal(meta(s,s.images[0]).level,1);
  assert.equal(calls(s,'shape.sync').length,2);
  s.failWith(null);s.clear();await s.manager.setSelectedLevel(5);
  assertLevels(s,s.images[0],5);
  assert.equal(calls(s,'shape.sync').length,3);
});

test('limit after ungroup: one immediate restoration attempt; no retry of award creation',async()=>{
  const s=await prepared(makeManager,{count:1});
  s.failWith(e=>e.method==='board.createImage'?new Error('429 rate limit exceeded'):null);
  await assert.rejects(()=>s.manager.changeAward(AWARDS[0].id),/Miro API-Limit erreicht/);
  const image=s.raw.items.get(s.images[0].id),group=s.raw.items.get(image.groupId);
  assert.equal(group.ids.length,7);assert.equal(calls(s,'board.createImage').length,1);
  assert.equal(calls(s,'board.group').length,1);
});

test('persistent Miro limit cannot freeze recovery; failed restoration is explicit and manually repairable',async t=>{
  const errors=[];t.mock.method(console,'error',(...args)=>errors.push(args));
  const s=await prepared(makeManager,{count:1});let blocked=false;
  s.failWith(e=>{
    if(e.method==='board.createImage')blocked=true;
    return blocked?new Error('429 rate limit exceeded'):null;
  });
  await assert.rejects(()=>s.manager.changeAward(AWARDS[0].id),/Gruppe konnte nicht vollständig wiederhergestellt/);
  assert.equal(calls(s,'board.createImage').length,1);
  assert.ok(s.events.length<30);
  assert.equal(errors.length,1);
  s.failWith(null);selectImages(s.raw,s.images);await s.manager.checkAndRepairSelected();
  assert.equal(s.raw.items.get(s.raw.items.get(s.images[0].id).groupId).ids.length,7);
});

test('Full Reset failure regroups survivors; a later manual Reset completes',async()=>{
  const s=await prepared(makeManager,{count:1,awards:1});let n=0;
  s.failWith(e=>e.method==='board.remove'&&++n===2?new Error('429 rate limit exceeded'):null);
  await assert.rejects(()=>s.manager.resetSelected(6),/Miro API-Limit erreicht/);
  assert.ok(s.raw.items.get(s.images[0].id).groupId);
  s.failWith(null);selectImages(s.raw,s.images);await s.manager.resetSelected(6);
  assert.equal(s.raw.items.size,1);assert.equal(meta(s,s.images[0]),null);
});

test('no artificial quota: a manual batch can exceed old budgets without waiting',async()=>{
  const s=instrumentBoard();
  const manager=makeManager(s.board,{creditMinute:1,creditHour:1,sleep:()=>{throw Error('No waits');}});
  s.raw.selected=[];
  for(let i=0;i<1801;i++)await manager.selectedCards();
  assert.equal(manager.getUsage().sessionTotal,900500);
});

test('idle manager has no calls; selection/moves/guests do not invoke any manager operation',async()=>{
  const trace=instrumentBoard(),manager=makeManager(trace.board);
  manager.setStatusHandler(()=>{});manager.setUsageHandler(()=>{});
  const image=trace.raw.add('image',{width:170,height:295,x:0,y:0});
  trace.raw.selected=[image.id];image.x=50;
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(trace.events.length,0);assert.equal(manager.getUsage().sessionTotal,0);
});

test('Grid API, UI handler and button removed; all thirteen award assets remain',()=>{
  const manager=makeManager(instrumentBoard().board);
  assert.equal(manager.arrangeSelectedGrid,undefined);
  for(const file of ['core.js','panel.js','panel.html'])assert.doesNotMatch(readFileSync(new URL(`../${file}`,import.meta.url),'utf8'),/arrangeSelectedGrid|grid-cards|Grid anordnen/);
  assert.equal(AWARDS.length,13);
  for(const award of AWARDS)assert.ok(readFileSync(new URL(`../assets/awards/${award.file}`,import.meta.url)).length>0);
});

test('incorrect number content is repaired locally without changing the other five badges',async()=>{
  const s=await prepared(makeManager,{count:1}),image=s.images[0];
  const before=[...meta(s,image).badgeIds];s.raw.items.get(before[1]).content='<p>7</p>';
  await s.manager.initializeSelected(6);
  const after=meta(s,image).badgeIds;
  assert.notEqual(after[1],before[1]);
  for(const i of [0,2,3,4,5])assert.equal(after[i],before[i]);
  assert.equal(s.raw.items.get(after[1]).content,'<p>2</p>');
  assert.equal(calls(s,'board.createShape').length,1);
  assert.equal([...s.raw.items.values()].filter(item=>item.type==='shape').length,6);
});

test('Prepare detects a broken size beyond the first badge and replaces only that badge',async()=>{
  const s=await prepared(makeManager,{count:1}),image=s.images[0];
  const before=[...meta(s,image).badgeIds];s.raw.items.get(before[4]).width=9;
  await s.manager.initializeSelected(6);
  const after=meta(s,image).badgeIds;
  assert.notEqual(after[4],before[4]);
  for(const i of [0,1,2,3,5])assert.equal(after[i],before[i]);
  assert.equal(calls(s,'board.createShape').length,1);
});

test('metadata failure after a color update recovers on manual retry without resyncing correct shapes',async()=>{
  const s=await prepared(makeManager,{count:1,level:1});
  s.failWith(e=>e.method==='image.setMetadata'?new Error('429 rate limit exceeded'):null);
  await assert.rejects(()=>s.manager.setSelectedLevel(3),/Miro API-Limit erreicht/);
  s.failWith(null);s.clear();await s.manager.setSelectedLevel(3);
  assert.equal(calls(s,'shape.sync').length,0);
  assert.equal(calls(s,'image.setMetadata').length,1);
  assertLevels(s,s.images[0],3);
});

test('a foreign group aborts the complete batch before mutating the healthy card',async()=>{
  const s=await prepared(makeManager,{count:2});
  const group=s.raw.items.get(s.raw.items.get(s.images[1].id).groupId);
  const unrelated=s.raw.add('shape',{content:'Workshop notes',shape:'rectangle',width:50,height:50,x:0,y:0,style:{}});
  unrelated.groupId=group.id;group.ids.push(unrelated.id);
  const before=snapshot(s.raw);s.clear();
  await assert.rejects(()=>s.manager.setSelectedLevel(4),/fremde Elemente/);
  noWrites(s);assert.deepEqual(snapshot(s.raw),before);
});

test('concurrent commands are rejected before any second-command SDK call',async()=>{
  const s=await prepared(makeManager,{count:1});
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const original=s.raw.getSelection.bind(s.raw);
  s.raw.getSelection=async()=>{await pending;return original();};
  const first=s.manager.setSelectedLevel(4);
  await assert.rejects(()=>s.manager.setSelectedLevel(5),/Eine Karten-Aktion läuft bereits/);
  assert.equal(calls(s,'board.getSelection').length,1);
  release();await first;assertLevels(s,s.images[0],4);
});
