// Client réseau du 3v3 en ligne. Enveloppe le socket.io du portail (global `io`,
// chargé via /socket.io/socket.io.js dans index.html) :
//  - matchmaking : quickplay 'valorant' → écran d'attente → game:start ;
//  - réception : snapshots (bufferisés pour interpolation), hits, kills, fx, fin ;
//  - émission : input (~30 Hz), tir reporté, capacité, achat, prêt.
//
// Le serveur est autoritaire (server/games/valorant.js). Ce module ne fait aucune
// simulation : il synchronise, main.js affiche.
import { createInterpolator } from './interpolation.js';

export class NetClient {
  constructor(socket, start) {
    this.socket = socket;
    // selfId = l'id STABLE de mon acteur (celui dont le socketId est ma socket),
    // pas la socket elle-même : il survit à un remplacement bot↔humain.
    this.selfId = start.roster.find((r) => r.socketId === socket.id)?.id ?? socket.id;
    this.mapId = start.mapId;
    this.roster = start.roster;
    this.interp = createInterpolator();
    if (start.snapshot) this.interp.push(start.snapshot);
    this.handlers = { hit: [], kill: [], fx: [], end: [] };

    socket.on('val:snap', (s) => this.interp.push(s));
    socket.on('val:hit', (d) => this.fire('hit', d));
    socket.on('val:kill', (d) => this.fire('kill', d));
    socket.on('val:fx', (d) => this.fire('fx', d));
    socket.on('game:end', (d) => this.fire('end', d));
  }

  on(ev, fn) { this.handlers[ev].push(fn); return this; }
  fire(ev, d) { for (const fn of this.handlers[ev]) fn(d); }

  // Dernier snapshot brut (champs discrets : hp, alive, spike, round, crédits…).
  get snap() { return this.interp.latest; }
  self() { return this.snap?.actors.find((a) => a.id === this.selfId) ?? null; }
  // Positions interpolées des autres acteurs, indexées par id.
  sample() { return this.interp.sample(); }

  sendInput(d) { this.socket.emit('val:input', d); }
  sendShot(d) { this.socket.emit('val:shot', d); }
  sendAbility(d) { this.socket.emit('val:ability', d); }
  sendBuy(d) { this.socket.emit('val:buy', d); }
  sendReady() { this.socket.emit('val:ready'); }
  close() { try { this.socket.close(); } catch { /* déjà fermé */ } }
}

// Se connecte, lance le quickplay, attend le début de partie. `onWait` reçoit le
// décompte de la file ({ left, mapId }) tant que la partie ne démarre pas.
export function joinOnlineMatch({ name, agentKey, onWait }) {
  const io = globalThis.io;
  if (!io) throw new Error('socket.io non chargé (voir index.html)');
  const socket = io();

  return new Promise((resolve, reject) => {
    socket.on('connect_error', (e) => reject(new Error('connexion serveur impossible : ' + e.message)));
    socket.on('val:wait', (d) => onWait?.(d));
    socket.once('game:start', (start) => resolve(new NetClient(socket, start)));
    socket.on('connect', () => {
      socket.emit('quickplay', { gameType: 'valorant', name, agentKey }, (ack) => {
        if (!ack?.ok) reject(new Error('matchmaking refusé : ' + (ack?.error ?? 'inconnu')));
      });
    });
  });
}
