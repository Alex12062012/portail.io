/**
 * valorant.js — logique serveur du 3v3 en ligne.
 *
 * Modèle « léger entre potes » (cf. décision produit) : le serveur est
 * autoritaire sur round / spike / économie / score / timer, sur les positions
 * et l'IA des BOTS, et sur l'application des dégâts. Les HUMAINS sont
 * autoritaires sur leur propre déplacement (ils l'envoient ~25 Hz, le serveur
 * clampe aux bornes de la map) et détectent leurs propres tirs côté client
 * (raycast Three), qu'ils reportent au serveur ; le serveur fait un contrôle
 * de cohérence léger puis applique les dégâts et les diffuse.
 *
 * Tout le cœur logique est RÉUTILISÉ tel quel depuis le jeu client — ces
 * modules sont déjà sans Three ni DOM (validés sous node par selftest.js) :
 * RoundManager, Spike, Wallet, BotController, damage/WEAPONS, botParams,
 * assignTeams, et les données de map via map_loader (MAPS/toCollider/…).
 *
 * ponytail: parité de netcode volontairement minimale (pas de prédiction/
 * réconciliation, pas de rewind lag-comp) — c'est le niveau choisi pour du jeu
 * entre amis. Points à durcir si un jour on veut de la compétition : raycast
 * autoritaire côté serveur, cadence de tir/munitions vérifiées, ELO réel des
 * bots. Chaque coin coupé est noté par un `ponytail:` local.
 */
import { WEAPONS, damage } from '../../public/games/valorant/js/weapons.js';
import { Wallet, REWARD, SHIELDS, STARTING_CREDITS } from '../../public/games/valorant/js/economy.js';
import { Spike, BLAST_RADIUS, PLANT_TIME, DEFUSE_TIME } from '../../public/games/valorant/js/spike.js';
import { RoundManager, TEAM_SIZE } from '../../public/games/valorant/js/round_manager.js';
import { BotController, reassignRoles, ATK_ROLES, DEF_ROLES } from '../../public/games/valorant/js/bots/bot_controller.js';
import { assignTeams } from '../../public/games/valorant/js/matchmaking.js';
import { MAPS, toCollider, siteAt as siteAtRaw, siteCenter, spawnSet } from '../../public/games/valorant/js/maps/map_loader.js';
import { blocked, groundHeight } from '../../public/games/valorant/js/player.js';
import { award, awardMovement, ranking } from '../../public/games/valorant/js/points.js';
import { selectProfiles } from '../../public/games/valorant/js/bots/bot_profile.js';
import fs from 'node:fs';

// Profils de bots entraînés (training/) s'ils existent : donnent aux bots des
// styles variés. Absent → comportement ELO par défaut (aucune régression).
const TRAINED = (() => {
  try {
    const p = new URL('../../public/games/valorant/js/bots/profiles.json', import.meta.url);
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j.profiles?.length ? j.profiles : null;
  } catch { return null; }
})();

// Doit rester aligné sur les agents réellement définis côté client (abilities.js).
const AGENT_KEYS = ['jett', 'sova', 'brimstone', 'sage'];
const BOT_ELO = 1150;          // ponytail: ELO fixe côté serveur (l'historique ELO vit dans le localStorage de chaque navigateur, pas ici). Le LOSS_BOOST par round reste actif.
const WAIT_SECONDS = 15;       // file d'attente avant remplissage par bots
const EYE = 1.4;               // hauteur des yeux, comme eye() dans main.js
const HIT_RANGE_MARGIN = 4;    // m de tolérance sur la distance reportée d'un tir

let botSeq = 1;

// --- Vision serveur (pure) : pas de mur ni de fumée entre deux points ------------
// Segment vs boîte AABB (méthode des slabs, en 3D). Les points sont pris à hauteur
// d'œil : un rayon horizontal ne heurte pas le sol, seulement les murs verticaux.
function segHitsBox(a, b, box) {
  let tmin = 0, tmax = 1;
  for (const ax of ['x', 'y', 'z']) {
    const d = b[ax] - a[ax];
    const lo = box.min[ax], hi = box.max[ax];
    if (Math.abs(d) < 1e-9) {
      if (a[ax] < lo || a[ax] > hi) return false;
    } else {
      let t1 = (lo - a[ax]) / d, t2 = (hi - a[ax]) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
  }
  return true;
}

export function createValorantGame(io, room, opts = {}) {
  const waitSeconds = opts.waitSeconds ?? WAIT_SECONDS;
  const silent = !!opts.silent; // entraînement headless : on ne diffuse pas de snapshot
  const mapId = opts.mapId ?? pickMapId();
  const mapDef = MAPS[mapId];
  const solids = mapDef.solids.map(toCollider);
  const sites = mapDef.sites;
  const nav = mapDef.nav;
  const spawnAttack = spawnSet(mapDef.attack);
  const spawnDefense = spawnSet(mapDef.defense);
  const bounds = {
    min: { x: Math.min(...solids.map((s) => s.min.x)), z: Math.min(...solids.map((s) => s.min.z)) },
    max: { x: Math.max(...solids.map((s) => s.max.x)), z: Math.max(...solids.map((s) => s.max.z)) },
  };

  const actors = [];          // { id, name, agentKey, team, bot, pos, yaw, pitch, hp, shield, ... }
  const bots = [];            // BotController[]
  const controllerOf = new Map(); // actor -> BotController
  const smokes = [];          // { pos:{x,z}, radius, life } — bloquent la vision
  const heals = [];           // { actor, rate, left }
  let botPlan = { site: 'A' };
  let running = false;
  let goAt = 0;
  let started = false;        // manche 1 réellement lancée (après la file d'attente)
  let rm = null;              // RoundManager, construit à `begin()` quand l'effectif est complet

  const spike = new Spike();
  const emit = (ev, data) => io.to(room.code).emit(ev, data);

  function pickMapId() {
    const ids = Object.keys(MAPS).filter((id) => id !== room.lastMapId);
    return ids[Math.floor(Math.random() * ids.length)];
  }
  room.lastMapId = mapId;

  const aliveCount = (team) => actors.filter((a) => a.team === team && a.alive).length;
  const siteAt = (p) => siteAtRaw(sites, p);
  const roleHolder = (team, role) => actors.find((a) => a.team === team && a.alive && a.role === role);

  function smokeBetween(a, b) {
    for (const z of smokes) {
      const dx = b.x - a.x, dz = b.z - a.z;
      const L2 = dx * dx + dz * dz;
      const t = L2 ? Math.min(1, Math.max(0, ((z.pos.x - a.x) * dx + (z.pos.z - a.z) * dz) / L2)) : 0;
      if (Math.hypot(a.x + t * dx - z.pos.x, a.z + t * dz - z.pos.z) < z.radius * 0.9) return true;
    }
    return false;
  }

  function canSee(a, b) {
    if (smokeBetween(a, b)) return false;
    const from = { x: a.x, y: a.y + EYE, z: a.z }, to = { x: b.x, y: b.y + EYE, z: b.z };
    for (const box of solids) if (segHitsBox(from, to, box)) return false;
    return true;
  }

  // --- Effectif ---------------------------------------------------------------
  // `id` est STABLE pour toute la partie (clé d'un acteur côté client) ; il ne
  // change pas quand un bot devient humain (join en cours) ou l'inverse (déco).
  // `socketId` est le routage réseau : la socket d'un humain, ou null pour un bot.
  let uidSeq = 1;
  function makeActor(name, agentKey, team, bot, socketId = null) {
    return {
      id: 'u' + uidSeq++, socketId,
      name, agentKey, agentName: agentKey, team, bot,
      pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0,
      hp: 100, maxHp: 100, shield: 0, shieldMax: 0,
      alive: true, wallet: new Wallet(STARTING_CREDITS), kills: 0, matchKills: 0, matchDeaths: 0,
      ready: false, role: null, weapon: 'classic', holding: false,
      model: { rotation: { y: 0 } }, // stub : BotController y écrit l'orientation, on la relit pour le snapshot
    };
  }

  function addHuman(id, name, agentKey = 'jett', { team } = {}) {
    const t = team ?? smallerTeam();
    const a = makeActor(name, AGENT_KEYS.includes(agentKey) ? agentKey : 'jett', t, false, id);
    actors.push(a);
    if (started) spawnActor(a); // rejoint en cours : on le place à un spawn de son camp
    return a;
  }

  function addBot(team, i = 0, profile) {
    const key = AGENT_KEYS[botSeq++ % AGENT_KEYS.length];
    const dupes = actors.filter((x) => x.agentKey === key).length;
    const a = makeActor(key + (dupes ? ` ${dupes + 1}` : ''), key, team, true, null);
    actors.push(a);
    // Priorité : profil explicite (fillWithBots) → hook d'entraînement → ELO défaut.
    const p = profile !== undefined ? profile : (opts.assignProfile?.(team, i) ?? null);
    const bc = new BotController(a, BOT_ELO, nav, p);
    bots.push(bc);
    controllerOf.set(a, bc);
    return a;
  }

  const smallerTeam = () => (actors.filter((a) => a.team === 0).length <= actors.filter((a) => a.team === 1).length ? 0 : 1);

  // Complète les deux équipes à TEAM_SIZE avec des bots, en respectant la
  // répartition des humains déjà présents (jamais regroupés — assignTeams).
  function fillWithBots() {
    const humans = actors.filter((a) => !a.bot);
    // (Ré)assigne les équipes des humains via la fonction pure partagée.
    // ponytail: ELO humain inconnu côté serveur → assignTeams reçoit elo:0 ; le
    // cas « 3 réels, meilleur ELO seul » retombe donc sur « le 1er reste seul ».
    const teams = assignTeams(humans.map((h) => ({ id: h.id, elo: 0 })), TEAM_SIZE);
    // Hors entraînement : si des profils entraînés existent, on en pioche un jeu
    // VARIÉ pour la partie (styles distincts). Sinon, comportement ELO par défaut.
    const totalBots = teams.reduce((s, tm) => s + tm.bots, 0);
    const profs = (!opts.assignProfile && TRAINED) ? selectProfiles(TRAINED, totalBots, { skill: 1 }) : null;
    let k = 0;
    teams.forEach((tm, ti) => {
      for (const h of tm.humans) actors.find((a) => a.id === h.id).team = ti;
      for (let i = 0; i < tm.bots; i++) addBot(ti, i, profs ? profs[k++] : undefined);
    });
  }

  // --- Cycle de round (miroir serveur de resetRound/kill/explode de main.js) ---
  function resetRound(attackers) {
    smokes.length = 0; heals.length = 0;
    botPlan = { site: Math.random() < 0.5 ? 'A' : 'B' };
    const seat = { 0: 0, 1: 0 };
    for (const a of actors) {
      a.role = (a.team === attackers ? ATK_ROLES : DEF_ROLES)[seat[a.team] % 3];
      const bc = controllerOf.get(a);
      if (bc) bc.newRound(seat[a.team], attackers);
      seat[a.team]++;
    }
    for (const a of actors) spawnActor(a, attackers);
  }

  function spawnActor(a, attackers = rm?.attackers ?? 0) {
    const set = a.team === attackers ? spawnAttack : spawnDefense;
    const idx = actors.filter((x) => x.team === a.team).indexOf(a);
    const s = set[idx % set.length];
    a.pos = { x: s.x, y: s.y, z: s.z };
    a.yaw = s.yaw ?? 0;
    a.alive = true; a.hp = a.maxHp; a.shield = 0; a.ready = false;
  }

  function succeedRoles(team) {
    const order = team === rm.attackers ? ATK_ROLES : DEF_ROLES;
    const roster = actors.filter((a) => a.team === team).map((a) => ({ actor: a, role: a.role }));
    for (const [a, role] of reassignRoles(roster, order)) {
      if (a.role === role) continue;
      const bc = controllerOf.get(a);
      if (bc) bc.promote(role); else a.role = role;
    }
  }

  function kill(actor, by, via) {
    if (!actor.alive) return;
    actor.alive = false; actor.hp = 0;
    actor.matchDeaths++;
    if (by && by !== actor && by.team !== actor.team) {
      by.kills++; by.matchKills++; by.wallet.add(REWARD.kill);
      award(by, 'kill'); // récompense de reward-shaping (distincte des crédits éco)
    }
    emit('val:kill', { byId: by?.id ?? null, byName: by?.name ?? null, targetId: actor.id, targetName: actor.name, via: via ?? null });
    succeedRoles(actor.team);
  }

  // Dégâts autoritaires : l'armure absorbe 1:1 avant les PV.
  function hurt(target, n, by, via) {
    if (!target.alive || n <= 0) return;
    let dmg = n;
    if (target.shield > 0) { const a = Math.min(target.shield, dmg); target.shield -= a; dmg -= a; }
    target.hp -= dmg;
    emit('val:hit', { byId: by?.id ?? null, targetId: target.id, dmg: n, killed: target.hp <= 0 });
    if (target.hp <= 0) kill(target, by, via);
  }

  function explode() {
    for (const a of actors) {
      if (a.alive && Math.hypot(a.pos.x - spike.pos.x, a.pos.z - spike.pos.z) < BLAST_RADIUS) kill(a, null, 'Spike');
    }
    emit('val:fx', { kind: 'explode', x: spike.pos.x, y: spike.pos.y, z: spike.pos.z });
  }

  // Contexte donné aux BotController, comme botCtx dans main.js.
  const botCtx = {
    spike, solids, sites, actors, siteCenter, siteAt, roleHolder, canSee,
    hurt,
    dropSmoke: (p) => { smokes.push({ pos: { x: p.x, z: p.z }, radius: 4, life: 15 }); emit('val:fx', { kind: 'smoke', x: p.x, y: p.y ?? 0, z: p.z, radius: 4 }); },
    healOver: (a) => { heals.push({ actor: a, rate: 8, left: 5 }); emit('val:fx', { kind: 'heal', id: a.id }); },
    tracer: (a, b) => emit('val:fx', { kind: 'tracer', from: { x: a.x, y: a.y + EYE, z: a.z }, to: { x: b.x, y: b.y + EYE, z: b.z } }),
  };

  // --- Réception des clients ---------------------------------------------------
  // Le joueur est autoritaire sur son déplacement : on clampe juste aux bornes.
  function handleInput(id, d) {
    const a = actors.find((x) => x.socketId === id);
    if (!a || a.bot || !a.alive || !d) return;
    const x = Number(d.x), y = Number(d.y), z = Number(d.z);
    if (![x, y, z].every(Number.isFinite)) return;
    a.pos.x = Math.min(Math.max(x, bounds.min.x), bounds.max.x);
    a.pos.y = y;
    a.pos.z = Math.min(Math.max(z, bounds.min.z), bounds.max.z);
    if (Number.isFinite(Number(d.yaw))) { a.yaw = Number(d.yaw); a.model.rotation.y = a.yaw; }
    if (Number.isFinite(Number(d.pitch))) a.pitch = Number(d.pitch);
    if (typeof d.holding === 'boolean') a.holding = d.holding;
  }

  // Tir reporté par le client (il a fait le raycast). Contrôle de cohérence léger
  // puis application autoritaire des dégâts.
  // ponytail: on fait confiance au client sur part/dist/pénétration (jeu entre
  // amis). Durcissement futur = raycast serveur. On rejette quand même l'absurde.
  function handleShot(id, d) {
    const by = actors.find((x) => x.socketId === id);
    if (!by || by.bot || !by.alive || !d || rm.phase !== 'live') return;
    const w = WEAPONS[by.weapon] ?? WEAPONS.classic;
    emit('val:fx', { kind: 'tracer', from: d.from, to: d.to });
    for (const h of d.hits ?? []) {
      const t = actors.find((x) => x.id === h.targetId);
      if (!t || !t.alive || t.team === by.team) continue;
      const dist = Number(h.dist);
      if (!Number.isFinite(dist)) continue;
      const real = Math.hypot(t.pos.x - by.pos.x, t.pos.z - by.pos.z);
      if (dist > (w.range ?? 200) || dist > real + HIT_RANGE_MARGIN) continue; // report grossièrement incohérent
      const part = h.part === 'h' ? 'h' : h.part === 'l' ? 'l' : 'b';
      const penMult = h.penMult > 0 && h.penMult <= 1 ? h.penMult : 1;
      hurt(t, Math.round(damage(w, part, dist) * penMult), by, w.name);
    }
  }

  function handleBuy(id, d) {
    const a = actors.find((x) => x.socketId === id);
    if (!a || a.bot || rm.phase !== 'buy' || !d) return;
    if (typeof d.weapon === 'string' && WEAPONS[d.weapon] && WEAPONS[d.weapon].price != null) {
      const price = WEAPONS[d.weapon].price;
      if (a.weapon !== d.weapon && a.wallet.spend(price)) a.weapon = d.weapon;
    }
    if (d.shield && SHIELDS[d.shield]) {
      const s = SHIELDS[d.shield];
      if (a.shield < s.hp && a.wallet.spend(s.price)) { a.shield = s.hp; a.shieldMax = s.hp; }
    }
  }

  function handleAbility(id, d) {
    const a = actors.find((x) => x.socketId === id);
    if (!a || a.bot || !a.alive || !d) return;
    // v1 : on relaie l'effet pour l'affichage chez les autres, et on applique les
    // effets qui touchent l'état partagé côté serveur (fumée → vision des bots, soin).
    // ponytail: parité complète des kits des 5 agents = incrément ultérieur.
    if (d.kind === 'smoke' && d.pos) botCtx.dropSmoke(d.pos);
    else if (d.kind === 'heal') botCtx.healOver(a);
    else emit('val:fx', { kind: 'ability', by: id, ...d });
  }

  function handleReady(id) {
    const a = actors.find((x) => x.socketId === id);
    if (a && !a.bot) a.ready = true;
  }

  // --- Boucle serveur (appelée par le tick global de server.js) ----------------
  function tick(dt) {
    if (!running) return;
    const now = Date.now();

    if (!started) {
      if (now >= goAt) begin();
      else { emit('val:wait', { left: Math.max(0, (goAt - now) / 1000), mapId }); return; }
    }

    // Achats des bots à l'entrée de la phase d'achat (une fois par round).
    if (rm.phase === 'buy') {
      for (const bc of bots) {
        if (bc._boughtFor !== rm.round) { bc.buyRound(); bc.a.weapon = weaponKeyOf(bc.weapon); bc._boughtFor = rm.round; }
        bc.tickBuy(dt);
      }
    }

    // Fumées et soins (état partagé, comptés côté serveur).
    for (let i = smokes.length - 1; i >= 0; i--) if ((smokes[i].life -= dt) <= 0) smokes.splice(i, 1);
    for (let i = heals.length - 1; i >= 0; i--) {
      const h = heals[i];
      if (h.actor.alive) h.actor.hp = Math.min(h.actor.maxHp, h.actor.hp + h.rate * dt);
      if ((h.left -= dt) <= 0) heals.splice(i, 1);
    }

    rm.update(dt);

    if (rm.live) {
      const attackers = rm.attackers;
      const carrier = actors.find((a) => a.team === attackers && a.alive && !a.bot)
        ?? actors.find((a) => a.team === attackers && a.alive);
      const wasPlanted = spike.planted;

      // Pose/désamorçage des HUMAINS (les bots s'en chargent dans leur decide()).
      for (const a of actors) {
        if (a.bot || !a.alive) continue;
        if (a.team === attackers && carrier === a && spike.state === 'carried') {
          spike.tickPlant(dt, a.holding, !!siteAt(a.pos), a.pos);
        } else if (a.team !== attackers && spike.planted
                   && Math.hypot(a.pos.x - spike.pos.x, a.pos.z - spike.pos.z) < 2) {
          spike.tickDefuse(dt, a.holding);
        }
      }

      const ctx2 = { ...botCtx, attackers, carrier, plan: botPlan };
      for (const bc of bots) bc.update(dt, ctx2);

      // Récompenses : pose du spike (au porteur) + déplacement pendant le round.
      if (!wasPlanted && spike.planted) award(carrier, 'plant');
      for (const a of actors) if (a.alive) awardMovement(a);

      tickTeleports();
    }

    if (spike.state === 'exploded' && spike.pos && !spike.blown) { spike.blown = true; explode(); }

    if (rm.phase === 'match' && running) return end();

    if (!silent) emit('val:snap', snapshot());
  }

  function tickTeleports() {
    for (const t of mapDef.teleports ?? []) {
      for (const a of actors) {
        const p = a.pos;
        if (!a.alive || p.y > 0.5) continue;
        if (p.x < t.zone.min.x || p.x > t.zone.max.x || p.z < t.zone.min.z || p.z > t.zone.max.z) continue;
        a.pos = { x: t.exit.x, y: t.exit.y, z: t.exit.z };
        if (!a.bot) { a.yaw = t.exit.yaw ?? a.yaw; emit('val:fx', { kind: 'teleport', to: t.exit }); }
      }
    }
  }

  // --- Démarrage / états -------------------------------------------------------
  function start() {
    running = true;
    started = false;
    goAt = Date.now() + waitSeconds * 1000;
    room.status = 'playing';
    // Les humains déjà là reçoivent l'écran d'attente ; game:start viendra à `begin`.
    emit('val:wait', { left: waitSeconds, mapId });
  }

  function begin() {
    started = true;
    fillWithBots();
    // RoundManager construit ici : son constructeur appelle resetRound(0), donc
    // l'effectif (humains + bots) doit déjà être complet. Round 1, attaquants = 0.
    rm = new RoundManager({
      spike, players: actors, aliveCount, resetRound,
      allReady: () => actors.every((a) => !a.alive || a.ready),
      onRoundEnd: (team) => {
        for (const bc of bots) if (bc.a.team !== team) bc.boost();
        for (const a of actors) if (a.team === team) award(a, 'roundWin'); // récompense d'équipe
      },
    });
    emit('game:start', startPayload());
  }

  function end() {
    running = false;
    room.status = 'ended';
    emit('game:end', {
      winner: rm.winner,
      score: rm.score,
      ranking: ranking(actors), // classement de points (joueurs + bots), décroissant
      players: actors.filter((a) => !a.bot).map((a) => ({ id: a.id, name: a.name, kills: a.matchKills, deaths: a.matchDeaths, won: a.team === rm.winner })),
    });
    opts.onEnd?.(room, { aborted: false });
  }

  function abort(reason) {
    if (!running) return;
    running = false;
    room.status = 'ended';
    emit('game:end', { aborted: true, reason });
    opts.onEnd?.(room, { aborted: true });
  }

  function removeHuman(id) {
    const a = actors.find((x) => x.socketId === id && !x.bot);
    if (!a) return false;
    const wasAlive = a.alive;
    // Déco en cours de match : un bot reprend sa place (même équipe) pour ne pas
    // pénaliser l'équipe. L'id STABLE ne change pas → les autres clients gardent
    // le même acteur. ponytail: pas de reprise de place à la reconnexion en v1.
    if (started && running) {
      a.bot = true;
      a.socketId = null;
      a.holding = false;
      const bc = new BotController(a, BOT_ELO, nav);
      bc.newRound(actors.filter((x) => x.team === a.team).indexOf(a), rm.attackers);
      bc.a.role = a.role;
      bots.push(bc); controllerOf.set(a, bc);
    } else {
      const i = actors.indexOf(a); if (i >= 0) actors.splice(i, 1);
    }
    return wasAlive;
  }

  function startPayload() {
    return {
      gameType: 'valorant', code: room.code, mapId,
      // socketId inclus : chaque client retrouve SON acteur (celui dont socketId
      // vaut sa propre socket) pour en déduire son id stable.
      roster: actors.map((a) => ({ id: a.id, socketId: a.socketId, name: a.name, agentKey: a.agentKey, team: a.team, bot: a.bot })),
      snapshot: snapshot(),
    };
  }

  function snapshot() {
    return {
      phase: rm.phase, round: rm.round, timer: Math.max(0, rm.timer), score: rm.score, attackers: rm.attackers,
      // Vainqueur + motif du round : sans eux le client ne peut pas dire au joueur
      // s'il a gagné (la bannière de fin retombait toujours sur « ROUND PERDU »).
      roundWinner: rm.roundWinner ?? null, reason: rm.reason ?? '',
      spike: { state: spike.state, x: spike.pos?.x ?? null, y: spike.pos?.y ?? null, z: spike.pos?.z ?? null, fuse: spike.fuse, plant: spike.plant, defuse: spike.defuse },
      actors: actors.map((a) => ({
        id: a.id, name: a.name, team: a.team, bot: a.bot, alive: a.alive,
        x: round1(a.pos.x), y: round1(a.pos.y), z: round1(a.pos.z),
        yaw: round2(a.model.rotation.y ?? a.yaw), hp: Math.round(a.hp), shield: Math.round(a.shield),
        weapon: a.weapon, role: a.role, ready: a.ready, points: Math.round(a.points ?? 0),
        // Compteurs de match : c'est ce que lit le scoreboard (Tab) et l'écran de fin.
        kills: a.matchKills, deaths: a.matchDeaths,
        credits: a.bot ? undefined : a.wallet.credits,
      })),
    };
  }

  return {
    start, tick, abort, addHuman, removeHuman, startPayload, snapshot,
    handleInput, handleShot, handleBuy, handleAbility, handleReady,
    // pas de bots-vivants à remplacer façon Tag Arena ici : on rejoint une place
    // libre pendant la file, sinon on remplace un bot au début de manche.
    replaceBotWithHuman: (id, name, agentKey) => replaceBot(id, name, agentKey),
    backfillBot: () => {}, // géré par removeHuman (déco → bot)
    joinableWaiting: () => running && !started && actors.filter((a) => !a.bot).length < TEAM_SIZE * 2,
    joinable: () => running && started && actors.some((a) => a.bot),
    isRunning: () => running,
    mapId,
    _actors: actors, _bots: bots, _rm: () => rm, _spike: () => spike, _begin: begin,
  };

  function replaceBot(id, name, agentKey) {
    const bot = actors.find((a) => a.bot && a.alive);
    if (!bot) return null;
    const bc = controllerOf.get(bot);
    if (bc) { bots.splice(bots.indexOf(bc), 1); controllerOf.delete(bot); }
    // id STABLE conservé : les autres clients gardent l'acteur, seul socketId change.
    bot.bot = false; bot.socketId = id; bot.name = name;
    if (AGENT_KEYS.includes(agentKey)) { bot.agentKey = agentKey; bot.agentName = agentKey; }
    bot.wallet = new Wallet(STARTING_CREDITS);
    return bot;
  }

  function weaponKeyOf(w) { return Object.keys(WEAPONS).find((k) => WEAPONS[k] === w) ?? 'classic'; }
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
