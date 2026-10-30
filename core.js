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

export function makeManager(board) {
  if (!board?.getSelection || !board?.group || !board?.storage?.collection) {
    throw new Error('Miro SDK nije dostupan. Otvori aplikaciju u Miro boardu.');
  }
  const collection = board.storage.collection(STORE);

  async function getConfig() {
    const saved = await collection.get(CONFIG_KEY) || {};
    return {
      levelCount: clamp(Number(saved.levelCount) || 6, 2, 10),
      zones: saved.zones && typeof saved.zones === 'object' ? {...saved.zones} : {},
      auto: !!saved.auto,
      pauseUntil: Number(saved.pauseUntil) || 0,
    };
  }

  async function putConfig(changes) {
    const next = {...await getConfig(), ...changes};
    await collection.set(CONFIG_KEY, next);
    return next;
  }

  async function withMutation(action) {
    await putConfig({pauseUntil: Date.now() + 10 * 60_000});
    try { return await action(); }
    finally { await putConfig({pauseUntil: 0}); }
  }

  async function readCard(image) {
    try { return await image.getMetadata(CARD_KEY); }
    catch (_) { return undefined; }
  }

  async function readAward(image) {
    try { return await image.getMetadata(AWARD_KEY); }
    catch (_) { return undefined; }
  }

  async function resolveImage(image, allowNew) {
    if (await readAward(image)) return undefined;
    const existing = await readCard(image);
    if (existing?.version === 1) return {image, meta:existing};
    if (!allowNew || !image.width || !image.height) return undefined;
    // A pasted avatar is 170:295. Ignore square award images and other board artwork.
    const ratio = image.width / image.height;
    if (Math.abs(ratio - 170 / 295) > 0.12) return undefined;
    return {image, meta:undefined};
  }

  async function selectedCards({allowNew = true} = {}) {
    const selected = await board.getSelection();
    const found = [];
    for (const item of selected) {
      const members = item.type === 'group' && item.getItems ? await item.getItems() : [item];
      for (const member of members) {
        if (member.type !== 'image') continue;
        const match = await resolveImage(member, allowNew);
        if (match) found.push(match);
      }
    }
    return uniqueById(found.map(x=>x.image)).map(image => found.find(x=>x.image.id===image.id));
  }

  async function allCards() {
    const images = await board.get({type:'image'});
    const groups = await board.get({type:'group'});
    const candidates = [...images];
    for (const group of groups) {
      for (const item of await group.getItems()) if (item.type === 'image') candidates.push(item);
    }
    const results = [];
    for (const img of uniqueById(candidates)) {
      const card = await resolveImage(img, false);
      if (card) results.push(card);
    }
    return results;
  }

  async function selectionInfo() {
    const items = await board.getSelection();
    return {
      total: items.length,
      cards: (await selectedCards()).length,
      zones: items.filter(x => x.type === 'shape' || x.type === 'frame').length,
    };
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
        const badge = await board.createShape({
          content: `<p>${slot.index}</p>`, shape:'circle',
          x:slot.x, y:slot.y, width:slot.diameter, height:slot.diameter,
          style:levelStyle(slot.index, level, slot.diameter),
        });
        ids.push(badge.id);
        await badge.setMetadata(CIRCLE_KEY, {cardId:image.id, index:slot.index});
      }
    } catch(error) {
      for (const badge of await getItemsByIds(ids)) {
        try { await board.remove(badge); } catch(cleanupError) {console.warn('Circle cleanup failed',cleanupError);}
      }
      throw error;
    }
    return ids;
  }

  async function getItemsByIds(ids) {
    const found = [];
    for (const id of ids) {
      try { found.push(await board.getById(id)); } catch (_) { /* removed manually */ }
    }
    return uniqueById(found);
  }

  async function releaseCardGroup(image) {
    if (!image.groupId) return [image];
    const group = await board.getById(image.groupId);
    if (!group || group.type !== 'group') return [image];
    const members = await group.getItems();
    const cardImages = [];
    for (const member of members) {
      if (member.type === 'image' && await readCard(member)) cardImages.push(member.id);
    }
    if (cardImages.length > 1) throw new Error('Mehrere Karten sind zusammen gruppiert. Bitte erst getrennt auswählen.');
    return group.ungroup();
  }

  async function liveImage(image, ungroupedMembers) {
    // After a moved group is ungrouped, old SDK image objects can still carry
    // pre-move coordinates. Fetch the released image again before laying out items.
    try { return await board.getById(image.id); }
    catch (_) { return ungroupedMembers.find(x => x.id === image.id) || image; }
  }

  async function regroup(members) {
    const items = uniqueById(members);
    if (items.length < 2) return null;
    return board.group({items});
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
      await board.deselect();
      await board.select({id:ids});
    } catch(err) {
      // A selection failure must never undo or invalidate successfully created cards.
      console.warn('Miro: could not restore card selection',err);
    }
  }

  async function initializeSelected(count, progress=()=>{}, repair=false) {
    const cards = await selectedCards({allowNew:!repair});
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
            if (meta?.awards?.length) await reflowAwardPositions(currentImage,meta.awards,anchor);
            if (meta?.badgeIds) {
              const stale = new Set(meta.badgeIds);
              for (const badge of await getItemsByIds([...stale])) await board.remove(badge);
              members = members.filter(x=>!stale.has(x.id));
            }
            const group=await regroup([...members, ...await getItemsByIds(badges)]);
            if(group)selectedGroupIds.push(group.id);
            await currentImage.setMetadata(CARD_KEY, {
              version:1, level, count:cardCount, badgeIds:badges,
              awards:Array.isArray(meta?.awards) ? meta.awards : [],
            });
          } catch(error) {
            // If still ungrouped, discard only our new circles before the recovery group.
            const live = await getItemsByIds(badges);
            if(live.every(item=>!item.groupId)) {
              for(const badge of live) {
                try { await board.remove(badge); }catch(cleanupError) {console.warn('Circle cleanup failed',cleanupError);}
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
    const cfg=await getConfig();
    return initializeSelected(cfg.levelCount,progress,true);
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
      try {shape=await board.getById(id);} catch (_) {continue;}
      if (shape.type !== 'shape') continue;
      const style=levelStyle(index,level,shape.width);
      shape.style.fillColor=style.fillColor;
      shape.style.color=style.color;
      await shape.sync();
    }
    await image.setMetadata(CARD_KEY,{...meta,level});
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
    const selection=await board.getSelection();
    if(selection.length!==1 || !['shape','frame'].includes(selection[0].type)) {
      throw new Error('Bitte genau ein Level-Feld auswählen (Shape oder Frame).');
    }
    const item=selection[0];
    if (item.type==='shape' && await item.getMetadata(CIRCLE_KEY)) {
      throw new Error('Bitte ein Level-Feld auswählen, keinen Kreis auf einer Karte.');
    }
    const cfg=await getConfig();
    level=clamp(Number(level)||1,1,cfg.levelCount);
    const zones={...cfg.zones,[item.id]:level};
    await putConfig({zones});
    return {id:item.id,level,type:item.type};
  }

  async function unassignSelectedZone() {
    const selection=await board.getSelection();
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
    try {parent=await board.getById(item.parentId);} catch (_) {return {x,y};}
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
      try {zone=await board.getById(id);} catch (_) {continue;}
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

  async function syncLevels(progress=()=>{}, respectAuto=false) {
    const cfg=await getConfig();
    if(respectAuto && (!cfg.auto || Date.now()<cfg.pauseUntil)) return {skipped:true};
    const zones=await loadZones(cfg);
    const cards=await allCards();
    let updated=0;
    for(let i=0;i<cards.length;i++) {
      const target=await detectedLevel(cards[i].image,zones);
      if(target!==null && await setLevel(cards[i].image,target)) updated++;
      progress(i+1,cards.length);
    }
    return {updated,total:cards.length,zones:zones.length};
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
      try { icon=await board.getById(awards[i].itemId); } catch (_) { continue; }
      if (icon?.type!=='image') continue;
      const pos=await awardPosition(image,i,anchor);
      if (icon.parentId && icon.parentId !== 'null') {
        const parent=await board.getById(icon.parentId);
        if (parent?.type !== 'frame') {
          throw new Error('Award je dete nepodržanog elementa. Pomeri ga iz kontejnera pre uređivanja.');
        }
        const left=parent.x-parent.width/2, top=parent.y-parent.height/2;
        const localX=pos.x-left, localY=pos.y-top;
        const halfW=Number(icon.width)/2 || 0,halfH=Number(icon.height)/2 || halfW;
        const fits=localX-halfW>=0 && localX+halfW<=parent.width &&
          localY-halfH>=0 && localY+halfH<=parent.height;
        if (icon.relativeTo==='parent_top_left' && fits) {
          // Keep award inside its frame, using the parent's local coordinates.
          icon.x=localX; icon.y=localY;
          await icon.sync();
          continue;
        }
        // The card was moved to another level frame. Miro rejects moves of
        // child images outside their old frame; detach BEFORE moving them.
        await parent.remove(icon);
        icon=await board.getById(icon.id);
        if (icon.parentId && icon.parentId !== 'null') {
          throw new Error('Miro nije uspeo da odvoji award od prethodnog Framea.');
        }
      }
      icon.x=pos.x; icon.y=pos.y;
      await icon.sync();
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
          const icon=await board.createImage({title:`Award: ${award.name}`,url:awardAssetUrl(award),x:p.x,y:p.y,width:p.size});
          addedIcon=icon;
          await icon.setMetadata(AWARD_KEY,{cardId:currentImage.id,id:slug});
          awards.push({id:slug,itemId:icon.id});
          members.push(icon);
        }
        await reflowAwardPositions(currentImage,awards,anchor);
        if(remove) {
          for(const img of await getItemsByIds([existing.itemId])) await board.remove(img);
          members=members.filter(x=>x.id!==existing.itemId);
        }
        const group=await regroup(members);
        await currentImage.setMetadata(CARD_KEY,{...meta,awards});
        return group?.id || currentImage.groupId || null;
      } catch(error) {
        if(addedIcon) {
          try {
            const live=await board.getById(addedIcon.id);
            if(!live.groupId) await board.remove(live);
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
            return regroup(members);
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
    getConfig,putConfig,selectionInfo,selectedCards,allCards,initializeSelected,repairSelected,
    setSelectedLevel,assignSelectedZone,unassignSelectedZone,syncLevels,changeAward,rearrangeSelectedAwards,
  };
}
