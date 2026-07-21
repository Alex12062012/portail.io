/**
 * smoke-mine.mjs — bout-en-bout du protocole Mine Coop : serveur réel + clients
 * socket.io simulés, exactement comme le fait public/games/mine-coop/main.js.
 * Couvre : création d'un monde (worldCode), game:start (spawn + inventaire),
 * streaming de chunks (mine:chunkRequest → mine:chunkData base64), minage
 * (mine:break → mine:blockSet + mine:inv), pose, téléportation
 * (mine:teleport → mine:teleportOk), 2 joueurs qui se voient (mine:state), et
 * persistance (quitter → rejoindre même code → bloc miné conservé).
 *
 *   node tests/smoke-mine.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert';
import { io as connect } from 'socket.io-client';
import { TILE, CHUNK, BLOCK, decodeChunk } from '../shared/mine-world.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3221;
const BASE = `http://localhost:${PORT}`;
const SAVES = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-smoke-'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
const ok = (cond, label) => { assert.ok(cond, label); passed++; console.log(`  ✔ ${label}`); };

const server = spawn(process.execPath, ['server/server.js', '--no-tunnel'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), MINE_SAVES_DIR: SAVES }, stdio: ['ignore', 'pipe', 'pipe']
});
server.stderr.on('data', d => process.stderr.write('[server] ' + d));
const cleanup = () => { try { server.kill(); } catch {} try { fs.rmSync(SAVES, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/')).ok) return; } catch {}
    await sleep(200);
  }
  throw new Error('serveur injoignable');
}
const client = () => connect(BASE, { transports: ['websocket'] });
const emitAck = (s, ev, p) => new Promise(res => s.emit(ev, p, res));
const waitFor = (s, ev, timeout = 5000) => new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error('timeout ' + ev)), timeout);
  s.once(ev, d => { clearTimeout(to); res(d); });
});

const WORLD = 'MINE01';

try {
  await waitForServer();

  console.log('— pages statiques du client Mine Coop');
  for (const p of ['/games/mine-coop/', '/games/mine-coop/main.js',
    '/games/mine-coop/render.js', '/games/mine-coop/mine.css', '/shared/mine-world.js',
    '/shared/mine-physics.js']) {
    const r = await fetch(BASE + p);
    ok(r.ok, `GET ${p} → ${r.status}`);
  }

  console.log('— création du monde + 2e joueur dans le lobby + game:start');
  const a = client();
  await waitFor(a, 'connect');
  const created = await emitAck(a, 'room:create', { gameType: 'mine-coop', name: 'Alex', worldCode: WORLD });
  ok(created.ok && created.code === WORLD, `monde créé avec code personnalisé (${created.code})`);
  // un 2e joueur rejoint AVANT le lancement (le multijoueur passe par le lobby)
  const b = client();
  await waitFor(b, 'connect');
  const bj = await emitAck(b, 'room:join', { code: WORLD, name: 'Bea' });
  ok(bj.ok, 'Bea rejoint le lobby avec le même code');
  const startP = waitFor(a, 'game:start');
  const bStart = waitFor(b, 'game:start');
  await emitAck(a, 'room:start');
  const gs = await startP;
  await bStart;
  ok(gs.gameType === 'mine-coop' && gs.spawn && gs.you?.inv, 'game:start : spawn + inventaire reçus');
  const tx = Math.floor(gs.spawn.x / TILE);
  const ty = Math.round(gs.spawn.y / TILE);     // tuile d'herbe sous le spawn
  ok(typeof gs.dayTime === 'number', `dayTime initial fourni (${gs.dayTime})`);

  console.log('— streaming de chunks (mine:chunkRequest → mine:chunkData)');
  const cx = (tx / CHUNK) | 0, cy = (ty / CHUNK) | 0;
  const chunkP = waitFor(a, 'mine:chunkData');
  a.emit('mine:chunkRequest', { list: [{ cx, cy }, { cx: cx - 1, cy }, { cx: cx + 1, cy }] });
  const cd = await chunkP;
  ok(Array.isArray(cd.chunks) && cd.chunks.length >= 1, `chunkData reçu (${cd.chunks.length} chunks)`);
  const spawnChunk = cd.chunks.find(c => c.cx === cx && c.cy === cy);
  const buf = decodeChunk(spawnChunk.data);
  ok(buf.length === CHUNK * CHUNK, `chunk décodé à la bonne taille (${buf.length})`);
  const idxIn = (gx, gy) => (gx - cx * CHUNK) * CHUNK + (gy - cy * CHUNK);
  ok(buf[idxIn(tx, ty)] === BLOCK.GRASS, 'herbe présente sous le spawn dans le chunk');

  console.log('— minage (mine:break → mine:blockSet + mine:inv)');
  a.emit('mine:move', { x: gs.spawn.x, y: gs.spawn.y, vx: 0, vy: 0, f: 1 });
  await sleep(60);
  const blockSetP = waitFor(a, 'mine:blockSet');
  const invP = waitFor(a, 'mine:inv');
  a.emit('mine:break', { tx, ty });
  const bs = await blockSetP;
  ok(bs.tx === tx && bs.ty === ty && bs.block === BLOCK.AIR, 'bloc miné → AIR diffusé via mine:blockSet');
  const inv = await invP;
  const dirt = [...inv.hotbar, ...inv.main].filter(Boolean).find(s => s.item === BLOCK.DIRT);
  ok(dirt && dirt.count === 1, 'herbe minée à la main → 1 terre dans l\'inventaire');

  console.log('— pose (mine:place → mine:blockSet)');
  const placeTx = tx + 1, placeTy = ty - 1;     // air au-dessus de l'herbe voisine
  const placeP = waitFor(a, 'mine:blockSet');
  a.emit('mine:place', { tx: placeTx, ty: placeTy });
  const ps = await placeP;
  ok(ps.tx === placeTx && ps.ty === placeTy && ps.block === BLOCK.DIRT, 'terre posée diffusée via mine:blockSet');

  console.log('— téléportation (mine:teleport → mine:teleportOk)');
  const tpP = waitFor(a, 'mine:teleportOk');
  a.emit('mine:teleport', { dispX: 5, y: ty });   // X affiché 5 → tx = 2053
  const tp = await tpP;
  ok(Math.floor(tp.x / TILE) === 2048 + 5 && Math.floor(tp.y / TILE) === ty, `téléporté en X affiché 5 (px ${Math.round(tp.x)})`);

  console.log('— les deux joueurs se voient dans mine:state');
  b.emit('mine:move', { x: 2060 * TILE, y: gs.spawn.y, vx: 0, vy: 0, f: 1 });
  await sleep(200);
  const st = await waitFor(a, 'mine:state');
  ok(st.players.length === 2, `mine:state : 2 joueurs (${st.players.map(p => p.name).join(', ')})`);
  const bea = st.players.find(p => p.name === 'Bea');
  ok(bea && Math.abs(bea.x - 2060 * TILE) < TILE, 'la position de Bea est relayée à Alex');

  console.log('— sauvegarde manuelle (mine:save) + persistance après rechargement');
  const saveOkP = waitFor(a, 'mine:saveOk');
  a.emit('mine:save');
  ok((await saveOkP)?.ts > 0, 'mine:save → mine:saveOk avec horodatage');
  a.emit('room:leave'); b.emit('room:leave');
  await sleep(300);
  a.disconnect(); b.disconnect();
  await sleep(150);

  const c = client();
  await waitFor(c, 'connect');
  const reopened = await emitAck(c, 'room:create', { gameType: 'mine-coop', name: 'Alex', worldCode: WORLD });
  ok(reopened.ok, 'monde rouvert avec le même code');
  const cStart = waitFor(c, 'game:start');
  await emitAck(c, 'room:start');
  await cStart;
  const chunk2P = waitFor(c, 'mine:chunkData');
  c.emit('mine:chunkRequest', { list: [{ cx, cy }] });
  const cd2 = await chunk2P;
  const buf2 = decodeChunk(cd2.chunks.find(ch => ch.cx === cx && ch.cy === cy).data);
  ok(buf2[idxIn(tx, ty)] === BLOCK.AIR, 'le bloc miné est toujours AIR après rechargement');
  ok(buf2[idxIn(placeTx, placeTy)] === BLOCK.DIRT, 'le bloc posé est conservé après rechargement');
  c.disconnect();

  console.log('— changement de code du monde en jeu (mine:setCode)');
  const e = client();
  await waitFor(e, 'connect');
  ok((await emitAck(e, 'room:create', { gameType: 'mine-coop', name: 'Eve', worldCode: 'SETCA' })).ok, 'monde SETCA créé');
  const eStart = waitFor(e, 'game:start');
  await emitAck(e, 'room:start');
  await eStart;
  ok((await emitAck(e, 'mine:save')) || fs.existsSync(path.join(SAVES, 'SETCA.json')), 'SETCA sauvegardé');
  const changedP = waitFor(e, 'mine:codeChanged');
  const setRes = await emitAck(e, 'mine:setCode', { newCode: 'SETCB' });
  ok(setRes.ok && setRes.newCode === 'SETCB', 'mine:setCode accepté (SETCA → SETCB)');
  ok((await changedP).newCode === 'SETCB', 'mine:codeChanged diffusé');
  ok(fs.existsSync(path.join(SAVES, 'SETCB.json')) && !fs.existsSync(path.join(SAVES, 'SETCA.json')),
    'sauvegarde renommée SETCA → SETCB');
  // le joueur reste rattaché au monde sous le nouveau code (un chunkRequest répond)
  const cd3 = waitFor(e, 'mine:chunkData');
  e.emit('mine:chunkRequest', { list: [{ cx: 64, cy: 2 }] });
  ok((await cd3).chunks.length >= 1, 'le joueur reste connecté au monde après le changement de code');
  // un nouveau code déjà pris est refusé
  const dup = await emitAck(e, 'mine:setCode', { newCode: 'SETCB' });
  ok(!dup.ok, 'mine:setCode refuse le code actuel');
  e.disconnect();

  console.log(`\n✅ smoke-mine.mjs : ${passed} vérifications passées`);
  cleanup();
  process.exit(0);
} catch (err) {
  console.error('\n❌ échec :', err.message);
  cleanup();
  process.exit(1);
}
