import assert from 'node:assert/strict';

class Item {
  constructor(board,type,props={}){Object.assign(this,props);this.board=board;this.type=type;this.id=String(++board.sequence);this.meta=new Map();}
  async getMetadata(key){return structuredClone(this.meta.get(key));}
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
export class MockBoard {
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

// Miro duplicates the metadata together with each item. The copied avatar,
// badges and awards get NEW Miro IDs but copied metadata keeps OLD IDs.
export async function duplicateAvatar(board,source,offset=280) {
  const live=await board.getById(source.id);
  const old=await board.getById(live.groupId);
  const members=await old.getItems();
  const cloned=[];
  for(const item of members) {
    const copy=board.add(item.type,{
      title:item.title,url:item.url,content:item.content,shape:item.shape,
      width:item.width,height:item.height,x:item.x+offset,y:item.y,
      style:item.style?structuredClone(item.style):undefined,
    });
    copy.meta=new Map([...item.meta].map(([k,v])=>[k,structuredClone(v)]));
    cloned.push(copy);
  }
  const group=await board.group({items:cloned});
  const image=cloned.find(item=>item.id!==source.id && item.type==='image' &&
    Math.abs(item.width/item.height-170/295)<.12);
  return {image,group,cloned};
}

