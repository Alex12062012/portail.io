/**
 * smoke-valorant-online-browser.mjs — smoke navigateur du chemin 3v3 EN LIGNE.
 * Un seul vrai joueur (headless) : le serveur complète avec des bots. Vérifie que
 * main.js branché sur le réseau démarre sans erreur, reçoit game:start, construit
 * les 6 acteurs et applique les snapshots serveur (round, crédits, positions).
 * Complète le smoke socket pur (smoke-valorant-online.mjs) côté client Three.
 *
 *   node tests/smoke-valorant-online-browser.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3217;
const BASE = `http://localhost:${PORT}`;
const url = `${BASE}/games/valorant/?test&mode=3v3`; // mode=3v3 force l'en ligne ; test expose les globals
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// waitSeconds=0 : la partie démarre dès le 1er tick (joueur seul + bots).
const server = spawn(process.execPath, ['server/server.js', '--no-tunnel'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), VAL_WAIT_SECONDS: '0' }, stdio: 'ignore',
});
const cleanup = () => { try { server.kill(); } catch {} };
process.on('exit', cleanup);

for (let i = 0; ; i++) {
  try { if ((await fetch(BASE + '/')).ok) break; } catch {}
  if (i >= 50) { cleanup(); throw new Error('serveur injoignable'); }
  await sleep(200);
}

const browser = await chromium.launch();
const errors = [];
let n = 0;
const ok = (cond, msg) => { n++; if (!cond) errors.push('ÉCHEC — ' + msg); };

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push('pageerror : ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console : ' + m.text()); });

  await page.goto(url);
  await page.click('#pick button[data-key="jett"]'); // pas d'écran de map en ligne (serveur choisit)

  // game:start construit la scène : on attend le canvas puis les globals exposés.
  await page.waitForSelector('canvas', { timeout: 15000 });
  await page.evaluate(() => { window.input.locked = true; });
  await page.waitForFunction(() => window.actors && window.actors.length === 6, null, { timeout: 15000 });

  const state = await page.evaluate(() => ({
    online: window.online,
    actors: window.actors.length,
    roster: window.net?.roster.length,
    humans: window.actors.filter((a) => !a.model || a.player).length, // le joueur local n'a pas de model
    round: window.rm.round,
    phase: window.rm.phase,
    credits: window.playerActor.wallet.credits,
    selfTeam: window.playerActor.team,
  }));
  ok(state.online === true, 'main.js démarre en mode en ligne');
  ok(state.actors === 6, `3v3 : 6 acteurs construits (mesuré ${state.actors})`);
  ok(state.roster === 6, 'roster réseau de 6');
  ok(state.round === 1, `round 1 miroité depuis le serveur (mesuré ${state.round})`);
  ok(state.phase === 'buy', `phase d'achat miroitée (mesuré ${state.phase})`);
  ok(state.credits === 2400, `crédits de départ reçus du serveur (mesuré ${state.credits})`);

  // Un snapshot plus tard, les bots ont une position non nulle (spawns serveur appliqués).
  await sleep(500);
  const botPlaced = await page.evaluate(() => {
    const b = window.actors.find((a) => a.model && !a.player);
    return b ? (Math.abs(b.model.position.x) + Math.abs(b.model.position.z)) : 0;
  });
  ok(botPlaced > 0.01, 'les bots distants sont positionnés via les snapshots (interpolation)');

  // Aucune erreur console/page pendant tout le parcours en ligne.
  ok(errors.length === 0, 'aucune erreur console/page en mode en ligne');

  await browser.close();
  cleanup();
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log(`smoke-valorant-online-browser : ${n} vérifications OK`);
  process.exit(0);
} catch (e) {
  try { await browser.close(); } catch {}
  cleanup();
  console.error((e && e.message) || e);
  if (errors.length) console.error(errors.join('\n'));
  process.exit(1);
}
