/**
 * smoke.mjs — tests de bout en bout : serveur réel + clients socket.io simulés.
 * Couvre : pages servies, ping HUD, salon amis 1v1 (mode classique 90 s),
 * transfert du tag + immunité, quickplay 4 joueurs (mode élimination : boom
 * réel à ~30 s, spectateur figé, nouveau it), salon à 4, déconnexions.
 *
 *   node tests/smoke.mjs   (durée ~60 s : inclut une vraie explosion à 30 s)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert';
import { io as connect } from 'socket.io-client';
import { MAPS } from '../shared/tag-map.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3211;
const BASE = `http://localhost:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
const ok = (cond, label) => { assert.ok(cond, label); passed++; console.log(`  ✔ ${label}`); };
const mapOf = payload => MAPS.find(m => m.id === payload.mapId);

// ---- démarrage du serveur jetable -------------------------------------------
const server = spawn(process.execPath, ['server/server.js', '--no-tunnel'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), TAG_START_DELAY: '0' },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stderr.on('data', d => process.stderr.write('[server] ' + d));
const cleanup = () => { try { server.kill(); } catch {} };
process.on('exit', cleanup);

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(BASE + '/');
      if (r.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error('serveur injoignable');
}

function client() {
  return connect(BASE, { transports: ['websocket'] });
}
const emitAck = (sock, ev, payload) =>
  new Promise(res => sock.emit(ev, payload, res));
const waitFor = (sock, ev, timeout = 5000) =>
  new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error(`timeout en attendant ${ev}`)), timeout);
    sock.once(ev, data => { clearTimeout(to); res(data); });
  });

try {
  await waitForServer();
  console.log('— pages statiques');
  for (const p of ['/', '/portal.js', '/portal.css', '/games/tag-arena/',
    '/games/tag-arena/main.js', '/games/tag-arena/render.js',
    '/shared/tag-map.js', '/shared/tag-physics.js', '/shared/debug-hud.js']) {
    const r = await fetch(BASE + p);
    ok(r.ok, `GET ${p} → ${r.status}`);
  }

  console.log('— ping HUD');
  const a = client();
  await waitFor(a, 'connect');
  const t0 = Date.now();
  await new Promise(res => a.emit('hud:ping', res));
  ok(Date.now() - t0 < 1000, `hud:ping répond via ack (${Date.now() - t0} ms)`);

  console.log('— salon entre amis : création / erreurs / join');
  const created = await emitAck(a, 'room:create', { gameType: 'tag-arena', name: 'Alice' });
  ok(created.ok && /^[A-Z]{4}$/.test(created.code), `salon créé, code 4 lettres (${created.code})`);

  const b = client();
  await waitFor(b, 'connect');
  const bad = await emitAck(b, 'room:join', { code: 'ZZZZ', name: 'Bob' });
  ok(!bad.ok && bad.error === 'not_found', 'join code inconnu → not_found');

  const roomUpdate = waitFor(a, 'room:update');
  const joined = await emitAck(b, 'room:join', { code: created.code, name: 'Bob' });
  ok(joined.ok, 'Bob rejoint avec le code');
  const upd = await roomUpdate;
  ok(upd.players.length === 2, 'room:update : 2 joueurs listés');

  console.log('— manche à 2 : mode CLASSIQUE (90 s, pas de bombes)');
  const startA = waitFor(a, 'game:start');
  const startB = waitFor(b, 'game:start');
  a.emit('room:start');
  const [gsA, gsB] = await Promise.all([startA, startB]);
  ok(gsA.mode === 'classic', '2 joueurs → mode classique');
  ok(gsA.snapshot.t > 85 && gsA.snapshot.t <= 90, `timer initial ~90 s (${gsA.snapshot.t.toFixed(1)})`);
  const map2 = mapOf(gsA);
  ok(!!map2, `carte transmise et connue (${gsA.mapId} — ${map2.name})`);
  ok(gsA.mapId === gsB.mapId, 'même carte pour les 2 clients');
  ok(gsA.snapshot.players.length === 2 && !gsA.snapshot.players.some(p => p.bot), '2 joueurs, aucun bot');

  console.log('— transfert du tag au contact + immunité');
  const gy = map2.ground.y;
  const itFirst = gsA.snapshot.itId;
  const itSock = itFirst === a.id ? a : b;
  const otherSock = itFirst === a.id ? b : a;
  itSock.emit('tag:move', { x: 200, y: gy, vx: 0, vy: 0, f: 1 });
  otherSock.emit('tag:move', { x: 1000, y: gy, vx: 0, vy: 0, f: 1 });
  await sleep(200);
  const taggedP = waitFor(a, 'tag:tagged');
  itSock.emit('tag:move', { x: 1000, y: gy, vx: 0, vy: 0, f: 1 }); // contact
  const tagged = await taggedP;
  ok(tagged.itId === otherSock.id && tagged.prevId === itSock.id, 'le rôle it est transféré au contact');

  let reTagged = null;
  // on ne retient que le PREMIER re-tag après l'immunité : avec une immunité
  // courte (0.6 s) et un contact maintenu, le rôle se renvoie en ping-pong,
  // donc capter le dernier événement ferait basculer la cible attendue.
  const onTag = e => { if (!reTagged) reTagged = e; };
  a.on('tag:tagged', onTag);
  await sleep(500);
  ok(reTagged === null, 'pas de re-tag pendant l\'immunité (0.6 s, contact maintenu)');
  await sleep(500);
  ok(reTagged && reTagged.itId === itSock.id, 'le re-tag arrive après l\'immunité');
  a.off('tag:tagged', onTag);

  console.log('— timer classique décompte + aucun boom');
  const s1 = await waitFor(a, 'tag:state');
  let sawBoom = false;
  const boomWatch = () => { sawBoom = true; };
  a.on('tag:boom', boomWatch);
  await sleep(1200);
  const s2 = await waitFor(a, 'tag:state');
  a.off('tag:boom', boomWatch);
  ok(s2.t < s1.t, `le timer décompte (${s1.t.toFixed(1)} → ${s2.t.toFixed(1)})`);
  ok(s2.mode === 'classic' && !sawBoom, 'mode classique : aucune explosion');

  console.log('— quitter en pleine manche à 2 → manche annulée');
  const endA = waitFor(a, 'tag:end');
  b.emit('room:leave');
  const endEv = await endA;
  ok(endEv.aborted === true, 'tag:end aborted quand il ne reste qu\'un joueur');

  console.log('— quickplay : 4 joueurs → mode ÉLIMINATION');
  const c = client();
  await waitFor(c, 'connect');
  const qStart = waitFor(c, 'game:start');
  const qAck = await emitAck(c, 'quickplay', { gameType: 'tag-arena', name: 'Carl' });
  ok(qAck.ok, 'quickplay accepté');
  const qs = await qStart;
  ok(qs.mode === 'elimination', '4 joueurs → mode élimination');
  ok(qs.snapshot.players.length === 4 && qs.snapshot.players.filter(p => p.bot).length === 3,
    '1 humain + 3 bots');
  // 30 s + 0,3 s d'extra sur la dernière seconde (TAG.lastSecondExtraMs)
  ok(qs.snapshot.t <= 30.31, `compte à rebours d'explosion ≤ 30,3 s (${qs.snapshot.t.toFixed(1)})`);
  const mapQ = mapOf(qs);
  ok(!!mapQ, `carte de la partie publique connue (${qs.mapId})`);

  // un 2e humain rejoint tout de suite (avant le 1er boom)
  const d = client();
  await waitFor(d, 'connect');
  const dStart = waitFor(d, 'game:start');
  const dAck = await emitAck(d, 'quickplay', { gameType: 'tag-arena', name: 'Dana' });
  ok(dAck.ok && dAck.code === qAck.code, 'second humain placé dans la même partie publique');
  const ds = await dStart;
  ok(ds.snapshot.players.filter(p => !p.bot).length === 2, '2 humains après remplacement d\'un bot');
  ok(ds.snapshot.players.find(p => p.id === d.id)?.imm === true, 'immunité de join');

  // l'humain Carl se gare dans un coin (il enverra sa position)
  c.emit('tag:move', { x: 200, y: mapQ.ground.y, vx: 0, vy: 0, f: 1 });
  d.emit('tag:move', { x: mapQ.width - 200, y: mapQ.ground.y, vx: 0, vy: 0, f: 1 });

  console.log('— attente de la 1ère explosion (~30 s)…');
  let itBeforeBoom = null;
  const stateWatch = s => { itBeforeBoom = s.itId; };
  c.on('tag:state', stateWatch);
  const boom = await waitFor(c, 'tag:boom', 35000);
  c.off('tag:state', stateWatch);
  ok(!!boom.playerId, `boom reçu : ${boom.name} a explosé`);
  ok(boom.playerId === itBeforeBoom, 'la victime est bien le it du moment');
  ok(boom.place === 4 && boom.remaining === 3, '1ère explosion → 4e place, 3 restants');

  await sleep(400);
  const sAfter = await waitFor(c, 'tag:state');
  const deadEntry = sAfter.players.find(p => p.id === boom.playerId);
  ok(deadEntry?.dead === true, 'la victime est marquée morte dans les états');
  ok(sAfter.itId && sAfter.itId !== boom.playerId &&
    sAfter.players.find(p => p.id === sAfter.itId)?.dead !== true,
    'nouveau it choisi parmi les survivants');

  // un éliminé (bot) ne bouge plus
  if (deadEntry.bot) {
    const px = deadEntry.x, py = deadEntry.y;
    await sleep(800);
    const sLater = await waitFor(c, 'tag:state');
    const still = sLater.players.find(p => p.id === boom.playerId);
    ok(Math.hypot(still.x - px, still.y - py) < 1, 'le bot explosé ne bouge plus');
  } else {
    ok(true, '(victime humaine — immobilité non testée)');
  }

  c.emit('room:leave'); d.emit('room:leave');
  await sleep(200);

  console.log('— salon amis à 4 joueurs : élimination + sync');
  const h = await emitAck(a, 'room:create', { gameType: 'tag-arena', name: 'Alice' });
  ok(h.ok, 'nouveau salon créé');
  for (const [s, n] of [[b, 'Bob'], [c, 'Carl'], [d, 'Dana']]) {
    const r = await emitAck(s, 'room:join', { code: h.code, name: n });
    ok(r.ok, `${n} rejoint`);
  }
  const socks = [a, b, c, d];
  const starts4 = Promise.all(socks.map(s => waitFor(s, 'game:start')));
  a.emit('room:start');
  const gs4 = await starts4;
  ok(gs4.every(g => g.mode === 'elimination'), '4 joueurs (amis) → mode élimination');
  ok(gs4.every(g => g.snapshot.players.length === 4), 'les 4 clients reçoivent la manche à 4');
  ok(new Set(gs4[0].snapshot.players.map(p => p.color)).size === 4, '4 couleurs distinctes');
  const map4 = mapOf(gs4[0]);
  const gy4 = map4.ground.y;
  const positions = [[100, gy4], [400, gy4], [700, gy4], [1100, gy4]];
  socks.forEach((s, i) => s.emit('tag:move', { x: positions[i][0], y: positions[i][1], vx: 0, vy: 0, f: 1 }));
  await sleep(400);
  const sync = await waitFor(d, 'tag:state');
  const xs = sync.players.map(p => Math.round(p.x)).sort((x, y) => x - y);
  ok(JSON.stringify(xs) === JSON.stringify([100, 400, 700, 1100]),
    `les 4 positions sont synchronisées (${xs.join(', ')})`);

  console.log('— déconnexion du it → it réassigné');
  const itNow = sync.itId;
  const itSock4 = socks.find(s => s.id === itNow);
  if (itSock4) {
    const survivor = socks.find(s => s !== itSock4);
    const reassigned = waitFor(survivor, 'tag:tagged');
    itSock4.disconnect();
    const re = await reassigned;
    ok(re.itId && re.itId !== itNow, 'nouveau it choisi après déconnexion du chat');
  } else {
    ok(true, '(it non trouvé parmi les sockets — ignoré)');
  }

  for (const s of socks) { try { s.disconnect(); } catch {} }
  console.log(`\n✅ smoke.mjs : ${passed} vérifications passées`);
  cleanup();
  process.exit(0);
} catch (err) {
  console.error('\n❌ échec :', err.message);
  cleanup();
  process.exit(1);
}
