// Orchestrateur : lance UN worker par rôle (6 en parallèle) et les laisse monter
// les 4 tranches d'ELO. Tourne sans intervention, écrit ses modèles au fil de
// l'eau, et s'arrête quand tous les rôles ont convergé.
//
//   node public/games/valorant/tools/train/train.js
//   node public/games/valorant/tools/train/train.js --hours 10   # arrêt garanti
//   node public/games/valorant/tools/train/train.js --roles entry,lurker
//
// Sorties :
//   ../../models/best_{role}_{tranche}.json  — le livrable, chargé par le jeu
//   ../../models/checkpoint_*.json           — historique (reprise / comparaison)
//   ../../models/index.json                  — manifeste lu par le jeu et le navigateur
//   ../../logs/training_{role}_{ts}.jsonl    — une ligne par génération
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { ROLES } from './reward-shaping.js';
import { fmtProgress, fmtSummary, stamp } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.join(__dirname, '../../models');
const LOGS_DIR = path.join(__dirname, '../../logs');
const SUMMARY_EVERY = 30 * 60 * 1000; // résumé global toutes les 30 min

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const hours = Number(arg('hours', 0));
const deadline = hours > 0 ? Date.now() + hours * 3.6e6 : Number.MAX_SAFE_INTEGER;
const roles = String(arg('roles', ROLES.join(','))).split(',').map((r) => r.trim()).filter((r) => ROLES.includes(r));

fs.mkdirSync(MODELS_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });

const ts = stamp();
const started = Date.now();
const states = {};
const workers = [];
let alive = roles.length;
let closing = false;

// Manifeste : le jeu (serveur ET navigateur) ne lit qu'un fichier au lieu de
// deviner le contenu d'un dossier — un navigateur ne peut pas lister un dossier.
function writeIndex() {
  const models = fs.readdirSync(MODELS_DIR)
    .filter((f) => f.startsWith('best_') && f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(MODELS_DIR, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .map(({ role, eloRange, elo, fitness, winRate, params }) => ({ role, eloRange, elo, fitness, winRate, params }));
  fs.writeFileSync(path.join(MODELS_DIR, 'index.json'), JSON.stringify({ updated: Date.now(), models }, null, 0));
  return models.length;
}

function finish(reason) {
  if (closing) return;
  closing = true;
  const n = writeIndex();
  const elapsed = ((Date.now() - started) / 3.6e6).toFixed(2);
  console.log(fmtSummary(states, Date.now() - started));
  console.log(`✅ entraînement terminé (${reason}) après ${elapsed} h — ${n} modèles dans models/index.json`);
  Promise.all(workers.map((w) => w.terminate())).then(() => process.exit(0));
}

for (const role of roles) {
  const w = new Worker(path.join(__dirname, 'worker.js'), {
    workerData: { role, modelsDir: MODELS_DIR, logsDir: LOGS_DIR, ts, deadline },
  });
  w.on('message', (m) => {
    states[m.role] = m;
    // Le worker vient d'écrire son modèle : on republie le manifeste dans la
    // foulée. Sans ça, un Ctrl-C brutal laisse des best_*.json que le serveur
    // charge (fs) mais que le navigateur ne voit pas (fetch index.json).
    if (m.type === 'progress') { console.log(fmtProgress(m)); writeIndex(); }
    if (m.type === 'done') {
      console.log(`[${m.role}] arrêt : ${m.reason} — tranche ${m.tranche_actuelle}, ELO ~${Math.round(m.elo_estimated)}.`);
      if (--alive === 0) finish(Object.values(states).every((s) => s.reason === 'convergence')
        ? 'tous les rôles ont convergé' : 'tous les workers se sont arrêtés');
    }
  });
  w.on('error', (e) => { console.error(`[${role}] worker:`, e.message); if (--alive === 0) finish('workers en erreur'); });
  workers.push(w);
}

const timer = setInterval(() => { console.log(fmtSummary(states, Date.now() - started)); writeIndex(); }, SUMMARY_EVERY);
timer.unref();

process.on('SIGINT', () => {
  console.log('\n⏹  arrêt demandé — les workers finissent leur génération…');
  for (const w of workers) w.postMessage('stop');
  setTimeout(() => finish('Ctrl-C'), 8000).unref();
});

const cores = os.cpus().length;
console.log(`▶ entraînement : ${roles.length} rôles (${roles.join(', ')}) · ${cores} cœurs`
  + `${cores < roles.length + 1 ? ' ⚠ moins de cœurs que de rôles : ça tournera, en plus lent' : ''}`
  + ` · budget ${hours > 0 ? hours + ' h' : 'jusqu\'à convergence (Ctrl-C pour couper)'}`);
