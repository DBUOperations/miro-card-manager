import {AWARDS, awardAssetUrl} from './awards.js';

const CARD_KEY = 'dbu_cm_card_v1';
const CIRCLE_KEY = 'dbu_cm_circle_v1';
const AWARD_KEY = 'dbu_cm_award_v1';
const YELLOW = '#FFEC00';
const MUTED = '#514663';
const INK = '#201833';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const uniqueById = values => [...new Map(values.filter(Boolean).map(x => [x.id, x])).values()];

export function makeManager(board, options={}) {
  if (!board?.getSelection || !board?.group) {
    throw new Error('Miro SDK nije dostupan. Otvori aplikaciju u Miro boardu.');
  }
  let statusHandler=()=>{};
  const sleep=options.sleep || (ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const creditHistory=[];
  // Local per-panel budget. Zero SDK calls happen without a deliberate command.
  const CREDIT_MINUTE=options.creditMinute??85000;
  const CREDIT_HOUR=options.creditHour??850000;
  const isRateLimit=err=>/rate.?limit|too many requests|credits? (?:per|limit|exceeded)|429/i.test(String(err?.message||err));
  // The Miro SDK reports an ID removed by Cut/Paste as
  // "Can not retrieve item with id ...", not just "not found". Its
  // old metadata reference must never make the entire operation fail.
  const isMissingItem=err=>/not found|\b404\b|deleted|does not exist|can(?:not| not|'t) retrieve item (?:with|by) id|cannot get item with id/i.test(String(err?.message||err));
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
  // Miro charges ten times more credits for image.sync than shape.sync.
  const syncItem=item=>sdkCall(()=>item.sync(),item?.type==='image'||item?.type==='embed'?500:50);
  const bringToFront=items=>sdkCall(()=>board.bringToFront(items));
  const getMembers=group=>sdkCall(()=>group.getItems());
  const removeItem=item=>sdkCall(()=>board.remove(item));
  const getLayerIndex=item=>sdkCall(()=>board.getLayerIndex(item));

  let activeMutation=false;
  async function withMutation(action) {
    // No background polling, storage queries or timers. Only button actions
    // enter this short-lived in-panel guard.
    if(activeMutation)throw new Error('Eine Karten-Aktion läuft bereits. Bitte warten.');
    activeMutation=true;
    try{return await action();}
    finally{activeMutation=false;}
  }

  async function readCard(image) {
    return getMetadata(image,CARD_KEY);
  }

  async function readAward(image) {
    return getMetadata(image,AWARD_KEY);
  }

  async function readCircle(shape) {
    return getMetadata(shape,CIRCLE_KEY);
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
    // Preserve the existing six-circle layout exactly. For 7-10 levels,
    // keep the badge HEIGHT unchanged and fit rounded rectangles across
    // the card; no tiny or illegible circles.
    const compact = n > 6;
    const gap = w * (compact ? .012 : .023);
    const height = w * .105;
    const width = compact
      ? Math.min(height,(w * .94 - (n-1)*gap)/n)
      : Math.min(height,(w * .86-(n-1)*gap)/n);
    const position = anchor || await absolutePosition(image);
    const start = position.x-(n*width+(n-1)*gap)/2+width/2;
    const y = position.y + h * (277 / 295 - .5);
    return Array.from({length:n}, (_,i)=>({
      x:start+i*(width+gap),y,width,height,
      shape:compact && n>7?'round_rectangle':'circle',index:i+1,
    }));
  }

  function levelStyle(index, level, width, height=width) {
    const active = index <= level;
    return {
      fillColor: active ? YELLOW : MUTED,
      color: active ? INK : '#FFFFFF',
      borderWidth: 0,
      fontFamily: 'arial',
      fontSize: Math.max(7,Math.min(height*.53,width/(index>=10?1.45:1.1))),
      textAlign: 'center',
      textAlignVertical: 'middle',
    };
  }

  async function createCircles(image, count, level, anchor) {
    const ids = [];
    try {
      for (const slot of await circleLayout(image, count, anchor)) {
        const badge = await sdkCall(()=>board.createShape({
          content: `<p>${slot.index}</p>`, shape:slot.shape,
          x:slot.x, y:slot.y, width:slot.width, height:slot.height,
          style:levelStyle(slot.index, level, slot.width, slot.height),
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
      if(!id)continue;
      try { found.push(await getById(id)); }
      catch (err) {
        if(!isMissingItem(err))throw err;
        // A missing element can be reconstructed by explicit Repair.
      }
    }
    return uniqueById(found);
  }

  async function groupMembers(image) {
    if(!image.groupId) return [image];
    const group=await getById(image.groupId);
    return group?.type==='group' ? getMembers(group) : [image];
  }

  // Every command uses the CURRENT Miro item IDs as the source of truth.
  // Miro copies item metadata when duplicating a group, including stale IDs.
  // Never use those copied IDs to delete or update another card's objects.
  const isAvatarImage=item=>item?.type==='image' &&
    !String(item.title||'').startsWith('Award: ') &&
    Number(item.width)>0 && Number(item.height)>0 &&
    Math.abs(item.width/item.height-170/295)<=.12;
  const badgeIndex=item=>{
    const match=String(item?.content||'').replace(/<[^>]*>/g,'').trim().match(/^(10|[1-9])$/);
    return match ? Number(match[1]) : 0;
  };
  async function inspectCard(image, originalMeta) {
    const meta=originalMeta===undefined ? await readCard(image) : originalMeta;
    const members=await groupMembers(image);
    const groupIds=new Set(members.map(item=>item.id));
    if(members.filter(isAvatarImage).length>1) {
      throw new Error('Mehrere Avatar-Karten sind zusammen gruppiert. Bitte die Karten zuerst einzeln gruppieren.');
    }
    const anchor=await absolutePosition(image);
    const badges=[], awards=[], foreign=[];
    const badgeIds=new Set(),awardIds=new Set();
    const addBadge=(item,index)=>{
      if(!badgeIds.has(item.id)){badges.push({item,index});badgeIds.add(item.id);}
    };
    const addAward=(item,id)=>{
      if(!awardIds.has(item.id)){awards.push({item,id});awardIds.add(item.id);}
    };
    for(const item of members) {
      if(item.id===image.id)continue;
      if(item.type==='shape') {
        const tag=await readCircle(item);
        const index=Number(tag?.index)||badgeIndex(item);
        const position=await absolutePosition(item);
        const looksLikeBadge=badgeIndex(item)>0 &&
          Math.abs(position.y-(anchor.y+image.height*(277/295-.5)))<image.height*.07 &&
          Number(item.width)<=image.width*.22 && Number(item.height)<=image.width*.22;
        if(index>=1 && index<=10 && (tag || looksLikeBadge))addBadge(item,index);
        else foreign.push(item);
      } else if(item.type==='image') {
        const tag=await readAward(item);
        const definition=AWARDS.find(a=>a.id===tag?.id ||
          String(item.title||'')===`Award: ${a.name}`);
        if(definition)addAward(item,definition.id);
        else foreign.push(item);
      } else foreign.push(item);
    }
    if(foreign.length) {
      throw new Error(`Diese Kartengruppe enthält ${foreign.length} fremde Elemente. Bitte diese Elemente separat gruppieren; sie werden nicht automatisch gelöscht.`);
    }
    // Recover manager-owned objects from an interrupted ungroup. References
    // copied from another avatar are ignored even when those IDs still exist.
    for(const id of meta?.badgeIds||[]) {
      if(!id || badgeIds.has(id))continue;
      const [item]=await getItemsByIds([id]);
      if(item?.type==='shape' && !item.groupId &&
        (await readCircle(item))?.cardId===image.id) {
        addBadge(item,Number((await readCircle(item)).index)||badgeIndex(item));
      }
    }
    for(const entry of meta?.awards||[]) {
      if(!entry?.itemId || awardIds.has(entry.itemId))continue;
      const [item]=await getItemsByIds([entry.itemId]);
      if(item?.type==='image' && !item.groupId &&
        (await readAward(item))?.cardId===image.id) {
        addAward(item,entry.id);
      }
    }
    const localBadgeIds=new Set(badges.map(x=>x.item.id));
    const localAwardIds=new Set(awards.map(x=>x.item.id));
    const claimedBadges=meta?.badgeIds||[];
    const claimedAwards=meta?.awards||[];
    const referencesLocal=!!meta && claimedBadges.every(id=>localBadgeIds.has(id)) &&
      claimedAwards.every(a=>localAwardIds.has(a.itemId));
    const localClaimed=claimedBadges.filter(id=>localBadgeIds.has(id)).length;
    // One deleted circle must not make a genuine card look like a clone.
    const copied=!!meta && claimedBadges.length>0 &&
      localClaimed===0 && badges.length>0;
    // A pasted bare SVG can inherit metadata from the old image. It is new.
    const effectiveMeta=meta && (badges.length || awards.length || referencesLocal)
      ? meta : undefined;
    const count=clamp(Number(effectiveMeta?.count)||Math.max(6,...badges.map(b=>b.index)),2,10);
    const level=clamp(Number(effectiveMeta?.level)||0,0,count);
    const badgeSlots=new Map();
    for(const badge of badges) {
      if(!badgeSlots.has(badge.index))badgeSlots.set(badge.index,[]);
      badgeSlots.get(badge.index).push(badge.item);
    }
    const orderedBadges=Array.from({length:count},(_,i)=>badgeSlots.get(i+1)?.[0]?.id||null);
    const awardSlugs=awards.map(a=>a.id);
    const uniqueAwards=new Set(awardSlugs).size===awards.length;
    const expected=new Set([image.id,...claimedBadges,...claimedAwards.map(x=>x.itemId)]);
    const healthy=!!effectiveMeta && !copied && !!image.groupId &&
      claimedBadges.length===count && orderedBadges.every((id,i)=>id===claimedBadges[i]) &&
      badges.length===count && awards.length===claimedAwards.length && uniqueAwards &&
      members.every(item=>expected.has(item.id));
    return {image,meta:effectiveMeta,members,badges,awards,anchor,
      count,level,copied,healthy,groupIds,badgeSlots};
  }

  // An interrupted older version can leave tagged circles or awards outside
  // the Miro group. This deep scan runs ONLY after a button click, never on
  // board moves, selection changes, startup or a background timer.
  async function attachNearbyOrphans(states) {
    const byOwner=new Map(states.map(state=>[state.image.id,state]));
    const scan=async(type,key,add)=>{
      const all=await sdkCall(()=>board.get({type}),500);
      for(const item of all) {
        if(item.groupId)continue; // Never steal another group's objects.
        // Most board items are not anywhere near the selected avatars. Use
        // free local geometry first, before spending an SDK metadata read.
        const pos=await absolutePosition(item);
        const candidates=states.filter(state=>
          Math.abs(pos.x-state.anchor.x)<=state.image.width*.7 &&
          Math.abs(pos.y-state.anchor.y)<=state.image.height*.6);
        if(!candidates.length)continue;
        const tag=await getMetadata(item,key);
        const state=byOwner.get(tag?.cardId);
        if(!state || !candidates.includes(state))continue;
        add(state,item,tag);
      }
    };
    await scan('shape',CIRCLE_KEY,(state,item,tag)=>{
      if(!state.badges.some(b=>b.item.id===item.id)) {
        const index=Number(tag.index)||badgeIndex(item);
        if(index>=1 && index<=10) {
          state.badges.push({item,index});
          state.healthy=false;
        }
      }
    });
    await scan('image',AWARD_KEY,(state,item,tag)=>{
      if(AWARDS.some(a=>a.id===tag.id) && !state.awards.some(a=>a.item.id===item.id)) {
        state.awards.push({item,id:tag.id});
        state.healthy=false;
      }
    });
  }

  async function rebuildCard(image,state,count,level,restoreMissingAwards=false) {
    count=clamp(Number(count)||6,2,10);
    level=clamp(Number(level)||0,0,count);
    const oldBadges=state.badges.map(b=>b.item);
    const oldAwards=state.awards.map(a=>a.item);
    const awardNames=new Set();
    const awards=state.awards.filter(a=>{
      if(awardNames.has(a.id))return false;
      awardNames.add(a.id);
      return true;
    });
    // Recreate a genuinely deleted award on its original card only. Do not
    // import an award belonging to the source of a copied avatar.
    const missing=restoreMissingAwards && !state.copied
      ? (state.meta?.awards||[]).filter(entry=>!awards.some(a=>a.id===entry.id)) : [];
    const createdAwardIds=[];
    let badgeIds=[];
    try {
      badgeIds=await createCircles(image,count,level,state.anchor);
      for(const entry of missing) {
        const definition=AWARDS.find(a=>a.id===entry.id);
        if(!definition)continue;
        const p=await awardPosition(image,awards.length,state.anchor);
        const item=await sdkCall(()=>board.createImage({
          title:`Award: ${definition.name}`,url:awardAssetUrl(definition),
          x:p.x,y:p.y,width:p.size,
        }),500);
        createdAwardIds.push(item.id);
        awards.push({item,id:definition.id});
      }
      const perform=async()=>{
        const live=await getById(image.id);
        let savedAwards=await getItemsByIds(awards.map(a=>a.item.id));
        if(restoreMissingAwards) {
          for(let i=0;i<awards.length;i++) {
            const icon=savedAwards.find(x=>x.id===awards[i].item.id);
            if(!icon)continue;
            const target=await awardPosition(live,i,state.anchor);
            const pos=await absolutePosition(icon);
            if(Math.abs(pos.x-target.x)>1 || Math.abs(pos.y-target.y)>1) {
              await moveCanvasItem(icon,target);
            }
          }
          savedAwards=await getItemsByIds(awards.map(a=>a.item.id));
        }
        for(const award of awards) {
          const local=savedAwards.find(x=>x.id===award.item.id);
          if(local)await setMetadata(local,AWARD_KEY,{cardId:image.id,id:award.id});
        }
        const ready=[live,...await getItemsByIds(badgeIds),...savedAwards];
        const group=await regroup(ready);
        const nextMeta={version:1,level,count,badgeIds,
          awards:awards.map(a=>({id:a.id,itemId:a.item.id}))};
        await setMetadata(live,CARD_KEY,nextMeta);
        try{await placeOwnOverlays(live,nextMeta,ready);}
        catch(err){console.warn('Non-critical overlay ordering failed',err);}
        return {group,meta:nextMeta};
      };
      const result=image.groupId ? await withReleasedCard(image,perform) : await perform();
      // Delete only the circles physically associated with this card.
      // Never follow an inherited metadata ID to the source avatar.
      for(const old of oldBadges) {
        const [live]=await getItemsByIds([old.id]);
        if(live && !live.groupId)await removeItem(live);
      }
      // A duplicated award with the same slug is never retained twice.
      const retained=new Set(awards.map(a=>a.item.id));
      for(const old of oldAwards)if(!retained.has(old.id)){
        const [live]=await getItemsByIds([old.id]);
        if(live && !live.groupId)await removeItem(live);
      }
      return result;
    } catch(error) {
      for(const id of [...badgeIds,...createdAwardIds]) {
        const [item]=await getItemsByIds([id]);
        if(item && !item.groupId) {
          try{await removeItem(item);}catch(cleanup){console.warn('Rebuild cleanup failed',cleanup);}
        }
      }
      throw error;
    }
  }

  async function ensurePrepared(image, progress=()=>{}) {
    const live=await getById(image.id);
    const state=await inspectCard(live);
    if(state.healthy)return {image:live,meta:state.meta,updated:false};
    const result=await rebuildCard(live,state,state.count,state.level,true);
    return {image:await getById(image.id),meta:result.meta,updated:true,
      groupId:result.group?.id};
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
    const cards = providedCards || await selectedCards({allowNew:true});
    if (!cards.length) throw new Error('Bitte zuerst eine oder mehrere Avatar-Karten auswählen.');
    count = clamp(Number(count) || 6, 2, 10);
    return withMutation(async () => {
      let updated=0, unchanged=0;
      const selectedGroupIds=[];
      // Resolve the complete selection first. A foreign/manual group aborts
      // before the first card on the board is changed.
      const states=[];
      for(const card of cards) {
        const live=await getById(card.image.id);
        states.push(await inspectCard(live));
      }
      await attachNearbyOrphans(states);
      for (let i=0;i<cards.length;i++) {
        const state=states[i],image=state.image;
        progress(i, cards.length);
        const cardCount = repair ? state.count : count;
        let layoutOutdated=false;
        if(!repair && state.healthy && cardCount>6 && state.count===cardCount) {
          // Upgrade cards prepared by older releases only when the user
          // explicitly clicks 'Level-Zahlen hinzufügen'.
          const first=await getItemsByIds(state.meta.badgeIds.slice(0,1));
          const slots=await circleLayout(image,cardCount,state.anchor);
          layoutOutdated=!first.length || first[0].shape!==slots[0].shape ||
            Math.abs(first[0].width-slots[0].width)>0.5 ||
            Math.abs(first[0].height-slots[0].height)>0.5;
        }
        if (!repair && !layoutOutdated && state.healthy && state.count===cardCount) {
          unchanged++;
          if(image.groupId)selectedGroupIds.push(image.groupId);
          continue;
        }
        const level=clamp(state.level,0,cardCount);
        const result=await rebuildCard(image,state,cardCount,level,repair);
        if(result.group)selectedGroupIds.push(result.group.id);
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
    const cards=providedCards || await selectedCards({allowNew:true});
    if(!cards.length)throw new Error('Bitte Avatar-Karten auswählen.');
    // A full reset leaves only the SVG image, including no manager metadata.
    // Preflight all groups first to avoid touching unrelated manual content.
    const states=[];
    for(const card of cards) {
      const state=await inspectCard(await getById(card.image.id));
      await requireCanvasItems(state.members,'Reset');
      states.push(state);
    }
    await attachNearbyOrphans(states);
    return withMutation(async()=>{
      const imageIds=[];
      let reset=0;
      for(const state of states) {
        const image=state.image;
        if(image.groupId)await releaseCardGroup(image);
        // The original image is NEVER removed or resized.
        const toRemove=uniqueById([...state.badges.map(b=>b.item),
          ...state.awards.map(a=>a.item)]);
        for(const item of toRemove) {
          const [live]=await getItemsByIds([item.id]);
          if(live && !live.groupId)await removeItem(live);
        }
        await setMetadata(await getById(image.id),CARD_KEY,null);
        imageIds.push(image.id);
        reset++;
        progress(reset,cards.length);
      }
      await restoreCardSelection(imageIds);
      return {reset,total:cards.length,count:0};
    });
  }

  async function arrangeSelectedGrid(columns=4,progress=()=>{}) {
    const cards=await selectedCards({allowNew:true});
    if(cards.length<2)throw new Error('Bitte mindestens zwei vorbereitete Karten auswählen.');
    columns=clamp(Math.round(Number(columns)||4),2,8);
    const snapshots=[];
    const states=[];
    for(const card of cards) {
      const state=await inspectCard(await getById(card.image.id));
      await requireCanvasItems(state.members,'Grid');
      states.push(state);
    }
    for(const state of states) {
      const prepared=state.healthy ?
        {image:state.image,meta:state.meta} :
        await ensurePrepared(state.image);
      const {image,meta}=prepared;
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
    const cards=await selectedCards({allowNew:true});
    if(!cards.length)throw new Error('Bitte vorbereitete Karten auswählen.');
    const states=[];
    for(const card of cards)states.push(await inspectCard(await getById(card.image.id)));
    await attachNearbyOrphans(states);
    const images=[];
    for(const state of states) {
      const prepared=state.healthy ?
        {image:state.image,meta:state.meta} :
        await ensurePrepared(state.image);
      images.push(prepared.image);
    }
    return withMutation(()=>normalizeLayers(images,progress));
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
      if(badge.shape!==slots[i].shape || Math.abs(badge.width-slots[i].width)>0.5 ||
        Math.abs(badge.height-slots[i].height)>0.5)issues.push('Kreisgrößen');
      const style=levelStyle(i+1,meta.level,badge.width,badge.height);
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
    const cards=await selectedCards({allowNew:true});
    if(!cards.length)throw new Error('Bitte Avatar-Karten auswählen.');
    const states=[];
    for(const card of cards)states.push(await inspectCard(await getById(card.image.id)));
    await attachNearbyOrphans(states);
    return withMutation(async()=>{
      let updated=0,healthy=0,awardsRepaired=0;
      const groupIds=[];
      for(let i=0;i<states.length;i++) {
        const state=states[i];
        const audit=state.healthy ? await auditCard(state.image,state.meta) : {healthy:false};
        if(audit.healthy) {
          healthy++;
          if(state.image.groupId)groupIds.push(state.image.groupId);
        } else {
          const result=await rebuildCard(state.image,state,state.count,state.level,true);
          if(result.group)groupIds.push(result.group.id);
          updated++;
          awardsRepaired+=Math.max(0,(result.meta.awards||[]).length-state.awards.length);
        }
        progress(i+1,states.length);
      }
      await restoreCardSelection(groupIds);
      return {updated,healthy,total:cards.length,awardsRepaired};
    });
  }

  async function setLevel(image, requested, providedMeta) {
    const meta = providedMeta || await readCard(image);
    if (!meta) return false;
    const level = clamp(Number(requested) || 0,0,meta.count);
    if (level === meta.level) return false;
    const targets=[];
    for (const [i,id] of meta.badgeIds.entries()) {
      const index=i+1;
      if ((index<=meta.level)===(index<=level)) continue;
      let shape;
      try {shape=await getById(id);} catch(err) {
        if(isRateLimit(err))throw err;
        throw new Error(`Level-Zahl ${index} fehlt. Bitte zuerst Repair ausführen.`);
      }
      if (shape.type !== 'shape')throw new Error(`Level-Zahl ${index} ist beschädigt. Bitte zuerst Repair ausführen.`);
      targets.push({shape,index});
    }
    // All required badges exist before the first color write.
    for(const {shape,index} of targets) {
      const style=levelStyle(index,level,shape.width,shape.height);
      shape.style.fillColor=style.fillColor;
      shape.style.color=style.color;
      await syncItem(shape);
    }
    await setMetadata(image,CARD_KEY,{...meta,level});
    return true;
  }

  async function setSelectedLevel(level, progress=()=>{}) {
    const cards=await selectedCards({allowNew:true});
    if (!cards.length) throw new Error('Zuerst Karten initialisieren und auswählen.');
    const requested=Math.round(Number(level));
    if(!Number.isInteger(requested) || requested<1 || requested>10)throw new Error('Bitte einen Level von 1 bis 10 auswählen.');
    const states=[];
    for(const card of cards)states.push(await inspectCard(await getById(card.image.id)));
    if(states.some(state=>state.count<requested)) {
      throw new Error(`Level ${requested} ist nicht auf allen ausgewählten Karten vorbereitet. Bitte zuerst "Level-Zahlen hinzufügen" klicken.`);
    }
    return withMutation(async()=>{
      let updated=0;
      const groupIds=[];
      for (let i=0;i<states.length;i++) {
        try {
          const state=states[i];
          const prepared=state.healthy ?
            {image:state.image,meta:state.meta} :
            await ensurePrepared(state.image);
          if(await setLevel(prepared.image,requested,prepared.meta))updated++;
          const live=await getById(prepared.image.id);
          if(live.groupId)groupIds.push(live.groupId);
        } catch(error) {
          throw new Error(`Level ${requested}: ${updated} von ${cards.length} Karten aktualisiert, danach Fehler: ${error.message}`);
        }
        progress(i+1,cards.length);
      }
      await restoreCardSelection(groupIds);
      return {updated,total:cards.length};
    });
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
    if(!remove && awards.length>=4)return false;
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
        try{await placeOwnOverlays(currentImage,nextMeta,members);}
        catch(err){console.warn('Non-critical overlay ordering failed',err);}
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
    const cards=await selectedCards({allowNew:true});
    if(!cards.length) throw new Error('Bitte vorbereitete Avatar-Karten auswählen.');
    const states=[];
    for(const card of cards)states.push(await inspectCard(await getById(card.image.id)));
    return withMutation(async()=>{
      let updated=0;
      const selectedGroupIds=[];
      for(let i=0;i<cards.length;i++) {
        const state=states[i];
        if(!state.awards.length && !state.meta) {
          progress(i+1,cards.length);
          continue;
        }
        const prepared=state.healthy ?
          {image:state.image,meta:state.meta} :
          await ensurePrepared(state.image);
        const {image,meta}=prepared;
        if(meta?.awards?.length) {
          const anchor=await absolutePosition(image);
          const group=await withReleasedCard(image,async members=>{
            const currentImage=await liveImage(image,members);
            await reflowAwardPositions(currentImage,meta.awards,anchor);
            const group=await regroup(members);
            try{await placeOwnOverlays(currentImage,meta,members);}
            catch(err){console.warn('Non-critical overlay ordering failed',err);}
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
    const cards=await selectedCards({allowNew:true});
    if(!cards.length) throw new Error('Bitte initialisierte Karten auswählen.');
    const states=[];
    for(const card of cards)states.push(await inspectCard(await getById(card.image.id)));
    return withMutation(async()=>{
      let changed=0,skippedLimit=0;
      const selectedGroupIds=[];
      for(let i=0;i<cards.length;i++) {
        const state=states[i];
        if(!remove && state.awards.length>=4 &&
          !state.awards.some(award=>award.id===slug)) {
          skippedLimit++;
          if(state.image.groupId)selectedGroupIds.push(state.image.groupId);
          progress(i+1,cards.length);
          continue;
        }
        let updatedGroup;
        try {
          if(remove && !state.meta && !state.awards.length) {
            progress(i+1,cards.length);
            continue;
          }
          const prepared=state.healthy ?
            {image:state.image,meta:state.meta} :
            await ensurePrepared(state.image);
          updatedGroup=await modifyAwardForCard(prepared.image,slug,remove);
        } catch(error) {
          if(changed)await restoreCardSelection(selectedGroupIds);
          throw new Error(`${changed} von ${cards.length} Karten aktualisiert, danach Fehler: ${error.message}`);
        }
        if(updatedGroup) changed++;
        const live=await getById(state.image.id);
        selectedGroupIds.push(updatedGroup || live.groupId);
        progress(i+1,cards.length);
      }
      if(changed)await restoreCardSelection(selectedGroupIds);
      return {changed,total:cards.length,skippedLimit};
    });
  }

  return {
    version:'1.9.1',selectionInfo,selectedCards,initializeSelected,repairSelected,
    resetSelected,arrangeSelectedGrid,layersSelected,checkAndRepairSelected,
    setSelectedLevel,changeAward,rearrangeSelectedAwards,
    setStatusHandler:fn=>{statusHandler=typeof fn==='function'?fn:()=>{};},
  };
}
