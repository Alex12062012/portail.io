// Vérification des collisions — la seule logique qui casse en silence.
// Lancer avec index.html?test : résultat en console + pastille en haut à droite.
import { surfaceY, groundHeight, blocked, Player } from './player.js';
import { WEAPONS, CATS, Arsenal, damage, recoilAt, spreadOf } from './weapons.js';
import { AGENTS, Loadout } from './abilities.js';
import { Wallet, REWARD, roundReward } from './economy.js';
import { Spike, PLANT_TIME, FUSE_TIME, DEFUSE_CHECKPOINT } from './spike.js';
import { RoundManager, BUY_SECONDS, END_SECONDS, ROUND_TIMER_SECONDS, ROUNDS_TO_WIN } from './round_manager.js';
import { MAPS, toCollider, siteCenter } from './maps/map_loader.js';
import { assignTeams } from './matchmaking.js';
import { matchElo, globalElo, recentElo, record, history, BASE_ELO,
         recordSolo, soloHistory, soloWins } from './skill_tracker.js';
import { botParams, LOSS_BOOST } from './bots/bot_difficulty.js';
import { BotController, reassignRoles, ATK_ROLES, DEF_ROLES, getModelForBot } from './bots/bot_controller.js';
import { bearing } from './ui/damage_indicator.js';
import { award, awardMovement, ranking, POINTS } from './points.js';
import { randomProfile, clampProfile, mutate, paramsOf, behavior, niche, scaleProfile, selectProfiles, RANGES } from './bots/bot_profile.js';

const box = (min, max, ramp) => ({
  min: { x: min[0], y: min[1], z: min[2] },
  max: { x: max[0], y: max[1], z: max[2] },
  ramp,
});

let n = 0;
const ok = (cond, msg) => { n++; if (!cond) throw new Error('ÉCHEC — ' + msg); };
const near = (a, b, msg) => ok(Math.abs(a - b) < 1e-6, `${msg} (${a} ≠ ${b})`);

// surfaceY sur une boîte
const b = box([-1, 0, -1], [1, 2, 1]);
near(surfaceY(b, 0, 0), 2, 'dessus de boîte');
ok(surfaceY(b, 5, 0) === null, 'hors emprise');
near(surfaceY(b, 1.2, 0, 0.35), 2, 'emprise gonflée du rayon joueur');

// surfaceY sur une rampe
const r = box([0, 0, -1], [4, 2, 1], { axis: 'x', dir: 1 });
near(surfaceY(r, 0, 0), 0, 'pied de rampe');
near(surfaceY(r, 2, 0), 1, 'milieu de rampe');
near(surfaceY(r, 4, 0), 2, 'haut de rampe');
near(surfaceY(box([0, 0, -1], [4, 2, 1], { axis: 'x', dir: -1 }), 0, 0), 2, 'rampe inversée');

const sol = box([-50, -1, -50], [50, 0, 50]);
near(groundHeight({ x: 0, y: 3, z: 0 }, [sol, b]), 2, 'sol le plus haut sous le joueur');

// Stubs : le joueur tourne sans clavier ni caméra réels.
const noInput = {
  locked: false,
  down: () => false,
  consumePress: () => false,
  consumeMouse: () => ({ x: 0, y: 0 }),
};
const cam = { position: { set() {} }, rotation: {} };

// Chute libre puis atterrissage
const p = new Player({ x: 0, y: 5, z: 0 });
for (let i = 0; i < 120; i++) p.update(1 / 60, noInput, [sol], cam);
near(p.pos.y, 0, 'atterrit sur le sol');
ok(p.grounded, 'au sol après la chute');

// Mur : bloque en x, laisse glisser en z
const mur = box([1, 0, -10], [1.5, 4, 10]);
const q = new Player({ x: 0, y: 0, z: 0 });
q.grounded = true;
for (let i = 0; i < 60; i++) {
  q.vel.x = 5; // poussée continue contre le mur
  q.vel.z = 5;
  q.update(1 / 60, noInput, [sol, mur], cam);
}
ok(q.pos.x <= 1 - 0.35 + 1e-3, `arrêté par le mur (x=${q.pos.x.toFixed(3)})`);
ok(q.pos.z > 3, `glisse le long du mur (z=${q.pos.z.toFixed(3)})`);

// Rampe : on la monte sans sauter
const rampe = box([0, 0, -2], [6, 2, 2], { axis: 'x', dir: 1 });
const m = new Player({ x: -1, y: 0, z: 0 });
m.grounded = true;
for (let i = 0; i < 90; i++) {
  m.vel.x = 4;
  m.update(1 / 60, noInput, [sol, rampe], cam);
}
ok(m.pos.y > 1, `monte la rampe à pied, sans sauter (y=${m.pos.y.toFixed(2)})`);
ok(m.grounded, 'reste au sol pendant la montée');
near(m.pos.y, surfaceY(rampe, m.pos.x, 0), 'collé à la pente, pas flottant');

// --- Maps (prompt 5) : la donnée est saine ---------------------------------------
// Un spawn dans un mur ou un site sans sol ne casse pas au chargement — seulement
// en pleine partie. On vérifie donc chaque point remarquable des trois maps.
const spawnable = (pos, solids, what) => {
  ok(!blocked(pos, solids, 1.85), `${what} : hors des murs`);
  ok(groundHeight({ ...pos, y: pos.y + 0.1 }, solids) > -Infinity, `${what} : posé sur un sol`);
};
ok(Object.keys(MAPS).length === 3, '3 maps');
for (const [id, def] of Object.entries(MAPS)) {
  const solids = def.solids.map(toCollider);
  ok(def.sites.length === 2 && def.sites[0].name === 'A' && def.sites[1].name === 'B', `${id} : sites A et B`);
  // spawnSet en produit 5 par camp : on valide les ancres et l'emprise des 5.
  for (const [camp, a] of [['attaque', def.attack], ['défense', def.defense]]) {
    for (let i = 0; i < 5; i++) spawnable({ x: a.x + (i - 2) * 1.8, y: 0, z: a.z }, solids, `${id} spawn ${camp} ${i + 1}`);
  }
  for (const s of def.sites) spawnable({ ...siteCenter(s), y: 0 }, solids, `${id} centre du site ${s.name}`);
  for (const t of def.teleports ?? []) {
    spawnable({ x: t.exit.x, y: t.exit.y, z: t.exit.z }, solids, `${id} sortie de téléporteur`);
    spawnable({ x: (t.zone.min.x + t.zone.max.x) / 2, y: 0, z: (t.zone.min.z + t.zone.max.z) / 2 }, solids, `${id} pad de téléporteur`);
  }
}
ok((MAPS.vault.teleports ?? []).length === 2, 'vault : 2 téléporteurs à sens unique');
ok(MAPS.ridge.solids.filter((s) => s.ramp).length >= 4, 'ridge : rampes présentes (mid vertical + heavens)');

// --- Routes des bots (prompt 6) : chaque route est marchable de bout en bout ------
// Un marcheur suit la polyligne par pas de 0.4 m en collant au sol, avec un y
// CONTINU d'un segment à l'autre (monter une rampe puis longer le heaven doit
// marcher). Renvoie -1, ou l'index du segment fautif.
const walkRoute = (pts, solids) => {
  let y = groundHeight({ x: pts[0][0], y: 1, z: pts[0][1] }, solids);
  for (let i = 1; i < pts.length; i++) {
    const [fx, fz] = pts[i - 1], [tx, tz] = pts[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(tx - fx, tz - fz) / 0.4));
    for (let k = 1; k <= steps; k++) {
      const pos = { x: fx + ((tx - fx) * k) / steps, y, z: fz + ((tz - fz) * k) / steps };
      if (blocked(pos, solids, 1.85)) return i;
      y = groundHeight(pos, solids);
      if (y === -Infinity) return i;
    }
  }
  return -1;
};
for (const [id, def] of Object.entries(MAPS)) {
  const solids = def.solids.map(toCollider);
  ok(['atkA', 'atkB', 'defA', 'defB', 'rotAB'].every((k) => def.nav[k]), `${id} : routes de nav complètes`);
  for (const [key, route] of Object.entries(def.nav)) {
    // Les routes atk/def partent du spawn : on valide aussi le premier tronçon.
    const anchor = key.startsWith('atk') ? def.attack : key.startsWith('def') ? def.defense : null;
    const pts = anchor ? [[anchor.x, anchor.z], ...route] : route;
    const bad = walkRoute(pts, solids);
    ok(bad === -1, `${id} ${key} : route marchable (segment ${bad} bloqué)`);
  }
}

// --- Matchmaking (prompt 6) --------------------------------------------------------
const t1 = assignTeams([{ id: 'you', elo: 1000 }]);
ok(t1[0].humans.length === 1 && t1[0].bots === 2 && t1[1].bots === 3, '1 réel : 1+2 bots contre 3 bots');
const t2 = assignTeams([{ id: 'a', elo: 1000 }, { id: 'b', elo: 1200 }]);
ok(t2[0].humans.length === 1 && t2[1].humans.length === 1, '2 réels : jamais dans la même équipe');
const t3 = assignTeams([{ id: 'a', elo: 900 }, { id: 'b', elo: 1400 }, { id: 'c', elo: 1100 }]);
ok(t3[0].humans.length === 1 && t3[0].humans[0].id === 'b', '3 réels : le meilleur ELO joue seul');
ok(t3[1].humans.length === 2 && t3[1].bots === 1, '3 réels : les deux autres ensemble + 1 bot');
const t4 = assignTeams(['a', 'b', 'c', 'd'].map((id) => ({ id, elo: 1000 })));
ok(t4[0].humans.length === 2 && t4[1].humans.length === 2, '4 réels : répartition équilibrée 2/2');

// Effectifs asymétriques (prompt 14) : le 1v3.
const solo = assignTeams([{ id: 'you', elo: 0 }], [1, 3]);
ok(solo[0].humans.length === 1 && solo[0].bots === 0, '1v3 : le joueur est seul dans son équipe');
ok(solo[1].humans.length === 0 && solo[1].bots === 3, '1v3 : 3 bots en face');
// La signature à un seul nombre reste celle du 3v3.
const back = assignTeams([{ id: 'you', elo: 0 }]);
ok(back[0].bots === 2 && back[1].bots === 3, 'signature à une taille : 3v3 inchangé');

// --- Suivi de niveau (prompt 6), stockage factice : pas de localStorage sous node --
const fake = (() => { let v = null; return { getItem: () => v, setItem: (_, x) => { v = x; } }; })();
ok(globalElo(history(fake)) === BASE_ELO, 'sans historique : niveau de base');
record({ won: true, kills: 10, deaths: 2, roundsWon: 3, roundsLost: 1 }, fake);
record({ won: false, kills: 2, deaths: 8, roundsWon: 1, roundsLost: 3 }, fake);
const hist = history(fake);
ok(hist.length === 2 && !!hist[0].date && hist[0].roundsWon === 3, 'historique stocké (date, rounds, kills)');
near(globalElo(hist), (matchElo(hist[0]) + matchElo(hist[1])) / 2, 'niveau global = moyenne des parties');
for (let i = 0; i < 10; i++) record({ won: true, kills: 5, deaths: 5 }, fake);
near(recentElo(history(fake), 8), matchElo({ won: true, kills: 5, deaths: 5 }),
     'niveau récent : fenêtre glissante des dernières parties');

// --- Historique solo (prompt 14) : strictement séparé du 3v3 ----------------------
const soloStore = (() => { const v = {}; return { getItem: (k) => v[k] ?? null, setItem: (k, x) => { v[k] = x; } }; })();
record({ won: true, kills: 3, deaths: 1 }, soloStore);
recordSolo({ difficulty: 'hard', won: true, kills: 5, deaths: 2 }, soloStore);
recordSolo({ difficulty: 'hard', won: false, kills: 1, deaths: 3 }, soloStore);
recordSolo({ difficulty: 'easy', won: true, kills: 9, deaths: 0 }, soloStore);
ok(soloHistory(soloStore).length === 3, 'les parties solo vont dans leur propre historique');
ok(history(soloStore).length === 1, 'l’historique 3v3 ne gagne rien des parties solo');
ok(!!soloHistory(soloStore)[0].date && soloHistory(soloStore)[0].difficulty === 'hard',
   'une entrée solo porte sa date et sa difficulté');
ok(soloWins('hard', soloHistory(soloStore)) === 1, 'victoires comptées par niveau');
ok(soloWins('nightmare', soloHistory(soloStore)) === 0, 'niveau jamais gagné : 0');

// --- ELO -> comportement : monotone dans le bon sens --------------------------------
const weak = botParams(900), sharp = botParams(1550);
ok(sharp.reaction < weak.reaction, 'ELO haut : réagit plus vite');
ok(sharp.headshotChance > weak.headshotChance, 'ELO haut : vise plus souvent la tête');
ok(sharp.aimError < weak.aimError, 'ELO haut : moins d’erreur de visée');
ok(sharp.abilityChance > weak.abilityChance, 'ELO haut : capacités mieux employées');
ok(!weak.smartBuy && sharp.smartBuy, 'ELO haut : achats cohérents avec les crédits');
ok(LOSS_BOOST >= 1.02 && LOSS_BOOST <= 1.05, 'montée par round perdu : +2 à +5 %');

// --- Rôles des bots (prompt 10) ---------------------------------------------------
// BotController n'importe pas Three : il tourne ici tel quel.
const mkBots = (team, attackers) => [0, 1, 2].map((i) => {
  const b = new BotController(
    { team, pos: { x: 0, y: 0, z: 0 }, hp: 100, maxHp: 100, alive: true, wallet: new Wallet() },
    1000, MAPS.nexus.nav,
  );
  b.newRound(i, attackers);
  return b;
});
const atkBots = mkBots(0, 0);
const defBots = mkBots(1, 0);
ok(new Set(atkBots.map((b) => b.role)).size === 3, 'attaque : 3 rôles distincts dans l’équipe');
ok(new Set(defBots.map((b) => b.role)).size === 3, 'défense : 3 rôles distincts dans l’équipe');
ok(atkBots.every((b) => ATK_ROLES.includes(b.role)), 'les rôles d’attaque viennent bien d’ATK_ROLES');
ok(defBots.every((b) => DEF_ROLES.includes(b.role)), 'les rôles de défense viennent bien de DEF_ROLES');
// Stable sur le round : seul newRound réassigne.
const before = atkBots.map((b) => b.role);
for (let i = 0; i < 120; i++) atkBots.forEach((b) => b.patrolTick(1 / 60));
ok(atkBots.every((b, i) => b.role === before[i]), 'le rôle ne change pas en cours de round');
// Le même bot change de camp au round suivant : ses rôles suivent.
atkBots.forEach((b, i) => b.newRound(i, 1));
ok(atkBots.every((b) => DEF_ROLES.includes(b.role)), 'camp inversé : rôles de défense');

// roamer / rotator bougent leur site, l'anchor jamais. On compte les BASCULES :
// regarder seulement le site final raterait un aller-retour complet.
const flipsOver = (bot, seconds) => {
  let flips = 0, prev = bot.holdSite;
  for (let i = 0; i < 60 * seconds; i++) {
    bot.patrolTick(1 / 60);
    if (bot.holdSite !== prev) { flips++; prev = bot.holdSite; }
  }
  return flips;
};
const [anchor, roamer, rotator] = mkBots(1, 0);
ok(flipsOver(anchor, 40) === 0, 'anchor : ne quitte jamais son site');
// Seuil à 2 et non 3 : un modèle entraîné (models/index.json) peut donner un roam
// bas, donc un patrolEvery jusqu'à 14 s — soit 2 bascules sur 40 s. On vérifie ici
// qu'un roamer BOUGE (vs 0 pour l'anchor, 1 pour le rotator), pas sa cadence.
ok(flipsOver(roamer, 40) >= 2, 'roamer : fait la navette entre les sites');
ok(flipsOver(rotator, 40) === 1, 'rotator : bascule une seule fois, sans ennemi vu');
const seenRot = mkBots(1, 0)[2];
seenRot.sawEnemy = true;
ok(flipsOver(seenRot, 40) === 0, 'rotator : ne bascule pas s’il a vu un ennemi');

// --- Succession des rôles (prompt 13) ---------------------------------------------
const squad = (...spec) => spec.map(([role, alive]) => ({ actor: { alive, tag: role }, role }));

// entry mort : la liste se tasse, personne ne reste sur un rôle vacant.
const r1 = squad(['entry', false], ['support', true], ['lurker', true]);
const n1 = reassignRoles(r1, ATK_ROLES);
ok(n1.get(r1[1].actor) === 'entry', 'entry mort : le support est promu entry');
ok(n1.get(r1[2].actor) === 'support', 'entry mort : le lurker devient support');
ok(!n1.has(r1[0].actor), 'le mort ne reçoit aucun rôle');

// Un seul survivant : il prend le rôle le plus prioritaire, le reste est vacant.
const r2 = squad(['entry', false], ['support', false], ['lurker', true]);
const n2 = reassignRoles(r2, ATK_ROLES);
ok(n2.size === 1 && n2.get(r2[2].actor) === 'entry', 'dernier survivant : il devient entry');

// Aucune mort : l'affectation ne bouge pas.
const r3 = squad(['entry', true], ['support', true], ['lurker', true]);
const n3 = reassignRoles(r3, ATK_ROLES);
ok(r3.every((t) => n3.get(t.actor) === t.role), 'équipe intacte : les rôles sont inchangés');

// L'ordre d'entrée ne compte pas, seule la priorité du rôle tenu compte.
const r4 = squad(['lurker', true], ['entry', false], ['support', true]);
const n4 = reassignRoles(r4, ATK_ROLES);
ok(n4.get(r4[2].actor) === 'entry' && n4.get(r4[0].actor) === 'support',
   'succession triée par priorité, pas par ordre de liste');

// Même mécanique côté défense.
const r5 = squad(['anchor', false], ['roamer', true], ['rotator', true]);
const n5 = reassignRoles(r5, DEF_ROLES);
ok(n5.get(r5[1].actor) === 'anchor' && n5.get(r5[2].actor) === 'roamer',
   'défense : le roamer reprend l’ancrage du site');

// Équipe entièrement morte : rien à distribuer, pas de plantage.
ok(reassignRoles(squad(['entry', false]), ATK_ROLES).size === 0, 'équipe éliminée : aucune affectation');

// Promotion : l'état interne du bot suit son nouveau rôle.
const promoted = mkBots(0, 0)[1]; // support : il attend au départ
ok(promoted.role === 'support' && promoted.wait > 0, 'le support démarre en attente');
promoted.promote('entry');
ok(promoted.role === 'entry' && promoted.wait === 0, 'promu entry : il cesse d’attendre');
const anchored = mkBots(1, 0)[1]; // roamer
anchored.promote('anchor');
ok(flipsOver(anchored, 40) === 0, 'promu anchor : il cesse de patrouiller');
// Le rôle est bien porté par l'acteur — c'est ce qui rend joueur et bots lisibles pareil.
ok(anchored.a.role === 'anchor', 'le rôle est stocké sur l’acteur');

// --- Indicateur directionnel (prompt 10) : angle horaire, 0 = devant -------------
// Regard vers -Z ; +X est alors la droite du joueur.
near(bearing(0, -1, 0, -1), 0, 'source droit devant : 0°');
near(bearing(0, -1, 1, 0), 90, 'source à droite : +90°');
near(bearing(0, -1, -1, 0), -90, 'source à gauche : -90°');
near(Math.abs(bearing(0, -1, 0, 1)), 180, 'source dans le dos : 180°');

// --- Armes ---------------------------------------------------------------------

// Table : les 18 du brief + le couteau + les couteaux d'ultime de Jett.
ok(Object.keys(WEAPONS).length === 20, 'arsenal complet (18 + couteau + Blade Storm)');
for (const [k, w] of Object.entries(WEAPONS)) {
  ok(w.d.at(-1).r === Infinity, `${k} : dernière tranche de dégâts sans borne`);
  // Le couteau fait des dégâts plats : pas de headshot au corps à corps.
  if (w.cat !== 'melee') ok(w.d.every((t) => t.h > t.b && t.b >= t.l), `${k} : tête > corps >= jambes`);
}

// Dropoff : le Phantom perd des dégâts au-delà de 20 m, le Vandal non.
near(damage(WEAPONS.phantom, 'b', 10), 39, 'Phantom corps de près');
near(damage(WEAPONS.phantom, 'b', 35), 35, 'Phantom corps à 35 m');
near(damage(WEAPONS.vandal, 'h', 50), 160, 'Vandal tête sans dropoff');
ok(damage(WEAPONS.operator, 'b', 50) >= 150, 'Operator corps = kill sec');

// Recul : déterministe, montée d'abord, dérive latérale ensuite, sens opposé Vandal/Phantom.
near(recoilAt(WEAPONS.vandal, 3).y, recoilAt(WEAPONS.vandal, 3).y, 'recul reproductible');
ok(recoilAt(WEAPONS.vandal, 8).y > recoilAt(WEAPONS.vandal, 0).y, 'la montée s’installe');
near(recoilAt(WEAPONS.vandal, 2).x, 0, 'pas de dérive sur les 1ères balles');
ok(recoilAt(WEAPONS.vandal, 9).x * recoilAt(WEAPONS.phantom, 9).x < 0, 'Vandal et Phantom dérivent à l’opposé');
near(recoilAt(WEAPONS.marshal, 0).x, 0, 'sniper : flinch vertical, pas de pattern');

// Précision : bouger dégrade, l'Ares se stabilise en tirant, le rifle non.
ok(spreadOf(WEAPONS.vandal, 0, 1) > spreadOf(WEAPONS.vandal, 0, 0), 'tir en mouvement = imprécis');
ok(spreadOf(WEAPONS.spectre, 0, 1) < spreadOf(WEAPONS.vandal, 0, 1), 'SMG moins pénalisée en mouvement');
ok(spreadOf(WEAPONS.ares, 12, 0) < spreadOf(WEAPONS.ares, 0, 0), 'Ares gagne en précision en tirant');
ok(spreadOf(WEAPONS.vandal, 12, 0) > spreadOf(WEAPONS.vandal, 0, 0), 'rifle : le spray disperse');

// Cadence, chargeur, rechargement, sur une arme équipée.
const stub = { spread: 0, recoilYaw: 0, recoilPitch: 0, speedMult: 1 };
const held = new Set(), once = new Set([0]);
const gun = {
  down: () => false, consumePress: () => false,
  mouse: (b) => held.has(b), consumeClick: (b) => once.delete(b),
};
const shots = [];
const arsenal = new Arsenal(['vandal', 'classic', 'knife']);
const hitApi = { trace: () => [], onHit: () => {}, onShot: (w) => shots.push(w.name) };

held.add(0);
for (let i = 0; i < 60; i++) arsenal.update(1 / 60, gun, stub, hitApi); // 1 s gâchette tenue
ok(Math.abs(shots.length - WEAPONS.vandal.fps) <= 1, `Vandal ~9.75 tirs/s (mesuré ${shots.length})`);
near(arsenal.clip.mag, WEAPONS.vandal.mag - shots.length, 'chargeur décrémenté');
ok(arsenal.recoil.y > 0, 'le recul monte pendant le spray');
ok(stub.speedMult === 1, 'un rifle ne ralentit pas le joueur');

held.delete(0);
for (let i = 0; i < 120; i++) arsenal.update(1 / 60, gun, stub, hitApi); // 2 s gâchette relâchée
ok(arsenal.shots === 0, 'compteur de spray remis à zéro entre deux rafales');
ok(arsenal.recoil.y < 0.05, 'la caméra revient après le spray');

arsenal.clip.mag = 0;
arsenal.startReload();
ok(arsenal.reloadTotal === CATS.rifle.reload, 'durée de rechargement de la famille par défaut');
for (let i = 0; i < 200; i++) arsenal.update(1 / 60, gun, stub, hitApi);
near(arsenal.clip.mag, WEAPONS.vandal.mag, 'rechargement complet');

// Régression : le compteur restait négatif après un rechargement (truthy), ce qui
// bloquait définitivement les suivants — flagrant sur les snipers à petit chargeur.
ok(arsenal.reloading === 0, 'compteur de rechargement revenu exactement à 0');
arsenal.clip.mag = 0;
arsenal.startReload();
ok(arsenal.reloading > 0, 'un 2e rechargement démarre');
for (let i = 0; i < 200; i++) arsenal.update(1 / 60, gun, stub, hitApi);
near(arsenal.clip.mag, WEAPONS.vandal.mag, '2e rechargement complet');

// Durée propre à l'arme : le Marshal recharge plus vite que sa famille sniper.
arsenal.slots[0] = 'marshal';
arsenal.reset('marshal');
arsenal.index = -1;
arsenal.equip(0);
arsenal.clip.mag = 0;
arsenal.startReload();
near(arsenal.reloading, WEAPONS.marshal.reload, 'Marshal : durée spécifique (2.5 s)');
ok(WEAPONS.marshal.reload < CATS.sniper.reload, 'plus court que la famille (3.7 s)');
arsenal.slots[0] = 'vandal';
arsenal.reset('vandal');
arsenal.index = -1;
arsenal.equip(0);

// Classic en semi-auto : maintenir la gâchette ne doit tirer qu'une fois.
arsenal.equip(1);
shots.length = 0;
held.add(0);
for (let i = 0; i < 60; i++) arsenal.update(1 / 60, gun, stub, hitApi);
ok(shots.length === 1, `semi-auto : 1 tir par clic (mesuré ${shots.length})`);
held.delete(0);

// Odin : très forte pénalité de mouvement en tirant.
arsenal.slots[0] = 'odin';
arsenal.reset('odin');
arsenal.index = -1;
arsenal.equip(0);
held.add(0);
once.add(0);
arsenal.update(1 / 60, gun, stub, hitApi);
ok(stub.speedMult < 0.6, `l’Odin ralentit le tireur (${stub.speedMult})`);

// Blade Storm : précision parfaite, y compris en pleine course.
near(spreadOf(WEAPONS.bladestorm, 4, 1), 0, 'Blade Storm : précision 100 % en mouvement');
near(damage(WEAPONS.bladestorm, 'h', 40), 150, 'couteau lancé : 150 à la tête');

// --- Agents et capacités ---------------------------------------------------------

ok(Object.keys(AGENTS).length === 4, '4 agents');
for (const [k, a] of Object.entries(AGENTS)) {
  ok(a.abilities.length === 4, `${k} : 4 capacités`);
  ok(a.abilities.map((b) => b.key).join() === 'KeyC,KeyQ,KeyE,KeyX', `${k} : mapping C/Q/E/X`);
  ok(a.abilities[3].ult === true, `${k} : la 4e capacité est l'ultime`);
  ok(a.ultCost >= 6 && a.ultCost <= 8, `${k} : coût d'ultime plausible`);
  ok(Number.isInteger(a.color) && a.color > 0, `${k} : une couleur de modèle`);
}
ok(new Set(Object.values(AGENTS).map((a) => a.color)).size === 4, 'les 4 couleurs sont distinctes');

// Manette factice : on pousse des appuis dans une file, Loadout les consomme.
const press = new Set(), clicks = new Set();
const pad = {
  down: () => false,
  consumePress: (c) => press.delete(c),
  consumeClick: (b) => clicks.delete(b),
};
// ctx factice : enregistre l'effet appelé. heal/revive/rotate renvoient false —
// c'est le cas "pas de cible" / "je tourne le mur", où la charge ne part pas.
const calls = [];
const noTarget = new Set(['heal', 'revive', 'rotate']);
const fakeCtx = new Proxy({}, {
  // onCast est un hook optionnel (relais réseau), pas un effet de capacité :
  // undefined => `ctx.onCast?.()` reste sans effet, comme en jeu local.
  get: (_, name) => (name === 'onCast' ? undefined
    : () => { calls.push(name); return noTarget.has(name) ? false : undefined; }),
});
const tick = (l) => l.update(1 / 60, pad, fakeCtx);

const jett = new Loadout('jett', 2);
near(jett.ult, 2, 'jauge d’ultime pré-chargée (startingUltPoints)');
ok(!jett.ultReady, 'ultime indisponible sous son coût');

press.add('KeyC'); tick(jett);
ok(jett.equipped === 0, 'C équipe Cloudburst');
clicks.add(0); tick(jett);
ok(calls.at(-1) === 'lob', 'le clic gauche lance la fumée');
ok(jett.state[0].charges === 1, 'une des deux charges consommée');
ok(jett.equipped === -1, 'capacité rangée après le lancer');

press.add('KeyE'); tick(jett);
clicks.add(0); tick(jett);
ok(calls.at(-1) === 'dash', 'Tailwind déclenche le dash');
ok(jett.state[2].charges === 0 && jett.state[2].cd > 0, 'Tailwind part en cooldown');
for (let i = 0; i < 13 * 60; i++) tick(jett);
ok(jett.state[2].charges === 1, 'Tailwind rechargée après 12 s');

press.add('KeyX'); tick(jett);
ok(calls.at(-1) !== 'equipWeapon', 'ultime refusé tant que la jauge est incomplète');
jett.addUlt(10);
near(jett.ult, 7, 'la jauge plafonne au coût de l’ultime');
press.add('KeyX'); tick(jett);
ok(calls.at(-1) === 'equipWeapon' && jett.ult === 0, 'Blade Storm prend la main et vide la jauge');
press.add('KeyX'); tick(jett);
ok(calls.at(-1) === 'equipWeapon', 'couteaux en main : X les rééquipe sans repayer');

// Sky Smoke : 1 charge offerte par round, 2 de plus achetables à 100 cr (3 max).
const brim = new Loadout('brimstone', 0);
brim.resetRound();
ok(brim.state[2].charges === 1, 'Sky Smoke : 1 charge offerte au début du round');
press.add('KeyE'); tick(brim);
clicks.add(0); tick(brim);
ok(brim.equipped === -1 && brim.state[2].charges === 0, 'une fumée consomme une charge');
const bp = new Wallet(300);
ok(brim.buyCharge(2, bp) && brim.buyCharge(2, bp) && brim.buyCharge(2, bp)
   && brim.state[2].charges === 3 && bp.credits === 0, '3 charges rachetées à 100 cr pièce');
ok(!brim.buyCharge(2, new Wallet(9000)), 'au-delà de 3 charges : refusé');

// Hunter's Fury : 3 tirs pour un seul ultime.
const sova = new Loadout('sova', 0);
sova.addUlt(10);
press.add('KeyX'); tick(sova);
clicks.add(0); tick(sova);
clicks.add(0); tick(sova);
ok(sova.equipped === 3 && sova.ult === 7, 'Hunter’s Fury : encore équipé après 2 tirs');
clicks.add(0); tick(sova);
ok(sova.equipped === -1 && sova.ult === 0, '3e tir : l’ultime part');

const sage = new Loadout('sage', 0);
press.add('KeyE'); tick(sage);
clicks.add(0); tick(sage);
ok(sage.state[2].charges === 1 && sage.equipped === 2, 'soin sans allié visé : charge conservée');
press.add('KeyC'); tick(sage);
clicks.add(2); tick(sage);
ok(sage.equipped === 0 && sage.state[0].charges === 1, 'clic droit = rotation du mur, charge intacte');

sage.state[2].charges = 0;
sage.resetRound();
ok(sage.state[2].charges === 1, 'début de round : la capacité signature est rendue');
ok(sage.state[1].charges === 0, 'début de round : les capacités payantes sont à racheter');
ok(sage.equipped === -1, 'début de round : rien en main');

const purse = new Wallet(300);
ok(sage.buyCharge(1, purse) && sage.state[1].charges === 1 && purse.credits === 100,
   'achat d’une charge de Slow Orb');
ok(!sage.buyCharge(1, purse), 'seconde charge refusée faute de crédits');
ok(!sage.buyCharge(2, purse), 'une capacité signature ne s’achète pas');

// --- Économie ------------------------------------------------------------------------

near(roundReward({ won: true }), 3000, 'victoire de round');
near(roundReward({ won: true, kills: 2 }), 3400, 'victoire + 2 kills');
near(roundReward({ won: false, lossStreak: 0 }), 1900, '1re défaite');
near(roundReward({ won: false, lossStreak: 1 }), 2400, '2e défaite d’affilée');
near(roundReward({ won: false, lossStreak: 2 }), 2900, '3e défaite d’affilée');
near(roundReward({ won: false, lossStreak: 9 }), 2900, 'au-delà, la défaite ne rapporte pas plus');
near(roundReward({ won: false, planted: true }), 2200, 'prime de pose due même en perdant');
ok(roundReward({ won: false, survived: true }) >= REWARD.survivedLoss, 'plancher du survivant sans kill');

const purse2 = new Wallet(8800);
purse2.add(1000);
near(purse2.credits, 9000, 'crédits plafonnés à 9000');
ok(!purse2.spend(9500) && purse2.credits === 9000, 'achat refusé faute de crédits');
ok(purse2.spend(2900) && purse2.credits === 6100, 'achat débité');

// --- Spike ---------------------------------------------------------------------------

const sp = new Spike();
sp.tickPlant(2, true, true, { x: 1, y: 0, z: 2 });
ok(sp.state === 'carried', 'pose encore incomplète à 2 s');
sp.tickPlant(1, true, false, { x: 0, y: 0, z: 0 });
near(sp.plant, 0, 'sortir du site remet la pose à zéro');
sp.tickPlant(PLANT_TIME, true, true, { x: 1, y: 0, z: 2 });
ok(sp.planted && sp.pos.x === 1, 'posé après 4 s continues, position mémorisée');
ok(sp.everPlanted, 'la pose reste comptabilisée pour la prime');

sp.tickDefuse(3, true);
sp.tickDefuse(1, false);
near(sp.defuse, 0, 'lâcher avant 3.5 s : tout le désamorçage est perdu');
sp.tickDefuse(4, true);
sp.tickDefuse(1, false);
near(sp.defuse, DEFUSE_CHECKPOINT, 'après le checkpoint, la progression est conservée');
sp.tickDefuse(3.5, true);
ok(sp.state === 'defused', 'désamorcé à 7 s cumulées');

const sp2 = new Spike();
sp2.tickPlant(PLANT_TIME, true, true, { x: 0, y: 0, z: 0 });
near(sp2.beepRate, 1, 'bip simple au départ');
sp2.tick(26); near(sp2.beepRate, 2, 'double bip sous 20 s restantes');
sp2.tick(10); near(sp2.beepRate, 3, 'triple bip sous 10 s restantes');
sp2.tick(10); ok(sp2.state === 'exploded', 'explosion en fin de mèche');
sp2.tickDefuse(99, true);
ok(sp2.state === 'exploded', 'on ne désamorce pas un spike déjà explosé');

// --- Rounds --------------------------------------------------------------------------

const roster = [
  { team: 0, wallet: new Wallet(0), kills: 0, alive: true },
  { team: 1, wallet: new Wallet(0), kills: 0, alive: true },
];
const spikeR = new Spike();
let resets = 0;
const rm = new RoundManager({
  spike: spikeR,
  players: roster,
  aliveCount: (t) => roster.filter((p) => p.team === t && p.alive).length,
  resetRound: () => { resets++; roster.forEach((p) => { p.alive = true; }); },
});

ok(rm.round === 1 && rm.attackers === 0 && resets === 1, 'round 1 lancé, équipe 0 à l’attaque');
ok(rm.phase === 'buy', 'un round commence par la buy phase');
rm.update(BUY_SECONDS);
ok(rm.phase === 'live', 'buy phase close après 15 s');

roster[1].alive = false;
rm.update(0.1);
ok(rm.phase === 'end' && rm.score[0] === 1, 'défenseurs éliminés : round aux attaquants');
near(roster[0].wallet.credits, REWARD.win, 'le vainqueur touche 3000');
near(roster[1].wallet.credits, REWARD.loss[0], 'le perdant touche 1900');

rm.update(END_SECONDS);
ok(rm.round === 2 && rm.attackers === 1, 'switch de camp à chaque round');
rm.update(BUY_SECONDS);
rm.update(ROUND_TIMER_SECONDS);
ok(rm.phase === 'end' && rm.score[0] === 2, 'temps écoulé sans pose : round aux défenseurs');
near(rm.lossStreak[1], 2, 'streak de défaite de l’équipe 1');

rm.update(END_SECONDS);
ok(rm.attackers === 0, 'round 3 : les camps ont encore tourné');
rm.update(BUY_SECONDS);
spikeR.tickPlant(PLANT_TIME, true, true, { x: 0, y: 0, z: 0 });
// Attaquants tous morts APRÈS la pose : le round continue, la mèche décide.
roster[0].alive = false;
rm.update(1);
ok(rm.phase === 'live', 'après la pose, éliminer les attaquants ne suffit plus');
rm.update(FUSE_TIME);
ok(rm.winner === 0 && rm.phase === 'match', 'spike explosé : 3e round gagné, match terminé');
near(rm.score[0], ROUNDS_TO_WIN, 'match remporté à 3 rounds gagnés');

// --- Profil de bot (bot_profile.js) --------------------------------------------
{
  let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const prof = randomProfile(rnd);
  ok(Object.keys(RANGES).every((g) => prof[g] >= RANGES[g][0] && prof[g] <= RANGES[g][1]),
     'randomProfile : tous les gènes dans leurs bornes');
  const wild = clampProfile({ reaction: -5, aimError: 999, aggression: 2, roam: -1 });
  ok(wild.reaction >= RANGES.reaction[0] && wild.aimError <= RANGES.aimError[1]
     && wild.aggression <= 1 && wild.roam >= 0, 'clampProfile ramène tout dans les bornes');
  let allBounded = true;
  for (let i = 0; i < 200; i++) {
    const m = mutate(prof, 0.4, rnd);
    if (!Object.keys(RANGES).every((g) => m[g] >= RANGES[g][0] - 1e-9 && m[g] <= RANGES[g][1] + 1e-9)) allBounded = false;
  }
  ok(allBounded, 'mutate reste borné sur 200 mutations');
  const pr = paramsOf({ ...prof, reaction: 0.18 });
  ok(pr.reaction >= 0.18 && pr.aimError >= RANGES.aimError[0], 'paramsOf : jamais sous-humain (pas d’aimbot)');
  const aggr = behavior({ aggression: 1, roam: 0 }), passive = behavior({ aggression: 0, roam: 0 });
  ok(aggr.supportDelay < passive.supportDelay && aggr.escortGap < passive.escortGap,
     'behavior : un profil agressif pousse plus tôt et colle plus');
  const roamy = behavior({ aggression: 0.5, roam: 1 }), anchor = behavior({ aggression: 0.5, roam: 0 });
  ok(roamy.patrolEvery < anchor.patrolEvery, 'behavior : un profil mobile change de site plus souvent');
  ok(/^\d+,\d+$/.test(niche(prof)), 'niche : coordonnée de grille valide');

  // Le BotController prend le profil quand il est fourni, et reste inchangé sinon.
  // Priorité réelle : modèle de rôle entraîné (tools/train) > profil > ELO. On
  // compare à la source que cette priorité désigne, pour que le test dise vrai
  // que models/ soit rempli ou non.
  const nav = MAPS.nexus.nav;
  const styled = { aggression: 1, roam: 1, reaction: 0.2, fireInterval: 0.5, aimError: 1, headshotChance: 0.3, abilityChance: 0.5 };
  const source = (bc, fallback) => getModelForBot(bc.role, bc.elo)?.params ?? fallback;
  const withProf = new BotController({ pos: { x: 0, y: 0, z: 0 }, team: 0 }, 1000, nav, styled);
  ok(Math.abs(withProf.p.reaction - paramsOf(source(withProf, styled)).reaction) < 1e-9, 'BotController(profil) : compétence issue du profil');
  ok(withProf.escortGap === behavior(source(withProf, styled)).escortGap, 'BotController(profil) : mouvement issu du profil (agressif)');
  const dflt = new BotController({ pos: { x: 0, y: 0, z: 0 }, team: 0 }, 1000, nav);
  const dfltModel = getModelForBot(dflt.role, dflt.elo);
  ok(Math.abs(dflt.p.reaction - (dfltModel ? paramsOf(dfltModel.params) : botParams(1000)).reaction) < 1e-9,
     'BotController(sans profil) : modèle de rôle s’il existe, sinon comportement ELO inchangé');

  // Calage sur la difficulté : le style est conservé, la compétence dégradée si skill<1.
  const base = { aggression: 0.8, roam: 0.3, reaction: 0.2, fireInterval: 0.5, aimError: 1, headshotChance: 0.4, abilityChance: 0.7 };
  const full = scaleProfile(base, 1), weak = scaleProfile(base, 0);
  ok(Math.abs(full.reaction - 0.2) < 1e-9, 'scaleProfile(skill=1) garde la compétence entraînée');
  ok(weak.reaction > full.reaction && weak.aimError > full.aimError, 'scaleProfile(skill=0) dégrade la compétence');
  ok(Math.abs(weak.aggression - base.aggression) < 1e-9 && Math.abs(weak.roam - base.roam) < 1e-9, 'scaleProfile conserve le STYLE quel que soit le niveau');
  const picks = selectProfiles([{ profile: base }, { profile: { ...base, aggression: 0.1 } }], 3, { skill: 0.5 });
  ok(picks.length === 3 && picks.every((p) => p && p.aggression != null), 'selectProfiles renvoie le bon nombre de profils calés');
  ok(selectProfiles([], 3)[0] === null, 'selectProfiles([]) → null (repli sur l’ELO)');
}

// --- Points / récompense (points.js) -------------------------------------------
{
  const A = { id: 'a', name: 'A', team: 0, pos: { x: 0, y: 0, z: 0 } };
  const B = { id: 'b', name: 'B', team: 1, pos: { x: 0, y: 0, z: 0 }, matchKills: 3 };
  award(A, 'kill');
  ok(A.points === POINTS.kill && A.pts.kill === POINTS.kill, 'un kill crédite le barème kill');
  award(A, 'plant');
  award(A, 'roundWin');
  ok(A.points === POINTS.kill + POINTS.plant + POINTS.roundWin, 'kill + pose + round cumulés');

  // Déplacement : premier appel = référence, puis récompense proportionnelle à la distance.
  A.pos.x = 0; awardMovement(A);
  const before = A.points;
  A.pos.x = 3; awardMovement(A); // 3 m
  near(A.points - before, 3 * POINTS.perMeter, 'déplacement récompensé par mètre');
  // Un saut > 5 m (respawn/téléport) n'est pas récompensé.
  const before2 = A.points;
  A.pos.x = 100; awardMovement(A);
  ok(A.points === before2, 'un saut de position (respawn) ne rapporte rien');

  const rk = ranking([A, B]);
  ok(rk[0].id === 'a' && rk[0].points >= rk[1].points, 'classement décroissant par points');
  ok(rk[1].kills === 3, 'le classement expose les kills du match');
}

console.log(`selftest : ${n} assertions OK`);
if (typeof document !== 'undefined') {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div style="position:fixed;right:10px;top:10px;z-index:3;color:#6f6">selftest ${n} OK</div>`,
  );
}
