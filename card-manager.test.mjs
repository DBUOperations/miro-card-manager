import test from 'node:test';
import assert from 'node:assert/strict';
import {makeManager as createManager} from '../core.js';
import {AWARDS} from '../awards.js';

// Regular integration tests exercise card behavior, not real-time quotas.
const makeManager=board=>createManager(board,{creditMinute:1e9,creditHour:1e9});

class Item {
  constructor(board,type,props={}){Object.assign(this,props);this.board=board;this.type=type;this.id=String(++board.sequence);this.meta=new Map();}
  async getMetadata(key){return this.meta.get(key);}
  async setMetadata(key,value){this.meta.set(key,value);}
  async sync(){
    if(this.failNextSync){this.failNextSync=false;throw new Error('Simulated SDK sync failure');}
    if(this.type==='image' && this.parentId && this.parentId!=='null'){
      if(this.board.rejectFrameImageMovement) {
        throw new Error('Cannot move the image item: child of another board item');
      }
      const parent=await this.board.getById(this.parentId);
      if(this.relativeTo!=='parent_top_left' ||
        this.x-this.width/2<0 || this.x+this.width/2>parent.width ||
        this.y-this.height/2<0 || this.y+this.height/2>parent.height) {
        throw new Error('Cannot move the image item: child of another board item');
      }
    }
    this.board.synced++;
  }
}
class FrameItem extends Item {
  async remove(child){
    assert.equal(child.parentId,this.id,'frame.remove called for a different parent');
    child.x+=this.x-this.width/2;
    child.y+=this.y-this.height/2;
    child.parentId=null;
    child.relativeTo='canvas_center';
    this.board.frameDetachCount++;
  }
}
class Group {
  constructor(board,items){this.board=board;this.type='group';this.id=String(++board.sequence);this.ids=items.map(x=>x.id);this.releaseShiftX=0;this.releaseShiftY=0;for(const x of items)x.groupId=this.id;}
  async getItems(){return this.ids.map(id=>this.board.items.get(id)).filter(Boolean);}
  move(dx,dy){for(const id of this.ids){const item=this.board.items.get(id);item.x+=dx;item.y+=dy;}}
  async ungroup(){
    // Mimic Miro's changing coordinate reference on ungroup. In this mock,
    // releaseShift can make post-ungroup SDK coordinates differ from the
    // reliable pre-ungroup coordinates used by Auto Level.
    const xs=[];
    for(const old of await this.getItems()) {
      const item=Object.assign(Object.create(Object.getPrototypeOf(old)),old,{
        x:old.x+this.releaseShiftX,y:old.y+this.releaseShiftY,groupId:undefined,
      });
      this.board.items.set(item.id,item);
      xs.push(item);
    }
    this.board.items.delete(this.id);
    return xs;
  }
}
class MockBoard {
  constructor(){this.sequence=100;this.items=new Map();this.selected=[];this.synced=0;this.frameDetachCount=0;this.rejectFrameImageMovement=true;this.layers=[];this.data=new Map();this.storage={collection:()=>({get:async k=>this.data.get(k),set:async(k,v)=>this.data.set(k,v)})};}
  add(type,props){const x=type==='frame'?new FrameItem(this,type,props):new Item(this,type,props);this.items.set(x.id,x);this.layers.push(x.id);return x;}
  async createShape(props){return this.add('shape',props);}
  async createImage(props){return this.add('image',{...props,height:props.width});}
  async getSelection(){return this.selected.map(id=>this.items.get(id)).filter(Boolean);}
  async get({type}){return [...this.items.values()].filter(x=>x.type===type);}
  async getById(id){const x=this.items.get(id);if(!x)throw Error('not found '+id);return x;}
  async group({items}){const g=new Group(this,items);this.items.set(g.id,g);return g;}
  async remove(item){this.items.delete(item.id);this.layers=this.layers.filter(id=>id!==item.id);}
  async bringToFront(items){
    for(const item of Array.isArray(items)?items:[items]){
      this.layers=this.layers.filter(id=>id!==item.id);
      this.layers.push(item.id);
    }
  }
  async bringInFrontOf(items,target){
    const ids=(Array.isArray(items)?items:[items]).map(x=>x.id);
    this.layers=this.layers.filter(id=>!ids.includes(id));
    const at=this.layers.indexOf(target.id);
    this.layers.splice(at+1,0,...ids);
  }
  async getLayerIndex(item){return this.layers.indexOf(item.id);}
  select(items){this.selected=Array.isArray(items)?items.map(x=>x.id):[items.id].flat();}
  async deselect(){this.selected=[];}
}

test('20 selected avatars: level badges, grouping, zone moves, awards, and reconfiguration',async()=>{
  const board=new MockBoard();const manager=makeManager(board);
  const images=Array.from({length:20},(_,i)=>board.add('image',{width:170,height:295,x:i*230,y:0,title:`Avatar ${i}`}));
  board.select(images);
  const result=await manager.initializeSelected(6);
  assert.deepEqual(result,{updated:20,unchanged:0,total:20});
  assert.equal((await board.get({type:'shape'})).length,120);
  assert.equal((await board.get({type:'group'})).length,20);
  assert.equal((await manager.initializeSelected(6)).updated,0);

  board.select(images.slice(0,2).map(x=>board.items.get(x.groupId)));
  assert.equal((await manager.setSelectedLevel(3)).updated,2);
  const info=await images[0].getMetadata('dbu_cm_card_v1');
  assert.equal(info.level,3);
  for(let i=0;i<6;i++)assert.equal((await board.getById(info.badgeIds[i])).style.fillColor,i<3?'#FFEC00':'#514663');

  const zone=board.add('shape',{x:500,y:0,width:450,height:450});
  board.select([zone]);
  await manager.assignSelectedZone(5);
  images[0].x=500;
  board.select(images.slice(0,2).map(x=>board.items.get(x.groupId)));
  await manager.syncSelectedLevels();
  assert.equal((await images[0].getMetadata('dbu_cm_card_v1')).level,5);
  zone.x=1500;images[0].x=1500;
  await manager.syncSelectedLevels();
  assert.equal((await images[0].getMetadata('dbu_cm_card_v1')).level,5);

  board.select(images.slice(0,2).map(x=>board.items.get(x.groupId)));
  assert.equal(AWARDS.length,13);
  assert.equal((await manager.changeAward('professorin')).changed,2);
  assert.equal((await manager.changeAward('professorin')).changed,0);
  for(const image of images.slice(0,2)){
    const m=await image.getMetadata('dbu_cm_card_v1');
    assert.equal(m.awards.length,1);
    const currentImage=await board.getById(image.id);
    assert.equal((await board.getById(m.awards[0].itemId)).groupId,currentImage.groupId);
  }
  assert.equal((await manager.changeAward('professorin',true)).changed,2);
  assert.equal((await manager.initializeSelected(8)).updated,2);
  assert.equal((await images[0].getMetadata('dbu_cm_card_v1')).badgeIds.length,8);
  assert.equal((await board.get({type:'group'})).length,20);
});

test('protect unrelated manual groups',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const a=board.add('image',{width:170,height:295,x:0,y:0});
  const b=board.add('image',{width:170,height:295,x:300,y:0});
  const group=await board.group({items:[a,b]});board.select([group]);
  await assert.rejects(()=>manager.initializeSelected(6),/bereits gruppiert/);
  assert.equal((await board.get({type:'group'})).length,1);
});

test('changing level count after moving a group uses its NEW position',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const image=board.add('image',{width:170,height:295,x:100,y:200});
  board.select([image]);
  await manager.initializeSelected(6);
  const initialGroup=await board.getById(image.groupId);
  initialGroup.move(700,450);
  initialGroup.releaseShiftX=-700;
  initialGroup.releaseShiftY=-450;
  board.select([initialGroup]);
  const res=await manager.initializeSelected(10);
  assert.equal(res.updated,1);
  const liveImage=await board.getById(image.id);
  // The returned post-ungroup item is intentionally stale in this test.
  assert.equal(liveImage.x,100);
  assert.equal(liveImage.y,200);
  const meta=await liveImage.getMetadata('dbu_cm_card_v1');
  assert.equal(meta.badgeIds.length,10);
  const badges=await Promise.all(meta.badgeIds.map(id=>board.getById(id)));
  assert.ok(badges.every(b=>Math.abs(b.x-800)<85));
  assert.ok(badges.every(b=>Math.abs(b.y-(650+295*(277/295-.5)))<.001));
});

test('awards stack vertically, and existing awards can be realigned after moving',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const image=board.add('image',{width:170,height:295,x:100,y:200});
  board.select([image]);
  await manager.initializeSelected(6);
  const awardIds=AWARDS.slice(0,3).map(a=>a.id);
  for(const id of awardIds)await manager.changeAward(id);
  let liveImage=await board.getById(image.id);
  let meta=await liveImage.getMetadata('dbu_cm_card_v1');
  let icons=await Promise.all(meta.awards.map(a=>board.getById(a.itemId)));
  assert.ok(icons.every(icon=>icon.x===icons[0].x));
  assert.ok(icons[0].y<icons[1].y && icons[1].y<icons[2].y);

  const group=await board.getById(liveImage.groupId);
  group.move(750,220);
  group.releaseShiftX=-750;
  group.releaseShiftY=-220;
  board.select([group]);
  assert.deepEqual(await manager.rearrangeSelectedAwards(),{updated:1,total:1});
  liveImage=await board.getById(image.id);
  meta=await liveImage.getMetadata('dbu_cm_card_v1');
  icons=await Promise.all(meta.awards.map(a=>board.getById(a.itemId)));
  assert.equal(liveImage.x,100);
  assert.ok(icons.every(icon=>icon.x>850 && icon.x<935));
  assert.ok(icons.every(icon=>icon.x===icons[0].x));
  assert.ok(icons[0].y<icons[1].y && icons[1].y<icons[2].y);
});

test('repair restores misplaced existing circles without changing count or level',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const image=board.add('image',{width:170,height:295,x:100,y:100});
  board.select([image]);
  await manager.initializeSelected(10);
  const group=await board.getById(image.groupId);
  board.select([group]);
  await manager.setSelectedLevel(4);

  // Reproduce a broken earlier version: image moved, circles stayed behind.
  image.x=800;
  image.y=500;
  assert.equal((await board.getById((await image.getMetadata('dbu_cm_card_v1')).badgeIds[0])).x<200,true);
  const result=await manager.repairSelected();
  assert.equal(result.updated,1);
  const liveImage=await board.getById(image.id);
  const meta=await liveImage.getMetadata('dbu_cm_card_v1');
  assert.equal(meta.count,10);
  assert.equal(meta.level,4);
  assert.equal((await board.get({type:'shape'})).length,10);
  const badges=await Promise.all(meta.badgeIds.map(id=>board.getById(id)));
  assert.ok(badges.every(b=>Math.abs(b.x-800)<85));
  assert.ok(badges.every((b,i)=>b.style.fillColor===(i<4?'#FFEC00':'#514663')));
  assert.equal((await board.get({type:'group'})).length,1);
});

test('award added after a move is placed at the pre-ungroup visual anchor',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const image=board.add('image',{width:170,height:295,x:50,y:60});
  board.select([image]);
  await manager.initializeSelected(6);
  const group=await board.getById(image.groupId);
  group.move(550,250);
  group.releaseShiftX=-550;
  group.releaseShiftY=-250;
  board.select([group]);
  await manager.changeAward(AWARDS[0].id);
  const current=await board.getById(image.id);
  const meta=await current.getMetadata('dbu_cm_card_v1');
  const icon=await board.getById(meta.awards[0].itemId);
  assert.ok(Math.abs(icon.x-(600+170*.37))<.001);
  assert.ok(Math.abs(icon.y-(310-295*.40))<.001);
});

test('frame-relative card coordinates are converted to absolute board coordinates',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const frame=board.add('frame',{x:1000,y:500,width:800,height:600});
  const image=board.add('image',{
    width:170,height:295,x:150,y:200,parentId:frame.id,relativeTo:'parent_top_left',
  });
  board.select([image]);
  await manager.initializeSelected(6);
  let meta=await image.getMetadata('dbu_cm_card_v1');
  const firstCircle=await board.getById(meta.badgeIds[0]);
  assert.ok(Math.abs(firstCircle.x-750)<85);
  assert.ok(Math.abs(firstCircle.y-(400+295*(277/295-.5)))<.001);
  const group=await board.getById(image.groupId);
  board.select([group]);
  await manager.changeAward(AWARDS[0].id);
  meta=await image.getMetadata('dbu_cm_card_v1');
  const icon=await board.getById(meta.awards[0].itemId);
  assert.ok(Math.abs(icon.x-(750+170*.37))<.001);
  assert.ok(Math.abs(icon.y-(400-295*.40))<.001);
});

test('unknown geometry stops safely before ungrouping',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const image=board.add('image',{width:170,height:295,x:100,y:100});
  board.select([image]);
  await manager.initializeSelected(6);
  const group=await board.getById(image.groupId);
  image.x=Infinity;
  board.select([group]);
  await assert.rejects(()=>manager.changeAward(AWARDS[0].id),/pouzdane koordinate/);
  assert.ok(board.items.has(group.id));
});

test('explicit award realign first detaches a frame child before any sync',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const frame=board.add('frame',{x:500,y:400,width:1000,height:800});
  const image=board.add('image',{width:170,height:295,x:500,y:400});
  board.select([image]);
  await manager.initializeSelected(6);
  await manager.changeAward(AWARDS[0].id);
  const meta=await image.getMetadata('dbu_cm_card_v1');
  const icon=await board.getById(meta.awards[0].itemId);
  icon.x-=frame.x-frame.width/2;
  icon.y-=frame.y-frame.height/2;
  icon.parentId=frame.id;
  icon.relativeTo='parent_top_left';
  board.select([await board.getById((await board.getById(image.id)).groupId)]);
  await manager.rearrangeSelectedAwards();
  assert.equal(board.frameDetachCount,1);
  const moved=await board.getById(icon.id);
  assert.equal(moved.parentId,null);
  assert.ok(Math.abs(moved.x-(500+170*.37))<.001);
  assert.ok(Math.abs(moved.y-(400-295*.40))<.001);
  assert.ok((await board.getById(image.id)).groupId);
});

test('adding an award after moving between frames does not sync or move earlier awards',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const oldFrame=board.add('frame',{x:500,y:500,width:800,height:800});
  const image=board.add('image',{width:170,height:295,x:500,y:500});
  board.select([image]);
  await manager.initializeSelected(6);
  await manager.changeAward(AWARDS[0].id);
  const meta=await image.getMetadata('dbu_cm_card_v1');
  const icon=await board.getById(meta.awards[0].itemId);
  icon.x-=oldFrame.x-oldFrame.width/2;
  icon.y-=oldFrame.y-oldFrame.height/2;
  icon.parentId=oldFrame.id;
  icon.relativeTo='parent_top_left';
  // The avatar group is dragged into another zone, while the award's old
  // parent association persists (the error seen on the real Miro board).
  const movedImage=await board.getById(image.id);
  movedImage.x=2100;movedImage.y=500;
  const selectedGroup=await board.getById((await board.getById(image.id)).groupId);
  board.select([selectedGroup]);
  await manager.changeAward(AWARDS[1].id);
  const currentMeta=await image.getMetadata('dbu_cm_card_v1');
  const items=await Promise.all(currentMeta.awards.map(a=>board.getById(a.itemId)));
  assert.equal(board.frameDetachCount,0);
  assert.equal((await board.getById(icon.id)).parentId,oldFrame.id);
  assert.ok(items[1].x>2100);
  assert.ok(items.every(a=>a.groupId===(board.items.get(image.id)).groupId));
  assert.equal((await board.get({type:'group'})).length,1);
});

test('changing level count does not move existing frame-owned awards',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const frame=board.add('frame',{x:500,y:500,width:800,height:800});
  const image=board.add('image',{width:170,height:295,x:500,y:500});
  board.select([image]);
  await manager.initializeSelected(6);
  await manager.changeAward(AWARDS[0].id);
  const meta=await image.getMetadata('dbu_cm_card_v1');
  const icon=await board.getById(meta.awards[0].itemId);
  icon.parentId=frame.id;icon.relativeTo='parent_top_left';
  icon.x-=frame.x-frame.width/2;icon.y-=frame.y-frame.height/2;
  board.select([await board.getById((await board.getById(image.id)).groupId)]);
  await manager.initializeSelected(10);
  assert.equal(board.frameDetachCount,0);
  assert.equal((await board.getById(icon.id)).parentId,frame.id);
  assert.equal((await board.get({type:'group'})).length,1);
  assert.equal((await image.getMetadata('dbu_cm_card_v1')).badgeIds.length,10);
});

test('an unexpected SDK award movement error restores the original card group',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const image=board.add('image',{width:170,height:295,x:100,y:150});
  board.select([image]);
  await manager.initializeSelected(6);
  await manager.changeAward(AWARDS[0].id);
  const meta=await image.getMetadata('dbu_cm_card_v1');
  const icon=await board.getById(meta.awards[0].itemId);
  icon.failNextSync=true;
  board.select([await board.getById((await board.getById(image.id)).groupId)]);
  await assert.rejects(()=>manager.rearrangeSelectedAwards(),/Simulated SDK sync failure/);
  assert.equal((await board.get({type:'group'})).length,1);
  const recoveredGroupId=(await board.getById(image.id)).groupId;
  assert.equal((await board.getById(icon.id)).groupId,recoveredGroupId);
  assert.equal((await board.getById(meta.badgeIds[0])).groupId,recoveredGroupId);
});

test('adding an award succeeds even if existing award would reject an SDK sync',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const image=board.add('image',{width:170,height:295,x:100,y:150});
  board.select([image]);
  await manager.initializeSelected(6);
  await manager.changeAward(AWARDS[0].id);
  const meta=await image.getMetadata('dbu_cm_card_v1');
  const existing=await board.getById(meta.awards[0].itemId);
  existing.failNextSync=true;
  board.select([await board.getById((await board.getById(image.id)).groupId)]);
  await manager.changeAward(AWARDS[1].id);
  assert.equal((await board.get({type:'group'})).length,1);
  assert.equal((await board.get({type:'image'})).length,3);
  assert.equal((await image.getMetadata('dbu_cm_card_v1')).awards.length,2);
  assert.equal(existing.failNextSync,true);
});

test('all 13 awards can be added sequentially without repositioning previous awards',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const image=board.add('image',{width:170,height:295,x:100,y:150});
  board.select([image]);
  await manager.initializeSelected(6);
  for(const award of AWARDS)await manager.changeAward(award.id);
  const meta=await image.getMetadata('dbu_cm_card_v1');
  const icons=await Promise.all(meta.awards.map(a=>board.getById(a.itemId)));
  assert.equal(meta.awards.length,13);
  assert.equal((await board.get({type:'group'})).length,1);
  assert.ok(icons.every(item=>item.groupId===(board.items.get(image.id)).groupId));
  // First six stack vertically. Seventh begins the next column.
  assert.ok(icons[0].y<icons[1].y);
  assert.ok(icons[0].x>icons[6].x);
});

test('repair of an accidentally ungrouped card retrieves orphan awards and restores circles',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const image=board.add('image',{width:170,height:295,x:100,y:150});
  board.select([image]);
  await manager.initializeSelected(6);
  for(const award of AWARDS.slice(0,3))await manager.changeAward(award.id);
  const meta=await image.getMetadata('dbu_cm_card_v1');
  const group=await board.getById((await board.getById(image.id)).groupId);
  await group.ungroup(); // Simulate the real failure: card + circles + icons split up.
  const movedImage=await board.getById(image.id);
  movedImage.x=900;movedImage.y=500;
  board.select([movedImage]);
  const result=await manager.repairSelected();
  assert.equal(result.updated,1);
  const current=await board.getById(image.id);
  const currentMeta=await current.getMetadata('dbu_cm_card_v1');
  assert.equal((await board.get({type:'group'})).length,1);
  assert.equal(currentMeta.awards.length,3);
  for(const item of await Promise.all(currentMeta.awards.map(a=>board.getById(a.itemId)))) {
    assert.equal(item.groupId,current.groupId);
    assert.ok(item.x>900);
    assert.ok(item.y>300 && item.y<600);
  }
  assert.equal((await board.get({type:'shape'})).length,6);
  for(const item of await Promise.all(currentMeta.badgeIds.map(id=>board.getById(id)))) {
    assert.equal(item.groupId,current.groupId);
    assert.ok(Math.abs(item.x-900)<85);
  }
});

test('Full Reset preserves avatars and groups, sets level zero and chosen circle count, deletes awards',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const images=Array.from({length:3},(_,i)=>board.add('image',{width:170,height:295,x:200*i,y:0}));
  board.select(images);await manager.initializeSelected(6);
  board.select(images.slice(0,2).map(img=>board.items.get(img.groupId)));
  await manager.setSelectedLevel(5);
  await manager.changeAward(AWARDS[0].id);
  const oldAwards=await Promise.all(images.slice(0,2).map(async img=>(await img.getMetadata('dbu_cm_card_v1')).awards[0].itemId));
  const res=await manager.resetSelected(10);
  assert.deepEqual(res,{reset:2,total:2,count:10});
  for(const image of images.slice(0,2)){
    const meta=await image.getMetadata('dbu_cm_card_v1');
    assert.equal(meta.level,0);
    assert.equal(meta.count,10);
    assert.deepEqual(meta.awards,[]);
    assert.equal(meta.badgeIds.length,10);
    assert.ok((await board.getById(image.id)).groupId);
    for(const id of meta.badgeIds)assert.equal((await board.getById(id)).style.fillColor,'#514663');
  }
  for(const id of oldAwards)await assert.rejects(()=>board.getById(id),/not found/);
  const untouched=await images[2].getMetadata('dbu_cm_card_v1');
  assert.equal(untouched.count,6);
  assert.equal((await manager.getConfig()).levelCount,10);
});

test('Full Reset refuses a group with unrelated objects before mutating anything',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const image=board.add('image',{width:170,height:295,x:0,y:0});
  board.select([image]);await manager.initializeSelected(6);
  const original=await board.getById(image.groupId);
  const foreign=board.add('shape',{x:0,y:0,width:30,height:30});
  await original.ungroup();
  const group=await board.group({items:[await board.getById(image.id),...await board.get({type:'shape'})]});
  board.select([group]);
  await assert.rejects(()=>manager.resetSelected(10),/fremde Elemente/);
  assert.equal((await image.getMetadata('dbu_cm_card_v1')).count,6);
  assert.equal((await board.get({type:'group'})).length,1);
  assert.ok(await board.getById(foreign.id));
});

test('Grid arranges 20 avatar groups into 4 columns and 5 rows preserving levels and awards',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const images=Array.from({length:20},(_,i)=>board.add('image',{width:170,height:295,x:(i%4)*220+((i*7)%23),y:Math.floor(i/4)*390+((i*11)%30)}));
  board.select(images);await manager.initializeSelected(6);
  board.select(images.map(img=>board.items.get(img.groupId)));
  await manager.setSelectedLevel(3);
  await manager.changeAward(AWARDS[0].id);
  const res=await manager.arrangeSelectedGrid(4);
  assert.deepEqual(res,{moved:19,total:20,columns:4});
  const live=await Promise.all(images.map(img=>board.getById(img.id)));
  const left=Math.min(...live.map(img=>img.x)),top=Math.min(...live.map(img=>img.y));
  const cells=new Set();
  for(const image of live){
    const col=Math.round((image.x-left)/(170*1.18));
    const row=Math.round((image.y-top)/(295*1.12));
    assert.ok(col>=0&&col<4&&row>=0&&row<5);
    cells.add(`${row}-${col}`);
    const meta=await image.getMetadata('dbu_cm_card_v1');
    assert.equal(meta.level,3);
    assert.equal(meta.awards.length,1);
    assert.equal((await board.getById(meta.awards[0].itemId)).groupId,image.groupId);
    for(const id of meta.badgeIds)assert.equal((await board.getById(id)).groupId,image.groupId);
  }
  assert.equal(cells.size,20);
  assert.equal((await board.get({type:'group'})).length,20);
});

test('Grid rejects Frame-owned cards without ungrouping anything',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const frame=board.add('frame',{x:400,y:400,width:800,height:800});
  const images=[board.add('image',{width:170,height:295,x:300,y:300}),board.add('image',{width:170,height:295,x:600,y:300})];
  board.select(images);await manager.initializeSelected(6);
  const first=await board.getById(images[0].id);
  first.parentId=frame.id;first.relativeTo='parent_top_left';first.x=300;first.y=300;
  board.select(images.map(img=>board.items.get(img.groupId)));
  await assert.rejects(()=>manager.arrangeSelectedGrid(4),/Frame/);
  assert.equal((await board.get({type:'group'})).length,2);
});

test('Layers brings the selected avatar, circles and awards above the other card as one stack',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const images=[board.add('image',{width:170,height:295,x:100,y:100}),board.add('image',{width:170,height:295,x:110,y:110})];
  board.select(images);await manager.initializeSelected(6);
  board.select([board.items.get(images[0].groupId)]);
  await manager.changeAward(AWARDS[0].id);
  const second=await board.getById(images[1].id);
  const meta=await images[0].getMetadata('dbu_cm_card_v1');
  const originalGroup=(await board.getById(images[0].id)).groupId;
  await manager.layersSelected();
  const positions=[images[0].id,...meta.badgeIds,meta.awards[0].itemId].map(id=>board.layers.indexOf(id));
  assert.ok(positions.every(pos=>pos>board.layers.indexOf(second.id)));
  assert.ok(positions[0]<positions[1]);
  assert.ok(positions[6]<positions[7]);
  assert.equal((await board.getById(images[0].id)).groupId,originalGroup);
});

test('Check & Repair does not change a healthy card',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const image=board.add('image',{width:170,height:295,x:100,y:150});
  board.select([image]);await manager.initializeSelected(6);await manager.changeAward(AWARDS[0].id);
  const originalGroup=(await board.getById(image.id)).groupId;
  const meta=await image.getMetadata('dbu_cm_card_v1');
  board.select([await board.getById(originalGroup)]);
  const result=await manager.checkAndRepairSelected();
  assert.deepEqual(result,{updated:0,healthy:1,total:1,awardsRepaired:0});
  assert.equal((await board.getById(image.id)).groupId,originalGroup);
  assert.deepEqual(await image.getMetadata('dbu_cm_card_v1'),meta);
});

test('Check & Repair restores a missing circle and deleted award while keeping the same level',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const image=board.add('image',{width:170,height:295,x:100,y:150});
  board.select([image]);await manager.initializeSelected(6);
  board.select([await board.getById(image.groupId)]);await manager.setSelectedLevel(4);
  await manager.changeAward(AWARDS[0].id);
  const meta=await image.getMetadata('dbu_cm_card_v1');
  await board.remove(await board.getById(meta.badgeIds[1]));
  await board.remove(await board.getById(meta.awards[0].itemId));
  board.select([await board.getById((await board.getById(image.id)).groupId)]);
  const res=await manager.checkAndRepairSelected();
  assert.equal(res.updated,1);
  const next=await image.getMetadata('dbu_cm_card_v1');
  assert.equal(next.level,4);assert.equal(next.count,6);assert.equal(next.awards.length,1);
  assert.equal((await board.get({type:'shape'})).length,6);
  assert.equal((await board.get({type:'image'})).length,2);
  for(let i=0;i<6;i++)assert.equal((await board.getById(next.badgeIds[i])).style.fillColor,i<4?'#FFEC00':'#514663');
  assert.equal((await board.getById(next.awards[0].itemId)).groupId,(await board.getById(image.id)).groupId);
});

test('manual level command checks only selected cards, never scans all board items',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const zone=board.add('shape',{x:700,y:200,width:300,height:400});
  const a=board.add('image',{width:170,height:295,x:0,y:200});
  const b=board.add('image',{width:170,height:295,x:250,y:200});
  board.select([a,b]);await manager.initializeSelected(6);
  board.select([zone]);await manager.assignSelectedZone(5);
  let fullScans=0;
  const previousGet=board.get.bind(board);
  board.get=async options=>{fullScans++;return previousGet(options);};
  const aGroup=await board.getById(a.groupId);
  aGroup.move(700,0);
  board.select([aGroup]);
  assert.equal((await a.getMetadata('dbu_cm_card_v1')).level,0,'moving is inert without click');
  const result=await manager.syncSelectedLevels();
  assert.equal(result.updated,1);
  assert.equal((await a.getMetadata('dbu_cm_card_v1')).level,5);
  assert.equal((await b.getMetadata('dbu_cm_card_v1')).level,0);
  assert.equal(fullScans,0,'manual level must not scan every image on the board');
  zone.x=250;
  board.select([board.items.get(b.groupId)]);
  assert.equal((await b.getMetadata('dbu_cm_card_v1')).level,0,'moving a zone is also inert');
  await manager.syncSelectedLevels();
  assert.equal(fullScans,0,'even after moving a zone, only selected avatars are checked');
  assert.equal((await b.getMetadata('dbu_cm_card_v1')).level,5);
});

test('automatic visual layers keep overlapping cards and badges in contiguous stacks',async()=>{
  const board=new MockBoard(),manager=makeManager(board);
  const back=board.add('image',{width:170,height:295,x:0,y:0});
  const front=board.add('image',{width:170,height:295,x:10,y:10});
  const backdrop=board.add('shape',{x:0,y:0,width:1000,height:1000});
  board.select([back,front]);
  await manager.initializeSelected(6);
  board.select([board.items.get(back.groupId)]);
  await manager.changeAward(AWARDS[0].id);
  board.select([board.items.get((await board.getById(back.id)).groupId),board.items.get((await board.getById(front.id)).groupId)]);
  await manager.layersSelected();

  const b=await back.getMetadata('dbu_cm_card_v1');
  const f=await front.getMetadata('dbu_cm_card_v1');
  const bIds=[back.id,...b.badgeIds,...b.awards.map(x=>x.itemId)];
  const fIds=[front.id,...f.badgeIds];
  const bi=bIds.map(id=>board.layers.indexOf(id));
  const fi=fIds.map(id=>board.layers.indexOf(id));
  assert.deepEqual(bi,[...bi].sort((a,c)=>a-c));
  assert.deepEqual(fi,[...fi].sort((a,c)=>a-c));
  assert.ok(Math.max(...bi)<Math.min(...fi));
  assert.ok(Math.min(...bi)>board.layers.indexOf(backdrop.id));
});

test('single failed SDK call is retried inside the same card without losing the group',async()=>{
  const board=new MockBoard();
  const waits=[];
  const manager=createManager(board,{
    sleep:async ms=>waits.push(ms),creditMinute:1e9,creditHour:1e9,
  });
  const originalCreate=board.createShape.bind(board);
  let failures=0;
  board.createShape=async props=>{
    if(failures++===0)throw new Error('Miro Web SDK rate limit exceeded: 429');
    return originalCreate(props);
  };
  const image=board.add('image',{width:170,height:295,x:0,y:0});
  board.select([image]);
  assert.equal((await manager.initializeSelected(3)).updated,1);
  assert.deepEqual(waits,[65000]);
  const meta=await image.getMetadata('dbu_cm_card_v1');
  assert.equal(meta.badgeIds.length,3);
  assert.ok(image.groupId);
});
