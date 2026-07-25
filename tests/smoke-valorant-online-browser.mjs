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

  // Le snapshot porte bien le vainqueur du round et les compteurs de match : sans
  // eux le client, qui ne calcule rien en ligne, affichait « ROUND PERDU » en boucle
  // et un scoreboard à 0 kill (le killfeed, lui, vient d'un event séparé).
  const mirrored = await page.evaluate(() => ({
    hasWinner: 'roundWinner' in window.net.snap,
    hasKills: window.net.snap.actors.every((a) => typeof a.kills === 'number'),
    applied: window.actors.every((a) => typeof a.matchKills === 'number'),
  }));
  ok(mirrored.hasWinner, 'snapshot : champ roundWinner transmis au client');
  ok(mirrored.hasKills, 'snapshot : kills du match transmis pour chaque acteur');
  ok(mirrored.applied, 'applyNet recopie les kills sur les acteurs locaux');

  // Fin de round gagnée : on fige un snapshot fabriqué (la propriété d'instance
  // masque le getter de NetClient) pour que applyNet le relise à chaque frame.
  const won = await page.evaluate(async () => {
    const s = JSON.parse(JSON.stringify(window.net.snap));
    s.phase = 'end'; s.roundWinner = window.playerActor.team; s.reason = 'défenseurs éliminés';
    s.actors.find((a) => a.id === window.playerActor.id).kills = 4;
    Object.defineProperty(window.net, 'snap', { get: () => s, configurable: true });
    await new Promise((r) => setTimeout(r, 150));
    dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab' })); // le scoreboard se reconstruit 4x/s
    await new Promise((r) => setTimeout(r, 400));
    const out = {
      banner: document.getElementById('banner').textContent,
      kills: window.playerActor.matchKills,
      cell: document.querySelectorAll('#board tr.me td')[2]?.textContent,
    };
    dispatchEvent(new KeyboardEvent('keyup', { code: 'Tab' }));
    delete window.net.snap; // rend la main au getter réel : les snapshots reprennent
    return out;
  });
  ok(won.banner.includes('ROUND GAGNÉ'), `bannière de round gagné en ligne : « ${won.banner} »`);
  ok(won.banner.includes('défenseurs éliminés'), 'le motif de fin de round vient du serveur');
  ok(won.kills === 4, `kills du joueur miroités depuis le serveur (${won.kills})`);
  ok(won.cell === '4', `scoreboard : la colonne K affiche les kills (« ${won.cell} »)`);

  // Écran de fin : le classement de points se rend correctement (6 lignes, colonne POINTS).
  const endInfo = await page.evaluate(() => {
    window.actors.forEach((a, i) => { a.points = (i + 1) * 10; a.pts = { kill: 0, plant: 0, roundWin: 0, move: (i + 1) * 10 }; });
    window.rm.winner = window.playerActor.team;
    window.hud.showEnd();
    const rows = document.querySelectorAll('#endscreen table.rank tbody tr');
    return { rows: rows.length, hasPoints: /POINTS/.test(document.querySelector('#endscreen').textContent) };
  });
  ok(endInfo.rows === 6, `écran de fin : classement de 6 lignes (${endInfo.rows})`);
  ok(endInfo.hasPoints, 'écran de fin : colonne POINTS présente');

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
