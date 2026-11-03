import {AWARDS, awardAssetUrl} from './awards.js?v=1.9.3';

const CARD_KEY = 'dbu_cm_card_v1';
const CIRCLE_KEY = 'dbu_cm_circle_v1';
const AWARD_KEY = 'dbu_cm_award_v1';
const YELLOW = '#FFEC00';
const MUTED = '#514663';
const INK = '#201833';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const uniqueById = values => [...new Map(values.filter(Boolean).map(x => [x.id, x])).values()];

export function makeManager(board) {
  if (!board?.getSelection || !board?.group) {
    throw new Error('Miro SDK nije dostupan. Otvori aplikaciju u Miro boardu.');
  }
  let statusHandler=()=>{};
  let usageHandler=()=>{};
  let usageScope=false;
  let context=null;
  const usage={lastAction:0,sessionTotal:0,calls:0,failedCalls:0,failedCredits:0};
  const isRateLimit=err=>err?.code==='MIRO_RATE_LIMIT' || err?.status===429 ||
    err?.statusCode===429 || /rate.?limit|too many requests|credits? (?:per|limit|exceeded)|429/i.test(String(err?.message||err));
  // The Miro SDK reports an ID removed by Cut/Paste as
  // "Can not retrieve item with id ...", not just "not found". Its
  // old metadata reference must never make the entire operation fail.
  const isMissingItem=err=>/not found|\b404\b|deleted|does not exist|can(?:not| not|'t) retrieve item (?:with|by) id|cannot get item with id/i.test(String(err?.message||err));
  async function sdkCall(operation,cost=50) {
    // Count attempted calls, including rejected attempts and immediate recovery.
    // This is a conservative local estimate, never a remaining Miro balance.
    usage.lastAction+=cost;usage.sessionTotal+=cost;usage.calls++;
    try {return remember(await operation());}
    catch(err) {
      usage.failedCalls++;usage.failedCredits+=cost;
      if(!isRateLimit(err))throw err;
      const hourly=/hour|stunde/i.test(String(err.message||err));
      const error=new Error(`Miro API-Limit erreicht (${hourly?'Stunde':'Minute / Sitzung'}). Aktion gestoppt; kein automatischer Neuversuch. Bitte später manuell erneut versuchen. Bei unvollständigen Karten danach Repair verwenden.`,{cause:err});
      error.code='MIRO_RATE_LIMIT';
      statusHandler(error.message);
      throw error;
    } finally {
      try{usageHandler({...usage});}catch(err){console.warn('Usage display failed',err);}
    }
  }
  function remember(value) {
    if(context)for(const item of Array.isArray(value)?value:[value]) {
      if(item?.id && item?.type)context.items.set(item.id,item);
    }
    return value;
  }
  function invalidateStructure() {
    if(!context)return;
    context.items.clear();context.groups.clear();context.missing.clear();
    context.structureChanged=true;
  }
  function beginAction() {
    if(usageScope)throw new Error('Eine Karten-Aktion läuft bereits. Bitte warten.');
    usageScope=true;usage.lastAction=0;
  }
  function endAction() {
    usageScope=false;
    try{usageHandler({...usage});}catch(err){console.warn('Usage display failed',err);}
  }
  const command=fn=>async(...args)=>{
    if(context)throw new Error('Eine Karten-Aktion läuft bereits. Bitte warten.');
    const ownsUsage=!usageScope;
    if(ownsUsage)beginAction();
    // Never reuse SDK objects or metadata between commands. Moves, duplicates,
    // external edits and Cut/Paste are observed afresh on the next click.
    context={items:new Map(),groups:new Map(),metadata:new Map(),missing:new Set(),structureChanged:false};
    try{return await fn(...args);}
    finally{context=null;if(ownsUsage)endAction();}
  };
  const getById=async id=>{
    if(context?.items.has(id))return context.items.get(id);
    if(context?.missing.has(id))throw new Error(`Can not retrieve item with id ${id}`);
    try{return await sdkCall(()=>board.getById(id));}
    catch(err){if(isMissingItem(err))context?.missing.add(id);throw err;}
  };
  const getSelection=()=>sdkCall(()=>board.getSelection(),500);
  const getMetadata=async(item,key)=>{
    const id=`${item.id}:${key}`;
    if(context?.metadata.has(id))return context.metadata.get(id);
    const value=await sdkCall(()=>item.getMetadata(key));
    context?.metadata.set(id,value);
    return value;
  };
  const setMetadata=async(item,key,value)=>{
    const id=`${item.id}:${key}`;
    if(context?.metadata.has(id) && JSON.stringify(context.metadata.get(id))===JSON.stringify(value))return;
    await sdkCall(()=>item.setMetadata(key,value));
    context?.metadata.set(id,value);
  };
  // Miro charges ten times more credits for image.sync than shape.sync.
  const syncItem=item=>sdkCall(()=>item.sync(),item?.type==='image'||item?.type==='embed'?500:50);
  const bringToFront=items=>sdkCall(()=>board.bringToFront(items));
  const getMembers=async group=>{
    if(context?.groups.has(group.id))return context.groups.get(group.id);
    const members=await sdkCall(()=>group.getItems());
    context?.groups.set(group.id,members);
    return members;
  };
  const removeItem=async item=>{
    await sdkCall(()=>board.remove(item));
    invalidateStructure();
  };
  const getLayerIndex=item=>sdkCall(()=>item.getLayerIndex ? item.getLayerIndex() : board.getLayerIndex(item));

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

  async function createCircles(image, count, level, anchor, onlySlots=null) {
    const ids = [];
    try {
      for (const slot of onlySlots || await circleLayout(image, count, anchor)) {
        const badge = await sdkCall(()=>board.createShape({
          content: `<p>${slot.index}</p>`, shape:slot.shape,
          x:slot.x, y:slot.y, width:slot.width, height:slot.height,
          style:levelStyle(slot.index, level, slot.width, slot.height),
        }));
        ids.push(badge.id);
        await setMetadata(badge,CIRCLE_KEY, {cardId:image.id, index:slot.index});
      }
    } catch(error) {
      for (const id of ids) {
        try {
          const [badge]=await getItemsByIds([id]);
          if(badge)await removeItem(badge);
        } catch(cleanupError) {console.warn('Circle cleanup failed',cleanupError);if(isRateLimit(cleanupError))break;}
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
    // Fast path: prove that ALL referenced IDs are the actual, current members
    // of this one group. Inherited IDs cannot pass this check after duplication.
    // Type/content checks also catch missing, extra and duplicate indicators.
    // Detailed Repair still audits each child's ownership metadata and geometry.
    if(meta?.version===1 && image.groupId && Number.isInteger(meta.count) &&
      meta.count>=2 && meta.count<=10 && Number.isInteger(meta.level) &&
      meta.level>=0 && meta.level<=meta.count && Array.isArray(meta.badgeIds) &&
      Array.isArray(meta.awards) && meta.badgeIds.length===meta.count && meta.awards.length<=4) {
      const expected=expectedMemberIds(image,meta);
      const index=new Map(members.map(item=>[item.id,item]));
      const badges=meta.badgeIds.map((id,i)=>({item:index.get(id),index:i+1}));
      const awards=meta.awards.map(a=>({item:index.get(a.itemId),id:a.id}));
      if(expected.size===1+meta.count+meta.awards.length && members.length===expected.size &&
        members.every(item=>expected.has(item.id) && item.groupId===image.groupId) &&
        badges.every(b=>b.item?.type==='shape' && badgeIndex(b.item)===b.index) &&
        new Set(awards.map(a=>a.id)).size===awards.length && awards.every(a=>
          a.item?.type==='image' && AWARDS.some(def=>def.id===a.id && a.item.title===`Award: ${def.name}`))) {
        return {image,meta,members,badges,awards,anchor,count:meta.count,level:meta.level,
          copied:false,healthy:true,groupIds,
          badgeSlots:new Map(badges.map(b=>[b.index,[b.item]]))};
      }
    }
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
      badges.every(b=>badgeIndex(b.item)===b.index) &&
      claimedAwards.every(entry=>awards.some(a=>a.id===entry.id && a.item.id===entry.itemId)) &&
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
    const slots=await circleLayout(image,count,state.anchor);
    // Keep every valid existing badge. Create only missing/broken sizes or
    // shapes; rebind copied tags without replacing correct physical objects.
    const retainedBadges=slots.map(slot=>state.badges.find(b=>
      b.index===slot.index && badgeIndex(b.item)===slot.index && b.item.type==='shape' &&
      b.item.shape===slot.shape && Math.abs(b.item.width-slot.width)<=.5 &&
      Math.abs(b.item.height-slot.height)<=.5)?.item);
    const missingSlots=slots.filter((_,i)=>!retainedBadges[i]);
    let createdBadgeIds=[];
    let badgeIds=[];
    try {
      createdBadgeIds=await createCircles(image,count,level,state.anchor,missingSlots);
      let nextCreated=0;
      badgeIds=slots.map((_,i)=>retainedBadges[i]?.id || createdBadgeIds[nextCreated++]);
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
      const readyIds=new Set([image.id,...badgeIds,...awards.map(a=>a.item.id)]);
      const sameMembers=!!image.groupId && state.members.length===readyIds.size &&
        state.members.every(item=>readyIds.has(item.id));
      let moveNeeded=false;
      for(let i=0;i<retainedBadges.length;i++)if(retainedBadges[i]) {
        const pos=await absolutePosition(retainedBadges[i]);
        if(Math.abs(pos.x-slots[i].x)>1 || Math.abs(pos.y-slots[i].y)>1)moveNeeded=true;
      }
      if(restoreMissingAwards)for(let i=0;i<awards.length;i++) {
        const pos=await absolutePosition(awards[i].item),target=await awardPosition(image,i,state.anchor);
        if(Math.abs(pos.x-target.x)>1 || Math.abs(pos.y-target.y)>1)moveNeeded=true;
      }
      const keepGroup=sameMembers && !moveNeeded;
      const perform=async()=>{
        const live=await getById(image.id);
        for(let i=0;i<badgeIds.length;i++) {
          let badge=await getById(badgeIds[i]);
          const position=await absolutePosition(badge);
          if(Math.abs(position.x-slots[i].x)>1 || Math.abs(position.y-slots[i].y)>1) {
            badge=await moveCanvasItem(badge,slots[i]);
          }
          const style=levelStyle(i+1,level,badge.width,badge.height);
          if(badge.style?.fillColor!==style.fillColor || badge.style?.color!==style.color) {
            const previous={...badge.style};
            badge.style={...badge.style,fillColor:style.fillColor,color:style.color};
            try{await syncItem(badge);}catch(err){badge.style=previous;throw err;}
          }
          const tag=await readCircle(badge);
          if(tag?.cardId!==image.id || tag?.index!==i+1) {
            await setMetadata(badge,CIRCLE_KEY,{cardId:image.id,index:i+1});
          }
        }
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
          if(local) {
            const tag=await readAward(local);
            if(tag?.cardId!==image.id || tag?.id!==award.id)await setMetadata(local,AWARD_KEY,{cardId:image.id,id:award.id});
          }
        }
        const ready=[live,...await getItemsByIds(badgeIds),...savedAwards];
        const group=keepGroup ? await getById(image.groupId) : await regroup(ready);
        const nextMeta={version:1,level,count,badgeIds,
          awards:awards.map(a=>({id:a.id,itemId:a.item.id}))};
        await setMetadata(live,CARD_KEY,nextMeta);
        try{await placeOwnOverlays(live,nextMeta,ready);}
        catch(err){if(isRateLimit(err))throw err;console.warn('Non-critical overlay ordering failed',err);}
        return {group,meta:nextMeta};
      };
      const result=image.groupId && !keepGroup ? await withReleasedCard(image,perform) : await perform();
      // Delete only the circles physically associated with this card.
      // Never follow an inherited metadata ID to the source avatar.
      for(const old of oldBadges) {
        if(badgeIds.includes(old.id))continue;
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
      for(const id of [...createdBadgeIds,...createdAwardIds]) {
        try {
          const [item]=await getItemsByIds([id]);
          if(item && !item.groupId)await removeItem(item);
        } catch(cleanup){console.warn('Rebuild cleanup failed',cleanup);if(isRateLimit(cleanup))break;}
      }
      throw error;
    }
  }

  async function ensurePrepared(image, providedState=null) {
    const live=await getById(image.id);
    const state=providedState || await inspectCard(live);
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
      invalidateStructure();
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
    const released=await sdkCall(()=>group.ungroup());
    invalidateStructure();
    // Do not cache released objects: Miro may change their coordinate reference.
    return released;
  }

  async function liveImage(image, ungroupedMembers) {
    // After a moved group is ungrouped, old SDK image objects can still carry
    // pre-move coordinates. Fetch the released image again before laying out items.
    try { return await getById(image.id); }
    catch (err) { if(!isMissingItem(err))throw err;return ungroupedMembers.find(x => x.id === image.id) || image; }
  }

  async function regroup(members) {
    const items = uniqueById(members);
    if (items.length < 2) return null;
    const group=await sdkCall(()=>board.group({items}));
    invalidateStructure();
    return group;
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
        error.message+=' Die Gruppe konnte nicht vollständig wiederhergestellt werden. Bitte später die Karte und ihre Elemente auswählen und Repair ausführen.';
      }
      throw error;
    }
  }

  async function restoreCardSelection(groupIds) {
    // Color-only and no-op commands keep the existing Miro selection intact.
    if(!context?.structureChanged)return;
    const ids=[...new Set(groupIds.filter(Boolean))];
    if(!ids.length || !board.select || !board.deselect) return;
    try {
      await sdkCall(()=>board.deselect());
      await sdkCall(()=>board.select({id:ids}));
    } catch(err) {
      // A selection failure must never undo or invalidate successfully created cards.
      if(isRateLimit(err))throw err;
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
      const suspect=states.filter(state=>!state.healthy);
      if(suspect.length)await attachNearbyOrphans(suspect);
      for (let i=0;i<cards.length;i++) {
        const state=states[i],image=state.image;
        progress(i, cards.length);
        const cardCount = repair ? state.count : count;
        let layoutOutdated=false;
        if(!repair && state.healthy && state.count===cardCount) {
          // Upgrade cards prepared by older releases only when the user
          // explicitly clicks 'Level-Zahlen hinzufügen'.
          const slots=await circleLayout(image,cardCount,state.anchor);
          layoutOutdated=state.badges.some(({item,index})=>
            item.shape!==slots[index-1].shape ||
            Math.abs(item.width-slots[index-1].width)>.5 ||
            Math.abs(item.height-slots[index-1].height)>.5);
        }
        const audited=repair && state.healthy ? await auditCard(image,state.meta) : null;
        if (!layoutOutdated && state.healthy && state.count===cardCount && (!repair || audited?.healthy)) {
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
        await withReleasedCard(image,async()=>{
          // The original image is NEVER removed or resized.
          const toRemove=uniqueById([...state.badges.map(b=>b.item),
            ...state.awards.map(a=>a.item)]);
          for(const item of toRemove) {
            const [live]=await getItemsByIds([item.id]);
            if(live && !live.groupId)await removeItem(live);
          }
          if(await readCard(await getById(image.id)))await setMetadata(await getById(image.id),CARD_KEY,null);
        });
        imageIds.push(image.id);
        reset++;
        progress(reset,cards.length);
      }
      await restoreCardSelection(imageIds);
      return {reset,total:cards.length,count:0};
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
      if(live.getLayerIndex || board.getLayerIndex)layer=await getLayerIndex(live);
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
        await ensurePrepared(state.image,state);
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
      if(badgeIndex(badge)!==i+1)issues.push('Kreisnummern');
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
    const targets=[];
    for (const [i,id] of meta.badgeIds.entries()) {
      const index=i+1;
      let shape;
      try {shape=await getById(id);} catch(err) {
        if(!isMissingItem(err))throw err;
        throw new Error(`Level-Zahl ${index} fehlt. Bitte zuerst Repair ausführen.`);
      }
      if (shape.type !== 'shape')throw new Error(`Level-Zahl ${index} ist beschädigt. Bitte zuerst Repair ausführen.`);
      const style=levelStyle(index,level,shape.width,shape.height);
      if(shape.style?.fillColor!==style.fillColor || shape.style?.color!==style.color)targets.push({shape,style});
    }
    // All required badges exist before the first color write.
    for(const {shape,style} of targets) {
      const previous={...shape.style};
      shape.style={...previous,fillColor:style.fillColor,color:style.color};
      try{await syncItem(shape);}catch(err){shape.style=previous;throw err;}
    }
    if(level!==meta.level)await setMetadata(image,CARD_KEY,{...meta,level});
    return targets.length>0 || level!==meta.level;
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
            await ensurePrepared(state.image,state);
          if(await setLevel(prepared.image,requested,prepared.meta) || prepared.updated)updated++;
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

  // Level 0 is deliberately not offered as a numbered level. This explicit
  // command restores ALL existing indicators to gray without deleting them
  // or touching the card's award images.
  async function resetSelectedLevels(progress=()=>{}) {
    const cards=await selectedCards({allowNew:true});
    if(!cards.length)throw new Error('Bitte Avatar-Karten auswählen.');
    const states=[];
    for(const card of cards)states.push(await inspectCard(await getById(card.image.id)));
    return withMutation(async()=>{
      let updated=0;
      const selectedIds=[];
      for(let i=0;i<states.length;i++) {
        const state=states[i],image=state.image;
        if(!state.meta && !state.badges.length) {
          if(image.groupId)selectedIds.push(image.groupId);
          progress(i+1,states.length);
          continue; // A brand-new avatar has nothing to reset.
        }
        if(!state.healthy) {
          // Copied/Cut-Pasted cards can contain inherited item IDs. Normalize
          // only their circles; do NOT resurrect deleted award icons.
          const result=await rebuildCard(image,state,state.count,0,false);
          selectedIds.push(result.group?.id||image.id);
          updated++;
        } else {
          const changed=await setLevel(image,0,state.meta);
          if(changed)updated++;
          if(image.groupId)selectedIds.push(image.groupId);
        }
        progress(i+1,states.length);
      }
      await restoreCardSelection(selectedIds);
      return {updated,total:states.length};
    });
  }

  // Remove only the awards physically belonging to the selected avatars.
  // Inherited metadata IDs on copied cards are NEVER used as delete targets.
  async function resetSelectedAwards(progress=()=>{},providedCards=null) {
    const cards=providedCards || await selectedCards({allowNew:true});
    if(!cards.length)throw new Error('Bitte Avatar-Karten auswählen.');
    const states=[];
    for(const card of cards) {
      const state=await inspectCard(await getById(card.image.id));
      await requireCanvasItems(state.members,'Awards Reset');
      states.push(state);
    }
    await attachNearbyOrphans(states);
    return withMutation(async()=>{
      let updated=0,removed=0;
      const selectedIds=[];
      for(let i=0;i<states.length;i++) {
        const state=states[i],image=state.image;
        if(!state.awards.length && !(state.meta?.awards||[]).length) {
          if(image.groupId)selectedIds.push(image.groupId);
          progress(i+1,states.length);
          continue;
        }
        const deletedIds=new Set(state.awards.map(a=>a.item.id));
        const newId=await withReleasedCard(image,async members=>{
          const live=await liveImage(image,members);
          for(const award of state.awards) {
            const [icon]=await getItemsByIds([award.item.id]);
            if(icon && !icon.groupId) {
              await removeItem(icon);
              removed++;
            }
          }
          const survivors=members.filter(item=>!deletedIds.has(item.id));
          const group=await regroup(survivors);
          // Rebind badge IDs to this exact card, not to a copied source.
          const badgeIds=Array.from({length:state.count},(_,slot)=>
            state.badges.find(b=>b.index===slot+1)?.item.id).filter(Boolean);
          // Copied circles must become owned by this copy while retaining their
          // IDs, positions, numbers and colors during an Awards-only reset.
          if(state.copied)for(const badge of state.badges) {
            await setMetadata(await getById(badge.item.id),CIRCLE_KEY,{cardId:image.id,index:badge.index});
          }
          const nextMeta=(state.meta || state.badges.length) ? {
            ...state.meta,version:1,count:state.count,level:state.level,
            badgeIds,awards:[],
          } : null;
          await setMetadata(live,CARD_KEY,nextMeta);
          return group?.id||live.id;
        });
        selectedIds.push(newId);
        updated++;
        progress(i+1,states.length);
      }
      await restoreCardSelection(selectedIds);
      return {updated,removed,total:states.length};
    });
  }

  async function absolutePosition(item) {
    const x=Number(item.x), y=Number(item.y);
    if(!Number.isFinite(x)||!Number.isFinite(y)) {
      throw new Error('Kartica nema pouzdane koordinate. Operacija je zaustavljena.');
    }
    if(!item.parentId || item.parentId==='null') return {x,y};
    let parent;
    try {parent=await getById(item.parentId);} catch (err) {if(!isMissingItem(err))throw err;return {x,y};}
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
      try { icon=await getById(awards[i].itemId); } catch (err) { if(!isMissingItem(err))throw err;continue; }
      if (icon?.type!=='image') continue;
      const pos=await awardPosition(image,i,anchor);
      const current=await absolutePosition(icon);
      if(Math.abs(current.x-pos.x)<=1 && Math.abs(current.y-pos.y)<=1)continue;
      if (icon.parentId && icon.parentId !== 'null') {
        const parent=await getById(icon.parentId);
        if (parent?.type !== 'frame') {
          throw new Error('Award je dete nepodržanog elementa. Pomeri ga iz kontejnera pre uređivanja.');
        }
        // Miro can reject an image sync even if the requested position is
        // expressed in frame-local coordinates. Detach unconditionally BEFORE
        // changing x/y. This runs only via the explicit realign action.
        await sdkCall(()=>parent.remove(icon));
        invalidateStructure();
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
        catch(err){if(isRateLimit(err))throw err;console.warn('Non-critical overlay ordering failed',err);}
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
          await ensurePrepared(state.image,state);
        const {image,meta}=prepared;
        if(meta?.awards?.length) {
          const anchor=await absolutePosition(image);
          const misplaced=[];
          for(let slot=0;slot<meta.awards.length;slot++) {
            const icon=await getById(meta.awards[slot].itemId);
            const actual=await absolutePosition(icon);
            const target=await awardPosition(image,slot,anchor);
            if(Math.abs(actual.x-target.x)>1 || Math.abs(actual.y-target.y)>1)misplaced.push(icon.id);
          }
          if(!misplaced.length) {
            if(image.groupId)selectedGroupIds.push(image.groupId);
            if(prepared.updated)updated++;
            progress(i+1,cards.length);
            continue;
          }
          const group=await withReleasedCard(image,async members=>{
            const currentImage=await liveImage(image,members);
            await reflowAwardPositions(currentImage,meta.awards,anchor);
            const group=await regroup(members);
            try{await placeOwnOverlays(currentImage,meta,members);}
            catch(err){if(isRateLimit(err))throw err;console.warn('Non-critical overlay ordering failed',err);}
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
            await ensurePrepared(state.image,state);
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
    version:'1.9.3',
    ...Object.fromEntries(Object.entries({selectionInfo,selectedCards,initializeSelected,repairSelected,
      resetSelected,layersSelected,checkAndRepairSelected,setSelectedLevel,resetSelectedLevels,
      changeAward,resetSelectedAwards,rearrangeSelectedAwards}).map(([name,fn])=>[name,command(fn)])),
    beginAction,endAction,getUsage:()=>({...usage}),
    setUsageHandler:fn=>{usageHandler=typeof fn==='function'?fn:()=>{};},
    setStatusHandler:fn=>{statusHandler=typeof fn==='function'?fn:()=>{};},
  };
}
