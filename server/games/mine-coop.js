/**
 * mine-coop.js — logique serveur de Mine Coop (bac à sable 2D façon Terraria, coop).
 * Le serveur est autoritaire sur : la grille de blocs, la validation minage/pose,
 * les inventaires, les zombies, l'horloge jour/nuit, la vie des joueurs et la
 * sauvegarde. Les humains sont autoritaires sur LEUR propre déplacement (comme
 * Tag Arena : ils envoient mine:move ~25 Hz, le serveur stocke + relaie). Le
 * monde n'est jamais envoyé en entier : streaming par chunks à la demande.
 *
 * Factory au même format que createTagGame : retourne un objet plat de méthodes,
 * branché par server/server.js (registre GAMES + routage des events mine:*).
 */
import {
  TILE, WORLD_W, WORLD_H, WORLD_PX_W, WORLD_PX_H, DAY_LENGTH_S, MINE,
  BLOCK, BLOCK_META, ITEM, ITEM_META, RECIPE_BY_ID, SMELT,
  tileIndex, inBounds, clampTileX, clampTileY, displayXToTileX, pxToTileX, pxToTileY,
  blockAt, solidAt, isSolidId, miningSeconds, canDrop, toolMeta, itemIsBlock,
  generateWorld, decodeWorld, encodeWorld, encodeChunk, isNight,
  makeInv, invAdd, invRemove, invCount, heldItem, CHUNKS_X, CHUNKS_Y,
  matchRecipe, recipeCost, makeChestContents, stackOf
} from '../../shared/mine-world.js';
import { createPlayerState, stepPlayer, aabbOverlap, bodyAabb } from '../../shared/mine-physics.js';
import { writeSave, deleteSave } from '../mine-save.js';

const REACH_PX = MINE.reachTiles * TILE;
const ZOMBIE = {
  hp: 20, dmg: 12, hitCd: 1.0, speedMul: 0.34, knockback: 280,
  swordDmg: { 0: 5, 1: 7, 2: 9, 3: 13 },
  cap: 16, perPlayer: 3, spawnEvery: 4, // s entre tentatives de spawn
  spawnMinTiles: 22, spawnMaxTiles: 30
};
const RESPAWN_IMMUNITY = 2000; // ms d'immunité après réapparition
const REGEN_DELAY = 5000;      // ms sans dégât avant régénération
const ATTACK_CD = 0.4;         // s entre coups d'épée

export function createMineGame(io, room, opts = {}) {
  // opts.onEnd / opts.startDelaySeconds (spécifiques à Tag Arena) sont ignorés.
  let world, seed, dayTime;
  const invByName = new Map();   // name -> inventaire sauvegardé (restauration au retour)
  const statsByName = new Map(); // name -> statistiques sauvegardées
  const chests = new Map();      // 'tx,ty' -> Array(27) (contenu de coffre, partagé coop)

  if (opts.save) {               // rechargement d'un monde existant
    world = decodeWorld(opts.save.world);
    seed = opts.save.seed >>> 0;
    dayTime = typeof opts.save.dayTime === 'number' ? opts.save.dayTime : 0.2;
    for (const [name, inv] of Object.entries(opts.save.inventories || {})) invByName.set(name, inv);
    for (const [name, st] of Object.entries(opts.save.playerStats || {})) statsByName.set(name, st);
    for (const [key, slots] of Object.entries(opts.save.chests || {})) chests.set(key, slots);
  } else {                       // nouveau monde
    seed = (opts.seed ?? 1) >>> 0;
    const gen = generateWorld(seed);
    world = gen.world;
    dayTime = 0.2;               // démarre en matinée
  }

  const players = new Map();     // id -> player record
  const zombies = new Map();     // zid -> zombie record
  let running = false;
  let tickN = 0, zSeq = 1;
  let saveTimer = 0, zSpawnTimer = ZOMBIE.spawnEvery;
  let dirty = false;

  const emit = (ev, data) => io.to(room.code).emit(ev, data);
  const emitTo = (id, ev, data) => io.to(id).emit(ev, data);
  const r1 = n => Math.round(n * 10) / 10;

  // --------------------------------------------------------------- helpers
  /** Première tuile solide depuis le haut d'une colonne (surface), ou WORLD_H. */
  function surfaceYAt(tx) {
    for (let ty = 0; ty < WORLD_H; ty++) if (solidAt(world, tx, ty)) return ty;
    return WORLD_H;
  }
  function defaultSpawn() {
    const tx = clampTileX(2048);
    return { x: tx * TILE + TILE / 2, y: surfaceYAt(tx) * TILE };
  }
  /** Le joueur est-il à portée d'un bloc donné (établi/fourneau) ? */
  function nearStation(p, blockId) {
    const ctx = pxToTileX(p.x), cty = pxToTileY(p.y - MINE.playerH / 2);
    for (let tx = ctx - 3; tx <= ctx + 3; tx++)
      for (let ty = cty - 3; ty <= cty + 3; ty++)
        if (inBounds(tx, ty) && world[tileIndex(tx, ty)] === blockId) return true;
    return false;
  }
  function withinReach(p, tx, ty) {
    const cx = tx * TILE + TILE / 2, cy = ty * TILE + TILE / 2;
    return Math.hypot(cx - p.x, cy - (p.y - MINE.playerH / 2)) <= REACH_PX;
  }
  function sendInv(p) { emitTo(p.id, 'mine:inv', p.inv); }
  function setBlock(tx, ty, b) { world[tileIndex(tx, ty)] = b; emit('mine:blockSet', { tx, ty, block: b }); dirty = true; }

  // --------------------------------------------------------------- joueurs
  function addHuman(id, name) {
    const sp = defaultSpawn();
    const base = createPlayerState(sp.x, sp.y);
    const saved = invByName.get(name);
    const p = {
      ...base, id, name,
      inv: saved ? deepInv(saved) : makeInv(),
      stats: restoreStats(statsByName.get(name)),
      mining: null, hurtCd: 0, attackCd: 0, immuneUntil: 0, lastHurtAt: 0,
      fuelTicks: 0, smelting: 0, smeltAcc: 0,
      sentChunks: new Set()
    };
    players.set(id, p);
    if (running) startFor(p); // (sécurité ; en pratique addHuman précède start())
    return p;
  }

  function removeHuman(id) {
    const p = players.get(id);
    if (!p) return false;
    invByName.set(p.name, deepInv(p.inv)); // restaure l'inventaire au retour sous le même pseudo
    statsByName.set(p.name, p.stats);      // idem pour les statistiques
    players.delete(id);
    dirty = true;
    return true;
  }

  function deepInv(inv) {
    const cp = s => (s ? { item: s.item, count: s.count } : null);
    return { hotbar: inv.hotbar.map(cp), main: inv.main.map(cp), sel: inv.sel | 0 };
  }

  const makeStats = () => ({
    blocks_mined: {}, blocks_placed: {}, items_crafted: {},
    zombies_killed: 0, damage_dealt: 0, damage_taken: 0,
    distance_walked: 0, jumps: 0, playtime_seconds: 0, manual_saves: 0
  });
  function restoreStats(saved) {
    const s = makeStats();
    if (saved) {
      for (const k of ['zombies_killed', 'damage_dealt', 'damage_taken', 'distance_walked', 'jumps', 'playtime_seconds', 'manual_saves'])
        if (typeof saved[k] === 'number') s[k] = saved[k];
      for (const k of ['blocks_mined', 'blocks_placed', 'items_crafted'])
        if (saved[k] && typeof saved[k] === 'object') s[k] = { ...saved[k] };
    }
    return s;
  }

  // --------------------------------------------------------------- démarrage
  function start() {
    running = true;
    room.status = 'playing';
    for (const p of players.values()) startFor(p);
  }
  function startFor(p) { emitTo(p.id, 'game:start', startPayload(p.id)); }

  function startPayload(forId) {
    const p = forId ? players.get(forId) : null;
    return {
      gameType: 'mine-coop', code: room.code, seed,
      spawn: p ? { x: p.x, y: p.y } : defaultSpawn(),
      dayTime,
      you: p ? { id: p.id, hp: p.hp, inv: p.inv } : null,
      players: roster()
    };
  }
  const roster = () => [...players.values()].map(p => ({ id: p.id, name: p.name, x: r1(p.x), y: r1(p.y), hp: p.hp }));

  function snapshot() {
    return {
      day: dayTime,
      players: [...players.values()].map(p => ({
        id: p.id, name: p.name, x: r1(p.x), y: r1(p.y),
        vx: Math.round(p.vx), vy: Math.round(p.vy), f: p.f, hp: p.hp
      })),
      zombies: [...zombies.values()].map(z => ({ id: z.id, x: r1(z.x), y: r1(z.y), f: z.f, hp: z.hp }))
    };
  }

  // --------------------------------------------------------- events client
  function handleMove(id, d) {
    const p = players.get(id);
    if (!p || !d) return;
    const x = Number(d.x), y = Number(d.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    p.x = Math.min(Math.max(x, 0), WORLD_PX_W);
    p.y = Math.min(Math.max(y, 0), WORLD_PX_H);
    p.vx = Number.isFinite(Number(d.vx)) ? Number(d.vx) : 0;
    p.vy = Number.isFinite(Number(d.vy)) ? Number(d.vy) : 0;
    p.f = d.f === -1 ? -1 : 1;
  }

  function handleSelect(id, d) {
    const p = players.get(id);
    if (p && Number.isInteger(d?.sel)) p.inv.sel = Math.min(8, Math.max(0, d.sel));
  }

  // minage : le client prédit la durée (mêmes tables) et envoie mine:break à la
  // complétion ; le serveur valide portée + capacité + présence du bloc et commit.
  function handleBreak(id, d) {
    const p = players.get(id);
    if (!p || !d) return;
    const tx = clampTileX(d.tx | 0), ty = clampTileY(d.ty | 0);
    if (tx !== (d.tx | 0) || ty !== (d.ty | 0)) return;
    const b = blockAt(world, tx, ty);
    if (b === BLOCK.AIR || !Number.isFinite(BLOCK_META[b]?.hardness)) return; // air/bedrock
    if (!withinReach(p, tx, ty)) return;
    const tool = toolMeta(heldItem(p.inv)?.item);
    const tier = tool ? tool.tier : 0;
    setBlock(tx, ty, BLOCK.AIR);
    p.stats.blocks_mined[b] = (p.stats.blocks_mined[b] || 0) + 1;
    if (b === BLOCK.CHEST) chests.delete(tx + ',' + ty); // contenu perdu (v1)
    const drop = BLOCK_META[b].drop;
    if (drop != null && canDrop(b, tier)) { invAdd(p.inv, drop, 1); sendInv(p); }
  }

  function handlePlace(id, d) {
    const p = players.get(id);
    if (!p || !d) return;
    const held = heldItem(p.inv);
    if (!held || !itemIsBlock(held.item) || held.count < 1) return;
    const tx = clampTileX(d.tx | 0), ty = clampTileY(d.ty | 0);
    if (blockAt(world, tx, ty) !== BLOCK.AIR) return;
    if (!withinReach(p, tx, ty)) return;
    // appui : au moins un voisin solide (pas de bloc flottant)
    const supported = solidAt(world, tx - 1, ty) || solidAt(world, tx + 1, ty) ||
      solidAt(world, tx, ty - 1) || solidAt(world, tx, ty + 1);
    if (!supported) return;
    // pas de pose dans le corps d'un joueur (anti-étouffement)
    if (isSolidId(held.item)) {
      const tb = { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE };
      for (const q of players.values()) {
        const a = bodyAabb(q.x, q.y);
        if (aabbOverlap(a.x, a.y, a.w, a.h, tb.x, tb.y, tb.w, tb.h)) return;
      }
    }
    setBlock(tx, ty, held.item);
    p.stats.blocks_placed[held.item] = (p.stats.blocks_placed[held.item] || 0) + 1;
    invRemove(p.inv, held.item, 1);
    sendInv(p);
  }

  function handleCraft(id, d) {
    const p = players.get(id);
    if (!p) return;
    const recipe = RECIPE_BY_ID[d?.recipeId];
    if (!recipe) return;
    if (recipe.station === 'table' && !nearStation(p, BLOCK.CRAFTING_TABLE)) return;
    const cost = recipeCost(recipe);
    for (const [item, n] of cost) if (invCount(p.inv, item) < n) return;
    for (const [item, n] of cost) invRemove(p.inv, item, n);
    invAdd(p.inv, recipe.out[0], recipe.out[1]);
    p.stats.items_crafted[recipe.id] = (p.stats.items_crafted[recipe.id] || 0) + 1;
    dirty = true;
    sendInv(p);
  }

  function handleSmelt(id) {
    const p = players.get(id);
    if (!p) return;
    if (!nearStation(p, BLOCK.FURNACE)) return;
    if (invCount(p.inv, ITEM.RAW_IRON) < 1) return;
    if (p.fuelTicks <= 0) {
      if (invRemove(p.inv, ITEM.COAL, 1)) p.fuelTicks = ITEM_META[ITEM.COAL].fuel;
      else if (invRemove(p.inv, ITEM.CHARCOAL, 1)) p.fuelTicks = ITEM_META[ITEM.CHARCOAL].fuel;
      else return; // pas de combustible
    }
    invRemove(p.inv, ITEM.RAW_IRON, 1);
    p.fuelTicks--; p.smelting++;
    dirty = true;
    sendInv(p);
  }

  function handleTeleport(id, d) {
    const p = players.get(id);
    if (!p || !d) return;
    const tx = clampTileX(displayXToTileX(Number(d.dispX) || 0));
    const ty = clampTileY(Number(d.y) || 0);
    p.x = tx * TILE + TILE / 2; p.y = ty * TILE; p.vx = 0; p.vy = 0;
    emitTo(id, 'mine:teleportOk', { x: p.x, y: p.y });
  }

  function handleAttack(id, d) {
    const p = players.get(id);
    if (!p || p.attackCd > 0) return;
    p.attackCd = ATTACK_CD;
    const dir = d?.dir === -1 ? -1 : 1;
    const held = heldItem(p.inv);
    const tool = toolMeta(held?.item);
    const tier = (tool && tool.tool === 'sword') ? tool.tier : 0;
    const dmg = ZOMBIE.swordDmg[tier];
    // AABB de frappe devant le joueur (~1,5 tuile)
    const sw = { x: dir > 0 ? p.x : p.x - 1.5 * TILE, y: p.y - MINE.playerH, w: 1.5 * TILE, h: MINE.playerH };
    for (const z of zombies.values()) {
      const za = bodyAabb(z.x, z.y);
      if (!aabbOverlap(sw.x, sw.y, sw.w, sw.h, za.x, za.y, za.w, za.h)) continue;
      z.hp -= dmg;
      p.stats.damage_dealt += dmg;
      z.vx += dir * ZOMBIE.knockback; z.vy = -200;
      if (z.hp <= 0) { zombies.delete(z.id); p.stats.zombies_killed++; emit('mine:zombieDead', { id: z.id, x: r1(z.x), y: r1(z.y) }); }
      else emit('mine:zombieHit', { id: z.id, hp: z.hp });
    }
  }

  function handleChunkRequest(id, d) {
    const p = players.get(id);
    if (!p || !d || !Array.isArray(d.list)) return;
    const chunks = [];
    for (const c of d.list.slice(0, 64)) {
      const cx = c.cx | 0, cy = c.cy | 0;
      if (cx < 0 || cx >= CHUNKS_X || cy < 0 || cy >= CHUNKS_Y) continue;
      const key = cx + ':' + cy;
      if (p.sentChunks.has(key)) continue;
      p.sentChunks.add(key);
      chunks.push({ cx, cy, data: encodeChunk(world, cx, cy) });
    }
    if (chunks.length) emitTo(id, 'mine:chunkData', { chunks });
  }

  // ----------------------------------------------- inventaire / coffres / craft
  const chestKey = (tx, ty) => tx + ',' + ty;

  /** Résout une section ('hotbar'|'bag'|'chest') en tableau de slots, ou null. */
  function sectionArray(p, sec, pos) {
    if (sec === 'hotbar') return p.inv.hotbar;
    if (sec === 'bag') return p.inv.main;
    if (sec === 'chest') {
      if (!pos) return null;
      const tx = pos.tx | 0, ty = pos.ty | 0;
      if (blockAt(world, tx, ty) !== BLOCK.CHEST || !withinReach(p, tx, ty)) return null;
      const key = chestKey(tx, ty);
      if (!chests.has(key)) chests.set(key, makeChestContents());
      return chests.get(key);
    }
    return null;
  }
  function broadcastChest(pos) {
    if (!pos) return;
    const key = chestKey(pos.tx | 0, pos.ty | 0);
    if (chests.has(key)) emit('mine:chestUpdate', { tx: pos.tx | 0, ty: pos.ty | 0, slots: chests.get(key) });
  }

  // déplacement d'un slot (inventaire ou inventaire↔coffre). splitHalf = moitié,
  // placeOne = 1 seul. Sinon : pile entière (fusion ou échange).
  function handleInvMove(id, d) {
    const p = players.get(id);
    if (!p || !d || !d.from || !d.to) return;
    const srcArr = sectionArray(p, d.from.section, d.from.chestPos);
    const dstArr = sectionArray(p, d.to.section, d.to.chestPos);
    if (!srcArr || !dstArr) return;
    const si = d.from.idx | 0, di = d.to.idx | 0;
    if (si < 0 || si >= srcArr.length || di < 0 || di >= dstArr.length) return;
    const sameSlot = d.from.section === d.to.section && si === di &&
      (d.from.section !== 'chest' || (d.from.chestPos?.tx === d.to.chestPos?.tx && d.from.chestPos?.ty === d.to.chestPos?.ty));
    if (sameSlot) return;
    const src = srcArr[si];
    if (!src) return;
    const max = stackOf(src.item);
    let qty = d.splitHalf ? Math.ceil(src.count / 2) : d.placeOne ? 1 : src.count;
    qty = Math.min(qty, src.count);

    const dst = dstArr[di];
    if (!dst) {
      dstArr[di] = { item: src.item, count: qty };
      src.count -= qty;
      if (src.count <= 0) srcArr[si] = null;
    } else if (dst.item === src.item) {
      const take = Math.min(max - dst.count, qty);
      if (take <= 0) return;
      dst.count += take; src.count -= take;
      if (src.count <= 0) srcArr[si] = null;
    } else if (qty === src.count && !d.splitHalf && !d.placeOne) {
      srcArr[si] = dst; dstArr[di] = src; // échange (déplacement complet uniquement)
    } else {
      return;
    }
    sendInv(p);
    broadcastChest(d.from.section === 'chest' ? d.from.chestPos : null);
    broadcastChest(d.to.section === 'chest' ? d.to.chestPos : null);
    dirty = true;
  }

  // fabrication par grille positionnelle (2×2 inventaire ou 3×3 établi). La grille
  // vient du client ; le serveur identifie la recette et consomme les ingrédients
  // dans l'inventaire réel (sécurité : invCount avant de retirer).
  function handleCraftGrid(id, d) {
    const p = players.get(id);
    if (!p || !d || !Array.isArray(d.grid)) return;
    if (d.grid.length !== 4 && d.grid.length !== 9) return;
    const grid = d.grid.map(s => (s && Number.isInteger(s.item) && s.count > 0) ? { item: s.item, count: s.count } : null);
    const station = nearStation(p, BLOCK.CRAFTING_TABLE) ? 'table' : 'none';
    const r = matchRecipe(grid, station);
    if (!r) return;
    const cost = recipeCost(r);
    for (const [item, n] of cost) if (invCount(p.inv, item) < n) return;
    for (const [item, n] of cost) invRemove(p.inv, item, n);
    invAdd(p.inv, r.out[0], r.out[1]);
    p.stats.items_crafted[r.id] = (p.stats.items_crafted[r.id] || 0) + 1;
    sendInv(p);
    dirty = true;
  }

  function handleChestOpen(id, d) {
    const p = players.get(id);
    if (!p || !d) return;
    const tx = d.tx | 0, ty = d.ty | 0;
    if (blockAt(world, tx, ty) !== BLOCK.CHEST || !withinReach(p, tx, ty)) return;
    const key = chestKey(tx, ty);
    if (!chests.has(key)) chests.set(key, makeChestContents());
    emitTo(id, 'mine:chestData', { tx, ty, slots: chests.get(key) });
  }

  // stats pilotées par le client (uniquement sauts + distance ; le reste = serveur)
  function handleStatInc(id, d) {
    const p = players.get(id);
    if (!p || !d) return;
    if (d.key !== 'jumps' && d.key !== 'distance_walked') return;
    const v = Number(d.val);
    if (!Number.isFinite(v) || v <= 0 || v > 1e6) return;
    p.stats[d.key] += v;
  }

  function handleSave(id) {
    const p = players.get(id);
    if (p) p.stats.manual_saves++;
    save();
    if (p) emitTo(id, 'mine:saveOk', { ts: Date.now() });
  }

  function handleStatsRequest(id) {
    const p = players.get(id);
    if (p) emitTo(id, 'mine:statsData', { stats: p.stats });
  }

  // changement de code du monde en cours de partie (renomme salon + canal + save)
  function handleSetCode(id, d, ack, rooms) {
    ack = typeof ack === 'function' ? ack : () => {};
    const p = players.get(id);
    if (!p) return ack({ ok: false, error: 'no_player' });
    const newCode = String(d?.newCode || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(newCode)) return ack({ ok: false, error: 'bad_code' });
    if (newCode === room.code) return ack({ ok: false, error: 'same_code' });
    if (!rooms || rooms.hasActive(newCode)) return ack({ ok: false, error: 'code_taken' });
    const oldCode = room.code;
    io.in(oldCode).socketsJoin(newCode);   // migre le canal socket.io vers le nouveau code
    io.in(oldCode).socketsLeave(oldCode);
    rooms.renameRoom(oldCode, newCode);    // met à jour room.code + l'index byPlayer
    save();                                 // écrit la sauvegarde sous le nouveau code
    deleteSave(oldCode);                    // supprime l'ancien fichier
    emit('mine:codeChanged', { newCode });  // emit cible désormais room.code = newCode
    ack({ ok: true, newCode });
  }

  // ------------------------------------------------------------------ tick
  function tick(dt) {
    if (!running) return;
    const now = Date.now();
    const wasNight = isNight(dayTime);
    dayTime = (dayTime + dt / DAY_LENGTH_S) % 1;
    const nowNight = isNight(dayTime);

    // joueurs : régen, fonte, refroidissements
    for (const p of players.values()) {
      p.attackCd = Math.max(0, p.attackCd - dt);
      p.stats.playtime_seconds += dt;
      if (p.smelting > 0) {
        p.smeltAcc += dt;
        if (p.smeltAcc >= SMELT[ITEM.RAW_IRON].seconds) {
          p.smeltAcc -= SMELT[ITEM.RAW_IRON].seconds; p.smelting--;
          invAdd(p.inv, ITEM.IRON_INGOT, 1); sendInv(p); dirty = true;
        }
      }
      if (p.hp < p.maxHp && now - p.lastHurtAt > REGEN_DELAY) {
        p.hp = Math.min(p.maxHp, p.hp + 2 * dt);
      }
    }

    // apparition de zombies la nuit
    if (nowNight && zombies.size < ZOMBIE.cap && players.size) {
      zSpawnTimer -= dt;
      if (zSpawnTimer <= 0) { zSpawnTimer = ZOMBIE.spawnEvery; trySpawnZombie(); }
    }

    // IA + dégâts au contact
    for (const z of zombies.values()) {
      z.hurtCd = Math.max(0, z.hurtCd - dt);
      const target = nearestPlayer(z);
      const input = { left: false, right: false, jumpPressed: false, jumpHeld: false };
      if (target) {
        const dir = Math.sign(target.x - z.x);
        if (dir < 0) input.left = true; else if (dir > 0) input.right = true;
        // saute si un mur d'1 bloc le bloque
        const feetTy = pxToTileY(z.y - 1), aheadTx = pxToTileX(z.x + dir * (MINE.playerW / 2 + 2));
        if (z.onGround && solidAt(world, aheadTx, feetTy) && !solidAt(world, aheadTx, feetTy - 1)) {
          input.jumpPressed = true; input.jumpHeld = true;
        }
      }
      stepPlayer(z, input, dt, { world, speedMul: ZOMBIE.speedMul });
      if (target && z.hurtCd <= 0) {
        const za = bodyAabb(z.x, z.y), pa = bodyAabb(target.x, target.y);
        if (aabbOverlap(za.x, za.y, za.w, za.h, pa.x, pa.y, pa.w, pa.h) && now >= target.immuneUntil) {
          z.hurtCd = ZOMBIE.hitCd;
          target.stats.damage_taken += ZOMBIE.dmg;
          hurtPlayer(target, ZOMBIE.dmg, now);
        }
      }
    }

    // aube : tous les zombies disparaissent
    if (wasNight && !nowNight && zombies.size) {
      for (const z of zombies.values()) emit('mine:zombieDead', { id: z.id, x: r1(z.x), y: r1(z.y) });
      zombies.clear();
    }

    // diffusions : état léger à 15 Hz (1 tick sur 2)
    tickN++;
    if (tickN % 2 === 0) emit('mine:state', snapshot());

    // sauvegarde périodique (~30 s) si modifié
    saveTimer += dt;
    if (saveTimer >= 30) { if (dirty) save(); saveTimer = 0; }
  }

  function hurtPlayer(p, dmg, now) {
    p.hp = Math.max(0, p.hp - dmg);
    p.lastHurtAt = now;
    emit('mine:hp', { id: p.id, hp: Math.round(p.hp) });
    if (p.hp <= 0) {
      const sp = defaultSpawn();
      p.x = sp.x; p.y = sp.y; p.vx = 0; p.vy = 0;
      p.hp = p.maxHp; p.immuneUntil = now + RESPAWN_IMMUNITY;
      emit('mine:respawn', { id: p.id, x: p.x, y: p.y });
    }
  }

  function nearestPlayer(z) {
    let best = null, bd = Infinity;
    for (const p of players.values()) {
      const d = Math.abs(p.x - z.x);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  function trySpawnZombie() {
    const arr = [...players.values()];
    const p = arr[Math.floor(Math.random() * arr.length)];
    if ([...zombies.values()].filter(z => Math.abs(z.x - p.x) < 30 * TILE).length >= ZOMBIE.perPlayer) return;
    const side = Math.random() < 0.5 ? -1 : 1;
    const dist = ZOMBIE.spawnMinTiles + Math.floor(Math.random() * (ZOMBIE.spawnMaxTiles - ZOMBIE.spawnMinTiles));
    const tx = clampTileX(pxToTileX(p.x) + side * dist);
    const sy = surfaceYAt(tx);
    if (sy >= WORLD_H - 1) return;
    // besoin de 2 tuiles d'air au-dessus du sol
    if (solidAt(world, tx, sy - 1) || solidAt(world, tx, sy - 2)) return;
    const z = {
      id: 'z' + (zSeq++), x: tx * TILE + TILE / 2, y: sy * TILE,
      vx: 0, vy: 0, f: 1, onGround: false, coyote: 0, jumpBuf: 0,
      hp: ZOMBIE.hp, maxHp: ZOMBIE.hp, hurtCd: 0
    };
    zombies.set(z.id, z);
  }

  // ------------------------------------------------------------ sauvegarde
  function save() {
    const inventories = {}, playerStats = {}, chestsObj = {};
    for (const [name, inv] of invByName) inventories[name] = inv;
    for (const [name, st] of statsByName) playerStats[name] = st;
    for (const p of players.values()) {            // joueurs connectés = état le plus frais
      inventories[p.name] = deepInv(p.inv);
      playerStats[p.name] = p.stats;
    }
    for (const [key, slots] of chests) chestsObj[key] = slots;
    writeSave(room.code, {
      version: 1, code: room.code, seed, dayTime,
      world: encodeWorld(world), inventories, chests: chestsObj, playerStats
    });
    dirty = false;
  }

  return {
    start, tick, addHuman, removeHuman,
    handleMove, handleSelect, handleBreak, handlePlace, handleChunkRequest,
    handleCraft, handleSmelt, handleTeleport, handleAttack,
    handleInvMove, handleCraftGrid, handleChestOpen, handleStatInc,
    handleSave, handleSetCode, handleStatsRequest,
    startPayload, snapshot, save,
    isRunning: () => running,
    // hooks de test
    _world: () => world, _players: players, _zombies: zombies, _chests: chests,
    _dayTime: () => dayTime, _setDayTime: t => { dayTime = t; }
  };
}
