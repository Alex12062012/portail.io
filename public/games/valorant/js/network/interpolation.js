// Interpolation d'entités : les autres joueurs (humains + bots) sont affichés avec
// ~100 ms de retard, en glissant entre les deux snapshots serveur qui encadrent
// l'instant de rendu. Résultat : un mouvement lisse malgré un tickrate serveur de
// ~25-30 Hz, sans à-coups ni téléportation entre deux paquets.
//
// Fonction pure (pas de DOM, pas de Three) : le curseur temporel est injecté, donc
// testable sous node. `now()` par défaut = performance.now() dans le navigateur.
const DELAY = 100; // ms de retard d'interpolation (un peu > l'intervalle entre snapshots)

const lerp = (a, b, f) => a + (b - a) * f;
// Angles : on interpole par le plus court chemin pour éviter le tour complet à ±π.
function lerpAngle(a, b, f) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}

export function createInterpolator(now = () => performance.now()) {
  const buf = []; // { t: instant de réception client, snap }

  return {
    push(snap) {
      buf.push({ t: now(), snap });
      if (buf.length > 40) buf.shift();
    },

    get latest() { return buf.length ? buf[buf.length - 1].snap : null; },

    // Positions/orientations interpolées, indexées par id d'acteur. Les champs
    // discrets (hp, alive…) doivent être lus sur `latest`, pas interpolés.
    sample() {
      if (!buf.length) return new Map();
      const target = now() - DELAY;
      let a = buf[0], b = buf[0];
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i].t <= target) { a = buf[i]; b = buf[i + 1] ?? buf[i]; break; }
      }
      const span = b.t - a.t;
      const f = span > 0 ? Math.min(1, Math.max(0, (target - a.t) / span)) : 0;
      const bById = new Map(b.snap.actors.map((x) => [x.id, x]));
      const out = new Map();
      for (const pa of a.snap.actors) {
        const pb = bById.get(pa.id) ?? pa;
        out.set(pa.id, {
          x: lerp(pa.x, pb.x, f), y: lerp(pa.y, pb.y, f), z: lerp(pa.z, pb.z, f),
          yaw: lerpAngle(pa.yaw ?? 0, pb.yaw ?? 0, f),
        });
      }
      return out;
    },
  };
}
