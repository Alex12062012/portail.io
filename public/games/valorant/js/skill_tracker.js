// Historique de parties en localStorage + niveau moyen global / récent.
// Le stockage est injectable : sous node (selftest), on passe un faux localStorage.
const KEY = 'valorant-like.history';
const noStore = { getItem: () => null, setItem: () => {} };
const store = () => (typeof localStorage === 'undefined' ? noStore : localStorage);

export const BASE_ELO = 1000;

// Performance d'une partie isolée, sur une échelle type ELO.
export function matchElo({ won, kills = 0, deaths = 0 }) {
  return Math.min(2000, Math.max(400, BASE_ELO + (won ? 150 : -150) + 30 * (kills - deaths)));
}

export function history(s = store()) {
  try { return JSON.parse(s.getItem(KEY)) ?? []; } catch { return []; }
}

// À appeler en fin de partie : date, résultat, kills/morts, rounds gagnés/perdus.
export function record(match, s = store()) {
  const h = history(s);
  h.push({ date: new Date().toISOString(), ...match });
  s.setItem(KEY, JSON.stringify(h));
  return h;
}

// Niveau moyen global : moyenne de toutes les parties. BASE_ELO sans historique.
// Recalculé à la demande — pas de valeur stockée qui pourrait diverger.
export function globalElo(h = history()) {
  return h.length ? h.reduce((sum, m) => sum + matchElo(m), 0) / h.length : BASE_ELO;
}

// Forme du moment : même moyenne, sur les n dernières parties.
export function recentElo(h = history(), n = 8) {
  return globalElo(h.slice(-n));
}

// --- Défi solo 1v3 (prompt 14) -----------------------------------------------------
// Historique SÉPARÉ : la difficulté y est choisie à la main, ces résultats ne
// doivent donc jamais peser sur globalElo()/recentElo() du 3v3.
const SOLO_KEY = 'valorant-like.solo-history';

export function soloHistory(s = store()) {
  try { return JSON.parse(s.getItem(SOLO_KEY)) ?? []; } catch { return []; }
}

// match : { difficulty, won, kills, deaths }
export function recordSolo(match, s = store()) {
  const h = soloHistory(s);
  h.push({ date: new Date().toISOString(), ...match });
  s.setItem(SOLO_KEY, JSON.stringify(h));
  return h;
}

// Victoires obtenues à un niveau donné — affiché sur l'écran de difficulté.
export function soloWins(difficulty, h = soloHistory()) {
  return h.filter((m) => m.difficulty === difficulty && m.won).length;
}
