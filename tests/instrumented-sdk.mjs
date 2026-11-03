import {MockBoard} from './mock-sdk.mjs';

// Independent observer at the app/SDK boundary. Calls made by mock internals
// (e.g. ungroup reading its own members) are deliberately not double-counted.
const boardMethods=new Set(['getSelection','get','getById','createShape','createImage','group','remove','select','deselect','bringToFront','bringInFrontOf','getLayerIndex']);
const itemMethods=new Set(['getMetadata','setMetadata','sync','getItems','ungroup','remove','getLayerIndex']);
const mutations=new Set(['createShape','createImage','group','remove','select','deselect','bringToFront','bringInFrontOf','setMetadata','sync','ungroup']);
export function instrumentBoard(raw=new MockBoard()) {
  const events=[];
  let fail=null;
  const proxies=new WeakMap();
  function wrap(value) {
    if(Array.isArray(value))return value.map(wrap);
    if(!value || typeof value!=='object' || !(value===raw || (value.type && value.id)))return value;
    if(proxies.has(value))return proxies.get(value);
    const proxy=new Proxy(value,{
      get(target,key){
        const original=Reflect.get(target,key);
        if(typeof original!=='function')return original;
        if(!(target===raw?boardMethods:itemMethods).has(key))return original.bind(target);
        return (...args)=>{
          const type=target===raw?'board':target.type;
          const cost=(key==='getSelection'||key==='get'||key==='createImage'||(key==='sync'&&['image','embed'].includes(type)))?500:50;
          const event={method:`${type}.${key}`,id:target.id??null,cost,mutation:mutations.has(key),failed:false};
          events.push(event);
          try {
            const error=fail?.(event,args);
            if(error)throw error;
            const result=original.apply(target,args);
            if(result?.then)return result.then(wrap,error=>{event.failed=true;throw error;});
            return wrap(result);
          }catch(error){event.failed=true;throw error;}
        };
      },
    });
    proxies.set(value,proxy);
    return proxy;
  }
  return {
    board:wrap(raw),raw,events,
    failWith(fn){fail=fn;},
    clear(){events.length=0;},
    summary(){return {
      calls:events.length,credits:events.reduce((sum,e)=>sum+e.cost,0),
      mutations:events.filter(e=>e.mutation).length,
      failedCalls:events.filter(e=>e.failed).length,
      failedCredits:events.filter(e=>e.failed).reduce((sum,e)=>sum+e.cost,0),
      byMethod:Object.fromEntries([...new Set(events.map(e=>e.method))].sort().map(name=>{
        const calls=events.filter(e=>e.method===name);
        return [name,{calls:calls.length,credits:calls.reduce((sum,e)=>sum+e.cost,0)}];
      })),
    };},
  };
}

export const CARD='dbu_cm_card_v1',CIRCLE='dbu_cm_circle_v1',AWARD='dbu_cm_award_v1';
export function selectImages(raw,images) {
  raw.selected=images.map(image=>raw.items.get(image.id).groupId || image.id);
}
export function snapshot(raw) {
  return [...raw.items.values()].map(item=>({
    id:item.id,type:item.type,groupId:item.groupId,parentId:item.parentId,
    x:item.x,y:item.y,width:item.width,height:item.height,shape:item.shape,
    style:structuredClone(item.style),meta:item.meta?structuredClone([...item.meta]):null,
    title:item.title,url:item.url,content:item.content,ids:item.ids?[...item.ids]:null,
  }));
}
export async function prepared(makeManager,{count=20,level=3,awards=0}={}) {
  const trace=instrumentBoard();
  const manager=makeManager(trace.board);
  const images=Array.from({length:count},(_,i)=>trace.raw.add('image',{
    title:`Avatar ${i+1}`,url:`https://example.invalid/avatar-${i+1}.svg`,
    width:170,height:295,x:(i%5)*230,y:Math.floor(i/5)*340,
  }));
  selectImages(trace.raw,images);
  await manager.initializeSelected(6);
  if(level)await manager.setSelectedLevel(level);
  const slugs=['spurensucher','faktencheck','egg-designer','quest-builder'];
  for(let i=0;i<awards;i++)await manager.changeAward(slugs[i]);
  selectImages(trace.raw,images);
  trace.clear();
  return {...trace,manager,images};
}
