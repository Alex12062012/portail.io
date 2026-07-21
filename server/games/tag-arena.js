/**
 * tag-arena.js — logique serveur du jeu Tag Arena.
 * Le serveur est autoritaire sur : le rôle "it", les timers, la détection des
 * tags, les éliminations et la fin de manche. Les humains envoient leur
 * position (~25 Hz) ; les bots sont simulés ici avec la physique partagée
 * (shared/tag-physics.js), la même que celle du client.
 *
 * Deux modes, choisis selon le nombre de joueurs au lancement :
 *  - 2 joueurs  → 'classic'     : 90 s, le "it" à la fin perd.
 *  - 3-4 joueurs → 'elimination': toutes les 30 s le "it" explose et devient
 *    spectateur ; dernier survivant = gagnant, classement par ordre
 *    d'élimination inversé.
 *
 * La carte est tirée au sort parmi MAPS à chaque manche (sans répéter la
 * carte de la manche précédente du même salon).
 */
import { PHYS, TAG, MAPS } from '../../shared/tag-map.js';
import { createPhysState, stepPlayer, centerOf, dist } from '../../shared/tag-physics.js';

const COLORS = ['#4cc9f0', '#80ed99', '#ffd166', '#f582ae'];
const BOT_NAMES = ['Zippy', 'Robo', 'Blip', 'Turbo', 'Pixel', 'Gizmo'];
let botSeq = 1;

/**
 * opts.onEnd(room, { aborted })   — rappelé à la fin de la manche.
 * opts.roundSeconds               — durée du mode classique (tests).
 * opts.eliminationSeconds         — période des explosions (tests).
 * opts.mapId                      — force une carte (tests).
 */
export function createTagGame(io, room, opts = {}) {
  const roundSeconds = opts.roundSeconds ?? TAG.roundSeconds;
  const elimSeconds = opts.eliminationSeconds ?? TAG.eliminationSeconds;
  // extra ajouté au deadline d'élimination (pas à elimSeconds, utilisé par les
  // tests) : la dernière seconde du décompte dure 1,3 s côté client (cf.
  // drawCountdown). Le cycle réel = elimSeconds * 1000 + ELIM_EXTRA_MS.
  const ELIM_EXTRA_MS = TAG.lastSecondExtraMs;
  // temps d'attente avant le vrai début de la manche (le temps que tout le
  // monde arrive) — 0 par défaut pour ne pas perturber les tests, le serveur
  // passe la vraie valeur en production.
  const startDelaySeconds = opts.startDelaySeconds ?? 0;
  const players = new Map(); // id -> { id, name, bot, color, pos, immuneUntil, alive, ai }
  const eliminated = [];     // joueurs explosés, dans l'ordre
  let mode = 'classic';      // fixé au start() selon le nombre de joueurs
  let itId = null;
  let deadline = 0;          // classic : fin de manche ; elimination : prochaine explosion
  let goAt = 0;              // instant où la manche démarre vraiment (fin de l'attente)
  let running = false;
  let botsFilled = false;    // bots ajoutés pour compléter une partie publique au 6e s

  const map = pickMap();
  room.lastMapId = map.id;

  const emit = (ev, data) => io.to(room.code).emit(ev, data);

  function pickMap() {
    if (opts.mapId) return MAPS.find(m => m.id === opts.mapId) || MAPS[0];
    const pool = MAPS.filter(m => m.id !== room.lastMapId);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const alivePlayers = () => [...players.values()].filter(p => p.alive);

  function pickColor() {
    const used = new Set([...players.values()].map(p => p.color));
    return COLORS.find(c => !used.has(c)) || COLORS[players.size % COLORS.length];
  }

  function pickSpawn() {
    const taken = [...players.values()].map(p => p.pos.x);
    const free = map.spawns.filter(s => !taken.some(x => Math.abs(x - s.x) < 60));
    return (free.length ? free : map.spawns)[Math.floor(Math.random() * (free.length || map.spawns.length))];
  }

  function makePlayer(id, name, bot) {
    const s = pickSpawn();
    return {
      id, name, bot,
      color: pickColor(),
      pos: createPhysState(s.x, s.y),
      immuneUntil: 0,
      alive: true,
      ai: bot ? { decideT: 0, jumpT: 0, objective: null, lastX: s.x, stuckT: 0, edgeT: 0, edgeDir: 1 } : null
    };
  }

  function addHuman(id, name, { joinImmunity = false } = {}) {
    const p = makePlayer(id, name, false);
    if (joinImmunity) p.immuneUntil = Date.now() + TAG.joinImmunitySeconds * 1000;
    players.set(id, p);
    return p;
  }

  function addBot() {
    const id = 'bot:' + botSeq++;
    const free = BOT_NAMES.filter(n => ![...players.values()].some(p => p.name === n));
    const name = free.length ? free[Math.floor(Math.random() * free.length)] : 'Bot' + botSeq;
    const p = makePlayer(id, name, true);
    players.set(id, p);
    return p;
  }

  function fillWithBots(target = TAG.maxPlayers) {
    while (players.size < target) addBot();
  }

  /** Remplace un partant encore vivant par exactement un bot (manche en cours). */
  function backfillBot() {
    if (!running || players.size >= TAG.maxPlayers) return;
    addBot();
  }

  /** Un humain remplace un bot VIVANT dans une partie publique en cours. */
  function replaceBotWithHuman(id, name) {
    const bots = alivePlayers().filter(p => p.bot);
    if (!bots.length) return null;
    const out = bots.find(b => b.id !== itId) || bots[0];
    players.delete(out.id);
    if (itId === out.id) reassignIt();
    return addHuman(id, name, { joinImmunity: true });
  }

  /** Retire un humain ; retourne true s'il était encore vivant. */
  function removeHuman(id) {
    const p = players.get(id);
    if (!p) return false;
    const wasAlive = p.alive;
    players.delete(id);
    const ei = eliminated.indexOf(p);
    if (ei !== -1) eliminated.splice(ei, 1);
    if (itId === id) reassignIt();
    // élimination : si le départ laisse un seul survivant, la manche se termine
    if (running && mode === 'elimination' && alivePlayers().length === 1) endElimination();
    return wasAlive;
  }

  function reassignIt() {
    const list = alivePlayers();
    if (!list.length) { itId = null; return; }
    const now = Date.now();
    const candidates = list.filter(p => now >= p.immuneUntil);
    const pool = candidates.length ? candidates : list;
    itId = pool[Math.floor(Math.random() * pool.length)].id;
    emit('tag:tagged', { itId, prevId: null });
  }

  function start() {
    running = true;
    botsFilled = false;
    const now = Date.now();
    goAt = now + startDelaySeconds * 1000;
    // pas d'attente (tests, TAG_START_DELAY=0) : pas de lobby, on complète
    // tout de suite une partie publique pour que le mode/itId tiennent
    // compte des bots dès le départ (comme avant l'introduction du lobby).
    if (goAt <= now && room.isPublic && players.size < TAG.maxPlayers) {
      fillWithBots(TAG.maxPlayers);
      botsFilled = true;
    }
    mode = players.size === 2 ? 'classic' : 'elimination';
    eliminated.length = 0;
    deadline = goAt + (mode === 'classic' ? roundSeconds * 1000 : elimSeconds * 1000 + ELIM_EXTRA_MS);
    const list = [...players.values()];
    const spawns = [...map.spawns].sort(() => Math.random() - 0.5);
    list.forEach((p, i) => {
      const s = spawns[i % spawns.length];
      p.pos = createPhysState(s.x, s.y);
      p.immuneUntil = 0;
      p.alive = true;
    });
    itId = list[Math.floor(Math.random() * list.length)].id;
    room.status = 'playing';
    emit('game:start', startPayload());
  }

  function startPayload() {
    return {
      gameType: 'tag-arena',
      code: room.code,
      isPublic: room.isPublic,
      mapId: map.id,
      mode,
      // temps d'attente restant avant que la manche démarre vraiment (s)
      startDelay: Math.max(0, (goAt - Date.now()) / 1000),
      snapshot: snapshot()
    };
  }

  function snapshot() {
    const now = Date.now();
    return {
      mode,
      t: Math.max(0, (deadline - now) / 1000),
      itId,
      players: [...players.values()].map(p => ({
        id: p.id, name: p.name, bot: p.bot, color: p.color,
        x: Math.round(p.pos.x * 10) / 10,
        y: Math.round(p.pos.y * 10) / 10,
        vx: Math.round(p.pos.vx),
        vy: Math.round(p.pos.vy),
        f: p.pos.f,
        imm: now < p.immuneUntil,
        dead: !p.alive
      }))
    };
  }

  /** Position reçue d'un client humain (il est autoritaire sur son déplacement). */
  function handleMove(id, data) {
    if (!running || !data) return;
    const p = players.get(id);
    if (!p || p.bot || !p.alive) return;
    const x = Number(data.x), y = Number(data.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    p.pos.x = Math.min(Math.max(x, PHYS.playerW / 2), map.width - PHYS.playerW / 2);
    p.pos.y = Math.min(Math.max(y, 0), map.height);
    p.pos.vx = Number.isFinite(Number(data.vx)) ? Number(data.vx) : 0;
    p.pos.vy = Number.isFinite(Number(data.vy)) ? Number(data.vy) : 0;
    p.pos.f = data.f === -1 ? -1 : 1;
  }

  /** Un client a déclenché un pad/téléporteur : on le relaie aux autres (FX). */
  function handleFx(id, data) {
    if (!running || !data) return;
    const p = players.get(id);
    if (!p || !p.alive) return;
    if (data.kind !== 'pad' && data.kind !== 'teleport') return;
    emit('tag:fx', {
      playerId: id,
      kind: data.kind,
      id: Number(data.id) || 0,
      from: Number(data.from) || 0,
      to: Number(data.to) || 0
    });
  }

  // ------------------------------------------------------------------ bots
  function nearestOf(from, filter) {
    let best = null, bd = Infinity;
    for (const p of players.values()) {
      if (p === from || !p.alive || (filter && !filter(p))) continue;
      const d = dist(centerOf(from.pos), centerOf(p.pos));
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  function botThink(bot, dt, now) {
    const ai = bot.ai, pos = bot.pos;
    const isIt = itId === bot.id;
    ai.jumpT = Math.max(0, ai.jumpT - dt);
    ai.decideT -= dt;
    const input = { left: false, right: false, jumpPressed: false, jumpHeld: ai.jumpT > 0 };

    let tx = pos.x, ty = pos.y;

    if (isIt) {
      // poursuite : viser le joueur vivant le plus proche (non immunisé de préférence)
      ai.objective = null;
      const target = nearestOf(bot, p => now >= p.immuneUntil) || nearestOf(bot);
      if (target) { tx = target.pos.x; ty = target.pos.y; }
    } else {
      const it = players.get(itId);

      if (ai.decideT <= 0) {
        ai.decideT = 0.3 + Math.random() * 0.35;
        // de temps en temps, fuir via un pad ou un téléporteur
        if (it && Math.abs(it.pos.x - pos.x) < 340 && Math.random() < 0.35) {
          const spots = [
            ...map.pads.map(s => ({ x: s.x + s.w / 2, y: s.y })),
            ...(pos.tpCooldown <= 0
              ? map.teleporters.map(s => ({ x: s.x + s.w / 2, y: s.y + s.h }))
              : [])
          ].filter(s => Math.abs(s.x - it.pos.x) > 180);
          if (spots.length) {
            spots.sort((a, b) => Math.abs(a.x - pos.x) - Math.abs(b.x - pos.x));
            ai.objective = { x: spots[0].x, y: spots[0].y, until: now + 2500 };
          }
        }
      }
      if (ai.objective && (now > ai.objective.until || Math.abs(ai.objective.x - pos.x) < 22)) {
        ai.objective = null;
      }

      if (ai.objective) {
        tx = ai.objective.x; ty = ai.objective.y;
      } else if (it) {
        // fuite : s'éloigner du chat ; coincé contre un mur → chercher la hauteur
        let away = Math.sign(pos.x - it.pos.x);
        if (away === 0) away = Math.random() < 0.5 ? -1 : 1;
        tx = pos.x + away * 420;
        if (tx < 60 || tx > map.width - 60) ty = pos.y - 180;
        tx = Math.min(Math.max(tx, 50), map.width - 50);
      }
    }

    // cible nettement en dessous alors qu'on est sur une plateforme :
    // viser le bord le plus proche pour en tomber (pas de drop-through)
    if (ty > pos.y + 80 && pos.onGround && pos.y < map.ground.y) {
      const hw = PHYS.playerW / 2;
      const sup = map.platforms.find(s =>
        pos.y === s.y && pos.x + hw > s.x && pos.x - hw < s.x + s.w);
      if (sup) {
        tx = (pos.x - sup.x < sup.x + sup.w - pos.x) ? sup.x - 40 : sup.x + sup.w + 40;
      }
    }

    // anti-blocage en bordure : si on est plaqué contre un bord de la carte et
    // qu'on vise encore au-delà du mur, la physique annule vx au clamp et le bot
    // pousserait le mur indéfiniment. On déclenche alors une poussée INVERSE
    // soutenue (~0.8 s) vers l'intérieur pour vraiment décoller du bord.
    const HW = PHYS.playerW / 2;
    ai.edgeT = Math.max(0, (ai.edgeT || 0) - dt);
    if (pos.x <= HW + 2 && tx <= pos.x) { ai.edgeT = 0.8; ai.edgeDir = 1; }
    else if (pos.x >= map.width - HW - 2 && tx >= pos.x) { ai.edgeT = 0.8; ai.edgeDir = -1; }
    if (ai.edgeT > 0) tx = pos.x + ai.edgeDir * 400;

    const dx = tx - pos.x;
    if (Math.abs(dx) > 12) (dx > 0 ? (input.right = true) : (input.left = true));

    let wantJump = false;
    if (pos.onGround) {
      if (ty < pos.y - 60 && Math.random() < 4.5 * dt) wantJump = true;   // grimper vers la cible
      if (isIt && ty < pos.y - 30 && Math.abs(dx) < 90) wantJump = true;  // cible juste au-dessus
      if (ai.stuckT > 0.5) { wantJump = true; ai.stuckT = 0; }            // débloquer
      if (!isIt && Math.random() < 0.25 * dt) wantJump = true;            // esquive occasionnelle
    }
    if (wantJump) {
      input.jumpPressed = true;
      input.jumpHeld = true;
      ai.jumpT = 0.2 + Math.random() * 0.15;
    }

    // blocage : on pousse dans une direction mais on n'avance pas
    if ((input.left || input.right) && Math.abs(pos.x - ai.lastX) < 30 * dt) ai.stuckT += dt;
    else ai.stuckT = 0;
    ai.lastX = pos.x;

    return input;
  }

  // ------------------------------------------------------------------ tick
  function tick(dt) {
    if (!running) return;
    const now = Date.now();

    // temps d'attente avant le vrai début (laisse le temps à tout le monde
    // d'arriver) : tout reste figé (pas de bots, pas de tags, pas de timer),
    // on diffuse juste l'état (le compte à rebours affiché continue de courir).
    if (now < goAt) {
      // à la dernière seconde de l'attente (6e s sur 7), une partie publique
      // encore incomplète est comblée par des bots, et le "it" est retiré au
      // sort parmi tous les joueurs pour rester équitable.
      if (!botsFilled && room.isPublic && players.size < TAG.maxPlayers && goAt - now <= 1000) {
        fillWithBots(TAG.maxPlayers);
        botsFilled = true;
        reassignIt();
      }
      emit('tag:state', snapshot());
      return;
    }

    for (const p of players.values()) {
      if (!p.bot || !p.alive) continue; // un bot éliminé ne fait plus rien
      const input = botThink(p, dt, now);
      const events = stepPlayer(p.pos, input, dt, {
        map,
        speedMul: itId === p.id ? PHYS.itSpeedMul : 1
      });
      for (const ev of events) {
        if (ev.kind === 'pad') emit('tag:fx', { playerId: p.id, kind: 'pad', id: ev.id });
        if (ev.kind === 'teleport') emit('tag:fx', { playerId: p.id, kind: 'teleport', from: ev.from, to: ev.to });
      }
    }

    // détection du tag (autoritaire, entre vivants) — un seul transfert par tick.
    // On retient le joueur éligible le PLUS PROCHE (et pas le premier de la
    // Map) pour que ce soit toujours le contact le plus visible qui transfère
    // la bombe — évite qu'un joueur immunisé "absorbe" le tag visuel d'un
    // autre joueur juste à côté.
    const it = players.get(itId);
    if (it && it.alive) {
      let best = null, bd = Infinity;
      for (const p of players.values()) {
        if (!p.alive || p.id === itId || now < p.immuneUntil) continue;
        const d = dist(centerOf(it.pos), centerOf(p.pos));
        if (d <= TAG.distance && d < bd) { bd = d; best = p; }
      }
      if (best) {
        const prev = itId;
        itId = best.id;
        it.immuneUntil = now + TAG.immunitySeconds * 1000; // l'ex-chat est intouchable un court instant
        emit('tag:tagged', { itId, prevId: prev });
      }
    } else if (alivePlayers().length) {
      reassignIt();
    }

    emit('tag:state', snapshot());

    if (now >= deadline) {
      if (mode === 'classic') endClassic();
      else boom();
    }
  }

  /** Mode élimination : le "it" explose, nouveau "it" parmi les survivants. */
  function boom() {
    const victim = players.get(itId);
    if (!victim) { reassignIt(); deadline = Date.now() + elimSeconds * 1000 + ELIM_EXTRA_MS; return; }
    victim.alive = false;
    eliminated.push(victim);
    const remaining = alivePlayers();
    emit('tag:boom', {
      playerId: victim.id,
      name: victim.name,
      x: Math.round(victim.pos.x),
      y: Math.round(victim.pos.y),
      place: remaining.length + 1, // 4 joueurs : 1ère explosion = 4e place, etc.
      remaining: remaining.length
    });
    itId = null;
    if (remaining.length <= 1) {
      endElimination();
      return;
    }
    itId = remaining[Math.floor(Math.random() * remaining.length)].id;
    emit('tag:tagged', { itId, prevId: null });
    deadline = Date.now() + elimSeconds * 1000 + ELIM_EXTRA_MS;
  }

  function endElimination() {
    if (!running) return;
    running = false;
    room.status = 'ended';
    const survivor = alivePlayers()[0] || null;
    // classement : gagnant, puis les éliminés du dernier au premier
    const ranking = [
      ...(survivor ? [survivor] : []),
      ...[...eliminated].reverse()
    ].map((p, i) => ({ id: p.id, name: p.name, bot: p.bot, rank: i + 1 }));
    emit('tag:end', {
      aborted: false,
      mode: 'elimination',
      winnerId: survivor?.id ?? null,
      winnerName: survivor?.name ?? '?',
      ranking
    });
    opts.onEnd?.(room, { aborted: false });
  }

  /** Mode classique (1v1) : le "it" à la fin du timer perd. */
  function endClassic() {
    running = false;
    room.status = 'ended';
    const loser = players.get(itId);
    emit('tag:end', {
      aborted: false,
      mode: 'classic',
      loserId: itId,
      loserName: loser ? loser.name : '?',
      winners: [...players.values()]
        .filter(p => p.id !== itId)
        .map(p => ({ id: p.id, name: p.name }))
    });
    opts.onEnd?.(room, { aborted: false });
  }

  /** Manche annulée (plus assez de joueurs dans un salon privé). */
  function abort(reason) {
    if (!running) return;
    running = false;
    room.status = 'ended';
    emit('tag:end', { aborted: true, reason });
    opts.onEnd?.(room, { aborted: true });
  }

  return {
    start,
    tick,
    abort,
    addHuman,
    removeHuman,
    replaceBotWithHuman,
    fillWithBots,
    backfillBot,
    handleMove,
    handleFx,
    startPayload,
    snapshot,
    /** Une partie publique peut accueillir un humain (en remplaçant un bot vivant). */
    joinable: () => running && alivePlayers().some(p => p.bot) &&
      (mode === 'classic'
        ? Math.max(0, (deadline - Date.now()) / 1000) > 10
        : alivePlayers().length >= 3),
    /** Partie publique encore en attente (avant goAt), place libre pour un humain. */
    joinableWaiting: () => running && room.isPublic && Date.now() < goAt && players.size < TAG.maxPlayers,
    isRunning: () => running,
    map,
    // exposé pour les tests
    _players: players,
    _itId: () => itId,
    _mode: () => mode
  };
}
