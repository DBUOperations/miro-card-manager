import {AWARDS, awardAssetUrl} from './awards.js';

const STORE = 'dbu-card-manager-v1';
const CONFIG_KEY = 'settings';
const CARD_KEY = 'dbu_cm_card_v1';
const CIRCLE_KEY = 'dbu_cm_circle_v1';
const AWARD_KEY = 'dbu_cm_award_v1';
const YELLOW = '#FFEC00';
const MUTED = '#514663';
const INK = '#201833';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const uniqueById = values => [...new Map(values.filter(Boolean).map(x => [x.id, x])).values()];

export function makeManager(board, options={}) {
  if (!board?.getSelection || !board?.group || !board?.storage?.collection) {
    throw new Error('Miro SDK nije dostupan. Otvori aplikaciju u Miro boardu.');
  }
  const collection = board.storage.collection(STORE);
  let statusHandler=()=>{};
  const sleep=options.sleep || (ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const creditHistory=[];
  // Local per-panel budget. Zero SDK calls happen without a deliberate command.
  const CREDIT_MINUTE=options.creditMinute??85000;
  const CREDIT_HOUR=options.creditHour??850000;
  const isRateLimit=err=>/rate.?limit|too many requests|credits? (?:per|limit|exceeded)|429/i.test(String(err?.message||err));
  async function sdkCall(operation,cost=50) {
    for(let attempt=0;attempt<4;attempt++) {
      while(true) {
        const now=Date.now();
        while(creditHistory.length && now-creditHistory[0].at>=3600000)creditHistory.shift();
        const minute=creditHistory.filter(x=>now-x.at<60000).reduce((s,x)=>s+x.cost,0);
        const hour=creditHistory.reduce((s,x)=>s+x.cost,0);
        if(minute+cost<=CREDIT_MINUTE && hour+cost<=CREDIT_HOUR)break;
        const oldMinute=creditHistory.find(x=>now-x.at<60000);
        const ms=minute+cost>CREDIT_MINUTE && oldMinute ? Math.max(1000,60000-(now-oldMinute.at)+250) :
          Math.max(1000,3600000-(now-creditHistory[0].at)+250);
        statusHandler(`Miro API: Limit wird geschont, ${Math.ceil(ms/1000)}s warten …`);
        await sleep(ms);
      }
      creditHistory.push({at:Date.now(),cost});
      try {return await operation();}
      catch(err) {
        if(!isRateLimit(err) || attempt===3)throw err;
        const hourly=/hour|stunde/i.test(String(err.message||err));
        if(hourly)throw new Error('Miro hat das stündliche API-Limit erreicht. Bitte später erneut versuchen.');
        statusHandler(`Miro API-Limit erreicht. Warte und versuche denselben Schritt erneut (${attempt+1}/3) …`);
        await sleep(65000);
      }
    }
  }
  const getById=id=>sdkCall(()=>board.getById(id));
  const getSelection=()=>sdkCall(()=>board.getSelection(),500);
  const getMetadata=(item,key)=>sdkCall(()=>item.getMetadata(key));
  const setMetadata=(item,key,value)=>sdkCall(()=>item.setMetadata(key,value));
  const syncItem=item=>sdkCall(()=>item.sync());
  const bringToFront=items=>sdkCall(()=>board.bringToFront(items));
  const getMembers=group=>sdkCall(()=>group.getItems());
  const removeItem=item=>sdkCall(()=>board.remove(item));
  const getLayerIndex=item=>sdkCall(()=>board.getLayerIndex(item));

  async function getConfig() {
    const saved = await collection.get(CONFIG_KEY) || {};
    return {
      levelCount: clamp(Number(saved.levelCount) || 6, 2, 10),
      zones: saved.zones && typeof saved.zones === 'object' ? {...saved.zones} : {},
    };
  }

  async function putConfig(changes) {
    const next = {...await getConfig(), ...changes};
    await collection.set(CONFIG_KEY, next);
    return next;
  }

  async function withMutation(action) {
    // Manual-only mode does not require SDK storage reads/writes for pauses.
    return action();
  }

  async function readCard(image) {
    try { return await getMetadata(image,CARD_KEY); }
    catch (err) { if(isRateLimit(err))throw err; return undefined; }
  }

  async function readAward(image) {
    try { return await getMetadata(image,AWARD_KEY); }
    catch (err) { if(isRateLimit(err))throw err; return undefined; }
  }

  async function readCircle(shape) {
    try { return await getMetadata(shape,CIRCLE_KEY); }
    catch (err) { if(isRateLimit(err))throw err; return undefined; }
  }

  async function resolveImage(image, allowNew) {
    // Our award images always have this title. Skip them before metadata
    // calls: on a board with 40 cards x 13 awards this saves 520 reads/scan.
    if(String(image.title||'').startsWith('Award: '))return undefined;
    const existing = await readCard(image);
    if (existing?.version === 1) return {image, meta:existing};
    if (!allowNew || !image.width || !image.height) return undefined;
    // A pasted avatar is 170:295. Ignore square award images and other board artwork.
    const ratio = image.width / image.height;
    if (Math.abs(ratio - 170 / 295) > 0.12) return undefined;
    if (await readAward(image)) return undefined;
    return {image, meta:undefined};
  }

  async function selectedCards({allowNew = true} = {}) {
    return cardsFromItems(await getSelection(),allowNew);
  }

  async function selectionInfo() {
    const items = await getSelection();
    return {
      total: items.length,
      cards: (await cardsFromItems(items,true)).length,
      zones: items.filter(x => x.type === 'shape' || x.type === 'frame').length,
    };
  }

  async function cardsFromItems(items,allowNew=false) {
    const found=[];
    const seen=new Set();
    for(const item of items) {
      const members=item.type==='group' && item.getItems ? await getMembers(item) : [item];
      for(const member of members) {
        if(member.type==='image' && !seen.has(member.id) && !String(member.title||'').startsWith('Award: ')) {
          seen.add(member.id);
          const card=await resolveImage(member,allowNew);
          if(card)found.push(card);
        }
      }
    }
    return [...new Map(found.map(x=>[x.image.id,x])).values()];
  }

  async function circleLayout(image, n, anchor) {
    const w = image.width, h = image.height;
    const gap = w * 0.023;
    const d = Math.min(w * 0.105, (w * 0.86 - (n - 1) * gap) / n);
    const position = anchor || await absolutePosition(image);
    const start = position.x - (n * d + (n - 1) * gap) / 2 + d / 2;
    const y = position.y + h * (277 / 295 - .5);
    return Array.from({length:n}, (_,i)=>({x:start+i*(d+gap),y,diameter:d,index:i+1}));
  }

  function levelStyle(index, level, diameter) {
    const active = index <= level;
    return {
      fillColor: active ? YELLOW : MUTED,
      color: active ? INK : '#FFFFFF',
      borderWidth: 0,
      fontFamily: 'arial',
      fontSize: Math.max(7, diameter * .53),
      textAlign: 'center',
      textAlignVertical: 'middle',
    };
  }

  async function createCircles(image, count, level, anchor) {
    const ids = [];
    try {
      for (const slot of await circleLayout(image, count, anchor)) {
        const badge = await sdkCall(()=>board.createShape({
          content: `<p>${slot.index}</p>`, shape:'circle',
          x:slot.x, y:slot.y, width:slot.diameter, height:slot.diameter,
          style:levelStyle(slot.index, level, slot.diameter),
        }));
        ids.push(badge.id);
        await setMetadata(badge,CIRCLE_KEY, {cardId:image.id, index:slot.index});
      }
    } catch(error) {
      for (const badge of await getItemsByIds(ids)) {
        try { await removeItem(badge); } catch(cleanupError) {console.warn('Circle cleanup failed',cleanupError);}
      }
      throw error;
    }
    return ids;
  }

  async function getItemsByIds(ids) {
    const found = [];
    for (const id of ids) {
      try { found.push(await getById(id)); } catch (err) { if(isRateLimit(err))throw err; /* removed manually */ }
    }
    return uniqueById(found);
  }

  async function groupMembers(image) {
    if(!image.groupId) return [image];
    const group=await getById(image.groupId);
    return group?.type==='group' ? getMembers(group) : [image];
  }

  function expectedMemberIds(image,meta) {
    return new Set([image.id,...(meta?.badgeIds||[]),...(meta?.awards||[]).map(a=>a.itemId)]);
  }

  async function safeManagedMembers(image,meta) {
    const members=await groupMembers(image);
    const allowed=expectedMemberIds(image,meta);
    if(members.some(item=>!allowed.has(item.id))) {
      throw new Error('Die Kartengruppe enthält fremde Elemente. Bitte vor dieser Aktion separat gruppieren.');
    }
    return members;
  }

  function requiresFrameDetach(item) {
    return item?.parentId && item.parentId!=='null';
  }

  async function requireCanvasItems(items, operation) {
    if(items.some(requiresFrameDetach)) {
      throw new Error(`${operation}: Diese Karte ist mit einem Frame verbunden. Bitte zuerst auf eine Rechteck-Levelzone verschieben.`);
    }
  }

  async function moveCanvasItem(item, position) {
    let live=await getById(item.id);
    if(requiresFrameDetach(live)) {
      const parent=await getById(live.parentId);
      if(parent?.type!=='frame' || !parent.remove) {
        throw new Error('Das Element ist Kind eines nicht unterstützten Containers.');
      }
      await sdkCall(()=>parent.remove(live));
      live=await getById(live.id);
      if(requiresFrameDetach(live))throw new Error('Das Element konnte nicht vom Frame gelöst werden.');
    }
    live.x=position.x;live.y=position.y;
    await syncItem(live);
    return live;
  }

  async function releaseCardGroup(image) {
    if (!image.groupId) return [image];
    const group = await getById(image.groupId);
    if (!group || group.type !== 'group') return [image];
    const members = await getMembers(group);
    const cardImages = [];
    for (const member of members) {
      if (member.type === 'image' && await readCard(member)) cardImages.push(member.id);
    }
    if (cardImages.length > 1) throw new Error('Mehrere Karten sind zusammen gruppiert. Bitte erst getrennt auswählen.');
    return sdkCall(()=>group.ungroup());
  }

  async function liveImage(image, ungroupedMembers) {
    // After a moved group is ungrouped, old SDK image objects can still carry
    // pre-move coordinates. Fetch the released image again before laying out items.
    try { return await getById(image.id); }
    catch (_) { return ungroupedMembers.find(x => x.id === image.id) || image; }
  }

  async function regroup(members) {
    const items = uniqueById(members);
    if (items.length < 2) return null;
    return sdkCall(()=>board.group({items}));
  }

  async function placeOwnOverlays(image,meta,members) {
    if(!board.bringInFrontOf)return;
    const index=new Map(members.map(item=>[item.id,item]));
    const ownImage=index.get(image.id)||image;
    const circles=(meta.badgeIds||[]).map(id=>index.get(id)).filter(Boolean);
    if(circles.length)await sdkCall(()=>board.bringInFrontOf(circles,ownImage));
    const awards=(meta.awards||[]).map(a=>index.get(a.itemId)).filter(Boolean);
    if(awards.length)await sdkCall(()=>board.bringInFrontOf(awards,circles.at(-1)||ownImage));
  }

  async function withReleasedCard(image, action) {
    const originalMembers = await releaseCardGroup(image);
    try {
      return await action([...originalMembers]);
    } catch (error) {
      // A failed SDK operation must not leave the whole avatar disassembled.
      // Reload because Miro replaces item objects when ungrouping.
      try {
        const survivors = await getItemsByIds(originalMembers.map(item => item.id));
        if (survivors.length >= 2 && survivors.every(item => !item.groupId)) {
          await regroup(survivors);
        }
      } catch (restoreError) {
        console.error('Could not restore the avatar group after a failed operation', restoreError);
      }
      throw error;
    }
  }

  async function restoreCardSelection(groupIds) {
    const ids=[...new Set(groupIds.filter(Boolean))];
    if(!ids.length || !board.select || !board.deselect) return;
    try {
      await sdkCall(()=>board.deselect());
      await sdkCall(()=>board.select({id:ids}));
    } catch(err) {
      // A selection failure must never undo or invalidate successfully created cards.
      console.warn('Miro: could not restore card selection',err);
    }
  }

  async function initializeSelected(count, progress=()=>{}, repair=false, providedCards=null) {
    const cards = providedCards || await selectedCards({allowNew:!repair});
    if (!cards.length) throw new Error('Bitte zuerst eine oder mehrere Avatar-Karten auswählen.');
    count = clamp(Number(count) || 6, 2, 10);
    return withMutation(async () => {
      if (!repair) await putConfig({levelCount:count});
      let updated=0, unchanged=0;
      const selectedGroupIds=[];
      for (let i=0;i<cards.length;i++) {
        const {image, meta:originalMeta} = cards[i];
        progress(i, cards.length);
        const meta = await readCard(image) || originalMeta;
        // The position used by Auto Level (while grouped) is authoritative.
        // Ungrouping may change how Miro exposes child coordinates, so retain
        // the board-space anchor BEFORE releasing the card group.
        const anchor = await absolutePosition(image);
        const cardCount = repair ? clamp(Number(meta?.count)||count,2,10) : count;
        if (!meta && image.groupId) {
          throw new Error('Eine neue Avatar-Karte ist bereits gruppiert. Bitte zuerst Gruppierung aufheben.');
        }
        if (!repair && meta && meta.count === cardCount && meta.badgeIds?.length === cardCount) {
          unchanged++;
          if(image.groupId)selectedGroupIds.push(image.groupId);
          continue;
        }
        const level = clamp(Number(meta?.level)||0, 0, cardCount);
        const perform = async released => {
          let members = released;
          const currentImage = await liveImage(image, members);
          // Create replacements first so an SDK failure does not destroy the old circles.
          const badges = await createCircles(currentImage,cardCount,level,anchor);
          try {
            if(repair && meta?.awards?.length) {
              // Recover awards orphaned by a previously interrupted ungroup.
              // Normal level-count changes leave existing awards untouched.
              const present=new Set(members.map(item=>item.id));
              const orphaned=(await getItemsByIds(meta.awards.map(a=>a.itemId)))
                .filter(item=>item.type==='image' && !present.has(item.id));
              if(orphaned.some(item=>item.groupId)) {
                throw new Error('Ein Award ist in einer anderen Gruppe. Bitte diese Gruppierung erst lösen.');
              }
              if(orphaned.length) {
                await reflowAwardPositions(currentImage,meta.awards,anchor);
                members=[...members,...orphaned];
              }
            }
            // Existing awards already move with their Miro group. Never
            // reposition these frame children just to change circle count.
            if (meta?.badgeIds) {
              const stale = new Set(meta.badgeIds);
              for (const badge of await getItemsByIds([...stale])) await removeItem(badge);
              members = members.filter(x=>!stale.has(x.id));
            }
            const readyMembers=[...members,...await getItemsByIds(badges)];
            const group=await regroup(readyMembers);
            if(group)selectedGroupIds.push(group.id);
            const nextMeta={
              version:1, level, count:cardCount, badgeIds:badges,
              awards:Array.isArray(meta?.awards) ? meta.awards : [],
            };
            await setMetadata(currentImage,CARD_KEY,nextMeta);
            await placeOwnOverlays(currentImage,nextMeta,readyMembers);
          } catch(error) {
            // If still ungrouped, discard only our new circles before the recovery group.
            const live = await getItemsByIds(badges);
            if(live.every(item=>!item.groupId)) {
              for(const badge of live) {
                try { await removeItem(badge); }catch(cleanupError) {console.warn('Circle cleanup failed',cleanupError);}
              }
            }
            throw error;
          }
        };
        if(meta) await withReleasedCard(image,perform);
        else await perform([image]);
        updated++;
      }
      await restoreCardSelection(selectedGroupIds);
      progress(cards.length, cards.length);
      return {updated, unchanged, total:cards.length};
    });
  }

  async function repairSelected(progress=()=>{}) {
    return checkAndRepairSelected(progress);
  }

  async function resetSelected(count,progress=()=>{},providedCards=null) {
    const cards=providedCards || await selectedCards({allowNew:false});
    if(!cards.length)throw new Error('Bitte vorbereitete Karten auswählen.');
    count=clamp(Number(count)||6,2,10);
    // Preflight every card before changing any board object.
    for(const {image,meta} of cards) {
      const members=await safeManagedMembers(image,meta);
      await requireCanvasItems(members,'Reset');
    }
    return withMutation(async()=>{
      await putConfig({levelCount:count});
      const groupIds=[];
      let reset=0;
      for(const {image,meta} of cards) {
        const anchor=await absolutePosition(image);
        const badgeIds=await createCircles(image,count,0,anchor);
        let committed=false;
        try {
          const group=await withReleasedCard(image,async()=>{
            const current=await getById(image.id);
            const newBadges=await getItemsByIds(badgeIds);
            const readyMembers=[current,...newBadges];
            const created=await regroup(readyMembers);
            const nextMeta={version:1,level:0,count,badgeIds,awards:[]};
            await setMetadata(current,CARD_KEY,nextMeta);
            await placeOwnOverlays(current,nextMeta,readyMembers);
            committed=true;
            return created;
          });
          if(group)groupIds.push(group.id);
          // Remove only elements created by this app for this avatar.
          for(const old of await getItemsByIds([...(meta.badgeIds||[]),...(meta.awards||[]).map(a=>a.itemId)])) {
            if(old.id===image.id)continue;
            const ownCircle=old.type==='shape' && (await readCircle(old))?.cardId===image.id;
            const ownAward=old.type==='image' && (await readAward(old))?.cardId===image.id;
            if(ownCircle || ownAward) {
              try {await removeItem(old);}catch(err){console.warn('Could not remove stale reset item',old.id,err);}
            }
          }
          reset++;
        } catch(error) {
          if(!committed) {
            for(const item of await getItemsByIds(badgeIds)) {
              if(!item.groupId)try{await removeItem(item);}catch(err){console.warn('Reset cleanup failed',err);}
            }
          }
          throw error;
        }
        progress(reset,cards.length);
      }
      await restoreCardSelection(groupIds);
      return {reset,total:cards.length,count};
    });
  }

  async function arrangeSelectedGrid(columns=4,progress=()=>{}) {
    const cards=await selectedCards({allowNew:false});
    if(cards.length<2)throw new Error('Bitte mindestens zwei vorbereitete Karten auswählen.');
    columns=clamp(Math.round(Number(columns)||4),2,8);
    const snapshots=[];
    for(const {image,meta} of cards) {
      const members=await safeManagedMembers(image,meta);
      const expected=expectedMemberIds(image,meta);
      if(expected.size!==members.length || members.some(item=>!expected.has(item.id))) {
        throw new Error('Eine Kartengruppe ist unvollständig. Bitte zuerst Repair ausführen.');
      }
      await requireCanvasItems(members,'Grid');
      const anchor=await absolutePosition(image);
      const positions=new Map();
      for(const item of members)positions.set(item.id,await absolutePosition(item));
      snapshots.push({image,meta,members,anchor,positions});
    }
    // First cluster approximately horizontal rows, then sort left to right.
    const maxW=Math.max(...snapshots.map(c=>Number(c.image.width)));
    const maxH=Math.max(...snapshots.map(c=>Number(c.image.height)));
    const rowBands=[];
    for(const card of [...snapshots].sort((a,b)=>a.anchor.y-b.anchor.y)) {
      const band=rowBands.find(row=>Math.abs(row.y-card.anchor.y)<=maxH*.35);
      if(band){band.cards.push(card);band.y=(band.y*(band.cards.length-1)+card.anchor.y)/band.cards.length;}
      else rowBands.push({y:card.anchor.y,cards:[card]});
    }
    const ordered=rowBands.flatMap(band=>band.cards.sort((a,b)=>a.anchor.x-b.anchor.x));
    const startX=Math.min(...snapshots.map(c=>c.anchor.x));
    const startY=Math.min(...snapshots.map(c=>c.anchor.y));
    const stepX=maxW*1.18,stepY=maxH*1.12;
    return withMutation(async()=>{
      const groupIds=[];
      let moved=0;
      for(let i=0;i<ordered.length;i++) {
        const card=ordered[i];
        const target={x:startX+(i%columns)*stepX,y:startY+Math.floor(i/columns)*stepY};
        const dx=target.x-card.anchor.x,dy=target.y-card.anchor.y;
        if(Math.abs(dx)<.01 && Math.abs(dy)<.01) {
          if(card.image.groupId)groupIds.push(card.image.groupId);
          progress(i+1,ordered.length);
          continue;
        }
        const group=await withReleasedCard(card.image,async()=>{
          try {
            for(const [id,origin] of card.positions) {
              await moveCanvasItem({id},{x:origin.x+dx,y:origin.y+dy});
            }
            const movedMembers=await getItemsByIds([...card.positions.keys()]);
            return regroup(movedMembers);
          } catch(error) {
            // Restore board coordinates before withReleasedCard regroups members.
            for(const [id,origin] of card.positions) {
              try{await moveCanvasItem({id},origin);}catch(restoreErr){console.error('Grid position rollback failed',id,restoreErr);}
            }
            throw error;
          }
        });
        if(group)groupIds.push(group.id);
        moved++;
        progress(i+1,ordered.length);
      }
      await restoreCardSelection(groupIds);
      return {moved,total:ordered.length,columns};
    });
  }

  async function normalizeLayers(images,progress=()=>{},mode='front') {
    if(!board.bringToFront)return {updated:0,total:images.length};
    // Sort from back to front by avatar, never by the most recently created circle.
    // Each image + its badges + its awards is then a contiguous visual block.
    const ordered=[];
    for(const image of uniqueById(images)) {
      const live=await getById(image.id);
      const meta=await readCard(live);
      if(!meta)continue;
      let layer=ordered.length;
      if(board.getLayerIndex)layer=await getLayerIndex(live);
      ordered.push({image:live,meta,layer});
    }
    ordered.sort((a,b)=>a.layer-b.layer);
    let updated=0;
    for(const {image,meta} of ordered) {
      const members=await safeManagedMembers(image,meta);
      const index=new Map(members.map(item=>[item.id,item]));
      if(mode==='front' || !board.bringInFrontOf)await bringToFront(index.get(image.id)||image);
      const circles=(meta.badgeIds||[]).map(id=>index.get(id)).filter(Boolean);
      if(circles.length) {
        if(mode==='relative' && board.bringInFrontOf) {
          await sdkCall(()=>board.bringInFrontOf(circles,index.get(image.id)||image));
        } else await bringToFront(circles);
      }
      const awards=(meta.awards||[]).map(a=>index.get(a.itemId)).filter(Boolean);
      if(awards.length) {
        if(mode==='relative' && board.bringInFrontOf) {
          await sdkCall(()=>board.bringInFrontOf(awards,circles.at(-1)||image));
        } else await bringToFront(awards);
      }
      updated++;
      progress(updated,ordered.length);
    }
    return {updated,total:ordered.length};
  }

  async function layersSelected(progress=()=>{}) {
    if(!board.bringToFront)throw new Error('Diese Miro-Version unterstützt die Ebenen-Funktion nicht.');
    const cards=await selectedCards({allowNew:false});
    if(!cards.length)throw new Error('Bitte vorbereitete Karten auswählen.');
    return withMutation(()=>normalizeLayers(cards.map(x=>x.image),progress));
  }

  async function auditCard(image,meta) {
    const issues=[];
    const expected=expectedMemberIds(image,meta);
    const members=await groupMembers(image);
    const grouped=new Set(members.map(item=>item.id));
    if(!image.groupId || members.some(item=>!expected.has(item.id)))issues.push('Gruppe');
    const anchor=await absolutePosition(image);
    const count=clamp(Number(meta.count)||6,2,10);
    if(!Array.isArray(meta.badgeIds) || meta.badgeIds.length!==count)issues.push('Kreisanzahl');
    const slots=await circleLayout(image,count,anchor);
    const badges=await getItemsByIds(meta.badgeIds||[]);
    for(let i=0;i<count;i++) {
      const badge=badges.find(item=>item.id===meta.badgeIds?.[i]);
      if(!badge || badge.type!=='shape' || !grouped.has(badge.id)) {issues.push('Kreise');continue;}
      const tag=await readCircle(badge);
      if(tag?.cardId!==image.id || tag?.index!==i+1)issues.push('Kreis-Metadaten');
      const pos=await absolutePosition(badge);
      if(Math.abs(pos.x-slots[i].x)>1 || Math.abs(pos.y-slots[i].y)>1)issues.push('Kreispositionen');
      const style=levelStyle(i+1,meta.level,badge.width);
      if(badge.style?.fillColor!==style.fillColor || badge.style?.color!==style.color)issues.push('Kreisfarben');
    }
    const awards=Array.isArray(meta.awards)?meta.awards:[];
    for(let i=0;i<awards.length;i++) {
      const icon=(await getItemsByIds([awards[i].itemId]))[0];
      if(!icon || icon.type!=='image' || !grouped.has(icon.id)){issues.push('Awards');continue;}
      const tag=await readAward(icon);
      if(tag?.cardId!==image.id || tag?.id!==awards[i].id)issues.push('Award-Metadaten');
      const pos=await absolutePosition(icon);
      const expectedPos=await awardPosition(image,i,anchor);
      if(Math.abs(pos.x-expectedPos.x)>1 || Math.abs(pos.y-expectedPos.y)>1)issues.push('Award-Positionen');
    }
    return {healthy:issues.length===0,issues:[...new Set(issues)],anchor,count};
  }

  async function checkAndRepairSelected(progress=()=>{}) {
    const cards=await selectedCards({allowNew:false});
    if(!cards.length)throw new Error('Bitte vorbereitete Karten auswählen.');
    return withMutation(async()=>{
      let updated=0,healthy=0,awardsRepaired=0;
      const groupIds=[];
      for(let i=0;i<cards.length;i++) {
        const image=await getById(cards[i].image.id);
        const meta=await readCard(image);
        if(!meta)throw new Error('Kartenmetadaten fehlen. Bitte zuerst die Karte vorbereiten.');
        await safeManagedMembers(image,meta);
        const audit=await auditCard(image,meta);
        if(audit.healthy) {
          healthy++;
          if(image.groupId)groupIds.push(image.groupId);
          progress(i+1,cards.length);
          continue;
        }
        const originalGroupId=image.groupId;
        const existingAwards=[];
        for(const aw of meta.awards||[]) {
          const icon=(await getItemsByIds([aw.itemId]))[0];
          if(icon?.groupId && icon.groupId!==originalGroupId) {
            throw new Error('Ein Award ist in einer anderen Gruppe. Bitte diese Gruppierung erst lösen.');
          }
          existingAwards.push(icon);
        }
        const badgeIds=await createCircles(image,audit.count,clamp(Number(meta.level)||0,0,audit.count),audit.anchor);
        const createdAwards=[],awardOrigins=[];
        let committed=false;
        try {
          const group=await withReleasedCard(image,async()=>{
            const current=await getById(image.id);
            const awards=[];
            try {
              for(let j=0;j<(meta.awards||[]).length;j++) {
                const previous=meta.awards[j];
                const definition=AWARDS.find(a=>a.id===previous.id);
                if(!definition)throw new Error('Unbekannter Award: '+previous.id);
                const target=await awardPosition(current,j,audit.anchor);
                let icon=existingAwards[j];
                if(icon) {
                  const origin=await absolutePosition(icon);
                  if(Math.abs(origin.x-target.x)>1 || Math.abs(origin.y-target.y)>1) {
                    awardOrigins.push({id:icon.id,pos:origin});
                    icon=await moveCanvasItem(icon,target);
                    awardsRepaired++;
                  }
                } else {
                  icon=await sdkCall(()=>board.createImage({title:`Award: ${definition.name}`,url:awardAssetUrl(definition),x:target.x,y:target.y,width:target.size}),500);
                  createdAwards.push(icon);
                  awardsRepaired++;
                }
                await setMetadata(icon,AWARD_KEY,{cardId:current.id,id:previous.id});
                awards.push({id:previous.id,itemId:icon.id});
              }
              const allIcons=await getItemsByIds(awards.map(a=>a.itemId));
              const readyMembers=[current,...await getItemsByIds(badgeIds),...allIcons];
              const group=await regroup(readyMembers);
              const nextMeta={version:1,count:audit.count,level:clamp(Number(meta.level)||0,0,audit.count),badgeIds,awards};
              await setMetadata(current,CARD_KEY,nextMeta);
              await placeOwnOverlays(current,nextMeta,readyMembers);
              committed=true;
              return group;
            } catch(error) {
              for(const old of awardOrigins) {
                try{await moveCanvasItem({id:old.id},old.pos);}catch(restoreErr){console.error('Award rollback failed',old.id,restoreErr);}
              }
              throw error;
            }
          });
          if(group)groupIds.push(group.id);
          // Only delete circles with the correct original card ownership.
          for(const old of await getItemsByIds(meta.badgeIds||[])) {
            if(old.type==='shape' && (await readCircle(old))?.cardId===image.id) {
              try{await removeItem(old);}catch(err){console.warn('Old circle cleanup failed',err);}
            }
          }
          updated++;
        } catch(error) {
          if(!committed) {
            for(const item of await getItemsByIds([...badgeIds,...createdAwards.map(a=>a.id)])) {
              if(!item.groupId)try{await removeItem(item);}catch(err){console.warn('Repair cleanup failed',err);}
            }
          }
          throw error;
        }
        progress(i+1,cards.length);
      }
      await restoreCardSelection(groupIds);
      return {updated,healthy,total:cards.length,awardsRepaired};
    });
  }

  async function setLevel(image, requested) {
    const meta = await readCard(image);
    if (!meta) return false;
    const level = clamp(Number(requested) || 0,0,meta.count);
    if (level === meta.level) return false;
    for (const [i,id] of meta.badgeIds.entries()) {
      const index=i+1;
      if ((index<=meta.level)===(index<=level)) continue;
      let shape;
      try {shape=await getById(id);} catch (err) {if(isRateLimit(err))throw err;continue;}
      if (shape.type !== 'shape') continue;
      const style=levelStyle(index,level,shape.width);
      shape.style.fillColor=style.fillColor;
      shape.style.color=style.color;
      await syncItem(shape);
    }
    await setMetadata(image,CARD_KEY,{...meta,level});
    return true;
  }

  async function setSelectedLevel(level, progress=()=>{}) {
    const cards=await selectedCards({allowNew:false});
    if (!cards.length) throw new Error('Zuerst Karten initialisieren und auswählen.');
    return withMutation(async()=>{
      let updated=0;
      for (let i=0;i<cards.length;i++) {
        if(await setLevel(cards[i].image,level)) updated++;
        progress(i+1,cards.length);
      }
      return {updated,total:cards.length};
    });
  }

  async function assignSelectedZone(level) {
    const selection=await getSelection();
    if(selection.length!==1 || !['shape','frame'].includes(selection[0].type)) {
      throw new Error('Bitte genau ein Level-Feld auswählen (Shape oder Frame).');
    }
    const item=selection[0];
    if (item.type==='shape' && await getMetadata(item,CIRCLE_KEY)) {
      throw new Error('Bitte ein Level-Feld auswählen, keinen Kreis auf einer Karte.');
    }
    const cfg=await getConfig();
    level=clamp(Number(level)||1,1,cfg.levelCount);
    const zones={...cfg.zones,[item.id]:level};
    await putConfig({zones});
    return {id:item.id,level,type:item.type};
  }

  async function unassignSelectedZone() {
    const selection=await getSelection();
    if(selection.length!==1 || !selection[0]?.id) throw new Error('Bitte ein Level-Feld auswählen.');
    const cfg=await getConfig();
    if (!Object.hasOwn(cfg.zones,selection[0].id)) return false;
    const zones={...cfg.zones};
    delete zones[selection[0].id];
    await putConfig({zones});
    return true;
  }

  async function absolutePosition(item) {
    const x=Number(item.x), y=Number(item.y);
    if(!Number.isFinite(x)||!Number.isFinite(y)) {
      throw new Error('Kartica nema pouzdane koordinate. Operacija je zaustavljena.');
    }
    if(!item.parentId || item.parentId==='null') return {x,y};
    let parent;
    try {parent=await getById(item.parentId);} catch (err) {if(isRateLimit(err))throw err;return {x,y};}
    if(parent?.type!=='frame' || item.relativeTo!=='parent_top_left') return {x,y};
    const result={x:parent.x-parent.width/2+x,y:parent.y-parent.height/2+y};
    if(!Number.isFinite(result.x)||!Number.isFinite(result.y)) {
      throw new Error('Frame nema pouzdane koordinate. Operacija je zaustavljena.');
    }
    return result;
  }

  async function loadZones(config) {
    const found=[];
    for(const [id,level] of Object.entries(config.zones)) {
      let zone;
      try {zone=await getById(id);} catch (err) {if(isRateLimit(err))throw err;continue;}
      if(!zone || !['shape','frame'].includes(zone.type)) continue;
      const pos=await absolutePosition(zone);
      const width=Number(zone.width),height=Number(zone.height);
      if (!(width>0 && height>0)) continue;
      found.push({id,level:Number(level),zone,x:pos.x,y:pos.y,width,height,area:width*height});
    }
    return found;
  }

  async function detectedLevel(image,zones) {
    // A card nested in a mapped frame belongs to that frame, even when the frame moves.
    const parent=zones.find(z=>z.zone.type==='frame' && z.id===image.parentId);
    if(parent) return parent.level;
    const {x,y}=await absolutePosition(image);
    const matches=zones.filter(z=>Math.abs(x-z.x)<=z.width/2 && Math.abs(y-z.y)<=z.height/2);
    if(!matches.length) return null; // Outside all zones: retain the previous level.
    matches.sort((a,b)=>a.area-b.area);
    return matches[0].level;
  }

  async function syncSelectedLevels(progress=()=>{}) {
    // Explicit command: never scan the entire board; inspect selected cards.
    const cards=await selectedCards({allowNew:false});
    if(!cards.length)throw new Error('Bitte vorbereitete Karten auswählen.');
    const zones=await loadZones(await getConfig());
    return withMutation(async()=>{
      let updated=0;
      for(let i=0;i<cards.length;i++) {
        const target=await detectedLevel(cards[i].image,zones);
        if(target!==null && await setLevel(cards[i].image,target))updated++;
        progress(i+1,cards.length);
      }
      return {updated,total:cards.length,zones:zones.length};
    });
  }

  async function awardPosition(image, slot, anchor) {
    const position = anchor || await absolutePosition(image);
    const size=image.width*.175;
    // Fill the rightmost column vertically, top to bottom. Wrap after six.
    const row=slot%6,column=Math.floor(slot/6);
    return {
      x:position.x + image.width*(.37-column*.19),
      y:position.y - image.height*(.40-row*.12),
      size,
    };
  }

  async function reflowAwardPositions(image, awards, anchor) {
    for (let i=0;i<awards.length;i++) {
      let icon;
      try { icon=await getById(awards[i].itemId); } catch (err) { if(isRateLimit(err))throw err;continue; }
      if (icon?.type!=='image') continue;
      const pos=await awardPosition(image,i,anchor);
      if (icon.parentId && icon.parentId !== 'null') {
        const parent=await getById(icon.parentId);
        if (parent?.type !== 'frame') {
          throw new Error('Award je dete nepodržanog elementa. Pomeri ga iz kontejnera pre uređivanja.');
        }
        // Miro can reject an image sync even if the requested position is
        // expressed in frame-local coordinates. Detach unconditionally BEFORE
        // changing x/y. This runs only via the explicit realign action.
        await sdkCall(()=>parent.remove(icon));
        icon=await getById(icon.id);
        if (icon.parentId && icon.parentId !== 'null') {
          throw new Error('Miro nije uspeo da odvoji award od prethodnog Framea.');
        }
      }
      icon.x=pos.x; icon.y=pos.y;
      await syncItem(icon);
    }
  }

  async function modifyAwardForCard(image,slug,remove) {
    const meta=await readCard(image);
    if(!meta) throw new Error('Bitte zuerst die Karte initialisieren.');
    const awards=Array.isArray(meta.awards) ? [...meta.awards] : [];
    const existing=awards.find(x=>x.id===slug);
    if(remove ? !existing : !!existing) return false;
    const anchor=await absolutePosition(image);
    return withReleasedCard(image,async members=>{
      const currentImage=await liveImage(image,members);
      let addedIcon;
      try {
        if(remove) {
          awards.splice(awards.indexOf(existing),1);
        } else {
          const award=AWARDS.find(a=>a.id===slug);
          if(!award) throw new Error('Unbekannter Award.');
          const p=await awardPosition(currentImage,awards.length,anchor);
          const icon=await sdkCall(()=>board.createImage({title:`Award: ${award.name}`,url:awardAssetUrl(award),x:p.x,y:p.y,width:p.size}),500);
          addedIcon=icon;
          await setMetadata(icon,AWARD_KEY,{cardId:currentImage.id,id:slug});
          awards.push({id:slug,itemId:icon.id});
          members.push(icon);
        }
        // Adding/removing awards must not move existing awards. Miro sometimes
        // keeps their old Frame ownership after dragging a group between zones.
        // Moving them here caused the entire card to be left ungrouped.
        if(remove) {
          for(const img of await getItemsByIds([existing.itemId])) await removeItem(img);
          members=members.filter(x=>x.id!==existing.itemId);
        }
        const group=await regroup(members);
        const nextMeta={...meta,awards};
        await setMetadata(currentImage,CARD_KEY,nextMeta);
        await placeOwnOverlays(currentImage,nextMeta,members);
        return group?.id || currentImage.groupId || null;
      } catch(error) {
        if(addedIcon) {
          try {
            const live=await getById(addedIcon.id);
            if(!live.groupId) await removeItem(live);
          } catch(cleanupError) {console.warn('Award cleanup failed',cleanupError);}
        }
        throw error;
      }
    });
  }

  async function rearrangeSelectedAwards(progress=()=>{}) {
    const cards=await selectedCards({allowNew:false});
    if(!cards.length) throw new Error('Bitte vorbereitete Avatar-Karten auswählen.');
    return withMutation(async()=>{
      let updated=0;
      const selectedGroupIds=[];
      for(let i=0;i<cards.length;i++) {
        const {image}=cards[i];
        const meta=await readCard(image);
        if(meta?.awards?.length) {
          const anchor=await absolutePosition(image);
          const group=await withReleasedCard(image,async members=>{
            const currentImage=await liveImage(image,members);
            await reflowAwardPositions(currentImage,meta.awards,anchor);
            const group=await regroup(members);
            await placeOwnOverlays(currentImage,meta,members);
            return group;
          });
          if(group)selectedGroupIds.push(group.id);
          updated++;
        } else if(image.groupId) selectedGroupIds.push(image.groupId);
        progress(i+1,cards.length);
      }
      await restoreCardSelection(selectedGroupIds);
      return {updated,total:cards.length};
    });
  }

  async function changeAward(slug,remove=false,progress=()=>{}) {
    if(!AWARDS.some(x=>x.id===slug)) throw new Error('Unbekannter Award.');
    const cards=await selectedCards({allowNew:false});
    if(!cards.length) throw new Error('Bitte initialisierte Karten auswählen.');
    return withMutation(async()=>{
      let changed=0;
      const selectedGroupIds=[];
      for(let i=0;i<cards.length;i++) {
        const updatedGroup=await modifyAwardForCard(cards[i].image,slug,remove);
        if(updatedGroup) changed++;
        selectedGroupIds.push(updatedGroup || cards[i].image.groupId);
        progress(i+1,cards.length);
      }
      await restoreCardSelection(selectedGroupIds);
      return {changed,total:cards.length};
    });
  }

  return {
    getConfig,putConfig,selectionInfo,selectedCards,initializeSelected,repairSelected,
    resetSelected,arrangeSelectedGrid,layersSelected,checkAndRepairSelected,
    setSelectedLevel,assignSelectedZone,unassignSelectedZone,syncSelectedLevels,changeAward,rearrangeSelectedAwards,
    setStatusHandler:fn=>{statusHandler=typeof fn==='function'?fn:()=>{};},
  };
}
