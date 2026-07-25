// Export de l'archive MAP-Elites → profils chargés par le jeu.
// Chaque case de l'archive est déjà le meilleur bot de son style : l'ensemble
// forme donc naturellement une palette variée et compétente. On écarte juste les
// styles les plus faibles (dégénérés) et on trie par fitness.
//
//   node training/export.mjs        # relit training/archive.json → profiles.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '../public/games/valorant/js/bots/profiles.json');
const MAX = 48; // plafond du nombre de styles embarqués

// archive : Map<niche, { profile, fitness, stats }>. bins : taille de grille.
export function exportProfiles(archive, bins = 8) {
  const cells = [...archive.entries()].map(([nk, v]) => ({
    niche: nk,
    profile: v.profile,
    fitness: Math.round(v.fitness),
    winRate: Number((v.stats?.winRate ?? 0).toFixed(3)),
    pointsPerRound: Math.round(v.stats?.pointsPerRound ?? 0),
    aggression: Number(v.profile.aggression.toFixed(3)),
    roam: Number(v.profile.roam.toFixed(3)),
  }));
  if (!cells.length) return 0;

  // Écarte le quart le plus faible (styles peu jouables) puis trie par fitness.
  const fits = cells.map((c) => c.fitness).sort((a, b) => a - b);
  const cutoff = fits[Math.floor(fits.length * 0.25)];
  const kept = cells.filter((c) => c.fitness >= cutoff).sort((a, b) => b.fitness - a.fitness).slice(0, MAX);

  fs.writeFileSync(OUT, JSON.stringify({ generated: cells.length, bins, profiles: kept }, null, 0));
  return kept.length;
}

// Exécution directe : relit l'archive et régénère profiles.json.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('export.mjs')) {
  const ARCHIVE = path.join(__dirname, 'archive.json');
  if (!fs.existsSync(ARCHIVE)) { console.error('training/archive.json introuvable — lance d’abord train.mjs'); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(ARCHIVE, 'utf8'));
  const archive = new Map((data.cells ?? []).map((e) => [e.niche, { profile: e.profile, fitness: e.fitness, stats: e.stats }]));
  const n = exportProfiles(archive, data.bins ?? 8);
  console.log(`✅ ${n} profils exportés → public/games/valorant/js/bots/profiles.json`);
}
