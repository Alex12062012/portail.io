/**
 * map-compare.mjs — capture une vue d'ensemble (dézoomée, sans joueurs) de
 * chaque carte de Tag Arena, pour la comparer aux captures de référence Tag 2.
 *
 *   node scripts/map-compare.mjs            (les 5 cartes copiées de Tag 2)
 *   node scripts/map-compare.mjs ice forest (cartes précises)
 *
 * Mécanisme : lance un serveur local jetable (--no-tunnel), ouvre chaque carte
 * via le hook DEV ?debugMap=<id> (actif uniquement en localhost, cf. main.js),
 * qui rend la carte en vue d'ensemble sans réseau ni joueurs, puis capture le
 * canvas dans docs/map-compare/<id>-game.png.
 *
 * Déposez la capture de référence correspondante dans
 * docs/map-compare/<id>-reference.png pour la comparaison côte à côte.
 *
 * Prérequis : npm install -D playwright && npx playwright install chromium
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'map-compare');
const PORT = 3212;
const BASE = `http://localhost:${PORT}`;

// cartes copiées de Tag 2 (par défaut) ; surchargées par les arguments CLI
const DEFAULT_MAPS = ['forest', 'ice', 'volcano', 'desert', 'space'];
const maps = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_MAPS;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = spawn(process.execPath, ['server/server.js', '--no-tunnel'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stderr.on('data', d => process.stderr.write('[server] ' + d));
const cleanup = () => { try { server.kill(); } catch {} };
process.on('exit', cleanup);

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/')).ok) return; } catch {}
    await sleep(200);
  }
  throw new Error('serveur injoignable');
}

try {
  fs.mkdirSync(OUT, { recursive: true });
  await waitForServer();

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  // satisfait le garde-fou de pseudo de main.js et active le hook debug
  await ctx.addInitScript(() => localStorage.setItem('portail.name', 'DebugView'));

  for (const id of maps) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/games/tag-arena/?debugMap=${id}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__debugMapReady === true, { timeout: 5000 });
    await sleep(300); // laisse une frame stable se dessiner
    const canvas = page.locator('#game');
    const file = path.join(OUT, `${id}-game.png`);
    await canvas.screenshot({ path: file });
    console.log(`  ✔ ${id.padEnd(8)} → ${path.relative(ROOT, file)}`);
    await page.close();
  }

  await browser.close();
  console.log(`\n✅ map-compare : ${maps.length} carte(s) capturée(s) dans docs/map-compare/`);
  cleanup();
  process.exit(0);
} catch (err) {
  console.error('\n❌ échec :', err.message);
  cleanup();
  process.exit(1);
}
