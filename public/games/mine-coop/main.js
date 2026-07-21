/**
 * main.js — client de Mine Coop.
 * - écrans : menu (créer/rejoindre) → lobby → jeu
 * - le joueur local est simulé ici (mine-physics partagée) au-dessus d'une grille
 *   reçue par chunks à la demande ; il envoie sa position ~25 Hz (mine:move). Le
 *   serveur est autoritaire sur la grille, les inventaires, les zombies, la vie,
 *   l'horloge jour/nuit et la sauvegarde.
 * - les autres joueurs + les zombies sont interpolés depuis mine:state (15 Hz).
 *
 * Contrats réseau exacts (cf. server/games/mine-coop.js, server/server.js) :
 *   → mine:move {x,y,vx,vy,f}  mine:select {sel}  mine:break {tx,ty}
 *     mine:place {tx,ty}  mine:chunkRequest {list:[{cx,cy}]}  mine:craft {recipeId}
 *     mine:smelt  mine:teleport {dispX,y}  mine:attack {dir}
 *   ← game:start {…you:{id,hp,inv}…}  mine:state {day,players,zombies}
 *     mine:inv {hotbar,main,sel}  mine:chunkData {chunks:[{cx,cy,data}]}
 *     mine:blockSet {tx,ty,block}  mine:hp {id,hp}  mine:respawn {id,x,y}
 *     mine:teleportOk {x,y}  mine:zombieHit {id,hp}  mine:zombieDead {id,x,y}
 */
import {
  TILE, VIEW, WORLD_W, WORLD_H, WORLD_TILES, WORLD_OFFSET_X,
  CHUNK, CHUNKS_X, CHUNKS_Y, MINE, BLOCK, BLOCK_META,
  tileIndex, pxToTileX, pxToTileY, displayXToTileX, chunkKey, chunkCoord,
  newWorldArray, makeInv, heldItem, toolMeta, miningSeconds,
  itemGlyph, itemName, itemIsBlock, decodeChunk,
  matchRecipe, stackOf, invAdd, invRemove, invCount
} from '/shared/mine-world.js';
import { createPlayerState, stepPlayer, bodyAabb } from '/shared/mine-physics.js';
import { createDebugHud } from '/shared/debug-hud.js';
import { createRenderer } from '/games/mine-coop/render.js';

const REACH_PX = MINE.reachTiles * TILE;
const PALETTE = ['#4cc9f0', '#f72585', '#ffd166', '#06d6a0', '#b5179e', '#ff7a3c', '#9b5de5', '#00bbf9'];
const colorFor = id => {
  let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

const $ = id => document.getElementById(id);
const socket = io();
const hud = createDebugHud(socket);
const renderer = createRenderer($('game'));
const canvas = $('game');

const NAME_KEY = 'portail.name';
const storedName = () => (localStorage.getItem(NAME_KEY) || '').trim();
$('nameInput').value = storedName();
const currentName = () => {
  const n = $('nameInput').value.trim().slice(0, 16);
  if (n.length >= 2) localStorage.setItem(NAME_KEY, n);
  return n;
};

// ---------------------------------------------------------------- écrans
const screens = { menu: $('screenMenu'), lobby: $('screenLobby'), game: $('screenGame') };
function show(which) {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== which;
  if (which === 'game') hud.show(); else hud.hide();
}

let myRoom = null;  // dernier room:update
let game = null;    // état de la manche en cours

// ---------------------------------------------------------------- keybinds
const DEFAULT_KEYBINDS = {
  moveLeft: 'ArrowLeft', moveRight: 'ArrowRight', jump: 'Space',
  openInv: 'Tab', attack: 'KeyE', teleport: 'KeyM',
  slot1: 'Digit1', slot2: 'Digit2', slot3: 'Digit3', slot4: 'Digit4', slot5: 'Digit5',
  slot6: 'Digit6', slot7: 'Digit7', slot8: 'Digit8', slot9: 'Digit9'
};
const KB_KEY = 'portail.mine.keybinds';
let keybinds = { ...DEFAULT_KEYBINDS, ...(JSON.parse(localStorage.getItem(KB_KEY) || 'null') || {}) };
const saveKeybinds = () => localStorage.setItem(KB_KEY, JSON.stringify(keybinds));
// résolution code-touche → action (recalculée quand les binds changent)
let codeToAction = {};
function rebuildKeyIndex() { codeToAction = {}; for (const a in keybinds) codeToAction[keybinds[a]] = a; }
rebuildKeyIndex();

// ---------------------------------------------------------------- état UI/inventaire
let invOpen = false, chestOpen = false, escOpen = false;
let craft2 = new Array(4).fill(null);   // grille de craft 2×2 (réservation client)
let craft3 = new Array(9).fill(null);   // grille de craft 3×3 (réservation client)
let chestState = null;                  // { tx, ty, slots:Array(27) } | null
let drag = null;                        // glisser en cours : { section, idx, chestPos, item, count, split }
let statsData = null;
let nearTable = false;                  // joueur à portée d'un établi (calcul client)
let pendingStats = { jumps: 0, distance_walked: 0 };

function setMenuError(msg) { $('menuError').textContent = msg || ''; }

// ---------------------------------------------------------------- menu : créer
$('btnShowCreate').onclick = () => {
  const panel = $('createPanel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    $('worldCodeInput').focus();
    socket.emit('mine:savesInfo', info => renderSaves(info));
  }
};
$('worldCodeInput').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

function renderSaves(info) {
  const box = $('savesBox'), list = $('savesList'), warn = $('lruWarn');
  const saves = (info && info.saves) || [];
  const max = (info && info.max) || 5;
  if (!saves.length) { box.hidden = true; warn.hidden = true; return; }
  box.hidden = false;
  list.innerHTML = '';
  for (const s of saves) {
    const li = document.createElement('li');
    const when = s.lastSaved ? new Date(s.lastSaved).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
    li.innerHTML = `<span>${s.code}</span><span class="when">${when}</span>`;
    list.appendChild(li);
  }
  if (saves.length >= max) {
    warn.hidden = false;
    warn.textContent = `⚠ ${max} mondes déjà sauvegardés (maximum). Créer un NOUVEAU monde supprimera le plus ancien (${saves[saves.length - 1].code}). Réutilise un code existant pour ne rien perdre.`;
  } else {
    warn.hidden = true;
  }
}

$('btnCreate').onclick = () => {
  const name = currentName();
  if (name.length < 2) return setMenuError('Choisis un pseudo (2 à 16 caractères).');
  const worldCode = $('worldCodeInput').value.trim().toUpperCase();
  if (worldCode && !/^[A-Z0-9]{4,8}$/.test(worldCode)) {
    return setMenuError('Le code de monde fait 4 à 8 lettres/chiffres.');
  }
  setMenuError('');
  $('btnCreate').disabled = true;
  socket.emit('room:create', { gameType: 'mine-coop', name, worldCode: worldCode || undefined }, res => {
    $('btnCreate').disabled = false;
    if (res?.ok) { myRoom = res.room; renderLobby(); show('lobby'); }
    else setMenuError({
      bad_code: 'Code de monde invalide (4 à 8 lettres/chiffres).',
      code_taken: 'Ce code est déjà utilisé par un salon actif. Choisis-en un autre.',
      unknown_game: 'Jeu inconnu.'
    }[res?.error] || 'Impossible de créer le monde.');
  });
};

// ---------------------------------------------------------------- menu : rejoindre
function joinByCode() {
  const name = currentName();
  if (name.length < 2) return setMenuError('Choisis un pseudo (2 à 16 caractères).');
  const code = $('codeInput').value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) return setMenuError('Le code de salon fait 4 lettres.');
  setMenuError('');
  socket.emit('room:join', { code, name }, res => {
    if (res?.ok) { myRoom = res.room; renderLobby(); show('lobby'); }
    else setMenuError({
      not_found: 'Salon introuvable. Vérifie le code !',
      full: 'Salon complet (4 joueurs max).',
      in_progress: 'La partie de ce salon a déjà commencé.'
    }[res?.error] || 'Impossible de rejoindre ce salon.');
  });
}
$('btnJoin').onclick = joinByCode;
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinByCode(); });
$('codeInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });

// ---------------------------------------------------------------- lobby
$('btnStart').onclick = () => socket.emit('room:start', res => {
  if (!res?.ok) $('lobbyHint').textContent = {
    not_enough_players: 'Il faut au moins 1 joueur.',
    not_host: "Seul l'hôte peut lancer.",
  }[res?.error] || 'Impossible de démarrer.';
});
$('btnLeaveLobby').onclick = () => { socket.emit('room:leave'); myRoom = null; show('menu'); };

socket.on('room:update', data => { myRoom = data; if (!game) renderLobby(); });

function renderLobby() {
  if (!myRoom) return;
  $('lobbyCode').textContent = myRoom.code;
  const ul = $('lobbyPlayers');
  ul.innerHTML = '';
  for (const p of myRoom.players) {
    const li = document.createElement('li');
    li.textContent = `${p.name}${p.isHost ? ' 👑' : ''}${p.id === socket.id ? ' (toi)' : ''}`;
    if (p.id === socket.id) li.classList.add('me');
    ul.appendChild(li);
  }
  const isHost = myRoom.hostId === socket.id;
  $('btnStart').hidden = !isHost;
  $('lobbyHint').textContent = isHost
    ? 'Prêt ? Entre dans le monde (tu peux y aller seul ou attendre des amis).'
    : "En attente du lancement par l'hôte…";
}

// ---------------------------------------------------------------- game:start
socket.on('game:start', payload => {
  if (payload.gameType !== 'mine-coop') return;
  const world = newWorldArray();
  game = {
    code: payload.code,
    world,
    loaded: new Set(),
    requested: new Set(),
    me: createPlayerState(payload.spawn.x, payload.spawn.y),
    inv: normalizeInv(payload.you?.inv),
    others: new Map(),   // id -> { disp:{x,y}, target:{x,y,vx,vy,f}, name, hp, color }
    zombies: new Map(),  // id -> { disp:{x,y}, target:{x,y,f}, hp, maxHp }
    dayTime: payload.dayTime ?? 0.3,
    over: false
  };
  game.me.hp = payload.you?.hp ?? MINE.maxHp;
  for (const p of payload.players || []) {
    if (p.id === socket.id) continue;
    game.others.set(p.id, {
      disp: { x: p.x, y: p.y }, target: { x: p.x, y: p.y, vx: 0, vy: 0, f: 1 },
      name: p.name, hp: p.hp, color: colorFor(p.id)
    });
  }
  craft2 = new Array(4).fill(null);
  craft3 = new Array(9).fill(null);
  chestState = null; drag = null; statsData = null;
  closeAllPanels();
  renderer.centerOn(game.me.x, game.me.y);
  renderHotbar();
  show('game');
  requestChunks();
  $('noticeOverlay').hidden = true;
});

function normalizeInv(inv) {
  if (!inv) return makeInv();
  return {
    hotbar: Array.from({ length: 9 }, (_, i) => inv.hotbar?.[i] || null),
    main: Array.from({ length: 27 }, (_, i) => inv.main?.[i] || null),
    sel: Math.min(8, Math.max(0, inv.sel | 0))
  };
}

// ---------------------------------------------------------------- état temps réel
socket.on('mine:state', s => {
  if (!game) return;
  game.dayTime = s.day;
  // autres joueurs
  const seen = new Set();
  for (const p of s.players || []) {
    if (p.id === socket.id) { game.me.hp = p.hp; continue; }
    seen.add(p.id);
    let o = game.others.get(p.id);
    if (!o) { o = { disp: { x: p.x, y: p.y }, target: {}, color: colorFor(p.id) }; game.others.set(p.id, o); }
    o.target = { x: p.x, y: p.y, vx: p.vx, vy: p.vy, f: p.f };
    o.name = p.name; o.hp = p.hp;
  }
  for (const id of [...game.others.keys()]) if (!seen.has(id)) game.others.delete(id);
  // zombies
  const zseen = new Set();
  for (const z of s.zombies || []) {
    zseen.add(z.id);
    let zz = game.zombies.get(z.id);
    if (!zz) { zz = { disp: { x: z.x, y: z.y }, target: {}, maxHp: 20 }; game.zombies.set(z.id, zz); }
    zz.target = { x: z.x, y: z.y, f: z.f };
    zz.hp = z.hp;
  }
  for (const id of [...game.zombies.keys()]) if (!zseen.has(id)) game.zombies.delete(id);
});

// Inventaire autoritaire. Invariant d'affichage : game.inv = inventaire serveur
// MOINS les items réservés dans les grilles de craft (client). On ré-applique
// donc la réservation après chaque mine:inv.
socket.on('mine:inv', inv => {
  if (!game) return;
  game.inv = normalizeInv(inv);
  for (const cell of [...craft2, ...craft3]) if (cell) invRemove(game.inv, cell.item, cell.count);
  renderHotbar();
  if (invOpen || chestOpen) renderInvUI();
});

socket.on('mine:chestData', d => {
  if (!game) return;
  chestState = { tx: d.tx, ty: d.ty, slots: normalizeSlots(d.slots, 27) };
  openChest();
});
socket.on('mine:chestUpdate', d => {
  if (chestState && chestState.tx === d.tx && chestState.ty === d.ty) {
    chestState.slots = normalizeSlots(d.slots, 27);
    if (chestOpen) renderInvUI();
  }
});
socket.on('mine:saveOk', d => showToast(`💾 Sauvegardé — ${new Date(d.ts).toLocaleTimeString('fr-FR')}`));
socket.on('mine:codeChanged', d => {
  if (game) game.code = d.newCode;
  showToast(`🔑 Nouveau code du monde : ${d.newCode}`);
  if (escOpen) renderEscCode();
});
socket.on('mine:statsData', d => { statsData = d.stats; renderStats(); });

function normalizeSlots(arr, n) {
  return Array.from({ length: n }, (_, i) => {
    const s = arr && arr[i];
    return s && Number.isInteger(s.item) && s.count > 0 ? { item: s.item, count: s.count } : null;
  });
}

socket.on('mine:blockSet', d => {
  if (!game) return;
  game.world[tileIndex(d.tx, d.ty)] = d.block;  // l'ordre d'émission serveur garantit la cohérence avec chunkData
});

socket.on('mine:chunkData', d => {
  if (!game || !d?.chunks) return;
  for (const c of d.chunks) applyChunk(c.cx, c.cy, c.data);
});

socket.on('mine:hp', d => {
  if (!game) return;
  if (d.id === socket.id) game.me.hp = d.hp;
  else { const o = game.others.get(d.id); if (o) o.hp = d.hp; }
});

socket.on('mine:respawn', d => {
  if (!game) return;
  if (d.id === socket.id) {
    game.me.x = d.x; game.me.y = d.y; game.me.vx = 0; game.me.vy = 0; game.me.hp = MINE.maxHp;
    renderer.centerOn(d.x, d.y);
  } else {
    const o = game.others.get(d.id);
    if (o) { o.disp.x = d.x; o.disp.y = d.y; o.target.x = d.x; o.target.y = d.y; }
  }
});

socket.on('mine:teleportOk', d => {
  if (!game) return;
  game.me.x = d.x; game.me.y = d.y; game.me.vx = 0; game.me.vy = 0;
  renderer.centerOn(d.x, d.y);
});

socket.on('mine:zombieHit', d => { const z = game?.zombies.get(d.id); if (z) z.hp = d.hp; });
socket.on('mine:zombieDead', d => { game?.zombies.delete(d.id); });

// ---------------------------------------------------------------- chunks
const chunkKeyOfTile = (tx, ty) => chunkKey((tx / CHUNK) | 0, (ty / CHUNK) | 0);

function applyChunk(cx, cy, data) {
  const buf = typeof data === 'string' ? decodeChunk(data) : Uint8Array.from(data);
  const x0 = cx * CHUNK, y0 = cy * CHUNK;
  let k = 0;
  for (let tx = x0; tx < x0 + CHUNK; tx++)
    for (let ty = y0; ty < y0 + CHUNK; ty++)
      game.world[tileIndex(tx, ty)] = buf[k++];
  game.loaded.add(chunkKey(cx, cy));
}

function requestChunks() {
  if (!game) return;
  const c = renderer.getCamera();
  const camL = c.x - VIEW.width / 2, camT = c.y - VIEW.height / 2;
  const csz = CHUNK * TILE;
  const cx0 = Math.max(0, Math.floor(camL / csz) - 1);
  const cx1 = Math.min(CHUNKS_X - 1, Math.floor((camL + VIEW.width) / csz) + 1);
  const cy0 = Math.max(0, Math.floor(camT / csz) - 1);
  const cy1 = Math.min(CHUNKS_Y - 1, Math.floor((camT + VIEW.height) / csz) + 1);
  // un seul lot couvre le viewport + 1 chunk de marge (~12 chunks ≪ la limite de
  // 64 côté serveur), donc aucun chunk n'est silencieusement tronqué. La socket
  // (TCP) garantit la livraison, et le serveur dédoublonne via sentChunks : on ne
  // redemande donc pas un chunk déjà demandé.
  const list = [];
  for (let cx = cx0; cx <= cx1; cx++)
    for (let cy = cy0; cy <= cy1; cy++) {
      const key = chunkKey(cx, cy);
      if (game.loaded.has(key) || game.requested.has(key)) continue;
      game.requested.add(key);
      list.push({ cx, cy });
    }
  if (list.length) socket.emit('mine:chunkRequest', { list });
}

/** Bloc pour le RENDU : -1 si le chunk n'est pas encore reçu (affiché « en cours »). */
function blockForRender(tx, ty) {
  if (ty < 0) return BLOCK.AIR;
  if (tx < 0 || tx >= WORLD_W || ty >= WORLD_H) return BLOCK.BEDROCK;
  if (!game.loaded.has(chunkKeyOfTile(tx, ty))) return -1;
  return game.world[tileIndex(tx, ty)];
}

/** La grille autour du joueur est-elle chargée ? (porte la physique locale.) */
function neighborhoodLoaded() {
  const { cx, cy } = chunkCoord(pxToTileX(game.me.x), pxToTileY(game.me.y));
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x >= CHUNKS_X || y < 0 || y >= CHUNKS_Y) continue; // bord du monde = solide
      if (!game.loaded.has(chunkKey(x, y))) return false;
    }
  return true;
}

// ---------------------------------------------------------------- entrées clavier
const keys = { left: false, right: false, jump: false };
let jumpQueued = false;
let capturingAction = null;     // action en cours de réassignation (panneau touches)

const typing = e => e.target.matches?.('input, textarea, select');
const anyPanelOpen = () => invOpen || chestOpen || escOpen;

addEventListener('keydown', e => {
  if (capturingAction) { e.preventDefault(); applyKeyCapture(e.code); return; }
  if (typing(e)) return;
  if (e.code === 'Escape') { if (game) { e.preventDefault(); onEscape(); } return; }

  const action = codeToAction[e.code];
  if (action === 'moveLeft' || action === 'moveRight' || action === 'jump') {
    if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab') e.preventDefault();
    if (anyPanelOpen()) return;
    if (action === 'jump') { if (!keys.jump) jumpQueued = true; keys.jump = true; }
    else keys[action === 'moveLeft' ? 'left' : 'right'] = true;
    return;
  }
  if (!game) return;
  if (action === 'openInv') { e.preventDefault(); toggleInventory(); return; }
  if (anyPanelOpen()) return;     // les actions de jeu sont bloquées si un overlay est ouvert
  if (action === 'attack') { attack(game.me.f); return; }
  if (action === 'teleport') { e.preventDefault(); $('tpX').focus(); $('tpX').select(); return; }
  if (action && action.startsWith('slot')) selectSlot(+action.slice(4) - 1);
});
addEventListener('keyup', e => {
  if (typing(e)) return;
  const action = codeToAction[e.code];
  if (action === 'moveLeft') keys.left = false;
  else if (action === 'moveRight') keys.right = false;
  else if (action === 'jump') keys.jump = false;
});

function onEscape() {
  if (drag) { cancelDrag(); return; }
  if (invOpen) return closeInventory();
  if (chestOpen) return closeChest();
  if (escOpen) return closeEsc();
  openEsc();
}

// ---------------------------------------------------------------- entrées souris
let mouse = { sx: 0, sy: 0, left: false, right: false };
let mining = null; // { tx, ty, acc }

function cursorWorld() {
  const rect = canvas.getBoundingClientRect();
  const sx = (mouse.sx - rect.left) / rect.width * canvas.width;
  const sy = (mouse.sy - rect.top) / rect.height * canvas.height;
  return renderer.screenToWorld(sx, sy);
}
function aimTileNow() { const w = cursorWorld(); return { tx: pxToTileX(w.x), ty: pxToTileY(w.y), wx: w.x, wy: w.y }; }

function withinReach(tx, ty) {
  const cx = tx * TILE + TILE / 2, cy = ty * TILE + TILE / 2;
  return Math.hypot(cx - game.me.x, cy - (game.me.y - MINE.playerH / 2)) <= REACH_PX;
}

canvas.addEventListener('mousemove', e => { mouse.sx = e.clientX; mouse.sy = e.clientY; });
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('mousedown', e => {
  if (!game || anyPanelOpen()) return;
  mouse.sx = e.clientX; mouse.sy = e.clientY;
  if (e.button === 0) { mouse.left = true; }
  else if (e.button === 2) { mouse.right = true; rightAction(); }
});
addEventListener('mouseup', e => {
  if (e.button === 0) { mouse.left = false; mining = null; }
  else if (e.button === 2) mouse.right = false;
});

function zombieAt(wx, wy) {
  for (const [id, z] of game.zombies) {
    const a = bodyAabb(z.disp.x, z.disp.y);
    if (wx >= a.x && wx <= a.x + a.w && wy >= a.y && wy <= a.y + a.h) return z;
  }
  return null;
}

function rightAction() {
  const aim = aimTileNow();
  const z = zombieAt(aim.wx, aim.wy);
  if (z) { attack(Math.sign(z.disp.x - game.me.x) || game.me.f); return; }
  // coffre : clic droit sur un CHEST à portée → ouvre l'UI du coffre
  if (game.loaded.has(chunkKeyOfTile(aim.tx, aim.ty)) &&
      game.world[tileIndex(aim.tx, aim.ty)] === BLOCK.CHEST && withinReach(aim.tx, aim.ty)) {
    socket.emit('mine:chestOpen', { tx: aim.tx, ty: aim.ty });
    return;
  }
  // pose : tuile vide, à portée, item plaçable sélectionné (serveur re-valide l'appui)
  const held = heldItem(game.inv);
  if (!held || !itemIsBlock(held.item)) return;     // pas un bloc → rien à poser
  if (!withinReach(aim.tx, aim.ty)) return;
  if (game.world[tileIndex(aim.tx, aim.ty)] !== BLOCK.AIR) return;
  socket.emit('mine:place', { tx: aim.tx, ty: aim.ty });
}

function attack(dir) { socket.emit('mine:attack', { dir: dir === -1 ? -1 : 1 }); }

// ---------------------------------------------------------------- hotbar / inv
function selectSlot(i) {
  if (!game || i < 0 || i > 8) return;
  game.inv.sel = i;
  renderHotbar();
  socket.emit('mine:select', { sel: i });
}

function renderHotbar() {
  const bar = $('hotbar');
  bar.innerHTML = '';
  for (let i = 0; i < 9; i++) {
    const s = game.inv.hotbar[i];
    const div = document.createElement('div');
    div.className = 'slot' + (i === game.inv.sel ? ' sel' : '');
    div.innerHTML = `<span class="keycap">${i + 1}</span>` +
      (s ? `<span class="glyph">${itemGlyph(s.item)}</span>${s.count > 1 ? `<span class="count">${s.count}</span>` : ''}` : '');
    div.title = s ? itemName(s.item) : '';
    div.onclick = () => selectSlot(i);
    bar.appendChild(div);
  }
}

// ====================================================== panneaux (ouvrir/fermer)
function clearMoveKeys() { keys.left = keys.right = keys.jump = false; jumpQueued = false; mouse.left = mouse.right = false; mining = null; }
function closeAllPanels() {
  invOpen = chestOpen = escOpen = false; drag = null;
  for (const id of ['invOverlay', 'chestOverlay', 'escOverlay', 'dragGhost']) { const el = $(id); if (el) el.hidden = true; }
}
function openInventory() {
  if (chestOpen) closeChest(); if (escOpen) closeEsc();
  invOpen = true; clearMoveKeys(); $('invOverlay').hidden = false; renderInvUI();
}
function closeInventory() { returnCraftToInv(); invOpen = false; cancelDrag(); $('invOverlay').hidden = true; }
function toggleInventory() { if (invOpen) closeInventory(); else openInventory(); }
function openChest() {
  if (invOpen) closeInventory(); if (escOpen) closeEsc();
  chestOpen = true; clearMoveKeys(); $('chestOverlay').hidden = false; renderInvUI();
}
function closeChest() { chestOpen = false; cancelDrag(); $('chestOverlay').hidden = true; chestState = null; }
function openEsc() {
  if (invOpen) closeInventory(); if (chestOpen) closeChest();
  escOpen = true; clearMoveKeys(); hideEscSub(); $('escOverlay').hidden = false;
}
function closeEsc() { escOpen = false; $('escOverlay').hidden = true; }
function hideEscSub() { for (const id of ['keybindPanel', 'statsPanel', 'setCodePanel']) $(id).hidden = true; $('escMain').hidden = false; }
function showEscSub(id) { $('escMain').hidden = true; for (const s of ['keybindPanel', 'statsPanel', 'setCodePanel']) $(s).hidden = s !== id; }

function returnCraftToInv() {
  for (const grid of [craft2, craft3])
    for (let i = 0; i < grid.length; i++) if (grid[i]) { invAdd(game.inv, grid[i].item, grid[i].count); grid[i] = null; }
  renderHotbar();
}

let toastTimer = null;
function showToast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); t.hidden = true; }, 2600);
}

// ====================================================== rendu des grilles de slots
const SLOT_ARR = {
  hotbar: () => game.inv.hotbar, bag: () => game.inv.main,
  craft2: () => craft2, craft3: () => craft3, chest: () => chestState?.slots || null
};
const sectionArr = sec => (SLOT_ARR[sec] ? SLOT_ARR[sec]() : null);
const isCraft = sec => sec === 'craft2' || sec === 'craft3';
const slotInner = s => s ? `<span class="glyph">${itemGlyph(s.item)}</span>${s.count > 1 ? `<span class="count">${s.count}</span>` : ''}` : '';

function renderGrid(el, arr, section, chestPos) {
  el.innerHTML = '';
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i];
    const div = document.createElement('div');
    div.className = 'slot';
    div.innerHTML = slotInner(s);
    div.title = s ? `${itemName(s.item)} ×${s.count}` : '';
    div.addEventListener('mousedown', e => onSlotDown(e, section, i, chestPos));
    div.addEventListener('mouseup', () => onSlotUp(section, i, chestPos));
    el.appendChild(div);
  }
}
const activeCraft = () => nearTable ? craft3 : craft2;
function renderCraftGrid() {
  const el = $('craftGrid');
  el.classList.toggle('g3', nearTable);
  renderGrid(el, activeCraft(), nearTable ? 'craft3' : 'craft2');
}
function renderInvUI() {
  if (invOpen) {
    $('invStation').hidden = !nearTable;
    renderCraftGrid();
    updateCraftPreview();
    renderGrid($('bagGrid'), game.inv.main, 'bag');
    renderGrid($('hotbarGrid'), game.inv.hotbar, 'hotbar');
  } else if (chestOpen && chestState) {
    renderGrid($('chestGrid'), chestState.slots, 'chest', { tx: chestState.tx, ty: chestState.ty });
    renderGrid($('chestBagGrid'), game.inv.main, 'bag');
    renderGrid($('chestHotbar'), game.inv.hotbar, 'hotbar');
  }
}

// ====================================================== glisser-déposer
function onSlotDown(e, section, idx, chestPos) {
  e.preventDefault();
  const arr = sectionArr(section); if (!arr) return;
  const s = arr[idx];
  if (e.shiftKey) { if (s) quickMove(section, idx, chestPos); return; }
  if (!s) return;
  drag = { section, idx, chestPos, item: s.item, count: s.count, split: e.button === 2 };
  showGhost(e);
}
function onSlotUp(section, idx, chestPos) {
  if (!drag) return;
  const from = drag, to = { section, idx, chestPos };
  drag = null; hideGhost();
  doMove(from, to);
}
function showGhost(e) {
  const g = $('dragGhost');
  const n = drag.split ? Math.ceil(drag.count / 2) : drag.count;
  g.innerHTML = slotInner({ item: drag.item, count: n });
  g.hidden = false; moveGhost(e);
}
function moveGhost(e) { const g = $('dragGhost'); g.style.left = e.clientX + 'px'; g.style.top = e.clientY + 'px'; }
function hideGhost() { $('dragGhost').hidden = true; }
function cancelDrag() { drag = null; hideGhost(); }
addEventListener('mousemove', e => { if (drag) moveGhost(e); });
addEventListener('mouseup', () => { if (drag) cancelDrag(); }); // relâché hors d'un slot → annule
addEventListener('contextmenu', e => { if (anyPanelOpen()) e.preventDefault(); });

function doMove(from, to) {
  const samePos = from.section === to.section && from.idx === to.idx &&
    (from.section !== 'chest' || (from.chestPos?.tx === to.chestPos?.tx && from.chestPos?.ty === to.chestPos?.ty));
  if (samePos) return;
  // coffre↔craft direct interdit (incohérent : passe par l'inventaire)
  if ((isCraft(from.section) && to.section === 'chest') || (from.section === 'chest' && isCraft(to.section))) return;

  if (isCraft(from.section) || isCraft(to.section)) {
    clientMove(from, to);          // réservation client (grille de craft)
    if (invOpen) renderInvUI();
    renderHotbar();
  } else {                         // sections serveur : autorité serveur
    socket.emit('mine:invMove', {
      from: { section: from.section, idx: from.idx, chestPos: from.chestPos },
      to: { section: to.section, idx: to.idx, chestPos: to.chestPos },
      splitHalf: !!from.split
    });
  }
}
function clientMove(from, to) {
  const sa = sectionArr(from.section), da = sectionArr(to.section);
  if (!sa || !da) return;
  const src = sa[from.idx]; if (!src) return;
  const max = stackOf(src.item);
  const qty = from.split ? Math.ceil(src.count / 2) : src.count;
  const dst = da[to.idx];
  if (!dst) {
    da[to.idx] = { item: src.item, count: qty };
    src.count -= qty; if (src.count <= 0) sa[from.idx] = null;
  } else if (dst.item === src.item) {
    const take = Math.min(max - dst.count, qty);
    if (take <= 0) return;
    dst.count += take; src.count -= take; if (src.count <= 0) sa[from.idx] = null;
  } else if (qty === src.count && !from.split) {
    sa[from.idx] = dst; da[to.idx] = src;
  }
}
function findDest(section, chestPos, item) {
  const arr = sectionArr(section); if (!arr) return -1;
  const max = stackOf(item);
  for (let i = 0; i < arr.length; i++) if (arr[i] && arr[i].item === item && arr[i].count < max) return i;
  for (let i = 0; i < arr.length; i++) if (!arr[i]) return i;
  return -1;
}
// Maj+clic : envoie la pile vers l'autre zone (hotbar↔sac, ou inventaire↔coffre)
function quickMove(section, idx, chestPos) {
  let target;
  if (chestOpen) target = section === 'chest'
    ? { section: 'bag' }
    : { section: 'chest', chestPos: { tx: chestState.tx, ty: chestState.ty } };
  else if (invOpen) target = isCraft(section) ? { section: 'bag' } : { section: section === 'hotbar' ? 'bag' : 'hotbar' };
  else return;
  let di = findDest(target.section, target.chestPos, sectionArr(section)[idx].item);
  let tsec = target.section, tpos = target.chestPos;
  if (di < 0 && chestOpen && section === 'chest') { di = findDest('hotbar', null, sectionArr(section)[idx].item); tsec = 'hotbar'; tpos = null; }
  if (di < 0) return;
  doMove({ section, idx, chestPos, split: false }, { section: tsec, idx: di, chestPos: tpos });
}

// ====================================================== craft (aperçu + exécution)
function updateCraftPreview() {
  const out = $('craftOutput');
  const r = matchRecipe(activeCraft(), nearTable ? 'table' : 'none');
  out._recipe = r || null;
  if (r) { out.innerHTML = slotInner({ item: r.out[0], count: r.out[1] }); out.classList.add('ready'); out.title = `${itemName(r.out[0])} ×${r.out[1]} — clic pour fabriquer`; }
  else { out.innerHTML = ''; out.classList.remove('ready'); out.title = ''; }
}
function doCraft() {
  const grid = activeCraft();
  const r = matchRecipe(grid, nearTable ? 'table' : 'none');
  if (!r) return;
  const snapshot = grid.map(c => c ? { item: c.item, count: c.count } : null);
  for (let i = 0; i < grid.length; i++) grid[i] = null;   // vide la grille (le serveur consomme dans l'inventaire réel)
  socket.emit('mine:craftGrid', { grid: snapshot });
  updateCraftPreview(); renderInvUI();
}

// ====================================================== établi à portée (client)
function isNearBlock(blockId) {
  const ctx = pxToTileX(game.me.x), cty = pxToTileY(game.me.y - MINE.playerH / 2);
  for (let tx = ctx - 3; tx <= ctx + 3; tx++)
    for (let ty = cty - 3; ty <= cty + 3; ty++) {
      if (tx < 0 || tx >= WORLD_W || ty < 0 || ty >= WORLD_H) continue;
      if (game.loaded.has(chunkKeyOfTile(tx, ty)) && game.world[tileIndex(tx, ty)] === blockId) return true;
    }
  return false;
}
function setNearTable(v) {
  if (v === nearTable) { $('tableTag').hidden = !v; return; }
  // la grille qui va être masquée rend ses items à l'inventaire (réservation annulée)
  const oldGrid = nearTable ? craft3 : craft2;
  for (let i = 0; i < oldGrid.length; i++) if (oldGrid[i]) { invAdd(game.inv, oldGrid[i].item, oldGrid[i].count); oldGrid[i] = null; }
  nearTable = v;
  $('tableTag').hidden = !v;
  renderHotbar();
  if (invOpen) renderInvUI();
}

// ====================================================== menu ESC + sous-panneaux
$('btnCloseInv').onclick = closeInventory;
$('btnCloseChest').onclick = closeChest;
$('btnSmelt').onclick = () => socket.emit('mine:smelt');
$('craftOutput').addEventListener('mousedown', e => { e.preventDefault(); doCraft(); });
$('escResume').onclick = closeEsc;
$('escSave').onclick = () => { socket.emit('mine:save'); showToast('💾 Sauvegarde en cours…'); };
$('escStats').onclick = () => { socket.emit('mine:statsRequest'); $('statsContent').textContent = 'Chargement…'; showEscSub('statsPanel'); };
$('escSetCode').onclick = () => { renderEscCode(); showEscSub('setCodePanel'); };
$('escKeybinds').onclick = () => { capturingAction = null; renderKeybinds(); showEscSub('keybindPanel'); };
$('escQuit').onclick = () => quitGame();
$('statsBack').onclick = hideEscSub;
$('setCodeBack').onclick = hideEscSub;
$('keybindBack').onclick = () => { capturingAction = null; hideEscSub(); };
$('keybindReset').onclick = () => { keybinds = { ...DEFAULT_KEYBINDS }; saveKeybinds(); rebuildKeyIndex(); renderKeybinds(); };

// ---- panneau touches ----
const KB_LABELS = {
  moveLeft: 'Aller à gauche', moveRight: 'Aller à droite', jump: 'Sauter',
  openInv: "Ouvrir l'inventaire", attack: 'Attaquer', teleport: 'Focus téléportation',
  slot1: 'Hotbar 1', slot2: 'Hotbar 2', slot3: 'Hotbar 3', slot4: 'Hotbar 4', slot5: 'Hotbar 5',
  slot6: 'Hotbar 6', slot7: 'Hotbar 7', slot8: 'Hotbar 8', slot9: 'Hotbar 9'
};
const KB_ORDER = ['moveLeft', 'moveRight', 'jump', 'openInv', 'attack', 'teleport',
  'slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7', 'slot8', 'slot9'];
function keyLabel(code) {
  if (!code) return '—';
  return code.replace('ArrowLeft', '←').replace('ArrowRight', '→').replace('ArrowUp', '↑').replace('ArrowDown', '↓')
    .replace('Space', 'Espace').replace(/^Key/, '').replace(/^Digit/, '');
}
function renderKeybinds() {
  const list = $('keybindList'); list.innerHTML = '';
  for (const action of KB_ORDER) {
    const row = document.createElement('div'); row.className = 'keybind-row';
    const label = document.createElement('span'); label.textContent = KB_LABELS[action]; row.appendChild(label);
    const btn = document.createElement('button');
    btn.className = 'ghost small key-btn' + (capturingAction === action ? ' capturing' : '');
    btn.textContent = capturingAction === action ? '…' : keyLabel(keybinds[action]);
    btn.onclick = () => { capturingAction = action; $('keybindHint').textContent = `Appuie sur une touche pour « ${KB_LABELS[action]} » (Échap pour annuler)`; renderKeybinds(); };
    row.appendChild(btn); list.appendChild(row);
  }
}
function applyKeyCapture(code) {
  if (code === 'Escape') { capturingAction = null; $('keybindHint').textContent = 'Annulé.'; renderKeybinds(); return; }
  const action = capturingAction;
  const conflict = Object.keys(keybinds).find(a => a !== action && keybinds[a] === code);
  if (conflict) { $('keybindHint').innerHTML = `<span class="warn">⚠️ « ${keyLabel(code)} » était sur « ${KB_LABELS[conflict]} » → réassignée ici.</span>`; keybinds[conflict] = ''; }
  else $('keybindHint').textContent = '';
  keybinds[action] = code; capturingAction = null;
  saveKeybinds(); rebuildKeyIndex(); renderKeybinds();
}

// ---- panneau stats ----
function labelOf(k) { return /^\d+$/.test(k) ? itemName(+k) : k; }
function renderStats() {
  const el = $('statsContent'); if (!el || !statsData) return;
  const s = statsData;
  const sum = o => Object.values(o || {}).reduce((a, b) => a + b, 0);
  const detail = o => { const d = Object.entries(o || {}).filter(([, v]) => v > 0).map(([k, v]) => `${labelOf(k)}: ${v}`).join(', '); return d ? ` (${d})` : ''; };
  const mins = Math.floor((s.playtime_seconds || 0) / 60), secs = Math.floor((s.playtime_seconds || 0) % 60);
  const rows = [
    ['Blocs minés', sum(s.blocks_mined) + detail(s.blocks_mined)],
    ['Blocs posés', sum(s.blocks_placed) + detail(s.blocks_placed)],
    ['Items craftés', sum(s.items_crafted) + detail(s.items_crafted)],
    ['Zombies tués', s.zombies_killed || 0],
    ['Dégâts infligés', s.damage_dealt || 0],
    ['Dégâts reçus', s.damage_taken || 0],
    ['Distance parcourue', `${Math.round(s.distance_walked || 0)} tuiles`],
    ['Sauts', s.jumps || 0],
    ['Temps de jeu', `${mins} min ${secs} s`],
    ['Sauvegardes manuelles', s.manual_saves || 0]
  ];
  el.innerHTML = rows.map(([k, v]) => `<div class="stat-row"><span>${k}</span><b>${v}</b></div>`).join('');
}

// ---- panneau changement de code ----
function renderEscCode() { $('curCode').textContent = game?.code || ''; $('newCodeInput').value = ''; $('setCodeError').textContent = ''; }
$('newCodeInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('newCodeInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('setCodeConfirm').click(); } });
$('setCodeConfirm').onclick = () => {
  const code = $('newCodeInput').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code)) { $('setCodeError').textContent = 'Code invalide (4 à 8 lettres/chiffres).'; return; }
  socket.emit('mine:setCode', { newCode: code }, res => {
    if (res?.ok) { $('setCodeError').textContent = ''; hideEscSub(); }
    else $('setCodeError').textContent = {
      bad_code: 'Code invalide.', same_code: "C'est déjà le code actuel.",
      code_taken: 'Ce code est déjà utilisé.', no_room: 'Indisponible pour le moment.'
    }[res?.error] || 'Échec du changement de code.';
  });
};

// ---------------------------------------------------------------- téléportation
function doTeleport() {
  if (!game) return;
  const dispX = parseInt($('tpX').value, 10);
  const y = parseInt($('tpY').value, 10);
  if (!Number.isFinite(dispX) || !Number.isFinite(y)) return;
  socket.emit('mine:teleport', { dispX, y });
  // mise à jour locale immédiate (le serveur confirme via mine:teleportOk)
  const tx = displayXToTileX(dispX);
  game.me.x = tx * TILE + TILE / 2; game.me.y = y * TILE; game.me.vx = 0; game.me.vy = 0;
  renderer.centerOn(game.me.x, game.me.y);
}
$('btnTeleport').onclick = doTeleport;
for (const id of ['tpX', 'tpY']) $(id).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doTeleport(); } });

// ---------------------------------------------------------------- quitter / avis
function quitGame() {
  socket.emit('room:leave');
  myRoom = null; game = null;
  closeAllPanels();
  show('menu');
}
$('btnQuitPlaying').onclick = quitGame;
$('btnNoticeMenu').onclick = () => { myRoom = null; game = null; show('menu'); };

socket.on('room:closed', () => { if (game) { game = null; myRoom = null; show('menu'); } });
socket.on('disconnect', () => {
  if (game && !game.over) {
    game.over = true;
    $('noticeTitle').textContent = '😵 Connexion au serveur perdue';
    $('noticeOverlay').hidden = false;
  }
});

// ---------------------------------------------------------------- boucle
let lastTs = performance.now();
function frame(ts) {
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;

  if (game && !game.over) {
    const work0 = performance.now();
    requestChunks();

    const ready = neighborhoodLoaded();
    if (ready) {
      const input = { left: keys.left, right: keys.right, jumpPressed: jumpQueued, jumpHeld: keys.jump };
      jumpQueued = false;
      const wasGround = game.me.onGround, px = game.me.x;
      stepPlayer(game.me, input, dt, { world: game.world });
      pendingStats.distance_walked += Math.abs(game.me.x - px) / TILE;       // stats : distance
      if (input.jumpPressed && wasGround && !game.me.onGround) pendingStats.jumps++; // stats : sauts
      setNearTable(isNearBlock(BLOCK.CRAFTING_TABLE));                        // établi à portée (UI/craft)
    }
    // la caméra suit le joueur (déjà déplacé) AVANT le calcul de la visée/minage,
    // pour que surbrillance, cible de minage et rendu utilisent la même caméra.
    renderer.update({ x: game.me.x, y: game.me.y }, dt);
    if (ready) updateMining(dt);

    // interpolation des autres joueurs + zombies
    const k = 1 - Math.exp(-18 * dt);
    for (const o of game.others.values()) lerpEntity(o, k);
    for (const z of game.zombies.values()) lerpEntity(z, k);

    updateHud();
    renderer.draw(buildView(ready));
    window.__mineDebug = { code: game.code, ready, loaded: game.loaded.size, x: pxToTileX(game.me.x) - WORLD_OFFSET_X, y: pxToTileY(game.me.y) }; // hook de test
    hud.markFrame(performance.now() - work0);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function lerpEntity(e, k) {
  const t = e.target;
  if (t.x === undefined) return;
  if (Math.abs(t.x - e.disp.x) > 400 || Math.abs(t.y - e.disp.y) > 400) { e.disp.x = t.x; e.disp.y = t.y; }
  else { e.disp.x += (t.x - e.disp.x) * k; e.disp.y += (t.y - e.disp.y) * k; }
}

function updateMining(dt) {
  if (mouse.right) return;                  // priorité à la pose/attaque
  if (!mouse.left || anyPanelOpen()) { mining = null; return; }
  const aim = aimTileNow();
  if (!withinReach(aim.tx, aim.ty)) { mining = null; return; }
  const id = game.loaded.has(chunkKeyOfTile(aim.tx, aim.ty)) ? game.world[tileIndex(aim.tx, aim.ty)] : -1;
  const tool = toolMeta(heldItem(game.inv)?.item);
  const secs = id >= 0 ? miningSeconds(id, tool) : Infinity;
  if (id <= 0 || !Number.isFinite(secs) || secs <= 0) { mining = null; return; } // air/bedrock/inconnu
  if (!mining || mining.tx !== aim.tx || mining.ty !== aim.ty) mining = { tx: aim.tx, ty: aim.ty, acc: 0 };
  mining.acc += dt;
  if (mining.acc >= secs) {
    socket.emit('mine:break', { tx: aim.tx, ty: aim.ty });
    mining = null;
  }
}

function updateHud() {
  // pxToTileX/Y (Math.floor) = la convention du moteur : le spawn (centré sur la
  // tuile) lit X 0, et une téléportation vers X affiché D y revient exactement.
  $('coordX').textContent = pxToTileX(game.me.x) - WORLD_OFFSET_X;
  $('coordY').textContent = pxToTileY(game.me.y);
}

function buildView(ready) {
  const players = [{
    x: game.me.x, y: game.me.y, f: game.me.f, hp: game.me.hp, maxHp: MINE.maxHp,
    name: storedName() || 'toi', color: colorFor(socket.id), me: true
  }];
  for (const [id, o] of game.others) {
    players.push({ x: o.disp.x, y: o.disp.y, f: o.target.f || 1, hp: o.hp, maxHp: MINE.maxHp, name: o.name, color: o.color });
  }
  const zombies = [];
  for (const z of game.zombies.values()) zombies.push({ x: z.disp.x, y: z.disp.y, f: z.target.f || 1, hp: z.hp, maxHp: z.maxHp });

  // tuile visée (surbrillance), seulement quand aucun overlay n'est ouvert
  let aim = null;
  if (!anyPanelOpen()) {
    const a = aimTileNow();
    aim = { tx: a.tx, ty: a.ty, valid: withinReach(a.tx, a.ty) };
  }
  const miningView = mining ? { tx: mining.tx, ty: mining.ty, progress: miningProgress() } : null;

  return {
    focus: { x: game.me.x, y: game.me.y },
    dayTime: game.dayTime,
    blockAt: blockForRender,
    players, zombies, aim, mining: miningView
  };
}

function miningProgress() {
  const id = game.loaded.has(chunkKeyOfTile(mining.tx, mining.ty)) ? game.world[tileIndex(mining.tx, mining.ty)] : -1;
  const secs = id >= 0 ? miningSeconds(id, toolMeta(heldItem(game.inv)?.item)) : Infinity;
  return Number.isFinite(secs) && secs > 0 ? mining.acc / secs : 0;
}

// ---------------------------------------------------------------- envoi position ~25 Hz
setInterval(() => {
  if (game && !game.over && socket.connected && neighborhoodLoaded()) {
    socket.emit('mine:move', { x: game.me.x, y: game.me.y, vx: game.me.vx, vy: game.me.vy, f: game.me.f });
  }
}, 40);

// ---------------------------------------------------------------- stats par lots (5 s)
setInterval(() => {
  if (!game || game.over || !socket.connected) return;
  if (pendingStats.jumps > 0) { socket.emit('mine:statInc', { key: 'jumps', val: pendingStats.jumps }); pendingStats.jumps = 0; }
  const d = Math.round(pendingStats.distance_walked);
  if (d >= 1) { socket.emit('mine:statInc', { key: 'distance_walked', val: d }); pendingStats.distance_walked -= d; }
}, 5000);
