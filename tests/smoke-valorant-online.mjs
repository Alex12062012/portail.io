/**
 * smoke-valorant-online.mjs — smoke réseau du 3v3 en ligne (serveur autoritaire).
 * Deux clients socket.io (aucun navigateur) : quickplay Valorant, la partie
 * démarre en 3v3 (humains + bots), les deux joueurs se voient bouger dans les
 * snapshots, et un tir reporté par un client applique des dégâts autoritaires
 * sur l'autre. Filet sur tout le chemin server.js → server/games/valorant.js.
 *
 *   node tests/smoke-valorant-online.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { io as ioc } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3216;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let n = 0;
const ok = (cond, msg) => { n++; if (!cond) throw new Error('ÉCHEC — ' + msg); };

// waitSeconds=1 : laisse les deux clients rejoindre la file avant le remplissage.
const server = spawn(process.execPath, ['server/server.js', '--no-tunnel'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), VAL_WAIT_SECONDS: '1' }, stdio: 'ignore',
});
const cleanup = () => { try { server.kill(); } catch {} };
process.on('exit', cleanup);

for (let i = 0; ; i++) {
  try { if ((await fetch(BASE + '/')).ok) break; } catch {}
  if (i >= 50) { cleanup(); throw new Error('serveur injoignable'); }
  await sleep(200);
}

const connect = () => new Promise((resolve) => { const s = ioc(BASE); s.on('connect', () => resolve(s)); });
const quickplay = (s, name, agentKey) => new Promise((res) => s.emit('quickplay', { gameType: 'valorant', name, agentKey }, res));
const waitFor = (s, ev, pred = () => true, ms = 8000) => new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error(`timeout sur ${ev}`)), ms);
  const h = (d) => { if (pred(d)) { clearTimeout(to); s.off(ev, h); resolve(d); } };
  s.on(ev, h);
});

try {
  const A = await connect();
  const B = await connect();

  const startA = waitFor(A, 'game:start');
  const startB = waitFor(B, 'game:start');
  ok((await quickplay(A, 'Alice', 'jett')).ok, 'quickplay A accepté');
  await sleep(100); // A crée la partie et entre en file
  ok((await quickplay(B, 'Bob', 'sova')).ok, 'quickplay B accepté (rejoint la file)');

  const gs = await startA; await startB;
  ok(gs.gameType === 'valorant', 'game:start est bien valorant');
  ok(gs.roster.length === 6, `3v3 : 6 acteurs (mesuré ${gs.roster.length})`);
  const humans = gs.roster.filter((r) => !r.bot);
  ok(humans.length === 2, '2 humains dans le roster');
  const aId = gs.roster.find((r) => r.name === 'Alice').id;
  const bId = gs.roster.find((r) => r.name === 'Bob').id;
  const aTeam = gs.roster.find((r) => r.id === aId).team;
  const bTeam = gs.roster.find((r) => r.id === bId).team;
  ok(aTeam !== bTeam, 'les 2 humains sont dans des équipes opposées (répartition équitable)');

  // Les deux se déclarent prêts ; on attend la phase live.
  A.emit('val:ready'); B.emit('val:ready');

  // A bouge : B doit le voir bouger dans un snapshot.
  const movedTo = { x: 3.5, y: 0, z: -7.5 };
  const tMove = setInterval(() => A.emit('val:input', { ...movedTo, yaw: 1.2, holding: false }), 50);
  const snapMoved = await waitFor(B, 'val:snap', (s) => {
    const a = s.actors.find((x) => x.id === aId);
    return a && Math.abs(a.x - movedTo.x) < 0.6 && Math.abs(a.z - movedTo.z) < 0.6;
  });
  clearInterval(tMove);
  ok(snapMoved, 'B voit la position de A mise à jour (mouvement synchronisé)');

  // On attend la phase live (bots + humains prêts).
  const liveSnap = await waitFor(B, 'val:snap', (s) => s.phase === 'live', 10000);
  ok(liveSnap.phase === 'live', 'le round passe en phase live');

  // A tire sur B : dégâts autoritaires appliqués et diffusés.
  const bBefore = liveSnap.actors.find((x) => x.id === bId).hp;
  const aPos = liveSnap.actors.find((x) => x.id === aId);
  const bPos = liveSnap.actors.find((x) => x.id === bId);
  const dist = Math.hypot(aPos.x - bPos.x, aPos.z - bPos.z);
  const hit = waitFor(A, 'val:hit', (h) => h.targetId === bId);
  A.emit('val:shot', {
    from: { x: aPos.x, y: aPos.y + 1.4, z: aPos.z },
    to: { x: bPos.x, y: bPos.y + 1.4, z: bPos.z },
    hits: [{ targetId: bId, part: 'b', dist }],
  });
  const h = await hit;
  ok(h.dmg > 0, `le tir de A inflige des dégâts à B (${h.dmg})`);
  const bAfter = (await waitFor(B, 'val:snap', (s) => {
    const b = s.actors.find((x) => x.id === bId);
    return !b.alive || b.hp < bBefore;
  })).actors.find((x) => x.id === bId);
  ok(bAfter.hp < bBefore || !bAfter.alive, `les PV de B baissent côté serveur (${bBefore} → ${bAfter.hp})`);

  // Système de points (récompense) : le snapshot porte des points par acteur, et
  // ils s'accumulent (au moins par le déplacement des bots pendant le round).
  ok(liveSnap.actors.every((x) => typeof x.points === 'number'), 'le snapshot expose les points par acteur');
  const scored = await waitFor(A, 'val:snap', (s) => s.actors.some((x) => x.points > 0), 8000);
  ok(scored.actors.some((x) => x.points > 0), 'des points sont accumulés pendant la partie (reward-shaping)');

  A.close(); B.close();
  cleanup();
  console.log(`smoke-valorant-online : ${n} vérifications OK`);
  process.exit(0);
} catch (e) {
  cleanup();
  console.error(e.message || e);
  process.exit(1);
}
