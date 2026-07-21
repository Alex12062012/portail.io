/**
 * unit-tag.mjs — tests unitaires de la logique de manche (sans réseau).
 * 1. Mode élimination (4 joueurs) : période d'explosion raccourcie à 1 s via
 *    opts.eliminationSeconds → booms, spectateurs, classement, gagnant.
 * 2. Mode classique (1v1) : manche raccourcie à 2 s via opts.roundSeconds →
 *    fin au timer, perdant = it courant.
 *
 *   node tests/unit-tag.mjs
 */
import assert from 'node:assert';
import { createTagGame } from '../server/games/tag-arena.js';
import { MAPS, PHYS } from '../shared/tag-map.js';
import { createPhysState, stepPlayer } from '../shared/tag-physics.js';

function makeIo(log) {
  return { to: () => ({ emit: (ev, data) => log.push({ ev, data }) }) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================================================ élimination
{
  const log = [];
  const room = { code: 'TEST', isPublic: true, status: 'lobby' };
  let ended = null;
  const game = createTagGame(makeIo(log), room, {
    eliminationSeconds: 1,
    mapId: 'forest',
    onEnd: (r, info) => { ended = info; }
  });

  game.addHuman('human:1', 'Alex');
  game.fillWithBots(4);
  assert.strictEqual(game._players.size, 4, '4 joueurs (1 humain + 3 bots)');
  game.start();
  assert.strictEqual(game._mode(), 'elimination', '4 joueurs → mode élimination');
  assert.strictEqual(game.map.id, 'forest', 'carte forcée pour le test');

  const startEv = log.find(e => e.ev === 'game:start');
  assert.strictEqual(startEv.data.mapId, 'forest', 'game:start transporte la carte');
  assert.strictEqual(startEv.data.mode, 'elimination', 'game:start transporte le mode');
  // période (1 s) + 0,3 s d'extra sur la dernière seconde (TAG.lastSecondExtraMs)
  assert.ok(startEv.data.snapshot.t <= 1.31, 'compte à rebours initial ≤ période + extra');

  // l'humain reste immobile sur son spawn
  const meSnap = startEv.data.snapshot.players.find(p => p.id === 'human:1');
  game.handleMove('human:1', { x: meSnap.x, y: meSnap.y, vx: 0, vy: 0, f: 1 });

  // on déroule en temps réel : 3 booms à ~1 s d'intervalle puis fin
  const deadMoves = new Map(); // id -> position figée à l'explosion
  const t0 = Date.now();
  while (Date.now() - t0 < 6000 && !ended) {
    game.tick(1 / 30);
    for (const e of log.filter(l => l.ev === 'tag:boom')) {
      const p = game._players.get(e.data.playerId);
      if (p && !deadMoves.has(e.data.playerId)) {
        deadMoves.set(e.data.playerId, { x: p.pos.x, y: p.pos.y });
      }
    }
    await sleep(1000 / 30);
  }

  assert.ok(ended && !ended.aborted, 'la manche se termine normalement');
  const booms = log.filter(e => e.ev === 'tag:boom');
  assert.strictEqual(booms.length, 3, '3 explosions pour 4 joueurs');
  assert.deepStrictEqual(booms.map(b => b.data.place), [4, 3, 2], 'places 4e, 3e, 2e');
  assert.deepStrictEqual(booms.map(b => b.data.remaining), [3, 2, 1], 'survivants 3, 2, 1');

  // timing : 1ère explosion à ~1 s, suivantes espacées de ~1 s
  // (vérifié indirectement : 3 booms en < 6 s avec période 1 s)

  // chaque victime était le "it" de l'instant et devient spectatrice
  for (const b of booms) {
    const p = game._players.get(b.data.playerId);
    assert.ok(p && p.alive === false, `${b.data.name} est marqué mort`);
  }

  // un bot éliminé ne bouge plus (position figée après son explosion)
  const firstDead = booms[0].data.playerId;
  const frozen = deadMoves.get(firstDead);
  const pDead = game._players.get(firstDead);
  assert.ok(Math.hypot(pDead.pos.x - frozen.x, pDead.pos.y - frozen.y) < 1,
    'un joueur explosé ne bouge plus');

  // après chaque boom (sauf le dernier), un nouveau it parmi les vivants
  const endEv = log.find(e => e.ev === 'tag:end');
  assert.strictEqual(endEv.data.mode, 'elimination');
  assert.strictEqual(endEv.data.ranking.length, 4, 'classement complet (4)');
  assert.strictEqual(endEv.data.ranking[0].rank, 1);
  assert.strictEqual(endEv.data.ranking[0].id, endEv.data.winnerId, '1er = gagnant');
  // le gagnant est le seul jamais explosé
  assert.ok(!booms.some(b => b.data.playerId === endEv.data.winnerId), 'le gagnant n\'a pas explosé');
  // dernier du classement = premier explosé
  assert.strictEqual(endEv.data.ranking[3].id, booms[0].data.playerId, 'premier explosé = dernier');
  assert.strictEqual(endEv.data.ranking[1].id, booms[2].data.playerId, 'dernier explosé = 2e');

  // les états portent le flag dead et le bon mode (le dernier état est émis
  // juste avant le 3e boom : il compte donc 2 morts ; la 3e élimination est
  // notifiée par tag:boom + tag:end)
  const lastState = [...log].reverse().find(e => e.ev === 'tag:state').data;
  assert.strictEqual(lastState.mode, 'elimination');
  assert.strictEqual(lastState.players.filter(p => p.dead).length, 2, '2 morts dans le dernier snapshot');

  console.log('  ✔ mode élimination : 3 booms, spectateurs figés, classement 1-4 cohérent');
}

// ============================================================ classique 1v1
{
  const log = [];
  const room = { code: 'DUEL', isPublic: false, status: 'lobby' };
  let ended = null;
  const game = createTagGame(makeIo(log), room, {
    roundSeconds: 2,
    mapId: 'space',
    onEnd: (r, info) => { ended = info; }
  });

  game.addHuman('h:1', 'Alice');
  game.addHuman('h:2', 'Bob');
  game.start();
  assert.strictEqual(game._mode(), 'classic', '2 joueurs → mode classique');

  const startEv = log.find(e => e.ev === 'game:start');
  assert.ok(startEv.data.snapshot.t > 1.9 && startEv.data.snapshot.t <= 2.01, 'timer initial = roundSeconds');

  const t0 = Date.now();
  while (Date.now() - t0 < 3000 && !ended) {
    game.tick(1 / 30);
    await sleep(1000 / 30);
  }

  assert.ok(ended && !ended.aborted, 'fin normale au timer');
  const endEv = log.find(e => e.ev === 'tag:end');
  assert.strictEqual(endEv.data.mode, 'classic', 'fin en mode classique');
  assert.ok(!log.some(e => e.ev === 'tag:boom'), 'aucune explosion en 1v1');
  assert.strictEqual(endEv.data.loserId, game._itId(), 'le perdant est le it courant');
  assert.strictEqual(endEv.data.winners.length, 1, '1 gagnant');
  console.log('  ✔ mode classique 1v1 : timer, pas de boom, perdant = chat');
}

// ============================================================ choix de carte
{
  // sans mapId forcé : la carte est dans MAPS et on évite la répétition
  const room = { code: 'MAPS', isPublic: true, status: 'lobby', lastMapId: null };
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const g = createTagGame(makeIo([]), room, {});
    assert.ok(MAPS.some(m => m.id === g.map.id), 'carte choisie parmi MAPS');
    if (i > 0) {
      // lastMapId vaut la carte précédente : pas de répétition immédiate
      // (room.lastMapId est mis à jour par createTagGame)
    }
    seen.add(g.map.id);
  }
  assert.ok(seen.size >= 4, `variété de cartes sur 12 tirages (${seen.size})`);
  // répétition immédiate impossible
  let prev = null;
  for (let i = 0; i < 30; i++) {
    const g = createTagGame(makeIo([]), room, {});
    if (prev !== null) assert.notStrictEqual(g.map.id, prev, 'pas deux fois la même carte de suite');
    prev = g.map.id;
  }
  console.log(`  ✔ sélection de carte : aléatoire, sans répétition immédiate (${seen.size} cartes vues / 12)`);
}

// ============================================================ bots en bordure
{
  // Régression : un bot qui "veut" aller au-delà d'un bord de la carte ne doit
  // pas rester plaqué contre le mur (la physique annule vx au clamp). Le bot
  // doit inverser sa direction et décoller du bord en moins d'~1 s.
  const room = { code: 'EDGE', isPublic: true, status: 'lobby' };
  const game = createTagGame(makeIo([]), room, { mapId: 'desert' });
  game.addHuman('h:1', 'Alex');
  game.fillWithBots(4);
  game.start();

  const HW = PHYS.playerW / 2;
  const bot = [...game._players.values()].find(p => p.bot && p.id !== game._itId());
  assert.ok(bot, 'un bot non-it est disponible');

  // on le plaque contre le bord gauche avec une envie PERSISTANTE d'aller
  // encore plus à gauche (objectif hors carte), et on le rend intouchable pour
  // qu'il reste non-it (sinon il poursuivrait et quitterait le mur autrement)
  bot.pos.x = HW;
  bot.pos.y = game.map.ground.y;
  bot.pos.vx = 0;
  bot.pos.onGround = true;
  bot.immuneUntil = Date.now() + 60_000;
  bot.ai.decideT = 1e9; // ne pas reconsidérer l'objectif pendant le test
  bot.ai.objective = { x: -300, y: game.map.ground.y, until: Date.now() + 60_000 };

  let maxX = bot.pos.x;
  for (let i = 0; i < 45; i++) { // ~1,5 s à 30 Hz
    game.tick(1 / 30);
    maxX = Math.max(maxX, bot.pos.x);
  }
  assert.ok(maxX > HW + 60,
    `un bot plaqué au bord s'en décolle (maxX=${maxX.toFixed(0)} > ${(HW + 60).toFixed(0)})`);
  console.log('  ✔ anti-blocage bordure : un bot ne reste pas collé au mur > 1 s');
}

// ============================================================ rampe (pente)
{
  // Carte synthétique : sol + une rampe descendante (x1,y1)->(x2,y2).
  const ramp = { x1: 200, y1: 700, x2: 600, y2: 900 };
  const map = {
    width: 1000, height: 960,
    ground: { x: 0, y: 920, w: 1000, h: 40 },
    platforms: [], pads: [], teleporters: [], ramps: [ramp]
  };
  const sy = x => ramp.y1 + (ramp.y2 - ramp.y1) * ((x - ramp.x1) / (ramp.x2 - ramp.x1));

  // 1) on tombe sur la rampe → on s'y pose (pas de chute au travers)
  const p = createPhysState(250, 600);
  for (let i = 0; i < 40; i++) stepPlayer(p, {}, 1 / 30, { map });
  assert.ok(p.onGround, 'le joueur se pose sur la rampe');
  assert.ok(Math.abs(p.y - sy(p.x)) < 2, `posé à la hauteur de la pente (${p.y.toFixed(1)} ≈ ${sy(p.x).toFixed(1)})`);

  // 2) on marche vers la droite (descente) : le y suit la pente, jamais de chute
  // au sol ni à travers la rampe, et on reste au contact
  let offRamp = false;
  for (let i = 0; i < 40; i++) {
    stepPlayer(p, { right: true }, 1 / 30, { map });
    if (p.x <= ramp.x2 && (Math.abs(p.y - sy(p.x)) > 4 || !p.onGround)) offRamp = true;
  }
  assert.ok(!offRamp, 'en descendant la pente le joueur reste collé à la rampe (pas de chute/blocage)');
  assert.ok(p.x > 300, `le joueur a bien avancé sur la pente (x=${p.x.toFixed(0)})`);

  // 3) demi-tour : on remonte la pente (le y diminue, on reste au sol)
  const xBefore = p.x, yBefore = p.y;
  for (let i = 0; i < 30; i++) stepPlayer(p, { left: true }, 1 / 30, { map });
  assert.ok(p.x < xBefore && p.y < yBefore, 'en remontant la pente le joueur monte (x et y diminuent)');
  assert.ok(p.onGround && Math.abs(p.y - sy(p.x)) < 4, 'toujours au contact de la pente en montant');

  console.log('  ✔ rampe : on marche dessus en montant/descendant, sans chute au travers');
}

console.log('✅ unit-tag.mjs : tous les asserts passent');
process.exit(0);
