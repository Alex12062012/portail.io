// Tests de l'entraînement — node natif, aucun framework.
//   node public/games/valorant/tools/train/train.test.js
//
// Couvre les quatre points qui, s'ils cassent, rendent une nuit d'entraînement
// inutile sans que ça se voie : convergence CMA-ES, barème de récompense,
// sélection du modèle par ELO, et repli quand models/ est vide.
import assert from 'node:assert/strict';
import { CMAES } from './cmaes.js';
import {
  REWARD_CONFIG, ROLE_REWARD, scoreRound, playMatch, evaluate,
  toProfile, toVector, GENE_ORDER,
} from './reward-shaping.js';
import { estimateElo, trancheOf, TRANCHES, REF_ELO } from './elo_estimator.js';
import { registerModels, getModelForBot, BotController } from '../../js/bots/bot_controller.js';
import { botParams } from '../../js/bots/bot_difficulty.js';
import { paramsOf } from '../../js/bots/bot_profile.js';
import { MAPS } from '../../js/maps/map_loader.js';

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

// Générateur déterministe : les tests ne doivent pas dépendre de la chance.
function lcg(seed = 42) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

console.log('\n— CMA-ES —');

test('converge sur la sphère (optimum à 0.7)', () => {
  const N = 7, target = 0.7;
  const es = new CMAES(new Array(N).fill(0.1), 0.3, { lambda: 12, rand: lcg(7) });
  const sphere = (x) => -x.reduce((s, v) => s + (v - target) ** 2, 0); // on maximise
  for (let g = 0; g < 300; g++) {
    const xs = es.ask();
    es.tell(xs, xs.map(sphere));
  }
  const err = Math.sqrt(-es.best.fitness);
  assert.ok(err < 1e-3, `distance à l'optimum ${err} >= 1e-3`);
  assert.ok(es.best.fitness > -1e-6, `fitness ${es.best.fitness} trop basse`);
});

test('sigma reste borné et la moyenne se déplace vers l\'optimum', () => {
  const es = new CMAES([0.1, 0.1, 0.1], 0.3, { lambda: 8, rand: lcg(3) });
  for (let g = 0; g < 120; g++) { const xs = es.ask(); es.tell(xs, xs.map((x) => -x.reduce((s, v) => s + v * v, 0))); }
  assert.ok(es.sigma > 0 && es.sigma <= 1, `sigma hors bornes : ${es.sigma}`);
  assert.ok(Math.hypot(...es.xmean) < 0.05, `xmean pas revenu vers 0 : ${es.xmean}`);
});

test('aller-retour vecteur <-> profil', () => {
  const v = [0.1, 0.25, 0.5, 0.75, 0.9, 0.3, 0.6];
  const back = toVector(toProfile(v));
  v.forEach((x, i) => assert.ok(Math.abs(x - back[i]) < 1e-9, `gène ${GENE_ORDER[i]} : ${x} != ${back[i]}`));
});

console.log('\n— Reward shaping —');

const base = { role: 'none', attacked: false, won: false, duration: 0, events: [] };
const round = (over = {}) => ({ ...base, ...over });
const delta = (over, role = 'none') => scoreRound(round(over), role) - scoreRound(base, 'none');

test('barème de base : une valeur exacte par action', () => {
  assert.equal(scoreRound(base, 'none'), REWARD_CONFIG.roundLoss, 'round perdu');
  assert.equal(delta({ won: true }), REWARD_CONFIG.roundWin - REWARD_CONFIG.roundLoss, 'round gagné');
  assert.equal(delta({ events: [{ type: 'kill', t: 1, mine: true }] }), REWARD_CONFIG.kill, 'kill');
  assert.equal(delta({ events: [{ type: 'death', t: 1 }] }), REWARD_CONFIG.death, 'mort');
  assert.equal(delta({ attacked: true, duration: 30, events: [{ type: 'planted', t: 5, mine: true }] }),
    REWARD_CONFIG.plant, 'spike posé');
  assert.equal(delta({ events: [{ type: 'defused', t: 5, mine: true }] }), REWARD_CONFIG.defuse, 'spike désamorcé');
});

test('kill/pose d\'un autre bot ne compte pas pour le nôtre', () => {
  assert.equal(delta({ events: [{ type: 'kill', t: 1, mine: false, ally: true }] }), 0);
  assert.equal(delta({ attacked: true, duration: 30, events: [{ type: 'planted', t: 5, mine: false }] }), 0);
});

test('pénalité de non-pose : -1/s après 30 s, attaque uniquement', () => {
  assert.equal(delta({ attacked: true, duration: 30 }), 0, 'pas de pénalité avant 30 s');
  assert.equal(delta({ attacked: true, duration: 75 }), -45, '75 s sans pose');
  assert.equal(delta({ attacked: false, duration: 75 }), 0, 'la défense n\'est jamais pénalisée');
  assert.equal(delta({ attacked: true, duration: 75, events: [{ type: 'planted', t: 40, mine: false }] }), -10,
    'la pénalité s\'arrête à la pose');
});

test('déplacement : plus aucune récompense', () => {
  assert.equal(REWARD_CONFIG.movement, 0);
});

test('bonus entry : premier kill du site dans les 10 s', () => {
  const ev = (t, mine) => [{ type: 'kill', t, mine, site: 'A' }];
  assert.equal(delta({ role: 'entry', events: ev(6, true) }, 'entry'), REWARD_CONFIG.kill + ROLE_REWARD.entry.firstSiteKill);
  assert.equal(delta({ role: 'entry', events: ev(12, true) }, 'entry'), REWARD_CONFIG.kill, 'trop tard');
  assert.equal(delta({ role: 'entry', events: [{ type: 'kill', t: 3, mine: false, site: 'A' }, ...ev(6, true)] }, 'entry'),
    REWARD_CONFIG.kill, 'pas le premier du site');
  assert.equal(delta({ role: 'entry', events: [{ type: 'kill', t: 6, mine: true, site: null }] }, 'entry'),
    REWARD_CONFIG.kill, 'kill hors site');
});

test('bonus support : trade dans les 2.2 s après un entry allié', () => {
  const lead = { type: 'kill', t: 10, mine: false, ally: true, byRole: 'entry' };
  assert.equal(delta({ role: 'support', events: [lead, { type: 'kill', t: 11.5, mine: true }] }, 'support'),
    REWARD_CONFIG.kill + ROLE_REWARD.support.trade);
  assert.equal(delta({ role: 'support', events: [lead, { type: 'kill', t: 13, mine: true }] }, 'support'),
    REWARD_CONFIG.kill, 'hors fenêtre');
  const solo = { type: 'kill', t: 10, mine: false, ally: true, byRole: 'lurker' };
  assert.equal(delta({ role: 'support', events: [solo, { type: 'kill', t: 11, mine: true }] }, 'support'),
    REWARD_CONFIG.kill, 'l\'allié n\'était pas entry');
});

test('bonus lurker : kill dans le dos', () => {
  assert.equal(delta({ role: 'lurker', events: [{ type: 'kill', t: 5, mine: true, back: true }] }, 'lurker'),
    REWARD_CONFIG.kill + ROLE_REWARD.lurker.backKill);
  assert.equal(delta({ role: 'lurker', events: [{ type: 'kill', t: 5, mine: true, back: false }] }, 'lurker'),
    REWARD_CONFIG.kill);
});

test('bonus anchor : tenu / quitté sans contact', () => {
  assert.equal(delta({ role: 'anchor', events: [{ type: 'held' }] }, 'anchor'), ROLE_REWARD.anchor.held);
  assert.equal(delta({ role: 'anchor', events: [{ type: 'leftNoContact' }] }, 'anchor'), ROLE_REWARD.anchor.leftWithoutContact);
});

test('bonus roamer : rotation suivie d\'un contact sous 5 s', () => {
  const rot = { type: 'rotation', t: 20, site: 'B' };
  assert.equal(delta({ role: 'roamer', events: [rot, { type: 'enemyOnSite', t: 23, site: 'B' }] }, 'roamer'),
    ROLE_REWARD.roamer.rotation);
  assert.equal(delta({ role: 'roamer', events: [rot, { type: 'enemyOnSite', t: 30, site: 'B' }] }, 'roamer'), 0, 'trop tard');
  assert.equal(delta({ role: 'roamer', events: [rot, { type: 'enemyOnSite', t: 22, site: 'A' }] }, 'roamer'), 0, 'autre site');
});

test('bonus rotator : arrivée sous 14 s après le premier contact', () => {
  const contact = { type: 'enemyOnSite', t: 10, site: 'A' };
  assert.equal(delta({ role: 'rotator', events: [contact, { type: 'arrival', t: 20, site: 'A' }] }, 'rotator'),
    ROLE_REWARD.rotator.arrival);
  assert.equal(delta({ role: 'rotator', events: [contact, { type: 'arrival', t: 30, site: 'A' }] }, 'rotator'), 0, 'trop lent');
  assert.equal(delta({ role: 'rotator', events: [contact, { type: 'arrival', t: 12, site: 'B' }] }, 'rotator'), 0, 'autre site');
});

test('les bonus de rôle ne s\'appliquent que dans les rounds où le bot porte ce rôle', () => {
  // Index 0 : entry en attaque, anchor en défense. Un round d'anchor ne doit pas
  // déclencher le bonus d'entry, sinon les deux rôles apprendraient la même chose.
  assert.equal(delta({ role: 'anchor', events: [{ type: 'kill', t: 3, mine: true, site: 'A' }] }, 'entry'),
    REWARD_CONFIG.kill);
});

console.log('\n— Estimation d\'ELO —');

test('formule Elo inverse et bornage du winrate', () => {
  assert.equal(Math.round(estimateElo(0.5, 1500)), 1500, '50 % = même niveau');
  assert.ok(estimateElo(1, 1500, 20) < 1500 + 700, '20/20 ne doit pas donner l\'infini');
  assert.ok(estimateElo(0, 1500, 20) > 1500 - 700, '0/20 non plus');
  assert.ok(estimateElo(0.75, 1500) > estimateElo(0.6, 1500), 'monotone');
});

test('tranches', () => {
  assert.equal(trancheOf(1200), 0);
  assert.equal(trancheOf(1700), 1);
  assert.equal(trancheOf(2900), 3);
  assert.equal(trancheOf(50), 0, 'sous la première tranche');
  assert.equal(trancheOf(9000), TRANCHES.length - 1, 'au-dessus de la dernière');
});

console.log('\n— Sélection du modèle en jeu —');

const model = (role, eloRange, reaction) => ({
  role, eloRange, elo: (eloRange[0] + eloRange[1]) / 2,
  params: { reaction, fireInterval: 0.6, aimError: 1.5, headshotChance: 0.3, abilityChance: 0.7, aggression: 0.6, roam: 0.4 },
});
const CATALOG = TRANCHES.map((t, i) => model('entry', t, 0.5 - i * 0.05))
  .concat(TRANCHES.map((t, i) => model('anchor', t, 0.52 - i * 0.05)));

test('getModelForBot rend la tranche la plus proche de l\'ELO demandé', () => {
  registerModels(CATALOG);
  assert.deepEqual(getModelForBot('entry', 1200).eloRange, [1000, 1500]);
  assert.deepEqual(getModelForBot('entry', 1700).eloRange, [1500, 2000]);
  assert.deepEqual(getModelForBot('entry', 2600).eloRange, [2500, 3000]);
  assert.deepEqual(getModelForBot('entry', 400).eloRange, [1000, 1500], 'sous la plage : la plus basse');
  assert.deepEqual(getModelForBot('entry', 9000).eloRange, [2500, 3000], 'au-dessus : la plus haute');
  assert.equal(getModelForBot('lurker', 1700), null, 'rôle non entraîné => null');
});

test('un bot applique le modèle de son rôle, et bascule à chaud quand l\'ELO monte', () => {
  registerModels(CATALOG);
  const nav = MAPS.nexus.nav;
  const actor = { team: 0, role: null, ready: false, pos: { x: 0, y: 0, z: 0 }, model: { rotation: { y: 0 } } };
  const bc = new BotController(actor, 1200, nav);
  bc.newRound(0, 0); // équipe 0 attaque => rôle entry
  assert.equal(bc.role, 'entry');
  assert.deepEqual(bc.p, paramsOf(getModelForBot('entry', 1200).params), 'modèle de la tranche 1000-1500');

  // Rounds perdus : l'ELO monte (LOSS_BOOST) jusqu'à basculer de tranche.
  const before = bc.modelKey;
  let swaps = 0;
  for (let i = 0; i < 40 && swaps === 0; i++) { const k = bc.modelKey; bc.boost(); if (bc.modelKey !== k) swaps++; }
  assert.equal(swaps, 1, 'la montée d\'ELO doit changer de tranche');
  assert.notEqual(bc.modelKey, before);
  assert.deepEqual(bc.p, paramsOf(getModelForBot('entry', bc.elo).params), 'params du modèle de la nouvelle tranche');
  assert.equal(bc.a, actor, 'le bot ne doit pas être recréé');
  // Entre deux tranches, boost() continue de faire monter la compétence sans
  // rappliquer le modèle : le bot progresse au lieu de rester figé.
  const reaction = bc.p.reaction;
  bc.boost();
  assert.ok(bc.p.reaction < reaction, 'la compétence doit continuer de monter dans la tranche');

  bc.newRound(0, 1); // équipe 0 défend => rôle anchor => autre modèle
  assert.equal(bc.role, 'anchor');
  assert.deepEqual(bc.p, paramsOf(getModelForBot('anchor', bc.elo).params));
});

test('repli : models/ vide => comportement scripté par ELO, inchangé', () => {
  assert.equal(registerModels([]), 0);
  assert.equal(getModelForBot('entry', 1700), null);
  const nav = MAPS.nexus.nav;
  const actor = { team: 0, role: null, ready: false, pos: { x: 0, y: 0, z: 0 }, model: { rotation: { y: 0 } } };
  const bc = new BotController(actor, 1200, nav);
  bc.newRound(0, 0);
  assert.deepEqual(bc.p, botParams(1200), 'doit retomber sur bot_difficulty.js');
  assert.equal(bc.supportDelay, 2.2, 'constantes de comportement historiques');
});

test('repli : registerModels tolère les entrées invalides', () => {
  assert.equal(registerModels(null), 0);
  assert.equal(registerModels([{ role: 'entry' }, null, { params: {} }]), 0, 'aucun modèle complet');
});

console.log('\n— Match headless (bout en bout) —');

test('playMatch produit des rounds observés et exploitables', () => {
  registerModels([]);
  const { rounds, winner } = playMatch(null, { slot: 0 });
  assert.ok(rounds.length >= 3, `un Bo5 fait au moins 3 rounds, vu ${rounds.length}`);
  assert.ok(winner === 0 || winner === 1, 'un match doit avoir un vainqueur');
  for (const r of rounds) {
    assert.ok(['entry', 'support', 'lurker', 'anchor', 'roamer', 'rotator'].includes(r.role), `rôle ${r.role}`);
    assert.equal(typeof r.attacked, 'boolean');
    assert.ok(r.duration > 0, 'un round dure un temps positif');
    assert.ok(Number.isFinite(scoreRound(r, 'entry')), 'score fini');
    assert.equal(r._contact, undefined, 'l\'état interne ne doit pas fuiter dans le round');
  }
  // Le camp alterne à chaque round : les deux rôles de la place 0 doivent apparaître.
  const roles = new Set(rounds.map((r) => r.role));
  assert.ok(roles.has('entry') && roles.has('anchor'), `place 0 => entry + anchor, vu ${[...roles]}`);
  // Un match complet produit des éliminations, sinon l'observation est muette.
  assert.ok(rounds.some((r) => r.events.some((e) => e.type === 'kill')), 'aucun kill observé sur tout un match');
});

test('evaluate rend une fitness finie et un winrate valide', () => {
  const r = evaluate(null, { role: 'entry', matches: 2 });
  assert.ok(Number.isFinite(r.fitness), `fitness ${r.fitness}`);
  assert.ok(r.winRate >= 0 && r.winRate <= 1, `winrate ${r.winRate}`);
  assert.ok(r.avgRounds >= 3, `rounds/match ${r.avgRounds}`);
});

console.log(failures ? `\n❌ ${failures} test(s) en échec\n` : '\n✅ tous les tests passent\n');
process.exit(failures ? 1 : 0);
