// 13 award images recovered from the two Module 2 PDFs.
// SELTENER FUND is intentionally omitted: no image is present in the source PDF.
export const AWARDS = [
  {id:'spurensucher', name:'SPURENSUCHER:IN', file:'spurensucher.png'},
  {id:'faktencheck', name:'FAKTENCHECK', file:'faktencheck.png'},
  {id:'egg-designer', name:'EGG-DESIGNER', file:'egg-designer.png'},
  {id:'quest-builder', name:'QUEST-BUILDER', file:'quest-builder.png'},
  {id:'playtester', name:'PLAYTESTER', file:'playtester.png'},
  {id:'brand-creator', name:'BRAND-CREATOR', file:'brand-creator.png'},
  {id:'medien-spuernase', name:'MEDIEN-SPÜRNASE', file:'medien-spuernase.png'},
  {id:'perspektivwechsel', name:'PERSPEKTIVWECHSEL', file:'perspektivwechsel.png'},
  {id:'impulsgeber', name:'IMPULSGEBER:IN', file:'impulsgeber.png'},
  {id:'transfer-profi', name:'TRANSFER-PROFI', file:'transfer-profi.png'},
  {id:'professorin', name:'PROFESSORIN', file:'professorin.png'},
  {id:'kreativ-bonus', name:'KREATIV-BONUS', file:'kreativ-bonus.png'},
  {id:'teamplayer', name:'TEAMPLAYER', file:'teamplayer.png'},
];

export function awardAssetUrl(award) {
  return new URL(`./assets/awards/${award.file}`, import.meta.url).href;
}
