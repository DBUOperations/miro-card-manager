import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('./panel.js',import.meta.url),'utf8');

function bootPanel(withNewCore) {
  const nodes=new Map();
  const sdkCalls=[];
  function makeNode() {
    return {
      value:'',checked:false,hidden:true,style:{},children:[],className:'',textContent:'',listeners:{},
      setAttribute(){},addEventListener(event,handler){this.listeners[event]=handler;},
      replaceChildren(...items){this.children=items;},
      append(...items){this.children.push(...items);},
    };
  }
  const document={
    getElementById(id){if(!nodes.has(id))nodes.set(id,makeNode());return nodes.get(id);},
    createElement:makeNode,
    querySelectorAll:()=>[],
  };
  const board={ui:{on(name){sdkCalls.push('listen:'+name);}}};
  const manager={
    selectionInfo:async()=>{sdkCalls.push('selectionInfo');return {cards:0,zones:0};},
    selectedCards:async()=>{sdkCalls.push('selectedCards');return [];},
    ...(withNewCore?{version:'1.9.0',setSelectedLevel:async n=>{sdkCalls.push('setLevel:'+n);return {updated:1,total:1};},setStatusHandler:()=>{}}:{}),
  };
  const window={miro:{board},confirm:()=>true};
  const runtime=source.replace(/^import .*?;\s*$/gm,'');
  runInNewContext(runtime,{
    document,window,makeManager:()=>manager,
    AWARDS:[{id:'one',name:'First'},{id:'two',name:'Second'}],
    awardAssetUrl:()=>'/award.png',
    setTimeout:()=>0,clearTimeout:()=>{},console,
  },{timeout:3000});
  return {nodes,window,sdkCalls};
}

test('manual-only panel boots without any Miro reads, subscriptions, or queries',()=>{
  const {nodes,window,sdkCalls}=bootPanel(true);
  assert.equal(window.__dbuPanelReady,true);
  assert.deepEqual(sdkCalls,[]);
  assert.equal(nodes.get('level-preview').children.length,6);
  assert.equal(nodes.get('level-buttons').children.length,6);
  assert.equal(nodes.get('level-buttons').children[5].textContent,'6');
  assert.equal(nodes.get('award-list').children.length,2);
});

test('slider changes only DOM and direct Level buttons are the only Level commands',async()=>{
  const {nodes,sdkCalls}=bootPanel(true);
  const range=nodes.get('level-count');
  range.listeners.input({target:{value:'10'}});
  assert.equal(nodes.get('level-preview').children.length,10);
  assert.equal(nodes.get('level-buttons').children.length,10);
  assert.deepEqual(sdkCalls,[],'slider must never use the SDK');
  await nodes.get('level-buttons').children[9].listeners.click();
  assert.deepEqual(sdkCalls,['setLevel:10']);
});

test('stale core.js no longer causes an entirely blank card-manager panel',()=>{
  const {nodes,window}=bootPanel(false);
  assert.equal(window.__dbuPanelReady,true);
  assert.equal(nodes.get('award-list').children.length,2);
  assert.match(nodes.get('message').textContent,/alte App-Dateien/);
});

test('HTML script and module imports use matching cache-busting versions',()=>{
  const panel=readFileSync(new URL('./panel.html',import.meta.url),'utf8');
  const index=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  const headless=readFileSync(new URL('./headless.js',import.meta.url),'utf8');
  assert.match(source,/core\.js\?v=1\.9\.0/);
  assert.match(headless,/panel\.html\?v=1\.9\.0/);
  assert.match(panel,/panel\.js\?v=1\.9\.0/);
  assert.match(panel,/style\.css\?v=1\.9\.0/);
  assert.match(index,/headless\.js\?v=1\.9\.0/);
  assert.doesNotMatch(panel,/zone-level|assign-zone|manual-level|sync-levels|Auto Level/);
  assert.doesNotMatch(source,/assignSelectedZone|syncSelectedLevels|getConfig/);
  assert.doesNotMatch(source,/selection:update|items:update|setInterval\(/);
  assert.doesNotMatch(headless,/selection:update|items:update|setInterval\(|setTimeout\(/);
});

test('headless registers only the user-click handler, no reactions to guest card moves',async()=>{
  const source=readFileSync(new URL('./headless.js',import.meta.url),'utf8');
  const listeners=new Map();
  const sdkCalls=[];
  const board={ui:{on:(key,callback)=>listeners.set(key,callback),openPanel:async args=>sdkCalls.push(args)}};
  runInNewContext(source,{window:{miro:{board}},setInterval:()=>{throw Error('Polling forbidden');},setTimeout:()=>{throw Error('Background timer forbidden');}},{timeout:3000});
  assert.deepEqual([...listeners.keys()],['icon:click']);
  assert.equal(sdkCalls.length,0);
  assert.equal(listeners.has('items:update'),false);
  await listeners.get('icon:click')();
  assert.equal(sdkCalls.length,1);
  assert.equal(sdkCalls[0].url,'panel.html?v=1.9.0');
});
