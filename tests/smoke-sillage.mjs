/**
 * smoke-sillage.mjs — le relais du free ride de Sillage : serveur réel + 2 clients
 * socket.io simulés. Couvre : CORS pour le domaine Vercel de Sillage, rejoindre
 * une station (roster), recevoir l'état de l'autre (sillage:states), le choc
 * relayé (sillage:bump → sillage:bumped), une autre station isolée, le départ.
 *
 *   node tests/smoke-sillage.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert';
import { io as connect } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3231;
const BASE = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
const ok = (cond, label) => { assert.ok(cond, label); passed++; console.log(`  ✔ ${label}`); };

const server = spawn(process.execPath, ['server/server.js', '--no-tunnel'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', d => process.stderr.write('[server] ' + d));
process.on('exit', () => { try { server.kill(); } catch {} });
for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/')).ok) break; } catch {} await sleep(200); }

const cors = await fetch(`${BASE}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: 'https://sillage-hazel-kappa.vercel.app' } });
ok(cors.headers.get('access-control-allow-origin') === 'https://sillage-hazel-kappa.vercel.app', 'CORS : le domaine Vercel de Sillage est autorisé');
const other = await fetch(`${BASE}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: 'https://example.com' } });
ok(!other.headers.get('access-control-allow-origin'), 'CORS : un autre domaine ne l’est pas');

const client = () => new Promise(res => { const s = connect(BASE, { transports: ['websocket'] }); s.on('connect', () => res(s)); });
const emit = (s, ev, data) => new Promise(res => s.emit(ev, data, res));
const a = await client(), b = await client(), c = await client();

const ja = await emit(a, 'sillage:join', { station: 'avoriaz', name: 'Alex', look: [0xff0000, 0x00ff00, 0x0000ff, 0xffffff] });
ok(ja.ok && ja.skiers.length === 0, 'A rejoint Avoriaz, seul');
const joined = new Promise(res => a.once('sillage:joined', res));
const jb = await emit(b, 'sillage:join', { station: 'avoriaz', name: 'Bob' });
ok(jb.ok && jb.skiers.length === 1 && jb.skiers[0].name === 'Alex' && jb.skiers[0].look[0] === 0xff0000, 'B rejoint et voit A (nom, tenue)');
ok((await joined).name === 'Bob', 'A est prévenu de l’arrivée de B');
const jc = await emit(c, 'sillage:join', { station: 'rousses', name: 'Cleo' });
ok(jc.ok && jc.skiers.length === 0, 'C est seule aux Rousses : les stations sont séparées');
ok(!(await emit(c, 'sillage:join', { station: '../x' })).ok, 'une station au nom invalide est refusée');
await emit(c, 'sillage:join', { station: 'rousses', name: 'Cleo' });

let seenByC = false;
c.on('sillage:states', st => { if (st[a.id]) seenByC = true; });
const statesB = new Promise(res => b.on('sillage:states', st => { if (st[a.id]) res(st); }));
a.emit('sillage:state', [10, 1500, -20, 1.5, 3, 0, 4, 0.2, 0, 2]);
const st = await statesB;
ok(st[a.id][0] === 10 && st[a.id][1] === 1500 && st[a.id][9] === 2, 'B reçoit la position de A (15 Hz)');
await sleep(200);
ok(!seenByC, 'C (autre station) ne la reçoit pas');

const bumped = new Promise(res => b.once('sillage:bumped', res));
a.emit('sillage:bump', { id: b.id, vx: 12, vz: -3 });
const bp = await bumped;
ok(bp.id === a.id && bp.vx === 12, 'le choc vu par A est relayé à B');

const aId = a.id;
const left = new Promise(res => b.once('sillage:left', res));
a.disconnect();
ok((await left) === aId, 'B est prévenu du départ de A');

b.disconnect(); c.disconnect();
console.log(`\nsmoke-sillage : ${passed} vérifications OK`);
process.exit(0);
