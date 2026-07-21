/**
 * mine-save.js — persistance disque des mondes Mine Coop (server-only, node:fs).
 * Un monde par code de salon : saves/<CODE>.json (schéma SAVE_VERSION). Écriture
 * atomique (temp + rename) et plafond LRU de MAX_SAVES mondes (le 6e supprime le
 * moins récemment sauvegardé). Séparé du module partagé pour garder
 * shared/mine-world.js importable par le navigateur.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MAX_SAVES = 5;

// Dossier de sauvegardes (surclassable par MINE_SAVES_DIR pour les tests, lu à
// chaque appel pour rester isolable).
const savesDir = () => process.env.MINE_SAVES_DIR
  ? path.resolve(process.env.MINE_SAVES_DIR)
  : path.join(__dirname, '..', 'saves');

function ensureDir() { fs.mkdirSync(savesDir(), { recursive: true }); }
const fileFor = code => path.join(savesDir(), `${code}.json`);

/** Graine aléatoire 32 bits (uniquement pour un NOUVEAU monde — pas en génération). */
export const randomSeed = () => (Math.random() * 0xffffffff) >>> 0;

/** Charge la sauvegarde d'un code si elle existe, sinon null. */
export function loadSaveIfExists(code) {
  try { return JSON.parse(fs.readFileSync(fileFor(code), 'utf8')); }
  catch { return null; }
}

/** Supprime le fichier de sauvegarde d'un code (no-op s'il n'existe pas). */
export function deleteSave(code) {
  try { fs.unlinkSync(fileFor(code)); } catch {}
}

/** Liste des mondes sauvegardés : [{ code, lastSaved }] (pour l'avertissement LRU). */
export function listSaves() {
  ensureDir();
  const dir = savesDir();
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const code = f.slice(0, -5);
      let lastSaved = 0;
      try {
        const full = path.join(dir, f);
        lastSaved = JSON.parse(fs.readFileSync(full, 'utf8')).lastSaved
          ?? fs.statSync(full).mtimeMs;
      } catch { lastSaved = 0; }
      return { code, lastSaved };
    })
    .sort((a, b) => b.lastSaved - a.lastSaved);
}

/** Écrit une sauvegarde (atomique). Applique le LRU si c'est un NOUVEAU monde. */
export function writeSave(code, obj) {
  ensureDir();
  obj.lastSaved = Date.now();
  const target = fileFor(code);
  if (!fs.existsSync(target)) evictIfNeeded(code);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, target); // atomique sur le même système de fichiers
}

/** Supprime les mondes les plus anciens jusqu'à laisser la place pour un nouveau. */
function evictIfNeeded(incomingCode) {
  const saves = listSaves().filter(s => s.code !== incomingCode);
  if (saves.length < MAX_SAVES) return;
  // listSaves trie du plus récent au plus ancien : on évince par la fin
  saves.sort((a, b) => a.lastSaved - b.lastSaved); // plus ancien d'abord
  while (saves.length >= MAX_SAVES) {
    const victim = saves.shift();
    try { fs.unlinkSync(fileFor(victim.code)); } catch {}
  }
}
