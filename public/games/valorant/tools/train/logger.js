// Journalisation de l'entraînement : une ligne JSON par génération (fichier) +
// une ligne lisible en console. Rien de plus — pas de rotation, pas de niveaux.
import fs from 'node:fs';
import path from 'node:path';

// Horodatage compact et triable, sûr comme nom de fichier (pas de ':').
export const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-').slice(0, 19);

export function createLogger(role, dir, ts = stamp()) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `training_${role}_${ts}.jsonl`);
  return {
    file,
    // rec : { gen, role, fitness_mean, fitness_best, elo_estimated, tranche_actuelle, sigma }
    gen(rec) { fs.appendFileSync(file, JSON.stringify(rec) + '\n'); },
  };
}

// `[entry] gen 120 | ELO ~1680 | best fitness 847 | tranche 1500-2000`
export const fmtProgress = (r) =>
  `[${r.role}] gen ${r.gen} | ELO ~${Math.round(r.elo_estimated)} | best fitness ${Math.round(r.fitness_best)} | tranche ${r.tranche_actuelle}`;

// Résumé global (toutes les 30 min) : une ligne par rôle, la plus récente connue.
export function fmtSummary(states, elapsedMs) {
  const h = Math.floor(elapsedMs / 3.6e6), m = Math.floor((elapsedMs % 3.6e6) / 6e4);
  const lines = Object.values(states)
    .sort((a, b) => a.role.localeCompare(b.role))
    .map((s) => `  ${s.role.padEnd(8)} gen ${String(s.gen).padStart(5)} · ELO ~${String(Math.round(s.elo_estimated)).padStart(4)}`
      + ` · best ${String(Math.round(s.fitness_best)).padStart(5)} · tranche ${s.tranche_actuelle}${s.done ? ' · TERMINÉ' : ''}`);
  return `\n── résumé à ${h} h ${String(m).padStart(2, '0')} ──\n${lines.join('\n')}\n`;
}
