// Reward shaping + observation d'un match headless.
//
// Deux moitiés bien séparées, pour que le barème soit testable sans simuler :
//   1. playMatch()  : joue un match bot-vs-bot et en extrait une liste d'ÉVÉNEMENTS
//                     par round (pur constat, aucun jugement de valeur).
//   2. scoreRound() : transforme ces événements en score selon REWARD_CONFIG.
//
// Le match réutilise EXACTEMENT le simulateur du jeu (createValorantGame) : ce qui
// est appris à l'entraînement se comporte pareil en partie. On n'y touche pas — on
// se branche sur son `io` (les événements val:kill passent par là) et on lit l'état
// exposé (_actors / _rm / _spike) à chaque tick.
import { createValorantGame } from '../../../../../server/games/valorant.js';
import { MAPS, siteAt as siteAtRaw } from '../../js/maps/map_loader.js';
import { RANGES, GENES, clampProfile } from '../../js/bots/bot_profile.js';

// --- Barème ---------------------------------------------------------------------
// Valeurs exposées et modifiables : c'est le cœur du reward shaping.
export const REWARD_CONFIG = {
  kill: 100,
  roundWin: 150,
  plant: 60,            // attaque uniquement (poser le spike)
  defuse: 80,           // défense uniquement (désamorcer)
  death: -60,
  roundLoss: -80,
  noPlantPerSecond: -1, // attaque : par seconde au-delà de la grâce, tant que rien n'est posé
  noPlantGrace: 30,
  movement: 0,          // supprimé : la récompense dense de déplacement (points.js)
                        // produit des bots qui tournent en rond pour marquer.
};

// Bonus PAR RÔLE, en plus du barème de base. `withinSeconds` = fenêtre temporelle.
export const ROLE_REWARD = {
  entry:   { firstSiteKill: 40, withinSeconds: 10 },
  support: { trade: 30, withinSeconds: 2.2 },
  lurker:  { backKill: 50, minAngleDeg: 120 },
  anchor:  { held: 40, leftWithoutContact: -30 },
  roamer:  { rotation: 20, withinSeconds: 5 },
  rotator: { arrival: 35, withinSeconds: 14 },
};

// Les rôles sont attribués par INDEX dans l'équipe (bot_controller.newRound) et le
// camp alterne à chaque round : l'index 0 est entry en attaque et anchor en défense.
// Entraîner un rôle = entraîner la place qui le porte.
export const ROLE_SLOT = { entry: 0, anchor: 0, support: 1, roamer: 1, lurker: 2, rotator: 2 };
export const ROLES = Object.keys(ROLE_SLOT);

// --- Espace de recherche ---------------------------------------------------------
// Vecteur CMA-ES <-> gène de bot_profile.js. On optimise les 7 gènes que le jeu LIT
// réellement (bot_controller via paramsOf/behavior) :
//   reaction=reaction_delay · aimError=1-aim_precision · abilityChance=ability_usage_rate
//   aggression=aggressivité · roam=positioning_weight · fireInterval · headshotChance
// Pas de `spike_priority` : rien ne le lit dans le contrôleur, ce serait un gène
// mort — donc du bruit pur ajouté à la fitness.
export const GENE_ORDER = GENES;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function toProfile(vec) {
  const p = {};
  GENE_ORDER.forEach((g, i) => { p[g] = lerp(RANGES[g][0], RANGES[g][1], clamp01(vec[i])); });
  return p;
}

export function toVector(profile) {
  const p = clampProfile(profile);
  return GENE_ORDER.map((g) => (p[g] - RANGES[g][0]) / (RANGES[g][1] - RANGES[g][0]));
}

// --- Score ------------------------------------------------------------------------
// round : { role, attacked, won, duration, events[] } produit par playMatch().
// Les bonus de rôle ne s'appliquent que dans les rounds où le bot PORTE ce rôle
// (le camp alterne) ; le barème de base compte dans tous les rounds.
export function scoreRound(round, role) {
  const R = REWARD_CONFIG;
  const ev = round.events ?? [];
  const of = (type) => ev.filter((e) => e.type === type);
  const mine = (type) => of(type).filter((e) => e.mine);

  let s = round.won ? R.roundWin : R.roundLoss;
  s += mine('kill').length * R.kill;
  s += of('death').length * R.death;
  s += mine('planted').length * R.plant;
  s += mine('defused').length * R.defuse;

  if (round.attacked) {
    const planted = of('planted')[0];
    const until = planted ? planted.t : (round.duration ?? 0);
    s += R.noPlantPerSecond * Math.max(0, until - R.noPlantGrace);
  }
  return s + roleBonus(round, role);
}

export function roleBonus(round, role) {
  const cfg = ROLE_REWARD[role];
  if (!cfg || round.role !== role) return 0;
  const ev = round.events ?? [];
  const of = (type) => ev.filter((e) => e.type === type);
  const myKills = of('kill').filter((e) => e.mine);

  switch (role) {
    case 'entry': {
      // Premier kill SUR UN SITE du round, et dans les 10 premières secondes.
      const first = of('kill').find((e) => e.site);
      return first && first.mine && first.t <= cfg.withinSeconds ? cfg.firstSiteKill : 0;
    }
    case 'support': {
      // Trade : kill dans la foulée du kill d'un entry allié.
      const leads = of('kill').filter((e) => e.ally && e.byRole === 'entry').map((e) => e.t);
      const traded = myKills.filter((k) => leads.some((t) => k.t > t && k.t - t <= cfg.withinSeconds));
      return traded.length * cfg.trade;
    }
    case 'lurker':
      return myKills.filter((k) => k.back).length * cfg.backKill;
    case 'anchor':
      return (of('held').length ? cfg.held : 0) + (of('leftNoContact').length ? cfg.leftWithoutContact : 0);
    case 'roamer': {
      // Changement de site PERTINENT : un ennemi se montre sur le nouveau site juste après.
      const contacts = of('enemyOnSite');
      const useful = of('rotation').filter((r) =>
        contacts.some((c) => c.site === r.site && c.t >= r.t && c.t - r.t <= cfg.withinSeconds));
      return useful.length * cfg.rotation;
    }
    case 'rotator': {
      // Arriver sur un site contesté dans les 14 s suivant le premier contact ennemi.
      const arrivals = of('arrival');
      const first = new Map();
      for (const c of of('enemyOnSite')) if (!first.has(c.site)) first.set(c.site, c.t);
      const good = arrivals.some((a) => first.has(a.site)
        && a.t >= first.get(a.site) && a.t - first.get(a.site) <= cfg.withinSeconds);
      return good ? cfg.arrival : 0;
    }
    default:
      return 0;
  }
}

export const scoreMatch = (rounds, role) => rounds.reduce((s, r) => s + scoreRound(r, role), 0);

// --- Observation d'un match --------------------------------------------------------
const DT = 0.1;         // pas de simulation (= plafond du tick serveur)
const MAX_TICKS = 6000; // garde-fou (~600 s simulés) contre un round qui ne finit pas

// Direction du regard d'un acteur. bot_controller écrit model.rotation.y via
// atan2(me.x - cible.x, me.z - cible.z) : le vecteur avant est donc (-sin, -cos).
const forward = (yaw) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });

// Angle (degrés) entre le regard de `victim` et la direction vers `killer`.
function backAngle(victim, killer) {
  const f = forward(victim.model?.rotation?.y ?? victim.yaw ?? 0);
  const dx = killer.pos.x - victim.pos.x, dz = killer.pos.z - victim.pos.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return 0;
  const dot = Math.min(1, Math.max(-1, f.x * (dx / len) + f.z * (dz / len)));
  return Math.acos(dot) * 180 / Math.PI;
}

// Joue un match et renvoie les rounds observés du point de vue du bot en `slot`
// (équipe 0). `candidate` / `opponent` sont des profils (bot_profile.js) ; null =
// bot scripté par défaut du serveur — c'est le repli, pas une erreur.
export function playMatch(candidate, { opponent = null, slot = 0, mapId } = {}) {
  const sink = [];
  const io = { to: () => ({ emit: (ev, d) => { if (ev === 'val:kill') sink.push(d); } }) };
  const room = { code: 'TRAIN', status: 'lobby', isPublic: false };
  const game = createValorantGame(io, room, {
    waitSeconds: 0, silent: true, mapId,
    // Le candidat occupe SA place ; ses coéquipiers et l'équipe adverse jouent
    // l'adversaire de référence. Sinon la fitness mesure l'équipe, pas le rôle.
    assignProfile: (team, i) => (team === 0 && i === slot ? candidate : opponent),
  });

  const sites = MAPS[game.mapId].sites;
  const siteOf = (p) => siteAtRaw(sites, p)?.name ?? null;
  const rounds = [];
  let me = null, myBot = null, byId = null;
  let cur = null, phase = null, simT = 0;
  let spikeState = null, carrier = null, defuser = null, holdSite = null;

  const openRound = (rm) => {
    cur = {
      role: me.role, attacked: me.team === rm.attackers, won: false,
      assignedSite: myBot?.holdSite ?? null, t0: simT, duration: 0, events: [],
      _contact: new Set(), _arrived: new Set(), _wasOnSite: false, _left: false,
    };
    holdSite = myBot?.holdSite ?? null;
  };

  const closeRound = (rm) => {
    cur.duration = simT - cur.t0;
    cur.won = rm.roundWinner === me.team;
    if (me.alive && cur.assignedSite && siteOf(me.pos) === cur.assignedSite) cur.events.push({ type: 'held' });
    if (cur._left) cur.events.push({ type: 'leftNoContact' });
    delete cur._contact; delete cur._arrived; delete cur._wasOnSite; delete cur._left;
    delete cur.t0;
    rounds.push(cur);
    cur = null;
  };

  game.start();
  let ticks = 0;
  while (game.isRunning() && ticks++ < MAX_TICKS) {
    const rm = game._rm();
    const spike = game._spike();
    // Photo d'AVANT-tick : qui portait le spike / qui était le plus proche pour
    // désamorcer. Le simulateur n'émet rien sur la pose, on l'attribue nous-mêmes.
    if (rm && me) {
      carrier = game._actors.find((a) => a.team === rm.attackers && a.alive) ?? null;
      const def = game._actors.filter((a) => a.team !== rm.attackers && a.alive);
      defuser = spike.planted && def.length
        ? def.reduce((m, a) => (Math.hypot(a.pos.x - spike.pos.x, a.pos.z - spike.pos.z)
            < Math.hypot(m.pos.x - spike.pos.x, m.pos.z - spike.pos.z) ? a : m))
        : null;
    }

    game.tick(DT);
    simT += DT;

    const rm2 = game._rm();
    if (!rm2) continue;
    if (!me) {
      me = game._actors.filter((a) => a.team === 0)[slot];
      myBot = game._bots.find((b) => b.a === me);
      byId = new Map(game._actors.map((a) => [a.id, a]));
      if (!me) break;
    }

    if (rm2.phase === 'live' && phase !== 'live') openRound(rm2);
    if (cur) {
      const t = simT - cur.t0;
      observe(t, rm2, spike);
      if (rm2.phase !== 'live') closeRound(rm2);
    }
    sink.length = 0; // les kills hors round ouvert ne concernent personne
    phase = rm2.phase;
  }
  if (cur) closeRound(game._rm());

  return { rounds, winner: game._rm()?.winner ?? null, myTeam: me?.team ?? 0, mapId: game.mapId };

  function observe(t, rm, spike) {
    // Kills : événement exact émis par le simulateur (aucune heuristique d'appariement).
    for (const k of sink) {
      const by = k.byId ? byId.get(k.byId) : null;
      const target = byId.get(k.targetId);
      if (!target) continue;
      if (target === me) cur.events.push({ type: 'death', t });
      cur.events.push({
        type: 'kill', t,
        mine: by === me,
        ally: !!by && by !== me && by.team === me.team,
        byRole: by?.role ?? null,
        site: siteOf(target.pos),
        // angle brut conservé : sans lui, un bonus « dans le dos » qui ne se
        // déclenche jamais est indistinguable d'un bug de repère.
        angle: by ? Math.round(backAngle(target, by)) : null,
        back: !!by && backAngle(target, by) > ROLE_REWARD.lurker.minAngleDeg,
      });
    }
    sink.length = 0;

    // Spike : transitions d'état, attribuées au porteur / au désamorceur d'avant-tick.
    if (spike.state !== spikeState) {
      if (spike.state === 'planted') cur.events.push({ type: 'planted', t, mine: carrier === me });
      if (spike.state === 'defused') cur.events.push({ type: 'defused', t, mine: defuser === me });
      spikeState = spike.state;
    }

    // Contact ennemi sur un site (premier de chaque site ; réarmé à chaque rotation
    // du bot, pour que le roamer puisse être crédité d'un aller-retour utile).
    for (const s of sites) {
      const hot = game._actors.some((a) => a.alive && a.team !== me.team && siteOf(a.pos) === s.name);
      if (hot && !cur._contact.has(s.name)) { cur._contact.add(s.name); cur.events.push({ type: 'enemyOnSite', t, site: s.name }); }
    }

    // Arrivée du bot sur un site + départ de son site assigné sans avoir vu personne.
    const here = siteOf(me.pos);
    if (here && !cur._arrived.has(here)) { cur._arrived.add(here); cur.events.push({ type: 'arrival', t, site: here }); }
    if (cur.assignedSite) {
      if (here === cur.assignedSite) cur._wasOnSite = true;
      else if (cur._wasOnSite && !cur._left && !myBot?.sawEnemy) cur._left = true;
    }

    // Rotation : le bot change de site assigné (roamer/rotator via patrolTick).
    if (myBot && myBot.holdSite !== holdSite) {
      holdSite = myBot.holdSite;
      cur.events.push({ type: 'rotation', t, site: holdSite });
      cur._contact.delete(holdSite); // un contact sur la nouvelle destination compte
    }
  }
}

// Fitness d'un profil pour un rôle : score moyen par match sur `matches` parties.
export function evaluate(profile, { role = 'entry', matches = 10, opponent = null, mapId } = {}) {
  const slot = ROLE_SLOT[role];
  let score = 0, wins = 0, rounds = 0;
  for (let m = 0; m < matches; m++) {
    const r = playMatch(profile, { opponent, slot, mapId });
    score += scoreMatch(r.rounds, role);
    rounds += r.rounds.length;
    if (r.winner === r.myTeam) wins++;
  }
  return { fitness: score / matches, winRate: wins / matches, avgRounds: rounds / matches };
}
