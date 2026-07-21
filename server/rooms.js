/**
 * rooms.js — gestionnaire de salons générique, réutilisable par tous les jeux.
 * Un salon = { code, gameType, isPublic, status, hostId, players, game }.
 * La logique propre à chaque jeu vit dans server/games/<jeu>.js et est
 * accrochée au salon via room.game (créée au lancement de la partie).
 */

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // sans I, L, O (ambigus)

export class RoomManager {
  constructor() {
    this.rooms = new Map();    // code -> room
    this.byPlayer = new Map(); // socketId -> code
  }

  genCode() {
    let code;
    do {
      code = Array.from({ length: 4 }, () =>
        CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
      ).join('');
    } while (this.rooms.has(code));
    return code;
  }

  create(gameType, { isPublic = false, code = null } = {}) {
    const room = {
      code: code || this.genCode(), // code imposé (Mine Coop) ou aléatoire (défaut)
      gameType,
      isPublic,
      status: 'lobby',      // 'lobby' | 'playing' | 'ended'
      hostId: null,
      players: new Map(),   // socketId -> { id, name }
      game: null,           // instance de jeu (server/games/*)
      createdAt: Date.now(),
      endedAt: 0
    };
    this.rooms.set(room.code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(code) || null;
  }

  /** Un salon actif occupe-t-il déjà ce code ? (collision de code de monde). */
  hasActive(code) {
    return this.rooms.has(code);
  }

  all() {
    return this.rooms.values();
  }

  roomOf(socketId) {
    const code = this.byPlayer.get(socketId);
    return code ? this.rooms.get(code) || null : null;
  }

  addPlayer(room, socket, name) {
    if (!room.hostId) room.hostId = socket.id;
    room.players.set(socket.id, { id: socket.id, name });
    this.byPlayer.set(socket.id, room.code);
    socket.join(room.code);
  }

  /**
   * Retire le joueur de son salon courant (s'il en a un).
   * Supprime le salon s'il devient vide, migre l'hôte sinon.
   * Retourne { room, removedRoom } ou null si le joueur n'était nulle part.
   */
  removePlayer(socket) {
    const code = this.byPlayer.get(socket.id);
    if (!code) return null;
    this.byPlayer.delete(socket.id);
    const room = this.rooms.get(code);
    if (!room) return null;
    room.players.delete(socket.id);
    socket.leave(code);
    let removedRoom = false;
    if (room.players.size === 0) {
      this.rooms.delete(code);
      removedRoom = true;
    } else if (room.hostId === socket.id) {
      room.hostId = room.players.keys().next().value; // migration d'hôte
    }
    return { room, removedRoom };
  }

  /**
   * Renomme le code d'un salon (Mine Coop : changement de code de monde en jeu).
   * Met à jour la table des salons et l'index byPlayer. Le canal socket.io doit
   * être migré séparément par l'appelant. Retourne false si conflit / introuvable.
   */
  renameRoom(oldCode, newCode) {
    const room = this.rooms.get(oldCode);
    if (!room || this.rooms.has(newCode)) return false;
    this.rooms.delete(oldCode);
    room.code = newCode;
    this.rooms.set(newCode, room);
    for (const id of room.players.keys()) this.byPlayer.set(id, newCode);
    return true;
  }

  /** Suppression forcée (ménage des salons publics terminés). */
  deleteRoom(room) {
    for (const id of room.players.keys()) this.byPlayer.delete(id);
    this.rooms.delete(room.code);
  }

  findPublic(gameType, predicate) {
    for (const r of this.rooms.values()) {
      if (r.isPublic && r.gameType === gameType && (!predicate || predicate(r))) return r;
    }
    return null;
  }

  /** Vue du salon envoyée aux clients (room:update). */
  serialize(room) {
    return {
      code: room.code,
      gameType: room.gameType,
      isPublic: room.isPublic,
      status: room.status,
      hostId: room.hostId,
      players: [...room.players.values()].map(p => ({
        id: p.id,
        name: p.name,
        isHost: p.id === room.hostId
      }))
    };
  }
}
