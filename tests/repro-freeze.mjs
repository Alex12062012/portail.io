import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = '/sessions/intelligent-pensive-gauss/mnt/game-portal';
const PORT = 3299;
const BASE = `http://localhost:${PORT}`;
const url = `${BASE}/games/valorant/?test`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = spawn(process.execPath, ['server/server.js', '--no-tunnel'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore'
});
const cleanup = () => { try { server.kill(); } catch {} };
process.on('exit', cleanup);

for (let i = 0; ; i++) {
  try { if ((await fetch(BASE + '/')).ok) break; } catch {}
  if (i >= 50) throw new Error('serveur injoignable');
  await sleep(200);
}

const domClick = (page, sel) => page.evaluate((s) => document.querySelector(s).click(), sel);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERROR', m.text()); });

await page.goto(url);
console.log('after goto, title:', await page.title());

const modeBtn = await page.$('button[data-mode="3v3"]');
if (modeBtn) await modeBtn.click();

await page.click('#mappick button[data-map="nexus"]');
await page.click('#pick button[data-key="jett"]');
await page.waitForSelector('canvas');
await page.evaluate(() => { window.input.locked = true; });

await page.waitForSelector('#buy.on');
await domClick(page, '#buy button[data-kind="ready"]');

await page.evaluate(() => {
  window.rm.timer = 0.001;
  window.actors.forEach((a) => { if (a !== window.playerActor) { a.hp = 1e4; a.maxHp = 1e4; } });
});
await page.waitForTimeout(200);
console.log('live?', await page.evaluate(() => window.rm.live));
console.log('team size player team', await page.evaluate(() =>
  window.actors.filter(a => a.team === window.playerActor.team).length));

const before = await page.evaluate(() => window.actors.filter(a => !a.player).map(a => ({ x: a.pos.x, z: a.pos.z, team: a.team, alive: a.alive, role: a.role })));
await page.waitForTimeout(1500);
const mid = await page.evaluate(() => window.actors.filter(a => !a.player).map(a => ({ x: a.pos.x, z: a.pos.z })));

await page.evaluate(() => { window.effects.hurt(window.playerActor, 1e5, null, 'test-kill'); });
console.log('player alive after hurt?', await page.evaluate(() => window.playerActor.alive));
console.log('rm.live after player death:', await page.evaluate(() => window.rm.live));
console.log('rm.phase after player death:', await page.evaluate(() => window.rm.phase));
console.log('aliveCount player team after death:', await page.evaluate(() =>
  window.actors.filter(a => a.team === window.playerActor.team && a.alive).length));

const afterKill1 = await page.evaluate(() => window.actors.filter(a => !a.player).map(a => ({ x: a.pos.x, z: a.pos.z, alive: a.alive })));
await page.waitForTimeout(2000);
const afterKill2 = await page.evaluate(() => window.actors.filter(a => !a.player).map(a => ({ x: a.pos.x, z: a.pos.z, alive: a.alive })));

function moved(a, b) {
  return a.map((p, i) => Math.hypot(p.x - b[i].x, p.z - b[i].z));
}
console.log('movement before->mid (should move):', moved(before, mid));
console.log('movement afterKill1->afterKill2 (2s post-death):', moved(afterKill1, afterKill2));
console.log('phase 2s post death:', await page.evaluate(() => window.rm.phase));

await browser.close();
cleanup();
