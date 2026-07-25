// Système de points / récompense — pensé comme une fonction de reward (RL) :
// chaque acteur (joueur OU bot) accumule des points selon ce qu'il fait, et un
// classement est dressé en fin de match. Utilisé aussi bien côté serveur (3v3 en
// ligne) que côté client (1v3 / 3v3 local) : module pur, sans Three ni DOM, il
// tourne sous node (voir selftest.js).
//
// Les points vivent SUR l'acteur : `a.points` (total) + `a.pts` (détail par
// source). Rien à instancier — award()/awardMovement() initialisent au besoin.

// Barème — volontairement exposé et facile à régler (c'est le cœur du "reward
// shaping"). Récompense dense de déplacement volontairement faible pour ne pas
// écraser les récompenses d'objectif.
export const POINTS = {
  kill: 100,     // éliminer un adversaire
  plant: 60,     // poser le spike
  roundWin: 150, // par round gagné (toute l'équipe gagnante)
  perMeter: 1,   // par mètre parcouru pendant un round actif
};

const KEY = { kill: 'kill', plant: 'plant', roundWin: 'roundWin', perMeter: 'move' };

export function ensure(a) {
  if (!a.pts) { a.pts = { kill: 0, plant: 0, roundWin: 0, move: 0 }; a.points = 0; }
  return a;
}

// Ajoute une récompense. `mult` sert au déplacement (nombre de mètres).
export function award(actor, kind, mult = 1) {
  if (!actor) return 0;
  ensure(actor);
  const gain = POINTS[kind] * mult;
  actor.pts[KEY[kind]] += gain;
  actor.points += gain;
  return gain;
}

// Récompense de déplacement : distance parcourue depuis le dernier appel.
// Un saut de position > 5 m (respawn de round, téléporteur) n'est pas récompensé.
export function awardMovement(actor) {
  ensure(actor);
  const p = actor.pos;
  if (actor._lastPos) {
    const d = Math.hypot(p.x - actor._lastPos.x, p.z - actor._lastPos.z);
    if (d > 0.001 && d < 5) award(actor, 'perMeter', d);
    actor._lastPos.x = p.x; actor._lastPos.z = p.z;
  } else {
    actor._lastPos = { x: p.x, z: p.z };
  }
}

// Classement décroissant par points, prêt pour l'affichage / le game:end.
export function ranking(actors) {
  return actors
    .map((a) => ({
      id: a.id, name: a.name, team: a.team, bot: !!a.bot,
      points: Math.round(a.points ?? 0),
      pts: a.pts ? { kill: Math.round(a.pts.kill), plant: Math.round(a.pts.plant),
                     roundWin: Math.round(a.pts.roundWin), move: Math.round(a.pts.move) }
                 : { kill: 0, plant: 0, roundWin: 0, move: 0 },
      kills: a.matchKills ?? 0,
    }))
    .sort((x, y) => y.points - x.points);
}
