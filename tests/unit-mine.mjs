/**
 * unit-mine.mjs — tests serveur de Mine Coop (sans réseau) : génération
 * déterministe, minage + gating d'outil, fabrication, pose, cycle jour/nuit +
 * zombies + combat, sauvegarde/rechargement, plafond LRU. Utilise un faux `io`
 * et un dossier de sauvegardes temporaire (MINE_SAVES_DIR) pour ne jamais
 * toucher aux vrais mondes.
 *
 *   node tests/unit-mine.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-saves-'));
process.env.MINE_SAVES_DIR = tmp;

const W = await import('../shared/mine-world.js');
const { createMineGame } = await import('../server/games/mine-coop.js');
const { writeSave, loadSaveIfExists, listSaves } = await import('../server/mine-save.js');

let passed = 0;
const ok = (cond, label) => { assert.ok(cond, label); passed++; console.log(`  ✔ ${label}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function newGame(opts = {}) {
  const log = [];
  const io = { to: t => ({ emit: (ev, data) => log.push({ t, ev, data }) }) };
  const room = { code: opts.code || 'TST', gameType: 'mine-coop', isPublic: false, status: 'lobby', players: new Map(), game: null };
  const game = createMineGame(io, room, opts);
  room.game = game;
  return { game, io, log, room };
}

try {
  // -------------------------------------------------- génération déterministe
  const g1 = W.generateWorld(2024);
  const g2 = W.generateWorld(2024);
  let identical = g1.world.length === g2.world.length;
  for (let i = 0; i < g1.world.length && identical; i++) if (g1.world[i] !== g2.world[i]) identical = false;
  ok(identical, 'génération déterministe (même seed → monde identique)');
  ok(g1.world[W.tileIndex(g1.spawnTileX, W.WORLD_H - 1)] === W.BLOCK.BEDROCK, 'bedrock indestructible au fond');

  // ---------------------------------------------------------- démarrage solo
  const { game, log } = newGame({ seed: 42, code: 'TST' });
  const p = game.addHuman('p1', 'Alex');
  game.start();
  const gs = log.find(e => e.ev === 'game:start');
  ok(gs && gs.data.spawn && gs.data.you && gs.data.you.inv, 'game:start émis avec spawn + inventaire');
  ok(game.isRunning(), 'la partie tourne immédiatement (pas de lobby)');

  const world = game._world();
  const stx = W.pxToTileX(p.x), hs = W.pxToTileY(p.y);
  ok(W.blockAt(world, stx, hs) === W.BLOCK.GRASS, 'herbe sous le spawn');

  // ------------------------------------------------------- minage main (herbe)
  game.handleBreak('p1', { tx: stx, ty: hs });
  ok(W.blockAt(world, stx, hs) === W.BLOCK.AIR, 'bloc miné → air');
  ok(W.invCount(p.inv, W.BLOCK.DIRT) === 1, 'herbe minée à la main → 1 terre');

  // ------------------------------------------- gating d'outil (pierre)
  let stoneTy = -1;
  for (let ty = hs + 1; ty < W.WORLD_H - 3; ty++) if (W.blockAt(world, stx, ty) === W.BLOCK.STONE) { stoneTy = ty; break; }
  ok(stoneTy > 0, 'pierre trouvée sous la surface');
  game.handleMove('p1', { x: stx * W.TILE + 16, y: stoneTy * W.TILE, vx: 0, vy: 0, f: 1 });
  game.handleBreak('p1', { tx: stx, ty: stoneTy });
  ok(W.blockAt(world, stx, stoneTy) === W.BLOCK.AIR, 'pierre cassée à la main');
  ok(W.invCount(p.inv, W.BLOCK.COBBLE) === 0, 'pierre à la main → aucun drop (tier insuffisant)');
  p.inv.hotbar[1] = { item: W.ITEM.WOOD_PICKAXE, count: 1 }; p.inv.sel = 1;
  game.handleBreak('p1', { tx: stx, ty: stoneTy + 1 });
  ok(W.invCount(p.inv, W.BLOCK.COBBLE) === 1, 'pierre à la pioche bois → 1 pierre taillée');

  // ----------------------------------------------------------- fabrication
  p.inv.sel = 0;
  W.invAdd(p.inv, W.BLOCK.LOG, 3);
  game.handleCraft('p1', { recipeId: 'planks' });
  ok(W.invCount(p.inv, W.BLOCK.PLANKS) === 4 && W.invCount(p.inv, W.BLOCK.LOG) === 2, '1 bûche → 4 planches');
  game.handleCraft('p1', { recipeId: 'sticks' });
  ok(W.invCount(p.inv, W.ITEM.STICK) === 4, '2 planches → 4 bâtons');
  // outil d'établi : échoue sans établi à portée
  W.invAdd(p.inv, W.BLOCK.PLANKS, 6);
  game.handleCraft('p1', { recipeId: 'wood_axe' });
  ok(W.invCount(p.inv, W.ITEM.WOOD_AXE) === 0, 'pas de hache sans établi à portée');
  world[W.tileIndex(stx + 1, stoneTy)] = W.BLOCK.CRAFTING_TABLE; // établi posé à côté
  game.handleCraft('p1', { recipeId: 'wood_axe' });
  ok(W.invCount(p.inv, W.ITEM.WOOD_AXE) === 1, 'hache en bois fabriquée près de l\'établi');

  // smelt : fer brut + charbon → lingot près d'un fourneau
  world[W.tileIndex(stx + 1, stoneTy + 1)] = W.BLOCK.FURNACE;
  W.invAdd(p.inv, W.ITEM.RAW_IRON, 2); W.invAdd(p.inv, W.ITEM.COAL, 1);
  game.handleSmelt('p1');
  for (let i = 0; i < 90; i++) game.tick(0.1); // 9 s > 8 s de fonte
  ok(W.invCount(p.inv, W.ITEM.IRON_INGOT) === 1, 'fer brut fondu → 1 lingot de fer');

  // ------------------------------------------------------------------- pose
  p.inv.hotbar[2] = { item: W.BLOCK.DIRT, count: 5 }; p.inv.sel = 2;
  const before = W.invCount(p.inv, W.BLOCK.DIRT);
  game.handlePlace('p1', { tx: stx, ty: stoneTy + 1 }); // air, voisin solide en dessous
  ok(W.blockAt(world, stx, stoneTy + 1) === W.BLOCK.DIRT, 'bloc posé dans le monde');
  ok(W.invCount(p.inv, W.BLOCK.DIRT) === before - 1, 'pose → 1 bloc consommé');

  // -------------------------------------------------- jour/nuit + zombies
  game._setDayTime(0.7); // nuit
  for (let i = 0; i < 120 && game._zombies.size === 0; i++) game.tick(0.1);
  const hadZombies = game._zombies.size;
  ok(hadZombies >= 1, 'des zombies apparaissent la nuit');

  // combat : un zombie à côté du joueur, tué à l'épée
  const z = [...game._zombies.values()][0];
  game.handleMove('p1', { x: z.x - 10, y: z.y, vx: 0, vy: 0, f: 1 });
  p.inv.hotbar[3] = { item: W.ITEM.IRON_SWORD, count: 1 }; p.inv.sel = 3;
  z.hp = 5; p.attackCd = 0;
  game.handleAttack('p1', { dir: 1 });
  ok(!game._zombies.has(z.id), 'zombie tué à l\'épée');

  // dégâts au contact : la vie baisse
  const z2 = game._zombies.size ? [...game._zombies.values()][0] : null;
  if (z2) {
    p.hp = 100; p.immuneUntil = 0; z2.hurtCd = 0;
    game.handleMove('p1', { x: z2.x, y: z2.y, vx: 0, vy: 0, f: 1 });
    game.tick(0.05);
    ok(p.hp < 100, 'le contact d\'un zombie inflige des dégâts');
  } else { ok(true, '(pas de 2e zombie pour le test de contact — ignoré)'); }

  // aube : tous les zombies disparaissent
  game._setDayTime(0.7);
  for (let i = 0; i < 60 && game._zombies.size === 0; i++) game.tick(0.1);
  const beforeDawn = game._zombies.size;
  game._setDayTime(0.949);
  game.tick(0.6); // franchit 0.95 → jour
  ok(beforeDawn > 0 && game._zombies.size === 0, `zombies (${beforeDawn}) disparaissent à l'aube`);

  // ------------------------------------------------- sauvegarde / rechargement
  game.save();
  const saved = loadSaveIfExists('TST');
  ok(saved && saved.world && saved.inventories.Alex, 'sauvegarde écrite (monde + inventaire par pseudo)');
  const r2 = newGame({ code: 'TST', save: saved });
  r2.game.addHuman('q1', 'Alex'); // même pseudo → inventaire restauré
  r2.game.start();
  const w2 = r2.game._world();
  ok(W.blockAt(w2, stx, hs) === W.BLOCK.AIR, 'monde rechargé conserve les blocs minés');
  const restored = [...r2.game._players.values()][0];
  ok(W.invCount(restored.inv, W.ITEM.IRON_INGOT) === 1, 'inventaire restauré par pseudo (lingot conservé)');

  // ============================= craft par grille + coffres + stats + save
  {
    const slot = (item, count = 1) => ({ item, count });
    const { game: cg, log: clog } = newGame({ seed: 7, code: 'CRF' });
    const cp = cg.addHuman('c1', 'Cara');
    cg.start();
    const cw = cg._world();
    const ctx2 = W.pxToTileX(cp.x), cty = W.pxToTileY(cp.y);
    const P = W.BLOCK.PLANKS, S = W.ITEM.STICK;

    // craftGrid 2×2 : 4 planches → 1 établi (station 'none')
    W.invAdd(cp.inv, P, 4);
    cg.handleCraftGrid('c1', { grid: [slot(P), slot(P), slot(P), slot(P)] });
    ok(W.invCount(cp.inv, W.BLOCK.CRAFTING_TABLE) === 1 && W.invCount(cp.inv, P) === 0,
      'craftGrid 2×2 : 4 planches → 1 établi');

    // craftGrid 3×3 pioche bois : refusée sans établi, acceptée à portée
    W.invAdd(cp.inv, P, 3); W.invAdd(cp.inv, S, 2);
    const g3 = [slot(P), slot(P), slot(P), null, slot(S), null, null, slot(S), null];
    cg.handleCraftGrid('c1', { grid: g3 });
    ok(W.invCount(cp.inv, W.ITEM.WOOD_PICKAXE) === 0, 'craftGrid 3×3 refusée sans établi à portée');
    cw[W.tileIndex(ctx2 + 1, cty)] = W.BLOCK.CRAFTING_TABLE;
    cg.handleCraftGrid('c1', { grid: g3 });
    ok(W.invCount(cp.inv, W.ITEM.WOOD_PICKAXE) === 1, 'craftGrid 3×3 pioche bois près de l\'établi');

    // invMove : pile entière hotbar→bag, puis split de moitié
    cp.inv.hotbar[0] = slot(W.BLOCK.DIRT, 10); cp.inv.main[0] = null;
    cg.handleInvMove('c1', { from: { section: 'hotbar', idx: 0 }, to: { section: 'bag', idx: 0 } });
    ok(cp.inv.hotbar[0] === null && cp.inv.main[0]?.item === W.BLOCK.DIRT && cp.inv.main[0].count === 10,
      'invMove hotbar→bag (pile entière)');
    cg.handleInvMove('c1', { from: { section: 'bag', idx: 0 }, to: { section: 'bag', idx: 1 }, splitHalf: true });
    ok(cp.inv.main[0].count === 5 && cp.inv.main[1]?.count === 5, 'invMove splitHalf : 10 → 5 + 5');

    // coffre : pose, ouvre, dépose ; diffusion à la room + persistance
    const cpos = { tx: ctx2 + 1, ty: cty - 1 };
    cw[W.tileIndex(cpos.tx, cpos.ty)] = W.BLOCK.CHEST;
    cg.handleChestOpen('c1', cpos);
    const chestData = clog.filter(e => e.ev === 'mine:chestData').pop();
    ok(chestData && chestData.data.slots.length === 27, 'chestOpen → mine:chestData (27 slots)');
    cg.handleInvMove('c1', { from: { section: 'bag', idx: 0 }, to: { section: 'chest', idx: 0, chestPos: cpos } });
    ok(cg._chests.get(cpos.tx + ',' + cpos.ty)[0]?.item === W.BLOCK.DIRT, 'invMove bag→coffre');
    const chestUpd = clog.filter(e => e.ev === 'mine:chestUpdate').pop();
    ok(chestUpd && chestUpd.t === 'CRF', 'mine:chestUpdate diffusé à toute la room');

    // stats : pilotées client (jumps) + refus des clés serveur, items_crafted serveur
    cg.handleStatInc('c1', { key: 'jumps', val: 3 });
    cg.handleStatInc('c1', { key: 'zombies_killed', val: 99 });
    ok(cp.stats.jumps === 3 && cp.stats.zombies_killed === 0, 'statInc : jumps accepté, clé serveur refusée');
    ok(cp.stats.items_crafted.crafting_table === 1 && cp.stats.items_crafted.wood_pickaxe === 1,
      'items_crafted incrémentées par craftGrid');

    // save manuel + statsRequest
    cg.handleSave('c1');
    const saveOk = clog.filter(e => e.ev === 'mine:saveOk').pop();
    ok(saveOk && cp.stats.manual_saves === 1, 'handleSave → mine:saveOk + manual_saves++');
    cg.handleStatsRequest('c1');
    const statsData = clog.filter(e => e.ev === 'mine:statsData').pop();
    ok(statsData && statsData.data.stats.jumps === 3, 'statsRequest → mine:statsData');

    // rechargement : coffre + stats restaurés
    const creSaved = loadSaveIfExists('CRF');
    ok(creSaved?.chests?.[cpos.tx + ',' + cpos.ty] && creSaved.playerStats?.Cara, 'save inclut coffres + stats');
    const cr2 = newGame({ code: 'CRF', save: creSaved });
    cr2.game.addHuman('c2', 'Cara'); cr2.game.start();
    ok(cr2.game._chests.get(cpos.tx + ',' + cpos.ty)?.[0]?.item === W.BLOCK.DIRT, 'coffre conservé après rechargement');
    ok([...cr2.game._players.values()][0].stats.jumps === 3, 'stats restaurées par pseudo (jumps)');
  }

  // ------------------------------------------------------------- plafond LRU
  const lruDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-lru-'));
  process.env.MINE_SAVES_DIR = lruDir;
  const emptyWorld = W.encodeWorld(W.newWorldArray());
  const mk = code => ({ version: 1, code, seed: 1, dayTime: 0, world: emptyWorld, inventories: {} });
  for (const c of ['LRA', 'LRB', 'LRC', 'LRD', 'LRE']) { writeSave(c, mk(c)); await sleep(6); }
  ok(listSaves().length === 5, '5 mondes sauvegardés');
  writeSave('LRF', mk('LRF')); // 6e → évince le plus ancien
  const after = listSaves();
  ok(after.length === 5, 'plafond LRU : toujours 5 mondes max');
  ok(!after.find(s => s.code === 'LRA'), 'le plus ancien (LRA) est supprimé');
  ok(after.find(s => s.code === 'LRF'), 'le nouveau monde (LRF) est conservé');

  console.log(`\n✅ unit-mine.mjs : ${passed} vérifications passées`);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  try { if (process.env.MINE_SAVES_DIR !== tmp) fs.rmSync(process.env.MINE_SAVES_DIR, { recursive: true, force: true }); } catch {}
}
