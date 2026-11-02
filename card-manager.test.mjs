import test from 'node:test';
import assert from 'node:assert/strict';
import {makeManager} from '../core.js';
import {AWARDS} from '../awards.js';

class Item {
  constructor(board,type,props={}){Object.assign(this,props);this.board=board;this.type=type;this.id=String(++board.sequence);this.meta=new Map();}
  async getMetadata(key){return this.meta.get(key);}
  async setMetadata(key,value){this.meta.set(key,value);}
  async sync(){this.board.synced++;}
}
class Group {
  constructor(board,items){this.board=board;this.type='group';this.id=String(++board.sequence);this.ids=items.map(x=>x.id);for(const x of items)x.groupId=this.id;}
  async getItems(){return this.ids.map(id=>this.board.items.get(id)).filter(Boolean);}
  async ungroup(){const xs=await this.getItems();for(const x of xs)x.groupId=undefined;this.board.items.delete(this.id);return xs;}
}
class MockBoard {
  constructor(){this.sequence=100;this.items=new Map();this.selected=[];this.synced=0;this.data=new Map();this.storage={collection:()=>({get:async k=>this.data.get(k),set:async(k,v)=>this.data.set(k,v)})};}
  add(type,props){const x=new Item(this,type,props);this.items.set(x.id,x);return x;}
  async createShape(props){return this.add('shape',props);}
  async createImage(props){return this.add('image',{...props,height:props.width});}
  async getSelection(){return this.selected.map(id=>this.items.get(id)).filter(Boolean);}
  async get({type}){return [...this.items.values()].filter(x=>x.type===type);}
  async getById(id){const x=this.items.get(id);if(!x)throw Error('not found '+id);return x;}
  async group({items}){const g=new Group(this,items);this.items.set(g.id,g);return g;}
  async remove(item){this.items.delete(item.id);}
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
  assert.equal((await manager.allCards()).length,20);
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
  await manager.syncLevels();
  assert.equal((await images[0].getMetadata('dbu_cm_card_v1')).level,5);
  zone.x=1500;images[0].x=1500;
  await manager.syncLevels();
  assert.equal((await images[0].getMetadata('dbu_cm_card_v1')).level,5);

  board.select(images.slice(0,2).map(x=>board.items.get(x.groupId)));
  assert.equal(AWARDS.length,13);
  assert.equal((await manager.changeAward('professorin')).changed,2);
  assert.equal((await manager.changeAward('professorin')).changed,0);
  for(const image of images.slice(0,2)){
    const m=await image.getMetadata('dbu_cm_card_v1');
    assert.equal(m.awards.length,1);
    assert.equal((await board.getById(m.awards[0].itemId)).groupId,image.groupId);
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
