// Worker d'évaluation : reçoit un profil, joue des matchs headless, renvoie sa
// fitness. Un par cœur (lancé par train.mjs). Isolé → aucun état partagé.
import { parentPort } from 'node:worker_threads';
import { evaluate } from './env.mjs';

parentPort.on('message', ({ id, profile, matches }) => {
  try {
    parentPort.postMessage({ id, res: evaluate(profile, { matches }) });
  } catch (e) {
    parentPort.postMessage({ id, error: String(e && e.message || e) });
  }
});
