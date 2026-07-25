// Profil de bot = un "gène" que l'optimiseur (self-play, training/) fait varier et
// que le jeu charge pour donner à chaque bot un STYLE distinct. Module pur (aucun
// import) : tourne sous node comme dans le navigateur, et est testé par selftest.js.
//
// Deux axes de STYLE servent aussi de niches à l'optimiseur MAP-Elites :
//   - aggression : pousser vite/coller (1) vs temporiser/tenir (0)
//   - roam       : bouger beaucoup, changer de site (1) vs ancrer (0)
// Les autres gènes règlent la COMPÉTENCE, bornée à des valeurs plausiblement
// humaines (pas d'aimbot : réaction jamais sous ~0.18 s, visée jamais parfaite).

export const RANGES = {
  reaction:       [0.18, 0.55], // s avant de riposter à un ennemi vu
  fireInterval:   [0.40, 1.20], // s entre deux tirs
  aimError:       [0.50, 6.00], // dégrade la proba de toucher (jamais 0)
  headshotChance: [0.05, 0.45],
  abilityChance:  [0.10, 0.95],
  aggression:     [0.00, 1.00],
  roam:           [0.00, 1.00],
};
export const GENES = Object.keys(RANGES);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;

export function clampProfile(p) {
  const out = {};
  for (const g of GENES) out[g] = clamp(p[g] ?? (RANGES[g][0] + RANGES[g][1]) / 2, RANGES[g][0], RANGES[g][1]);
  return out;
}

export function randomProfile(rand = Math.random) {
  const p = {};
  for (const g of GENES) p[g] = lerp(RANGES[g][0], RANGES[g][1], rand());
  return p;
}

// Mutation gaussienne (approx via somme d'uniformes) d'une fraction des gènes.
export function mutate(profile, sigma = 0.15, rand = Math.random) {
  const gauss = () => (rand() + rand() + rand() + rand() - 2) / 2; // ~N(0, .58)
  const p = { ...profile };
  for (const g of GENES) {
    if (rand() < 0.5) continue; // ne mute qu'une partie des gènes à chaque fois
    const span = RANGES[g][1] - RANGES[g][0];
    p[g] += gauss() * sigma * span;
  }
  return clampProfile(p);
}

// Paramètres de COMBAT/compétence attendus par BotController (même forme que
// botParams()). smartBuy/holdsHigh sont dérivés de façon lisible.
export function paramsOf(profile) {
  const p = clampProfile(profile);
  const skill = 1 - (p.reaction - RANGES.reaction[0]) / (RANGES.reaction[1] - RANGES.reaction[0]);
  return {
    skill,
    reaction: p.reaction,
    fireInterval: p.fireInterval,
    aimError: p.aimError,
    headshotChance: p.headshotChance,
    abilityChance: p.abilityChance,
    smartBuy: p.aimError < 3,       // un bon tireur achète mieux
    holdsHigh: p.aggression < 0.45, // les passifs prennent le high ground
  };
}

// Constantes de MOUVEMENT propres au bot, dérivées du style (aggression/roam).
export function behavior(profile) {
  const p = clampProfile(profile);
  return {
    supportDelay: lerp(3.0, 0.3, p.aggression), // agressif = pousse tôt
    escortGap:    lerp(7.0, 3.0, p.aggression), // agressif = colle et avance
    patrolEvery:  lerp(14, 4, p.roam),          // roam élevé = change de site souvent
    rotateAfter:  lerp(22, 8, p.roam),
  };
}

// Case de la grille MAP-Elites (niche) à partir des deux axes de style.
export function niche(profile, bins = 8) {
  const b = (v) => Math.min(bins - 1, Math.max(0, Math.floor(v * bins)));
  return `${b(profile.aggression)},${b(profile.roam)}`;
}

// --- Utilisation en jeu --------------------------------------------------------
// Cale un profil entraîné sur un niveau (skill 0..1) : le STYLE (aggression/roam)
// est conservé, seule la COMPÉTENCE est dégradée vers un bot faible quand skill<1.
// skill=1 → profil tel quel ; skill=0 → réaction lente, visée médiocre.
const WEAK = { reaction: 0.55, fireInterval: 1.2, aimError: 6, headshotChance: 0.05, abilityChance: 0.15 };
export function scaleProfile(profile, skill = 1) {
  const s = Math.min(1, Math.max(0, skill));
  const p = clampProfile(profile);
  const mix = (g) => lerp(WEAK[g], p[g], s);
  return clampProfile({
    ...p,
    reaction: mix('reaction'), fireInterval: mix('fireInterval'), aimError: mix('aimError'),
    headshotChance: mix('headshotChance'), abilityChance: mix('abilityChance'),
  });
}

// Choisit `count` profils VARIÉS depuis une liste entraînée (déjà diversifiée par
// niche), calés au niveau demandé. Renvoie des null si la liste est vide → le
// jeu retombe alors sur le comportement ELO par défaut. `list` accepte des profils
// bruts ou des entrées { profile, ... } (format profiles.json).
export function selectProfiles(list, count, { skill = 1, rand = Math.random } = {}) {
  if (!list || !list.length) return Array.from({ length: count }, () => null);
  const pool = [...list];
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return Array.from({ length: count }, (_, i) => scaleProfile(pool[i % pool.length].profile ?? pool[i % pool.length], skill));
}
