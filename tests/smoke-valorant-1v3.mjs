/**
 * smoke-valorant-1v3.mjs — mode défi solo (prompt 14).
 * Vérifie l'effectif asymétrique, la difficulté choisie à la main, la
 * succession des rôles côté adverse et la séparation des historiques.
 *
 * Le mode et la difficulté passent par l'URL (`?test&mode=1v3&diff=hard`) :
 * aucun clic à deviner, aucun hasard.
 *
 *   node tests/smoke-valorant-1v3.mjs            vérifie
 *   node tests/smoke-valorant-1v3.mjs shot.png   vérifie + capture une image
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3215;
const BASE = `http://localhost:${PORT}`;
const url = `${BASE}/games/valorant/?test&mode=1v3&diff=hard`;
const HARD_ELO = 1450; // doit suivre DIFFICULTIES.hard dans mode_select.js

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ['server/server.js', '--no-tunnel'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore',
});
const cleanup = () => { try { server.kill(); } catch {} };
process.on('exit', cleanup);

for (let i = 0; ; i++) {
  try { if ((await fetch(BASE + '/')).ok) break; } catch {}
  if (i >= 50) throw new Error('serveur injoignable');
  await sleep(200);
}

const browser = await chromium.launch();
const errors = [];
let n = 0;
const ok = (cond, msg) => { n++; if (!cond) errors.push('ÉCHEC — ' + msg); };

const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`pageerror : ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console : ${m.text()}`); });

await page.goto(url);
await page.click('#mappick button[data-map="nexus"]');
await page.click('#pick button[data-key="jett"]');
await page.waitForSelector('canvas');
await page.evaluate(() => { window.input.locked = true; });

// Pas d'écran de recherche : il n'y a personne à chercher en solo.
ok(!(await page.$('#search')), 'aucun écran de recherche en 1v3');
ok(await page.evaluate(() => window.mode === '1v3' && window.difficulty === 'hard'),
   'mode et difficulté lus depuis l’URL');

await page.waitForSelector('#buy.on');
const roster = await page.evaluate(() => ({
  total: window.actors.length,
  mine: window.actors.filter((a) => a.team === window.playerActor.team).length,
  foes: window.actors.filter((a) => a.team !== window.playerActor.team).length,
  elos: window.bots.map((b) => b.elo),
  foeTeams: window.bots.map((b) => b.a.team),
  playerTeam: window.playerActor.team,
}));
ok(roster.total === 4, `4 acteurs en jeu (${roster.total})`);
ok(roster.mine === 1, `le joueur est seul dans son équipe (${roster.mine})`);
ok(roster.foes === 3, `3 bots en face (${roster.foes})`);
ok(roster.foeTeams.every((t) => t !== roster.playerTeam), 'tous les bots sont dans l’équipe adverse');
ok(roster.elos.every((e) => e === HARD_ELO), `bots à l’ELO « Difficile » (${roster.elos.join(', ')})`);

// Rôles : le même chemin qu'en 3v3 (resetRound) doit en distribuer 3 distincts.
const roles = await page.evaluate(() => window.bots.map((b) => b.role));
ok(new Set(roles).size === 3, `3 rôles distincts côté adverse (${roles.join(', ')})`);

// Lancement du round, puis succession : on tue l'entry par le circuit de dégâts.
await page.evaluate(() => {
  window.rm.timer = 0.001;
  window.actors.forEach((a) => { a.hp = 1e4; a.maxHp = 1e4; });
});
await sleep(200);
ok(await page.evaluate(() => window.rm.live), 'le round est lancé');

// Le rôle de tête dépend du camp des bots : « entry » s'ils attaquent, sinon
// « anchor ». Au round 1 ce sont les t0 qui attaquent, et le camp du joueur est
// tiré au sort — d'où la lecture dynamique de rm.attackers plutôt qu'un rôle figé.
const succession = await page.evaluate(async () => {
  const botTeam = window.bots[0].a.team;
  const top = botTeam === window.rm.attackers ? 'entry' : 'anchor';
  const lead = window.bots.find((b) => b.role === top);
  const before = { name: lead.a.name, role: lead.role };
  lead.a.hp = 10; lead.a.shield = 0;
  window.effects.hurt(lead.a, 999, window.playerActor, 'test');
  await new Promise((r) => setTimeout(r, 200));
  return {
    top,
    before,
    stillAlive: lead.a.alive,
    survivors: window.bots.filter((b) => b.a.alive).map((b) => b.role),
  };
});
ok(!succession.stillAlive, `le bot de tête (${succession.before.name}, ${succession.top}) est mort`);
ok(succession.survivors.includes(succession.top),
   `un bot survivant reprend « ${succession.top} » (${succession.survivors.join(', ')})`);

if (process.argv[2]) await page.screenshot({ path: process.argv[2] });

// Fin de match : l'entrée part dans l'historique SOLO, pas dans celui du 3v3.
const before = await page.evaluate(() => ({
  solo: window.stats.solo().length, global: window.stats.global().length,
}));
await page.evaluate(() => {
  const t = window.playerActor.team;
  window.rm.score[t] = window.ROUNDS_TO_WIN - 1;
  window.rm.end(t, 'test');
});
await sleep(250);
const after = await page.evaluate(() => ({
  phase: window.rm.phase,
  end: document.getElementById('endscreen').classList.contains('on'),
  solo: window.stats.solo(),
  global: window.stats.global().length,
}));
ok(after.phase === 'match', 'le match se termine');
ok(after.end, 'écran de fin affiché');
ok(after.solo.length === before.solo + 1, `une partie solo enregistrée (${after.solo.length})`);
ok(after.global === before.global, 'l’historique 3v3 est resté intact');
ok(after.solo.at(-1)?.difficulty === 'hard', 'la difficulté est consignée dans l’entrée solo');

// Écran de fin : le pseudo porte la couleur de son équipe réelle. En 1v3 c'est
// 1 contre 3, donc une couleur d'un côté et trois de l'autre — quel que soit le
// camp tiré au sort pour le joueur.
const endNames = await page.evaluate(() => [...document.querySelectorAll('#endscreen td.nm')]
  .map((td) => ({ team: td.classList.contains('b0') ? 0 : 1, color: getComputedStyle(td).color })));
ok(endNames.length === 4, `écran de fin : 4 pseudos rendus (${endNames.length})`);
ok(endNames.every((x) => x.color === (x.team === 0 ? 'rgb(74, 163, 255)' : 'rgb(255, 77, 77)')),
   `écran de fin : bleu pour t0, rouge pour t1 (${endNames.map((x) => x.color).join(' ')})`);

// Tirage du camp (prompt 16) : on recharge jusqu'à voir les deux camps. Sans le
// tirage, assignTeams laisserait le joueur en équipe 0 à chaque partie et la
// boucle irait au bout sans jamais voir le rouge.
const seen = new Set([roster.playerTeam]);
for (let i = 0; i < 12 && seen.size < 2; i++) {
  await page.goto(url);
  await page.click('#mappick button[data-map="nexus"]');
  await page.click('#pick button[data-key="jett"]');
  await page.waitForSelector('canvas');
  await page.waitForSelector('#buy.on');
  const t = await page.evaluate(() => ({
    team: window.playerActor.team,
    mine: window.actors.filter((a) => a.team === window.playerActor.team).length,
    foes: window.actors.filter((a) => a.team !== window.playerActor.team).length,
  }));
  ok(t.mine === 1 && t.foes === 3, `tirage ${i} : le 1v3 reste 1 contre 3 (${t.mine}/${t.foes})`);
  seen.add(t.team);
}
ok(seen.size === 2, `le camp du joueur est tiré au sort en local (camps vus : ${[...seen].sort()})`);

await page.close();
await browser.close();
cleanup();

if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`smoke-valorant-1v3 : ${n} vérifications OK`);
process.exit(0);
