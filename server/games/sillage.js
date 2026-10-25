/**
 * sillage.js — free ride de Sillage (jeu hébergé sur Vercel) : un simple relais.
 * Un canal par station ; chaque skieur envoie son état ~15 fois par seconde, le
 * serveur renvoie à 15 Hz l'état de tous les skieurs du canal. Pas de physique
 * côté serveur : chaque client reste maître de son skieur (comme Valorant pour
 * les positions). Un choc est signalé par celui qui le voit (`sillage:bump`),
 * le serveur le relaie à l'autre pour qu'il chute aussi.
 */

const MAX_PER_STATION = 40;
const STATION = /^[a-z][a-z0-9-]{1,23}$/;
const channel = station => `sillage:${station}`;
const num = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);

export function createSillageRelay(io) {
  const skiers = new Map(); // socketId -> { station, name, look, state: number[] }

  function roster(station) {
    return [...skiers.entries()].filter(([, s]) => s.station === station).map(([id, s]) => ({ id, name: s.name, look: s.look }));
  }

  function leave(socket) {
    const s = skiers.get(socket.id);
    if (!s) return;
    skiers.delete(socket.id);
    socket.leave(channel(s.station));
    io.to(channel(s.station)).emit('sillage:left', socket.id);
  }

  function connect(socket) {
    socket.on('sillage:join', (payload = {}, cb) => {
      const ack = typeof cb === 'function' ? cb : () => {};
      const station = String(payload.station ?? '');
      if (!STATION.test(station)) return ack({ ok: false, error: 'bad_station' });
      if (roster(station).length >= MAX_PER_STATION) return ack({ ok: false, error: 'full' });
      leave(socket);
      const name = String(payload.name ?? '').trim().slice(0, 16) || `Skieur${Math.floor(100 + Math.random() * 900)}`;
      // la tenue : 4 couleurs 0xRRGGBB (veste, pantalon, casque, skis)
      const look = (Array.isArray(payload.look) ? payload.look : []).slice(0, 4).map(c => (Number.isInteger(c) ? c & 0xffffff : 0x888888));
      skiers.set(socket.id, { station, name, look, state: null });
      socket.join(channel(station));
      socket.to(channel(station)).emit('sillage:joined', { id: socket.id, name, look });
      ack({ ok: true, id: socket.id, skiers: roster(station).filter(s => s.id !== socket.id) });
    });

    // [x, y, z, cap, vx, vy, vz, carre, dérapage, drapeaux] — drapeaux : 1 en l'air, 2 tuck, 4 freine, 8 chute, 16 en remontée
    socket.on('sillage:state', data => {
      const s = skiers.get(socket.id);
      if (s && Array.isArray(data) && data.length <= 12) s.state = data.map(num);
    });

    socket.on('sillage:bump', (data = {}) => {
      const s = skiers.get(socket.id), other = skiers.get(String(data.id ?? ''));
      if (!s || !other || other.station !== s.station) return;
      io.to(String(data.id)).emit('sillage:bumped', { id: socket.id, vx: num(data.vx), vz: num(data.vz) });
    });

    socket.on('sillage:leave', () => leave(socket));
    socket.on('disconnect', () => leave(socket));
  }

  // diffusion à 15 Hz : les états de chaque station, à tous ceux qui y sont
  setInterval(() => {
    const byStation = new Map();
    for (const [id, s] of skiers) {
      if (!s.state) continue;
      if (!byStation.has(s.station)) byStation.set(s.station, {});
      byStation.get(s.station)[id] = s.state;
    }
    for (const [station, states] of byStation) io.to(channel(station)).emit('sillage:states', states);
  }, 1000 / 15);

  return { connect, count: () => skiers.size };
}
