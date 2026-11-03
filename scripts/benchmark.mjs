import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {makeManager as optimized} from '../core.js';
import {prepared,selectImages} from '../tests/instrumented-sdk.mjs';

const baselinePath=process.argv[2];
if(!baselinePath) {
  console.error('Usage: npm run benchmark -- /absolute/path/to/original-v1.9.2/core.js [output.json]');
  process.exit(1);
}
const baselineFile=resolve(baselinePath);
const {makeManager:original}=await import(pathToFileURL(baselineFile));
// Disable only the baseline's waits for deterministic simulation, not its calls.
// The original source remains byte-for-byte unchanged.
const baseline=board=>original(board,{creditMinute:1e12,creditHour:1e12,sleep:()=>{throw Error('Unexpected wait');}});
const scenarios=[
  {name:'Level 3 on twenty Level 3 cards',settings:{},action:s=>s.manager.setSelectedLevel(3)},
  {name:'Mixed levels: 15 × L3, 3 × L2, 2 × L1 → L3',settings:{},setup:async s=>{
    selectImages(s.raw,s.images.slice(15,18));await s.manager.setSelectedLevel(2);
    selectImages(s.raw,s.images.slice(18));await s.manager.setSelectedLevel(1);
    selectImages(s.raw,s.images);
  },action:s=>s.manager.setSelectedLevel(3)},
  {name:'All twenty Level 1 cards → Level 3',settings:{level:1},action:s=>s.manager.setSelectedLevel(3)},
  {name:'Add existing award (four awards per card)',settings:{awards:4},action:s=>s.manager.changeAward('spurensucher')},
  {name:'Remove absent award (four awards per card)',settings:{awards:4},action:s=>s.manager.changeAward('professorin',true)},
  {name:'Arrange four already aligned awards per card',settings:{awards:4},action:s=>s.manager.rearrangeSelectedAwards()},
  {name:'Prepare twenty already healthy six-level cards',settings:{},action:s=>s.manager.initializeSelected(6)},
  {name:'Repair twenty healthy cards (two awards each)',settings:{awards:2},action:s=>s.manager.checkAndRepairSelected()},
  {name:'Add a second award to twenty cards',settings:{awards:1},action:s=>s.manager.changeAward('faktencheck')},
  {name:'Remove one of two awards on twenty cards',settings:{awards:2},action:s=>s.manager.changeAward('faktencheck',true)},
  {name:'Reset Levels on twenty Level 3 cards (two awards each)',settings:{awards:2},action:s=>s.manager.resetSelectedLevels()},
  {name:'Reset Awards on twenty cards (two awards each)',settings:{awards:2},action:s=>s.manager.resetSelectedAwards()},
  {name:'Full Reset on twenty cards (two awards each)',settings:{awards:2},action:s=>s.manager.resetSelected(6)},
  {name:'Layers on twenty cards (two awards each)',settings:{awards:2},action:s=>s.manager.layersSelected()},
];
const results=[];
for(const scenario of scenarios) {
  const row={scenario:scenario.name};
  for(const [version,factory] of [['before',baseline],['after',optimized]]) {
    const s=await prepared(factory,scenario.settings);
    if(scenario.setup)await scenario.setup(s);
    s.clear();await scenario.action(s);
    row[version]=s.summary();
    if(version==='after')assert.equal(s.manager.getUsage().lastAction,row[version].credits,'independent meter and application counter must agree');
  }
  assert.ok(row.after.credits<row.before.credits,scenario.name);
  row.reductionPercent=Number((100*(1-row.after.credits/row.before.credits)).toFixed(1));
  results.push(row);
}
const report={
  version:'1.9.3',baselineVersion:'1.9.2',date:'2026-11-03',
  baselineCoreSha256:createHash('sha256').update(readFileSync(baselineFile)).digest('hex'),
  optimizedCoreSha256:createHash('sha256').update(readFileSync(new URL('../core.js',import.meta.url))).digest('hex'),
  method:'Independent instrumented SDK mock, fresh manager and 20 cards per scenario; current groups selected. Six level badges, Level 3 unless specified. Setup excluded; synchronous command and selection restoration included. No wall-clock or real-Miro measurements.',
  weights:'getSelection/get/createImage/image.sync: 500; all other used SDK methods: 50. Attempted calls, including errors, counted conservatively.',
  sources:['https://developers.miro.com/docs/websdk-reference-rate-limiting','https://developers.miro.com/docs/websdk-reference-board'],
  results,
};
const output=process.argv[3];
if(output)writeFileSync(resolve(output),JSON.stringify(report,null,2)+'\n');
console.table(results.map(r=>({Scenario:r.scenario,'Before credits':r.before.credits,'After credits':r.after.credits,'Before calls':r.before.calls,'After calls':r.after.calls,'Reduction %':r.reductionPercent})));
