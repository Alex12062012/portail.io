// Traduction ELO -> paramètres concrets de comportement d'un bot.
// 800 = manche à balai, 1600 = tueur. Aucun import : tourne sous node (selftest).

// Montée de niveau par round perdu (spec : +2 à +5 % par round).
export const LOSS_BOOST = 1.035;

export const skillOf = (elo) => Math.min(1, Math.max(0, (elo - 800) / 800));
const lerp = (a, b, t) => a + (b - a) * t;

export function botParams(elo) {
  const s = skillOf(elo);
  return {
    skill: s,
    reaction: lerp(0.9, 0.22, s),      // secondes avant de riposter à un ennemi vu
    fireInterval: lerp(1.4, 0.5, s),   // secondes entre deux tirs
    aimError: lerp(6, 0.6, s),         // dégrade la probabilité de toucher
    headshotChance: lerp(0.05, 0.45, s),
    abilityChance: lerp(0.15, 0.9, s), // proba d'utiliser fumée / soin à bon escient
    smartBuy: s >= 0.35,               // achat par palier vs achat désordonné
    holdsHigh: s >= 0.55,              // défend depuis le high ground (Ridge)
  };
}
