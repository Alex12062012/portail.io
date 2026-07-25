// Entraînement des bots par self-play — MAP-Elites (Quality-Diversity).
//
// But : NON pas trouver un seul bot optimal, mais remplir une grille de STYLES
// (agressivité × mobilité) avec, dans chaque case, la meilleure version de ce
// style. Résultat = une palette de bots distincts et compétents → gameplay varié
// et plus humain. 100 % CPU (tes cœurs), aucune dépendance, aucun GPU requis.
//
//   node training/train.mjs                 # tourne jusqu'à Ctrl-C (checkpoints réguliers)
//   node training/train.mjs --hours 8       # arrêt auto après 8 h
//   node training/train.mjs --seconds 20    # run court (validation)
//   node training/train.mjs --bins 8 --matches 3 --workers 7
//
// Sorties (écrites régulièrement, sûres si on coupe au Ctrl-C) :
//   training/archive.json                          — archive complète (reprise possible)
//   public/games/valorant/js/bots/profiles.json    — profils chargés par le jeu
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { randomProfile, mutate, niche } from '../public/games/valorant/js/bots/bot_profile.js';
import { exportProfiles } from './export.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// --- arguments ------------------------------------------------------------------
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const BINS = Number(arg('bins', 8));
const MATCHES = Number(arg('matches', 3));
const WORKERS = Math.max(1, Number(arg('workers', Math.max(1, os.cpus().length - 1))));
const ARCHIVE_PATH = path.join(__dirname, arg('out', 'archive.json'));
const secs = arg('seconds', null), mins = arg('minutes', null), hrs = arg('hours', null);
const BUDGET_MS = secs ? +secs * 1e3 : mins ? +mins * 6e4 : hrs ? +hrs * 36e5 : Infinity;
const INIT_RANDOM = BINS * BINS; // phase d'amorçage : profils aléatoires avant mutation

// --- archive MAP-Elites : niche -> { profile, fitness, stats } -------------------
const archive = new Map();
function insert(profile, res) {
  const key = niche(profile, BINS);
  const cur = archive.get(key);
  if (!cur || res.fitness > cur.fitness) archive.set(key, { profile, fitness: res.fitness, stats: res });
}
function loadCheckpoint() {
  if (!fs.existsSync(ARCHIVE_PATH)) return;
  try {
    const data = JSON.parse(fs.readFileSync(ARCHIVE_PATH, 'utf8'));
    if (data.bins && data.bins !== BINS) {
      console.warn(`checkpoint en grille ${data.bins}×${data.bins} ≠ ${BINS}×${BINS} demandée : on repart de zéro.`);
      return;
    }
    for (const e of data.cells ?? []) archive.set(e.niche, { profile: e.profile, fitness: e.fitness, stats: e.stats });
    console.log(`↻ reprise : ${archive.size} cases chargées depuis ${path.relative(ROOT, ARCHIVE_PATH)}`);
  } catch (e) { console.warn('checkpoint illisible, on repart de zéro :', e.message); }
}
function saveCheckpoint() {
  const cells = [...archive.entries()].map(([nk, v]) => ({ niche: nk, ...v }));
  fs.writeFileSync(ARCHIVE_PATH, JSON.stringify({ bins: BINS, updated: Date.now(), cells }, null, 0));
  exportProfiles(archive, BINS); // rafraîchit profiles.json pour le jeu, même en cours de route
}

// --- prochain candidat : aléatoire tant qu'on amorce, sinon mutation d'un élite --
let evalsDone = 0;
function nextProfile() {
  if (archive.size < INIT_RANDOM || Math.random() < 0.15) return randomProfile();
  const elites = [...archive.values()];
  const parent = elites[Math.floor(Math.random() * elites.length)].profile;
  return mutate(parent, 0.15);
}

// --- pool de workers ------------------------------------------------------------
const started = Date.now();
let running = true, nextId = 1;
const inflight = new Map(); // id -> profile
const workers = [];
const idle = [];

function dispatch(w) {
  if (!running || Date.now() - started >= BUDGET_MS) { idle.push(w); return; }
  const profile = nextProfile();
  const id = nextId++;
  inflight.set(id, profile);
  w.postMessage({ id, profile, matches: MATCHES });
}

for (let i = 0; i < WORKERS; i++) {
  const w = new Worker(path.join(__dirname, 'eval-worker.mjs'));
  w.on('message', ({ id, res, error }) => {
    const profile = inflight.get(id); inflight.delete(id);
    if (profile && res && !error) { insert(profile, res); evalsDone++; }
    dispatch(w); // enchaîne
  });
  w.on('error', (e) => console.error('worker:', e.message));
  workers.push(w);
}

// --- boucle de progression + checkpoints ----------------------------------------
const total = BINS * BINS;
let lastSave = 0;
const timer = setInterval(() => {
  const elapsed = (Date.now() - started) / 1000;
  const fits = [...archive.values()].map((v) => v.fitness).sort((a, b) => b - a);
  const best = fits[0] ?? 0, med = fits.length ? fits[Math.floor(fits.length / 2)] : 0;
  const rate = Math.round(evalsDone / Math.max(1, elapsed));
  console.log(`t=${elapsed.toFixed(0)}s · évals=${evalsDone} (${rate}/s) · styles=${archive.size}/${total} · fitness best=${best.toFixed(0)} méd=${med.toFixed(0)}`);
  if (Date.now() - lastSave > 15000) { saveCheckpoint(); lastSave = Date.now(); }
  if (Date.now() - started >= BUDGET_MS && inflight.size === 0) finish('budget écoulé');
}, 3000);

function finish(reason) {
  if (!running) return;
  running = false;
  clearInterval(timer);
  saveCheckpoint();
  console.log(`\n✅ terminé (${reason}) : ${archive.size}/${total} styles, ${evalsDone} évaluations.`);
  console.log(`   → ${path.relative(ROOT, ARCHIVE_PATH)} + public/games/valorant/js/bots/profiles.json`);
  Promise.all(workers.map((w) => w.terminate())).then(() => process.exit(0));
}

process.on('SIGINT', () => { console.log('\n⏹  arrêt demandé…'); running = false; setTimeout(() => finish('Ctrl-C'), 200); });

loadCheckpoint();
console.log(`▶ entraînement : ${WORKERS} workers · grille ${BINS}×${BINS} · ${MATCHES} matchs/éval · budget ${BUDGET_MS === Infinity ? '∞ (Ctrl-C)' : (BUDGET_MS / 1000) + 's'}`);
for (const w of workers) dispatch(w);
