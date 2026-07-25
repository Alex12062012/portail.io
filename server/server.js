/**
 * server.js — serveur du portail portail.io.
 * - sert le portail et les jeux (public/) + les modules partagés (shared/)
 * - héberge le système de salons générique (rooms.js)
 * - branche les jeux (server/games/*) sur les salons via le registre GAMES
 * - npm start : lance aussi un tunnel ngrok ; npm run server-only : sans tunnel
 */
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { RoomManager } from './rooms.js';
import { createTagGame } from './games/tag-arena.js';
import { createMineGame } from './games/mine-coop.js';
import { createValorantGame } from './games/valorant.js';
import { TAG } from '../shared/tag-map.js';
import { loadSaveIfExists, listSaves, randomSeed } from './mine-save.js';
import { registerModels } from '../public/games/valorant/js/bots/bot_controller.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const NO_TUNNEL = process.argv.includes('--no-tunnel');

// Modèles de bots entraînés par rôle (public/games/valorant/tools/train). Absents
// => les bots gardent leur comportement scripté par ELO : rien ne casse.
(() => {
  const dir = path.join(ROOT, 'public/games/valorant/models');
  try {
    const models = fs.readdirSync(dir)
      .filter((f) => f.startsWith('best_') && f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    const n = registerModels(models);
    if (n) console.log(`valorant : ${n} modèles de bots entraînés chargés`);
  } catch { /* dossier absent ou illisible : bots scriptés */ }
})();

// ---- registre des jeux ------------------------------------------------------
// Pour ajouter un jeu : créer server/games/<id>.js + public/games/<id>/,
// puis l'enregistrer ici (voir README).
const GAMES = {
  'tag-arena': {
    minPlayers: TAG.minPlayers,
    maxPlayers: TAG.maxPlayers,
    create: (io, room, opts) => createTagGame(io, room, opts)
  },
  'mine-coop': {
    minPlayers: 1, // un monde solo doit pouvoir démarrer
    maxPlayers: 4,
    create: (io, room, opts) => createMineGame(io, room, opts)
  },
  'valorant': {
    minPlayers: 1, // un joueur seul démarre, les places libres sont comblées par des bots
    maxPlayers: 6, // 3v3
    create: (io, room, opts) => createValorantGame(io, room, opts)
  }
};

const app = express();
app.use(express.static(path.join(ROOT, 'public')));
app.use('/shared', express.static(path.join(ROOT, 'shared')));

const server = http.createServer(app);
const io = new Server(server);
const rooms = new RoomManager();

const cleanName = raw => {
  const s = String(raw ?? '').trim().slice(0, 16);
  return s.length >= 2 ? s : 'Joueur' + Math.floor(100 + Math.random() * 900);
};

function broadcastRoom(room) {
  io.to(room.code).emit('room:update', rooms.serialize(room));
}

/** Lance une manche dans un salon (amis ou public). */
function startGame(room, gameOpts = {}) {
  const def = GAMES[room.gameType];
  const opts = { ...gameOpts };
  // les options de lobby/fin de manche sont propres à Tag Arena ; Mine Coop
  // démarre immédiatement (pas d'attente, pas de bots, pas de onEnd) avec son
  // monde (seed ou sauvegarde) transmis via gameOpts.
  if (room.gameType === 'tag-arena') {
    opts.onEnd = onRoundEnd;
    opts.startDelaySeconds = process.env.TAG_START_DELAY !== undefined
      ? Number(process.env.TAG_START_DELAY)
      : 7;
  }
  if (room.gameType === 'valorant') {
    opts.onEnd = onRoundEnd; // partie publique terminée → statut 'ended' + ménage
    if (process.env.VAL_WAIT_SECONDS !== undefined) opts.waitSeconds = Number(process.env.VAL_WAIT_SECONDS);
  }
  room.game = def.create(io, room, opts);
  // p.agentKey n'existe que pour valorant (posé au quickplay) ; undefined ailleurs,
  // ce que les addHuman de tag/mine ignorent (paramètre d'options par défaut).
  for (const p of room.players.values()) room.game.addHuman(p.id, p.name, p.agentKey);
  room.game.start(); // met room.status = 'playing' et émet game:start
  broadcastRoom(room);
}

function onRoundEnd(room, { aborted = false } = {}) {
  if (room.isPublic) {
    room.status = 'ended';
    room.endedAt = Date.now();
  } else {
    // salon entre amis : retour au lobby, l'hôte peut relancer
    room.status = 'lobby';
    room.game = null;
    broadcastRoom(room);
  }
}

/** Sort le joueur de son salon courant en gérant la partie en cours. */
function leaveCurrent(socket) {
  const res = rooms.removePlayer(socket);
  if (!res) return;
  const { room, removedRoom } = res;
  if (room.game && room.status === 'playing') {
    if (room.gameType === 'mine-coop') {
      room.game.removeHuman(socket.id); // sauvegarde l'inventaire du partant
      if (removedRoom) room.game.save(); // dernier joueur parti → persiste le monde
    } else if (room.gameType === 'valorant') {
      // Déco en cours de match : un bot reprend la place, la partie continue.
      room.game.removeHuman(socket.id);
    } else {
      const wasAlive = room.game.removeHuman(socket.id);
      if (!room.isPublic && room.players.size < GAMES[room.gameType].minPlayers) {
        room.game.abort('Un joueur a quitté : il faut au moins 2 joueurs.');
      }
      if (room.isPublic && !removedRoom && wasAlive) {
        // un humain encore en jeu parti d'une partie publique est remplacé par
        // exactement un bot (un spectateur déjà éliminé ne libère aucune place)
        room.game.backfillBot();
      }
    }
  }
  if (!removedRoom) broadcastRoom(room);
}

io.on('connection', socket => {
  // ping du HUD de debug : réponse immédiate via l'ack (avec ou sans payload)
  socket.on('hud:ping', (...args) => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') cb();
  });

  socket.on('room:create', (payload = {}, cb) => {
    const ack = typeof cb === 'function' ? cb : () => {};
    if (!GAMES[payload.gameType]) return ack({ ok: false, error: 'unknown_game' });
    leaveCurrent(socket);

    let room, gameOpts = {};
    if (payload.gameType === 'mine-coop' && payload.worldCode) {
      // code de monde personnalisé : recharge une sauvegarde, ou nouveau monde
      const code = String(payload.worldCode).trim().toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(code)) return ack({ ok: false, error: 'bad_code' });
      if (rooms.hasActive(code)) return ack({ ok: false, error: 'code_taken' });
      const save = loadSaveIfExists(code);
      room = rooms.create(payload.gameType, { code });
      gameOpts = save ? { save } : { seed: randomSeed() };
    } else if (payload.gameType === 'mine-coop') {
      room = rooms.create(payload.gameType);     // code aléatoire 4 lettres
      gameOpts = { seed: randomSeed() };
    } else {
      room = rooms.create(payload.gameType);     // Tag Arena : inchangé
    }
    room._gameOpts = gameOpts; // transmis à startGame quand l'hôte lance
    rooms.addPlayer(room, socket, cleanName(payload.name));
    broadcastRoom(room);
    ack({ ok: true, code: room.code, room: rooms.serialize(room) });
  });

  socket.on('room:join', (payload = {}, cb) => {
    const ack = typeof cb === 'function' ? cb : () => {};
    const code = String(payload.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room || room.isPublic) return ack({ ok: false, error: 'not_found' });
    if (room.status !== 'lobby') return ack({ ok: false, error: 'in_progress' });
    if (room.players.size >= GAMES[room.gameType].maxPlayers) return ack({ ok: false, error: 'full' });
    leaveCurrent(socket);
    rooms.addPlayer(room, socket, cleanName(payload.name));
    broadcastRoom(room);
    ack({ ok: true, code: room.code, room: rooms.serialize(room) });
  });

  socket.on('room:leave', () => leaveCurrent(socket));

  socket.on('room:start', (...args) => {
    const cb = args[args.length - 1];
    const ack = typeof cb === 'function' ? cb : () => {};
    const room = rooms.roomOf(socket.id);
    if (!room) return ack({ ok: false, error: 'no_room' });
    if (room.hostId !== socket.id) return ack({ ok: false, error: 'not_host' });
    if (room.status !== 'lobby') return ack({ ok: false, error: 'bad_status' });
    if (room.players.size < GAMES[room.gameType].minPlayers) {
      return ack({ ok: false, error: 'not_enough_players' });
    }
    startGame(room, room._gameOpts || {});
    ack({ ok: true });
  });

  // "Tous ensemble" : rejoint une partie publique en cours (en remplaçant un
  // bot) ou en attente (place libre), ou en crée une qui démarre immédiatement.
  socket.on('quickplay', (payload = {}, cb) => {
    const ack = typeof cb === 'function' ? cb : () => {};
    if (!GAMES[payload.gameType]) return ack({ ok: false, error: 'unknown_game' });
    leaveCurrent(socket);
    const name = cleanName(payload.name);
    let room = rooms.findPublic(payload.gameType, r =>
      r.status === 'playing' && r.game &&
      (r.game.joinableWaiting() || r.game.joinable()));
    if (room) {
      rooms.addPlayer(room, socket, name);
      if (room.gameType === 'valorant') {
        // Valorant : l'agent choisi voyage avec le joueur. Pendant la file, on
        // prend une place libre sans game:start (le jeu enverra val:wait puis
        // game:start à `begin`) ; sinon on remplace un bot dans la manche en cours.
        room.players.get(socket.id).agentKey = payload.agentKey;
        if (room.game.joinableWaiting()) {
          room.game.addHuman(socket.id, name, payload.agentKey);
          broadcastRoom(room);
        } else {
          room.game.replaceBotWithHuman(socket.id, name, payload.agentKey);
          broadcastRoom(room);
          socket.emit('game:start', room.game.startPayload());
        }
      } else {
        if (room.game.joinableWaiting()) {
          // encore dans le temps d'attente : on prend une place libre
          room.game.addHuman(socket.id, name, { joinImmunity: true });
        } else {
          room.game.replaceBotWithHuman(socket.id, name);
        }
        broadcastRoom(room);
        socket.emit('game:start', room.game.startPayload());
      }
    } else {
      room = rooms.create(payload.gameType, { isPublic: true });
      rooms.addPlayer(room, socket, name);
      if (payload.gameType === 'valorant') room.players.get(socket.id).agentKey = payload.agentKey;
      startGame(room);
    }
    ack({ ok: true, code: room.code });
  });

  // événements du jeu Tag Arena, routés vers l'instance du salon
  socket.on('tag:move', data => {
    const room = rooms.roomOf(socket.id);
    if (room?.game && room.status === 'playing') room.game.handleMove(socket.id, data);
  });
  socket.on('tag:fx', data => {
    const room = rooms.roomOf(socket.id);
    if (room?.game && room.status === 'playing') room.game.handleFx(socket.id, data);
  });

  // événements du jeu Mine Coop, routés vers l'instance du salon (même garde)
  const routeMine = (ev, method) => socket.on(ev, data => {
    const room = rooms.roomOf(socket.id);
    if (room?.game && room.status === 'playing' && room.gameType === 'mine-coop') {
      room.game[method](socket.id, data);
    }
  });
  routeMine('mine:move', 'handleMove');
  routeMine('mine:select', 'handleSelect');
  routeMine('mine:break', 'handleBreak');
  routeMine('mine:place', 'handlePlace');
  routeMine('mine:chunkRequest', 'handleChunkRequest');
  routeMine('mine:craft', 'handleCraft');
  routeMine('mine:smelt', 'handleSmelt');
  routeMine('mine:teleport', 'handleTeleport');
  routeMine('mine:attack', 'handleAttack');
  routeMine('mine:invMove', 'handleInvMove');
  routeMine('mine:craftGrid', 'handleCraftGrid');
  routeMine('mine:chestOpen', 'handleChestOpen');
  routeMine('mine:statInc', 'handleStatInc');
  routeMine('mine:save', 'handleSave');
  routeMine('mine:statsRequest', 'handleStatsRequest');

  // événements du jeu Valorant, routés vers l'instance du salon (même garde)
  const routeVal = (ev, method) => socket.on(ev, data => {
    const room = rooms.roomOf(socket.id);
    if (room?.game && room.status === 'playing' && room.gameType === 'valorant') {
      room.game[method](socket.id, data);
    }
  });
  routeVal('val:input', 'handleInput');   // position/orientation + touche d'action (pose/défuse)
  routeVal('val:shot', 'handleShot');     // tir reporté (le client a fait le raycast)
  routeVal('val:ability', 'handleAbility');
  routeVal('val:buy', 'handleBuy');
  routeVal('val:ready', 'handleReady');

  // changement de code du monde : a besoin d'un callback + accès au gestionnaire de salons
  socket.on('mine:setCode', (data, cb) => {
    const ack = typeof cb === 'function' ? cb : () => {};
    const room = rooms.roomOf(socket.id);
    if (!room?.game || room.status !== 'playing' || room.gameType !== 'mine-coop') {
      return ack({ ok: false, error: 'no_room' });
    }
    room.game.handleSetCode(socket.id, data, ack, rooms);
  });

  // liste des mondes sauvegardés (écran de création : avertissement avant éviction LRU)
  socket.on('mine:savesInfo', (_payload, cb) => {
    const ack = typeof cb === 'function' ? cb : () => {};
    ack({ saves: listSaves(), max: 5 });
  });

  socket.on('disconnect', () => leaveCurrent(socket));
});

// ---- boucle de simulation (bots, tags, timer) à 30 Hz -----------------------
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  for (const room of rooms.all()) {
    if (room.status === 'playing' && room.game) room.game.tick(dt);
  }
}, 1000 / 30);

// ---- ménage : salons publics terminés depuis plus d'une minute --------------
setInterval(() => {
  for (const room of [...rooms.all()]) {
    if (room.isPublic && room.status === 'ended' && Date.now() - room.endedAt > 60_000) {
      io.to(room.code).emit('room:closed');
      io.in(room.code).socketsLeave(room.code);
      rooms.deleteRoom(room);
    }
  }
}, 30_000);

// ---- démarrage + tunnel ngrok -----------------------------------------------
server.listen(PORT, async () => {
  console.log('');
  console.log(' ⚡ portail.io lancé !');
  console.log(`    Local  : http://localhost:${PORT}`);
  const lan = Object.values(os.networkInterfaces()).flat()
    .find(i => i && i.family === 'IPv4' && !i.internal);
  if (lan) console.log(`    LAN    : http://${lan.address}:${PORT}`);
  if (NO_TUNNEL) {
    console.log('    (tunnel ngrok désactivé — --no-tunnel)');
    return;
  }
  try {
    const mod = await import('@ngrok/ngrok');
    const ngrok = mod.default ?? mod;
    const listener = await ngrok.connect({ addr: PORT, authtoken_from_env: true });
    console.log(`    Public : ${listener.url()}   ← à partager aux amis`);
  } catch (err) {
    console.warn(`    ⚠ ngrok non démarré : ${err.message}`);
    console.warn('      (définis NGROK_AUTHTOKEN, ou utilise npm run server-only)');
  }
});
