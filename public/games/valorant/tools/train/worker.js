// Un worker = UN rôle, une instance CMA-ES, qui monte les 4 tranches d'ELO.
// Lancé par train.js (node:worker_threads) — isolé, aucun état partagé.
//
// Boucle : génération -> évaluation des 20 individus -> mise à jour CMA-ES.
// Tous les VALIDATE_EVERY gens : validation contre la référence -> ELO -> checkpoint.
// Patience épuisée : soit on monte de tranche (curriculum), soit on resserre sigma.
// Sigma refermé et jamais promu : on relance l'exploration (RESTART_AFTER).
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { CMAES } from './cmaes.js';
import { evaluate, toProfile, GENE_ORDER } from './reward-shaping.js';
import { TRANCHES, trancheLabel, trancheOf, REF_ELO, WEAKEST_REF, PROMOTE_WINRATE,
         VALIDATE_EVERY, validate } from './elo_estimator.js';
import { createLogger } from './logger.js';

// Constantes d'entraînement, exposées pour être réglées d'un seul endroit.
export const POPULATION = 20;             // individus par génération
export const MATCHES_PER_INDIVIDUAL = 10; // matchs joués par individu
export const PATIENCE = 20;               // générations sans amélioration avant réaction
export const SIGMA0 = 0.15;               // pas initial (espace normalisé [0,1])
export const SIGMA_SHRINK = 0.8;          // resserrement quand ça stagne dans la tranche
export const RESTART_AFTER = 200;         // gens sans nouveau best -> relance l'exploration
export const MAX_RESTARTS = 3;            // au-delà, le rôle a vraiment fait son temps

// SIGMA_SHRINK s'applique toutes les PATIENCE gens sans plancher : 0.8^25 = 0.004, le
// pas tombe à zéro et le rôle ne peut plus rien trouver. Sans relance, un rôle coincé
// SOUS la tranche haute ne converge jamais (`converged` n'est vrai qu'en haut) et
// tourne à vide jusqu'au budget. Pur, donc testable sans lancer d'entraînement.
export const shouldRestart = (sinceBest, restarts) =>
  sinceBest >= RESTART_AFTER && restarts < MAX_RESTARTS;

if (parentPort) run();

async function run() {
  const { role, modelsDir, logsDir, ts, deadline } = workerData;
  const log = createLogger(role, logsDir, ts);
  fs.mkdirSync(modelsDir, { recursive: true });

  let stopped = false;
  parentPort.on('message', (m) => { if (m === 'stop') stopped = true; });

  let ti = 0;                                            // plus haute tranche atteinte
  let reference = { elo: REF_ELO, profile: WEAKEST_REF }; // bootstrap : le bot le plus faible
  let es = new CMAES(new Array(GENE_ORDER.length).fill(0.5), SIGMA0, { lambda: POPULATION });
  let best = { fitness: -Infinity, x: es.xmean.slice() }; // meilleur FACE À LA RÉFÉRENCE COURANTE
  let bestSaved = {};                                     // label de tranche -> fitness déjà écrite
  let lastLabel = null;                                   // dernière tranche d'ELO estimée
  let promotions = 0, converged = false, restarts = 0;
  let sinceImprove = 0, gen = 0, elo = REF_ELO, winRate = 0, mean = 0;
  let sinceBest = 0; // ≠ sinceImprove, que le resserrement remet à 0 tous les 20 gens

  while (!converged && !stopped && Date.now() < deadline) {
    let promote = false;
    const xs = es.ask();
    const fits = xs.map((x) => evaluate(toProfile(x), {
      role, matches: MATCHES_PER_INDIVIDUAL, opponent: reference.profile,
    }).fitness);
    es.tell(xs, fits);
    gen++;

    mean = fits.reduce((a, b) => a + b, 0) / fits.length;
    const top = fits.indexOf(Math.max(...fits));
    if (fits[top] > best.fitness) { best = { fitness: fits[top], x: xs[top].slice() }; sinceImprove = 0; sinceBest = 0; }
    else { sinceImprove++; sinceBest++; }

    // --- Validation périodique : winrate -> ELO estimé -> checkpoint ------------
    if (gen % VALIDATE_EVERY === 0) {
      const v = validate(toProfile(best.x), { role, reference });
      elo = v.elo; winRate = v.winRate;
      ti = Math.max(ti, trancheOf(elo)); // la tranche RAPPORTÉE suit l'ELO mesuré,
                                         // comme le nom du fichier écrit juste après
      const label = trancheLabel(TRANCHES[trancheOf(elo)]);
      const model = {
        role, elo: Math.round(elo), eloRange: TRANCHES[trancheOf(elo)], gen,
        fitness: Math.round(best.fitness), winRate: Number(winRate.toFixed(3)),
        reference: { elo: Math.round(reference.elo), promotions },
        params: toProfile(best.x),
      };
      // Checkpoint quand l'ELO estimé bascule dans une NOUVELLE tranche (sinon on
      // écrirait un fichier toutes les 10 générations, soit ~900 sur une nuit).
      if (label !== lastLabel) {
        lastLabel = label;
        write(path.join(modelsDir, `checkpoint_${role}_${label}_gen${gen}.json`), model);
      }
      // best_ de la tranche : seulement si le score y est meilleur que le précédent.
      if (!(label in bestSaved) || best.fitness > bestSaved[label]) {
        bestSaved[label] = best.fitness;
        write(path.join(modelsDir, `best_${role}_${label}.json`), model);
      }
      parentPort.postMessage({ type: 'progress', ...record() });
      promote = winRate >= PROMOTE_WINRATE;
    }

    log.gen(record()); // AVANT la promotion : elle remet best.fitness à -Infinity,
                       // que JSON.stringify écrirait `null` dans le log.

    // --- Promotion de la référence -----------------------------------------------
    // La référence est nettement battue : elle ne mesure plus rien (le winrate colle
    // au clamp d'estimateElo). Le champion prend sa place et CMA-ES repart de LUI
    // (curriculum learning) avec un pas neuf.
    if (promote) {
      reference = { elo, profile: toProfile(best.x) };
      promotions++;
      // La référence change : les fitness d'avant ne sont plus comparables
      // (adversaire plus fort = score plus bas). Sans ce reset, un modèle
      // meilleur mais moins bien noté ne remplacerait jamais l'ancien.
      bestSaved = {};
      es = new CMAES(best.x.slice(), SIGMA0, { lambda: POPULATION });
      best = { fitness: -Infinity, x: best.x.slice() };
      sinceImprove = 0;
      sinceBest = 0;
      restarts = 0; // nouvelle référence = nouveau paysage, la patience repart entière
    }

    // --- Early stopping ---------------------------------------------------------
    // La montée de niveau passe désormais par la promotion de référence ci-dessus.
    // Ici il ne reste que la stagnation : on resserre, et on s'arrête si ça stagne
    // alors qu'on est déjà dans la tranche la plus haute.
    if (sinceImprove >= PATIENCE) {
      if (trancheOf(elo) === TRANCHES.length - 1) converged = true;
      else es.sigma *= SIGMA_SHRINK;
      sinceImprove = 0;
    }

    // --- Relance de l'exploration (sigma refermé, jamais promu) -------------------
    // Le pas est tombé à zéro et le rôle n'atteint pas le seuil de promotion : on
    // repart du meilleur checkpoint avec un pas neuf, MÊME référence. Les fitness
    // restent donc comparables et `best` est conservé (contrairement à la promotion).
    // Au bout de MAX_RESTARTS relances stériles, le rôle a fait son temps : sans ça
    // il tournerait à vide jusqu'au budget puisque `converged` n'est vrai qu'en
    // tranche haute.
    if (sinceBest >= RESTART_AFTER) {
      if (shouldRestart(sinceBest, restarts)) {
        es = new CMAES(best.x.slice(), SIGMA0, { lambda: POPULATION });
        restarts++;
        sinceImprove = 0;
      } else converged = true;
      sinceBest = 0;
    }

    await new Promise((r) => setImmediate(r)); // laisse passer un éventuel 'stop'
  }

  const reason = converged ? 'convergence' : stopped ? 'arrêt demandé' : 'budget écoulé';
  parentPort.postMessage({ type: 'done', role, reason, ...record(), done: true });

  function record() {
    return {
      gen, role,
      fitness_mean: Math.round(mean), fitness_best: Math.round(best.fitness),
      elo_estimated: Math.round(elo), tranche_actuelle: trancheLabel(TRANCHES[Math.min(ti, TRANCHES.length - 1)]),
      sigma: Number(es.sigma.toFixed(4)), winRate: Number(winRate.toFixed(3)),
      restarts,
    };
  }
}

function write(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
