/**
 * browser-mine.mjs — boot navigateur réel du client Mine Coop (Playwright/Chromium).
 * Vérifie que le client se charge sans erreur, que le flux menu → créer → lobby →
 * jeu fonctionne, que le monde se dessine vraiment sur le canvas (chunks reçus +
 * tuiles peintes), que le HUD de coordonnées lit X 0 au spawn, que la hotbar et
 * l'inventaire/craft s'affichent. Complète smoke-mine.mjs (qui ne teste que le
 * protocole, sans charger le client dans un navigateur).
 *
 *   node tests/browser-mine.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3231;
const BASE = `http://localhost:${PORT}`;
const SAVES = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-browser-'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
const ok = (cond, label) => { assert.ok(cond, label); passed++; console.log(`  ✔ ${label}`); };

const server = spawn(process.execPath, ['server/server.js', '--no-tunnel'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), MINE_SAVES_DIR: SAVES }, stdio: ['ignore', 'pipe', 'pipe']
});
server.stderr.on('data', d => process.stderr.write('[server] ' + d));
let browser;
const cleanup = () => {
  try { browser?.close(); } catch {}
  try { server.kill(); } catch {}
  try { fs.rmSync(SAVES, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/')).ok) return; } catch {}
    await sleep(200);
  }
  throw new Error('serveur injoignable');
}

try {
  await waitForServer();
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  console.log('— chargement du client + pseudo');
  await page.goto(BASE + '/games/mine-coop/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('portail.name', 'Mineur'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  ok(await page.$eval('#screenMenu', el => !el.hidden), 'écran menu affiché');
  ok(await page.$eval('#nameInput', el => el.value) === 'Mineur', 'pseudo pré-rempli depuis localStorage');

  console.log('— créer un monde → lobby');
  await page.click('#btnShowCreate');
  ok(await page.$eval('#createPanel', el => !el.hidden), 'sous-panneau de création ouvert');
  await page.fill('#worldCodeInput', 'BROWS1');
  await page.click('#btnCreate');
  await page.waitForSelector('#screenLobby:not([hidden])', { timeout: 5000 });
  const code = await page.$eval('#lobbyCode', el => el.textContent.trim());
  ok(code === 'BROWS1', `lobby affiché avec le code du monde (${code})`);
  ok(await page.$eval('#btnStart', el => !el.hidden), 'bouton Entrer visible pour l\'hôte');

  console.log('— entrer dans le monde → rendu réel');
  await page.click('#btnStart');
  await page.waitForSelector('#screenGame:not([hidden])', { timeout: 5000 });
  await page.waitForFunction(() => window.__mineDebug?.ready && window.__mineDebug.loaded > 0, { timeout: 8000 });
  const dbg = await page.evaluate(() => window.__mineDebug);
  ok(dbg.loaded > 0, `chunks chargés (${dbg.loaded})`);
  ok(dbg.ready, 'physique locale active (voisinage chargé)');
  ok(dbg.x === 0, `coordonnée X affichée = 0 au spawn (X=${dbg.x}, Y=${dbg.y})`);

  // le monde est réellement peint : variété de couleurs + présence de tuiles
  // « sol » (vert herbe / brun terre) dans la moitié basse du canvas
  await sleep(600);
  const paint = await page.evaluate(() => {
    const c = document.getElementById('game');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const colors = new Set();
    let ground = 0;
    for (let y = c.height / 2; y < c.height; y += 6)
      for (let x = 0; x < c.width; x += 6) {
        const i = (y * c.width + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        colors.add((r >> 4 << 8) | (g >> 4 << 4) | (b >> 4));
        if ((g > 90 && g > b && r < g + 40) || (r > 90 && r > b && g < r)) ground++; // herbe ou terre
      }
    return { distinct: colors.size, ground };
  });
  ok(paint.distinct > 6, `canvas peint avec de la variété (${paint.distinct} teintes)`);
  ok(paint.ground > 20, `tuiles de sol (herbe/terre) dessinées (${paint.ground} échantillons)`);

  console.log('— hotbar + inventaire (Tab) + grille de craft');
  ok(await page.$$eval('#hotbar .slot', els => els.length) === 9, 'hotbar (bas) : 9 cases');
  await page.keyboard.press('Tab');
  await page.waitForSelector('#invOverlay:not([hidden])', { timeout: 3000 });
  ok(await page.$$eval('#bagGrid .slot', els => els.length) === 27, 'sac : 27 cases');
  ok(await page.$$eval('#hotbarGrid .slot', els => els.length) === 9, 'hotbar dans l\'inventaire : 9 cases');
  ok(await page.$$eval('#craftGrid .slot', els => els.length) === 4, 'grille de craft 2×2 (hors établi)');
  await page.keyboard.press('Tab');
  ok(await page.$eval('#invOverlay', el => el.hidden), 'inventaire refermé avec Tab');

  console.log('— menu pause (Échap) : stats + touches + réassignation');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#escOverlay:not([hidden])', { timeout: 3000 });
  ok(await page.$$eval('#escMain button', els => els.length) === 6, 'menu pause : 6 boutons');
  await page.click('#escStats');
  await page.waitForFunction(() => document.querySelectorAll('#statsContent .stat-row').length >= 10, { timeout: 4000 });
  ok(await page.$$eval('#statsContent .stat-row', els => els.length) === 10, 'panneau stats : 10 lignes');
  await page.click('#statsBack');
  await page.click('#escKeybinds');
  await page.waitForSelector('#keybindPanel:not([hidden])', { timeout: 3000 });
  ok(await page.$$eval('#keybindList .keybind-row', els => els.length) === 15, 'panneau touches : 15 actions');
  // réassigne « Attaquer » (5e ligne) sur F → persisté en localStorage
  await page.click('#keybindList .keybind-row:nth-child(5) .key-btn');
  await page.keyboard.press('KeyF');
  const kb = await page.evaluate(() => JSON.parse(localStorage.getItem('portail.mine.keybinds') || '{}'));
  ok(kb.attack === 'KeyF', 'réassignation Attaquer → F persistée (portail.mine.keybinds)');
  await page.click('#keybindBack');
  await page.click('#escResume');
  ok(await page.$eval('#escOverlay', el => el.hidden), 'menu pause refermé');

  ok(errors.length === 0, `aucune erreur page/console (${errors.length})`);
  if (errors.length) errors.forEach(e => console.error('   ⚠', e));

  await browser.close();
  console.log(`\n✅ browser-mine.mjs : ${passed} vérifications passées`);
  cleanup();
  process.exit(0);
} catch (err) {
  console.error('\n❌ échec :', err.message);
  cleanup();
  process.exit(1);
}
