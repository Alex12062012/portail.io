// Estimation de l'ELO d'un modèle en cours d'entraînement.
//
// Principe : une série de validation contre un adversaire de RÉFÉRENCE dont on
// connaît l'ELO, puis conversion du winrate en écart d'ELO (formule Elo inverse).
//
// La référence démarre au bot scripté LE PLUS FAIBLE et monte par paliers : dès
// qu'un candidat la bat au-delà de PROMOTE_WINRATE, le champion devient le nouvel
// adversaire, avec l'ELO qu'on vient de lui estimer.
//
// ponytail: pourquoi pas une référence fixe. botParams SATURE à 1600 (skillOf
// plafonne) : au-delà, un bot scripté n'est pas plus fort. Contre une référence
// figée, le winrate colle à 100 % dès les premières générations et estimateElo
// rend toujours la même valeur — le clamp, pas une mesure. Le curriculum ne monte
// alors jamais. L'échelle reste relative, comme tout classement Elo : c'est un
// ancrage, pas une mesure absolue.
import { RANGES, scaleProfile } from '../../js/bots/bot_profile.js';
import { evaluate } from './reward-shaping.js';

export const TRANCHES = [[1000, 1500], [1500, 2000], [2000, 2500], [2500, 3000]];
export const REF_ELO = 800;           // plancher de botParams : skillOf(<=800) = 0
export const PROMOTE_WINRATE = 0.65;  // au-delà, la référence a fait son temps
export const VALIDATION_MATCHES = 20; // série de validation
export const VALIDATE_EVERY = 5;      // toutes les N générations

// Le bot scripté le plus faible, exprimé en profil : scaleProfile(_, 0) rend les
// paramètres WEAK de bot_profile.js, soit exactement botParams(800). Un profil
// explicite plutôt que `null`, car `null` = bot scripté à l'ELO du SERVEUR (1150),
// ce qui n'est pas le plus faible.
export const WEAKEST_REF = scaleProfile({ aggression: 0.5, roam: 0.5 }, 0);

export const trancheLabel = ([lo, hi]) => `${lo}-${hi}`;

export function trancheOf(elo) {
  const i = TRANCHES.findIndex(([lo, hi]) => elo >= lo && elo < hi);
  if (i >= 0) return i;
  return elo < TRANCHES[0][0] ? 0 : TRANCHES.length - 1;
}

// ELO_estimé = ELO_référence + 400 * log10(wr / (1 - wr)).
// Le winrate est borné à ±une demi-partie : sans ça, 20/20 donne l'infini.
export function estimateElo(winRate, refElo = REF_ELO, matches = VALIDATION_MATCHES) {
  const eps = 0.5 / Math.max(1, matches);
  const wr = Math.min(1 - eps, Math.max(eps, winRate));
  return refElo + 400 * Math.log10(wr / (1 - wr));
}

// Série de validation : winrate du candidat contre la référence, et ELO estimé.
// `reference` : { elo, profile } — profile null = bot scripté du jeu.
export function validate(profile, { role, reference, matches = VALIDATION_MATCHES }) {
  const { winRate } = evaluate(profile, { role, matches, opponent: reference.profile ?? null });
  return { winRate, elo: estimateElo(winRate, reference.elo, matches) };
}

// Garde-fou : un profil doit rester dans les bornes du jeu (pas d'aimbot).
export const withinRanges = (p) => Object.keys(RANGES).every((g) =>
  p[g] >= RANGES[g][0] - 1e-9 && p[g] <= RANGES[g][1] + 1e-9);
