/**
 * browser.mjs — test navigateur réel (puppeteer-core + Chrome/Edge installé).
 * Couvre : portail + pseudo, variété des 5 cartes/thèmes sur plusieurs
 * manches, HUD (FPS écran + FPS moteur + ping, dont ping accru via un proxy
 * TCP à latence), mode élimination (écran "VOUS AVEZ EXPLOSÉ" + EXIT +
 * classement, vues d'ensemble dézoomées), salon 1v1 (mode classique).
 *
 *   node tests/browser.mjs   (npm i --no-save puppeteer-core au préalable)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import assert from 'node:assert';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3212;
const PROXY_PORT = 3213;
const BASE = `http://localhost:${PORT}`;
const ART = path.join(__dirname, 'artifacts');
fs.mkdirSync(ART, { recursive: true });

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find(p => fs.existsSync(p));
if (!CHROME) { console.error('Pas de Chrome/Edge trouvé'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
const ok = (cond, label) => { assert.ok(cond, label); passed++; console.log(`  ✔ ${label}`); };

// ---- serveur jetable + proxy TCP à latence (~150 ms par sens) -----------------
const server = spawn(process.execPath, ['server/server.js', '--no-tunnel'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore'
});
const proxy = net.createServer(cli => {
  const up = net.connect(PORT, 'localhost');
  cli.on('data', d => setTimeout(() => up.writable && up.write(d), 150));
  up.on('data', d => setTimeout(() => cli.writable && cli.write(d), 150));
  const kill = () => { cli.destroy(); up.destroy(); };
  cli.on('error', kill); up.on('error', kill);
  cli.on('close', kill); up.on('close', kill);
});
proxy.listen(PROXY_PORT);
const cleanup = () => { try { server.kill(); } catch {} try { proxy.close(); } catch {} };
process.on('exit', cleanup);

async function waitServer(base) {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + '/')).ok) return; } catch {}
    await sleep(200);
  }
  throw new Error('serveur injoignable : ' + base);
}

const hudText = page => page.evaluate(() => {
  const els = [...document.querySelectorAll('div')];
  const el = els.find(e => e.textContent.startsWith('FPS') && e.style.position === 'fixed');
  return el ? { text: el.textContent, visible: el.style.display !== 'none' } : null;
});

const setName = async (page, base, name) => {
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(n => localStorage.setItem('portail.name', n), name);
};

try {
  await waitServer(BASE);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    protocolTimeout: 60000,
    args: [
      '--window-size=1500,950', '--disable-gpu',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling'
    ]
  });

  // ============ portail : modale pseudo ============
  console.log('— portail : pseudo');
  const p0 = await browser.newPage();
  await p0.setViewport({ width: 1440, height: 900 });
  await p0.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  ok(await p0.$eval('#nameModal', el => !el.hidden), 'modale pseudo affichée au 1er chargement');
  await p0.type('#nameInput', 'Xavier');
  await p0.click('#nameOk');
  ok(await p0.$eval('#nameModal', el => el.hidden), 'modale fermée après pseudo valide');
  await p0.close();

  // ============ variété des cartes/thèmes sur 10 manches ============
  console.log('— variété des cartes (10 quickplays)');
  const p1 = await browser.newPage();
  await p1.setViewport({ width: 1440, height: 900 });
  await setName(p1, BASE, 'Solo');
  const seenThemes = new Map(); // mapId -> screenshot pris ?
  for (let round = 0; round < 10; round++) {
    await p1.goto(BASE + '/games/tag-arena/', { waitUntil: 'domcontentloaded' });
    await p1.click('#btnQuick');
    await p1.waitForSelector('#screenGame:not([hidden])', { timeout: 5000 });
    await p1.waitForFunction(() => window.__tagDebug?.mapId, { timeout: 5000 });
    const dbg = await p1.evaluate(() => window.__tagDebug);
    if (!seenThemes.has(dbg.mapId)) {
      await sleep(700); // laisser le décor s'installer
      await p1.screenshot({ path: path.join(ART, `theme-${dbg.mapId}.png`) });
      seenThemes.set(dbg.mapId, true);
    }
    if (round < 9) await p1.evaluate(() => window.location.reload()); // quitte la partie
  }
  ok(seenThemes.size >= 4, `cartes distinctes sur 10 manches : ${seenThemes.size} (${[...seenThemes.keys()].join(', ')})`);
  ok([...seenThemes.keys()].every(id => typeof id === 'string'), 'mapId transmis au client à chaque manche');

  // ============ HUD + élimination sur la dernière manche ============
  console.log('— HUD (FPS écran / FPS moteur / ping) + mode élimination');
  const dbgLast = await p1.evaluate(() => window.__tagDebug);
  ok(dbgLast.mode === 'elimination', 'quickplay à 4 (1 humain + 3 bots) → mode élimination');
  await sleep(2200);
  const hud1 = await hudText(p1);
  ok(hud1 && hud1.visible, 'HUD visible en haut à gauche pendant la partie');
  const fpsScreen = Number((hud1.text.match(/FPS écran\s+(\d+)/) || [])[1]);
  const fpsEngine = Number((hud1.text.match(/FPS moteur\s+(\d+)/) || [])[1]);
  const ping1 = Number((hud1.text.match(/PING\s+(\d+) ms/) || [])[1]);
  ok(fpsScreen > 5, `FPS écran mesuré (${fpsScreen})`);
  ok(fpsEngine > 0, `FPS moteur mesuré, non plafonné (${fpsEngine})`);
  ok(fpsEngine >= fpsScreen, `FPS moteur (${fpsEngine}) ≥ FPS écran (${fpsScreen})`);
  ok(Number.isFinite(ping1) && ping1 < 100, `ping local faible (${ping1} ms)`);

  // canvas animé + caméra : le viewport (1280×720) est plus petit que la carte
  const camInfo = await p1.evaluate(() => {
    const c = document.getElementById('game');
    return { cw: c.width, ch: c.height, mapId: window.__tagDebug.mapId };
  });
  ok(camInfo.cw === 1280 && camInfo.ch === 720, 'viewport canvas 1280×720 (cartes 2400-3200 px → caméra)');
  await p1.keyboard.down('ArrowRight');
  await sleep(900);
  await p1.keyboard.up('ArrowRight');
  await p1.screenshot({ path: path.join(ART, 'camera-ingame.png') });

  console.log('— attente explosion / fin de manche (~15-50 s)…');
  await p1.waitForFunction(
    () => !document.getElementById('explodedOverlay').hidden ||
          !document.getElementById('endOverlay').hidden,
    { timeout: 55000, polling: 500 });
  const exploded = await p1.$eval('#explodedOverlay', el => !el.hidden);
  if (exploded) {
    ok(true, 'écran "VOUS AVEZ EXPLOSÉ" affiché au joueur éliminé');
    const txt = await p1.$eval('#explodedOverlay h2', el => el.textContent);
    ok(/VOUS AVEZ EXPLOSÉ/.test(txt), 'titre conforme à la référence');
    await p1.screenshot({ path: path.join(ART, 'exploded-overview.png') });
    await p1.click('#btnExit');
    ok(await p1.$eval('#explodedOverlay', el => el.hidden), 'EXIT referme l\'écran → spectateur (vue d\'ensemble)');
    await sleep(600);
    await p1.screenshot({ path: path.join(ART, 'spectate-overview.png') });
    await p1.waitForFunction(() => !document.getElementById('endOverlay').hidden,
      { timeout: 40000, polling: 500 });
  } else {
    ok(true, '(le joueur a survécu jusqu\'à la fin — pas d\'écran d\'explosion pour lui)');
  }
  const rankCount = await p1.$eval('#endRanking', el => (el.hidden ? 0 : el.children.length));
  ok(rankCount >= 2, `écran de fin avec classement (${rankCount} entrées)`);
  const endTitle = await p1.$eval('#endTitle', el => el.textContent);
  ok(/Gagné|place|Éliminé/.test(endTitle), `titre de fin cohérent (« ${endTitle} »)`);
  await p1.screenshot({ path: path.join(ART, 'end-ranking.png') });
  await p1.close();

  // ============ ping qui augmente avec la latence (proxy TCP) ============
  console.log('— HUD : le ping augmente avec une latence simulée');
  const p2 = await browser.newPage();
  const PROXY_BASE = `http://localhost:${PROXY_PORT}`;
  await setName(p2, PROXY_BASE, 'Lent');
  await p2.goto(PROXY_BASE + '/games/tag-arena/', { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  const hud2 = await hudText(p2);
  const ping2 = Number(((hud2?.text || '').match(/PING\s+(\d+) ms/) || [])[1]);
  ok(Number.isFinite(ping2) && ping2 >= 250, `ping ≥ 250 ms via proxy à latence (${ping2} ms vs ${ping1} ms en direct)`);
  await p2.close();

  // ============ salon 1v1 : mode classique ============
  console.log('— salon entre amis 1v1 : mode classique (90 s)');
  const A = await browser.newPage();
  const B = await browser.newPage();
  await A.setViewport({ width: 1440, height: 900 });
  await B.setViewport({ width: 1440, height: 900 });
  await setName(A, BASE, 'Hote');
  await setName(B, BASE, 'Invite');
  await A.goto(BASE + '/games/tag-arena/', { waitUntil: 'domcontentloaded' });
  await B.goto(BASE + '/games/tag-arena/', { waitUntil: 'domcontentloaded' });

  await A.bringToFront();
  await A.click('#btnCreate');
  await A.waitForSelector('#screenLobby:not([hidden])', { timeout: 5000 });
  const code = await A.$eval('#lobbyCode', el => el.textContent.trim());
  ok(/^[A-Z]{4}$/.test(code), `salon créé depuis l'UI, code affiché (${code})`);

  await B.bringToFront();
  await B.click('#btnShowJoin');
  await B.type('#codeInput', code);
  await B.click('#btnJoin');
  await B.waitForSelector('#screenLobby:not([hidden])', { timeout: 5000 });
  await sleep(400);

  await A.bringToFront();
  ok(await A.$eval('#btnStart', el => !el.disabled), 'bouton Lancer actif à 2 joueurs');
  await A.click('#btnStart');
  await A.waitForSelector('#screenGame:not([hidden])', { timeout: 5000 });
  await B.waitForSelector('#screenGame:not([hidden])', { timeout: 5000 });
  const modeA = await A.evaluate(() => window.__tagDebug.mode);
  const modeB = await B.evaluate(() => window.__tagDebug.mode);
  ok(modeA === 'classic' && modeB === 'classic', 'manche à 2 → mode classique pour les 2 clients');
  await sleep(1200);
  await A.screenshot({ path: path.join(ART, 'friends-1v1-classic.png') });
  ok((await hudText(A))?.visible, 'HUD visible aussi en partie amis');

  await browser.close();
  console.log(`\n✅ browser.mjs : ${passed} vérifications passées (captures dans tests/artifacts/)`);
  cleanup();
  process.exit(0);
} catch (err) {
  console.error('\n❌ échec :', err);
  cleanup();
  process.exit(1);
}
