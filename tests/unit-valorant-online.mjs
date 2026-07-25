// Test unitaire du module serveur 3v3 en ligne (server/games/valorant.js).
// Faux `io` qui capture les emits : aucune socket, aucun réseau — on valide la
// logique autoritaire pure (effectif, rôles, dégâts, fin de round, snapshot).
import { createValorantGame } from '../server/games/valorant.js';

let n = 0;
const ok = (cond, msg) => { n++; if (!cond) throw new Error('ÉCHEC — ' + msg); };

// --- Faux io/room ---------------------------------------------------------------
const events = [];
const io = { to: () => ({ emit: (ev, data) => events.push({ ev, data }) }) };
const room = { code: 'TEST', status: 'lobby', isPublic: true };
const last = (ev) => [...events].reverse().find((e) => e.ev === ev)?.data;

const game = createValorantGame(io, room, { waitSeconds: 0, mapId: 'nexus' });

// --- File d'attente → démarrage -------------------------------------------------
game.addHuman('you', 'Vous', 'jett');
game.start();
ok(room.status === 'playing', 'la partie passe en playing');
game.tick(0.05); // goAt dans le passé (waitSeconds 0) → begin()

const started = last('game:start');
ok(started, 'game:start émis après la file');
ok(started.mapId === 'nexus', 'map transmise');
ok(game._actors.length === 6, `effectif complet 3v3 = 6 (mesuré ${game._actors.length})`);
ok(game._actors.filter((a) => !a.bot).length === 1, '1 seul humain, le reste en bots');
ok(game._actors.filter((a) => a.team === 0).length === 3
   && game._actors.filter((a) => a.team === 1).length === 3, 'équipes 3 et 3');

// --- Rôles distincts par équipe après resetRound --------------------------------
for (const team of [0, 1]) {
  const roles = game._actors.filter((a) => a.team === team).map((a) => a.role);
  ok(new Set(roles).size === 3, `équipe ${team} : 3 rôles distincts (${roles.join(',')})`);
}

// --- Passage en phase live (tous prêts) -----------------------------------------
game.handleReady('you');
for (let i = 0; i < 200 && game._rm().phase !== 'live'; i++) game.tick(0.05);
ok(game._rm().phase === 'live', 'le round démarre une fois tout le monde prêt');

// --- Tir autoritaire reporté par le client --------------------------------------
const you = game._actors.find((a) => a.socketId === 'you'); // id = uid stable ; on route par socketId
const foe = game._actors.find((a) => a.team !== you.team && a.alive);
you.weapon = 'vandal';
you.pos = { x: foe.pos.x + 2, y: foe.pos.y, z: foe.pos.z }; // à 2 m, report cohérent
const hpBefore = foe.hp;
game.handleShot('you', { from: you.pos, to: foe.pos, hits: [{ targetId: foe.id, part: 'b', dist: 2 }] });
ok(foe.hp < hpBefore, `un tir corps applique des dégâts (${hpBefore} → ${foe.hp})`);

// Report incohérent (distance absurde) : rejeté.
const hp2 = foe.hp;
game.handleShot('you', { from: you.pos, to: foe.pos, hits: [{ targetId: foe.id, part: 'h', dist: 300 }] });
ok(foe.hp === hp2, 'un tir à distance incohérente est rejeté');

// --- Fin de round : éliminer tous les défenseurs --------------------------------
const rm = game._rm();
const scoreBefore = rm.score[rm.attackers];
const defenders = game._actors.filter((a) => a.team === rm.defenders && a.alive);
for (const d of defenders) game.handleShot('you', {
  from: { x: d.pos.x + 1, y: d.pos.y, z: d.pos.z }, to: d.pos,
  hits: [{ targetId: d.id, part: 'h', dist: 1 }],
}); // vandal tête à bout portant = one-shot, plusieurs fois si armure
// on force la mort directe pour ne pas dépendre de l'armure
for (const d of defenders) { d.shield = 0; d.hp = 1; }
game.handleShot('you', { from: you.pos, to: defenders[0].pos, hits: defenders.map((d) => ({ targetId: d.id, part: 'b', dist: 1 })) });
// repositionner près de chacun pour que le report passe le contrôle de distance
for (const d of defenders) {
  you.pos = { x: d.pos.x + 1, y: d.pos.y, z: d.pos.z };
  game.handleShot('you', { from: you.pos, to: d.pos, hits: [{ targetId: d.id, part: 'b', dist: 1 }] });
}
game.tick(0.05);
ok(game._actors.filter((a) => a.team === rm.defenders && a.alive).length === 0, 'tous les défenseurs éliminés');
ok(rm.score[rm.attackers] > scoreBefore || rm.phase !== 'live', 'le round se conclut en faveur des attaquants');

// --- Snapshot bien formé --------------------------------------------------------
const snap = game.snapshot();
ok(Array.isArray(snap.actors) && snap.actors.length === 6, 'snapshot : 6 acteurs');
ok(typeof snap.phase === 'string' && Array.isArray(snap.score), 'snapshot : phase + score');
ok(snap.actors.every((a) => typeof a.x === 'number' && typeof a.hp === 'number'), 'snapshot : positions + hp numériques');
ok(snap.actors.find((a) => a.id === you.id).credits !== undefined, 'crédits exposés pour l’humain');
ok(snap.actors.find((a) => a.bot).credits === undefined, 'crédits masqués pour les bots');

// Le client ne calcule rien en ligne : sans ces champs la bannière de fin de round
// affichait « ROUND PERDU » même en gagnant, et le scoreboard restait à 0 kill.
ok(snap.roundWinner === rm.roundWinner, `snapshot : vainqueur du round (${snap.roundWinner})`);
ok(typeof snap.reason === 'string' && snap.reason.length > 0, `snapshot : motif de fin (« ${snap.reason} »)`);
ok(snap.actors.every((a) => typeof a.kills === 'number' && typeof a.deaths === 'number'),
   'snapshot : kills et morts du match exposés pour chaque acteur');
ok(snap.actors.find((a) => a.id === you.id).kills === you.matchKills && you.matchKills > 0,
   `snapshot : les kills de l’humain remontent (${snap.actors.find((a) => a.id === you.id).kills})`);
ok(snap.actors.filter((a) => a.deaths > 0).length === 3, 'snapshot : les 3 défenseurs comptent une mort');

// --- Camp du joueur tiré au sort à chaque partie --------------------------------
// 40 parties neuves : les deux camps doivent sortir. Le tirage est dans
// fillWithBots — assignTeams, pure, mettrait toujours l'humain en équipe 0.
const sides = new Set();
for (let i = 0; i < 40; i++) {
  const g = createValorantGame(io, { code: 'T' + i, status: 'lobby', isPublic: true },
                               { waitSeconds: 0, mapId: 'nexus' });
  g.addHuman('you', 'Vous', 'jett');
  g.start();
  g.tick(0.05); // begin() → fillWithBots
  sides.add(g._actors.find((a) => a.socketId === 'you').team);
  ok(g._actors.filter((a) => a.team === 0).length === 3
     && g._actors.filter((a) => a.team === 1).length === 3, `partie ${i} : équipes toujours 3 et 3`);
  g.abort('fin de test');
}
ok(sides.has(0) && sides.has(1), `en ligne : le joueur joue les deux camps sur 40 parties (${[...sides]})`);

console.log(`unit-valorant-online : ${n} assertions OK`);
