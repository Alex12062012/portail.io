import * as THREE from 'three';
import { buildMap, selectMap, siteAt, siteCenter } from './maps/map_loader.js';
import { createCharacterModel, BODY_HEIGHT } from './character.js';
import { AGENTS, AGENT_KEYS, Loadout } from './abilities.js';
import { selectAgent } from './agent_select.js';
import { Effects } from './effects.js';
import { initInput, input } from './input.js';
import { Player } from './player.js';
import { Arsenal, WEAPONS, PEN } from './weapons.js';
import { WeaponView } from './weapon_view.js';
import { Crosshair } from './hud_crosshair.js';
import { Wallet, REWARD } from './economy.js';
import { Spike, BLAST_RADIUS, PLANT_TIME, DEFUSE_TIME } from './spike.js';
import { RoundManager, ROUNDS_TO_WIN, STARTING_ULT_POINTS } from './round_manager.js';
import { BuyMenu } from './buy_menu.js';
import { BotController, reassignRoles, ATK_ROLES, DEF_ROLES } from './bots/bot_controller.js';
import { searchMatch, assignTeams } from './matchmaking.js';
import { selectMode, selectDifficulty, DIFFICULTIES } from './mode_select.js';
import { globalElo, recentElo, record, recordSolo, soloHistory, history } from './skill_tracker.js';
import { Hud } from './ui/hud.js';
import { TeamIndicators } from './ui/team_indicators.js';
import { createDebugHud } from '/shared/debug-hud.js';

const ACTION = 'KeyF'; // pose et désamorçage

// Valorant annonce 103° de FOV *horizontal*, Three attend un FOV vertical : converti au resize.
const H_FOV = 103;

const overlay = document.getElementById('overlay');
overlay.style.display = 'none';
const mode = await selectMode();
const difficulty = mode === '1v3' ? await selectDifficulty() : null;
const mapId = await selectMap();
const agentKey = await selectAgent();

// 1v3 : personne à chercher, donc pas d'écran de recherche — on construit le
// lobby directement. La difficulté choisie remplace l'ELO moyen pour les bots.
// 3v3 : matchmaking et niveau moyen global inchangés.
let lobby, botElo;
if (mode === '1v3') {
  const teams = assignTeams([{ id: 'you', elo: 0 }], [1, 3]);
  lobby = { playerTeam: teams.findIndex((t) => t.humans.some((h) => h.id === 'you')), teams };
  botElo = DIFFICULTIES[difficulty].elo;
} else {
  botElo = globalElo();
  lobby = await searchMatch({
    elo: botElo,
    recent: recentElo(),
    seconds: location.search.includes('test') ? 1 : 15,
  });
}
overlay.style.display = 'grid';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);
scene.fog = new THREE.Fog(0x0d1117, 45, 95);

const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 500);
camera.rotation.order = 'YXZ';
scene.add(camera); // sans ça le modèle d'arme, enfant de la caméra, n'est pas rendu

scene.add(new THREE.AmbientLight(0xffffff, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(12, 30, 6);
scene.add(sun);

const map = await buildMap(mapId, scene);
const { solids, meshes, sites } = map;

// --- Effectif -----------------------------------------------------------------------
// Le joueur est team 0. Chaque acteur porte ses PV, son armure, son portefeuille et
// ses kills du round — c'est ce que RoundManager attend pour payer en fin de round.
const player = new Player(map.spawn);
const loadout = new Loadout(agentKey, STARTING_ULT_POINTS);

const playerActor = {
  name: 'Vous', agentName: AGENTS[agentKey].name, team: lobby.playerTeam,
  pos: player.pos, hp: 100, maxHp: 100, shield: 0,
  alive: true, wallet: new Wallet(), kills: 0, matchKills: 0, matchDeaths: 0, player, loadout,
};
const actors = [playerActor];
const bots = [];

// Les places restantes du 3v3 sont des bots, tous au niveau moyen global (spec).
const pool = AGENT_KEYS.filter((k) => k !== agentKey);
let nextAgent = 0;
for (let team = 0; team < 2; team++) {
  for (let i = 0; i < lobby.teams[team].bots; i++) {
    const key = pool[nextAgent++ % pool.length];
    const model = createCharacterModel(AGENTS[key].color);
    model.userData.head.userData.part = 'h';
    model.userData.body.userData.part = 'b';
    scene.add(model);
    // Deux bots peuvent jouer le même agent : on numérote pour le killfeed/scoreboard.
    const dupes = actors.filter((a) => a.agentName === AGENTS[key].name).length;
    const actor = {
      name: AGENTS[key].name + (dupes ? ` ${dupes + 1}` : ''), agentName: AGENTS[key].name,
      team, pos: model.position, hp: 100, maxHp: 100, shield: 0,
      alive: true, wallet: new Wallet(), kills: 0, model,
    };
    model.userData.actor = actor;
    actors.push(actor);
    bots.push(new BotController(actor, botElo, map.nav));
  }
}

// Tout ce qu'une balle peut toucher. Explicite plutôt que scene.children : le modèle
// d'arme est enfant de la caméra, il ne doit jamais s'auto-toucher. Les capacités y
// ajoutent et retirent leurs objets destructibles (mur de Sage, Recon Bolt, drone).
const hittables = [...meshes];
for (const a of actors) if (a.model) hittables.push(a.model.userData.head, a.model.userData.body);

const spike = new Spike();

function kill(actor, by, via) {
  actor.alive = false;
  actor.hp = 0;
  if (actor.model) actor.model.visible = false;
  actor.loadout?.addUlt(); // mourir charge aussi la jauge d'ultime
  actor.matchDeaths = (actor.matchDeaths ?? 0) + 1;
  if (by && by.team !== actor.team) {
    by.kills++;
    by.matchKills = (by.matchKills ?? 0) + 1;
    by.wallet.add(REWARD.kill);
    by.loadout?.addUlt();
  }
  // Assists : avoir touché la victime dans les 4 dernières secondes, sans la tuer.
  const helpers = new Set();
  for (const h of actor.recentHits ?? []) {
    if (effects.time - h.t < 4 && h.by !== by && h.by.team !== actor.team) helpers.add(h.by);
  }
  for (const h of helpers) h.assists = (h.assists ?? 0) + 1;
  actor.recentHits = [];
  hud.feed.add(by, actor, via);
  succeedRoles(actor.team); // un rôle vacant est repris tout de suite
}

// Réattribue les rôles de l'équipe qui vient de perdre quelqu'un. Uniquement ici :
// pas de recalcul périodique, la mort est le seul événement qui libère un rôle.
function succeedRoles(team) {
  const order = team === rm.attackers ? ATK_ROLES : DEF_ROLES;
  const roster = actors.filter((a) => a.team === team).map((a) => ({ actor: a, role: a.role }));
  for (const [a, role] of reassignRoles(roster, order)) {
    if (a.role === role) continue;
    // Le joueur : on met juste l'étiquette à jour, ses bots allié s'y adaptent.
    if (a.player) a.role = role;
    else bots.find((b) => b.a === a)?.promote(role);
  }
}

// Résurrection de Sage : remet debout sans toucher au score du round.
function revive(actor) {
  actor.alive = true;
  actor.hp = actor.maxHp;
  if (actor.model) actor.model.visible = true;
}

// --- Tir ------------------------------------------------------------------------------

const ray = new THREE.Raycaster();
const dir = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
const origin = new THREE.Vector3();
const shotEnd = new THREE.Vector3(); // point d'arrivée du dernier pellet, pour le tracer
const muzzle = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const LEG_TOP = BODY_HEIGHT * 0.45; // sous cette hauteur relative, c'est une jambe

// Un pellet. Renvoie le premier impact sur une cible, en traversant jusqu'à 2 murs
// si la pénétration de l'arme le permet.
function shootOne(w, coneDeg) {
  camera.getWorldDirection(dir);
  if (coneDeg > 0) {
    right.crossVectors(dir, UP).normalize();
    up.crossVectors(right, dir).normalize();
    const a = Math.random() * Math.PI * 2;
    // sqrt() pour une répartition uniforme sur le disque et non concentrée au centre
    const r = Math.tan((coneDeg * Math.PI) / 180) * Math.sqrt(Math.random());
    dir.addScaledVector(right, r * Math.cos(a)).addScaledVector(up, r * Math.sin(a)).normalize();
  }
  camera.getWorldPosition(origin);

  const penMultiplier = PEN[w.pen];
  const maxWalls = penMultiplier > 0 ? 2 : 0;
  let mult = 1;
  for (let pass = 0; pass <= maxWalls; pass++) {
    ray.set(origin, dir);
    ray.far = w.range ?? 200;
    const hit = ray.intersectObjects(hittables, false).find((h) => h.object.parent.visible);
    if (!hit) { shotEnd.copy(origin).addScaledVector(dir, ray.far); return null; }
    shotEnd.copy(hit.point);

    // Mur de Sage, Recon Bolt, drone : ils encaissent au lieu de laisser passer.
    if (hit.object.userData.destructible) {
      return { destructible: hit.object.userData.destructible, dist: hit.distance, penMult: mult };
    }

    const tag = hit.object.userData.part;
    if (tag) {
      const owner = hit.object.parent;
      const local = hit.point.y - owner.position.y;
      return {
        target: owner.userData.actor,
        part: tag === 'h' ? 'h' : local < LEG_TOP ? 'l' : 'b',
        dist: hit.distance,
        penMult: mult,
      };
    }
    if (pass === maxWalls) return null;
    mult *= penMultiplier;
    // On ressort 0.6 m derrière l'impact : plus épais que n'importe quel mur de la map.
    origin.copy(hit.point).addScaledVector(dir, 0.6);
  }
  return null;
}

// Tracer : une fine ligne qui s'efface en 60 ms. Assez pour lire d'où part une
// balle, pas assez pour transformer un échange en spectacle laser.
const TRACER_MAT = new THREE.LineBasicMaterial({ color: 0xfff2c4, transparent: true, opacity: 0.45 });

function addTracer(from, to) {
  const geo = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
  const line = new THREE.Line(geo, TRACER_MAT);
  scene.add(line);
  // onEnd remplace le retrait par défaut : il faut aussi libérer la géométrie,
  // sinon les buffers WebGL s'accumulent au fil des milliers de tirs d'un match.
  effects.fade(line, 0.06, () => { scene.remove(line); geo.dispose(); });
}

const api = {
  trace(w, deg) {
    const hits = [];
    for (let i = 0; i < (w.pellets ?? 1); i++) {
      const h = shootOne(w, deg + (w.spread ?? 0));
      // Une trace par tir et non par pellet : un shotgun en dessinerait 15.
      if (i === 0) {
        camera.updateMatrixWorld();
        addTracer(view.root.getWorldPosition(muzzle), shotEnd);
      }
      if (h) hits.push(h);
    }
    return hits;
  },
  onHit(hit, dmg, grouped) {
    crosshair.hit();

    if (hit.destructible) {
      const d = hit.destructible;
      d.hp -= dmg;
      if (d.hp <= 0) d.remove();
      return;
    }

    const t = hit.target;
    if (!t || !t.alive || t.team === playerActor.team) return; // pas de tir allié

    effects.hurt(t, dmg, playerActor, arsenal.w.name);

    // Blade Storm : un kill au lancer simple rend un couteau, le lancer groupé non.
    if (!t.alive && arsenal.key === 'bladestorm' && !grouped) {
      arsenal.clip.mag = Math.min(arsenal.clip.mag + 1, WEAPONS.bladestorm.mag);
    }
  },
};

// --- Assemblage -------------------------------------------------------------------------

// Pas d'arme principale au round 1 : elle s'achète au buy menu.
const arsenal = new Arsenal([null, 'classic', 'knife']);
// Déclarés ici, et pas près de resetRound : le constructeur de RoundManager appelle
// resetRound, qui les lit — plus bas, ils seraient encore dans leur zone morte.
let deadLastRound = false;
let botPlan = { site: 'A' }; // site visé par les attaquants bots ce round
let matchRecorded = false;
const view = new WeaponView(camera);
const crosshair = new Crosshair();
const effects = new Effects({
  scene, camera, solids, meshes, hittables, actors, player, arsenal, playerActor, kill, revive,
  onPlayerHurt: (p) => hud.dmg.add(p), // `hud` existe avant le moindre dégât
});
const ctx = effects.ctx();

const aliveCount = (team) => actors.filter((a) => a.team === team && a.alive).length;

const rm = new RoundManager({
  spike,
  players: actors,
  aliveCount,
  resetRound,
  // Le round démarre dès que joueur et bots ont fini d'acheter.
  allReady: () => actors.every((a) => !a.alive || a.ready),
  onRoundEnd: (team) => {
    buy.hide();
    // Les bots de l'équipe perdante montent en niveau (spec : +2 à +5 % par round).
    for (const b of bots) if (b.a.team !== team) b.boost();
  },
});

const buy = new BuyMenu({
  input, canvas: renderer.domElement, wallet: playerActor.wallet, arsenal, loadout, actor: playerActor,
});

view.setWeapon(arsenal.w);
initInput(renderer.domElement, overlay);

// Début de round : tout le monde debout, à son spawn, capacités et armure remises à plat.
// Appelée par le constructeur de RoundManager, donc elle ne doit rien toucher qui soit
// déclaré plus bas — le buy menu s'ouvre depuis la boucle, sur changement de phase.
function resetRound(attackers) {
  loadout.resetRound();
  botPlan = { site: Math.random() < 0.5 ? 'A' : 'B' }; // le site que poussent les bots
  // Index PAR ÉQUIPE : c'est lui qui distribue les rôles (entry/support/lurker
  // côté attaque, anchor/roamer/rotator côté défense).
  // Le joueur occupe le premier siège de SON équipe — une étiquette pour orienter
  // les bots, elle ne change rien à ses contrôles. Ses coéquipiers démarrent donc
  // à 1 ; l'équipe adverse, 100 % bots, garde le comptage depuis 0.
  playerActor.role = (playerActor.team === attackers ? ATK_ROLES : DEF_ROLES)[0];
  const seat = { 0: 0, 1: 0 };
  seat[playerActor.team] = 1;
  for (const b of bots) b.newRound(seat[b.a.team]++, attackers);
  const next = { 0: 0, 1: 0 };
  for (const a of actors) {
    const set = a.team === attackers ? map.spawnAttack : map.spawnDefense;
    const s = set[next[a.team]++ % set.length];
    a.alive = true;
    a.hp = a.maxHp;
    a.ready = false; // chacun redevient « pas prêt » : la phase d'achat reprend
    a.shield = 0; // l'armure se rachète à chaque round
    if (a.model) { a.model.visible = true; a.model.position.set(s.x, s.y, s.z); }
    if (a.player) {
      Object.assign(a.player.pos, { x: s.x, y: s.y, z: s.z });
      a.player.vel.x = a.player.vel.y = a.player.vel.z = 0;
      a.player.yaw = s.yaw;
      a.player.team = a.team;
    }
  }
  // On perd son arme principale en mourant, on la garde en survivant.
  if (deadLastRound) { arsenal.slots[0] = null; arsenal.index = -1; arsenal.equip(1); }
  deadLastRound = false;
}

// --- Spike : visuel et bips ---------------------------------------------------------------

const spikeMesh = new THREE.Mesh(
  new THREE.BoxGeometry(0.4, 0.32, 0.4),
  new THREE.MeshLambertMaterial({ color: 0xd23b3b, emissive: 0x3a0000 }),
);
spikeMesh.visible = false;
scene.add(spikeMesh);

// Bips : un oscillateur, pas d'asset à charger.
let audio = null;
let beepClock = 0;
function beep() {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = 950;
    g.gain.setValueAtTime(0.04, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.08);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.09);
  } catch { /* pas de son disponible : le jeu continue */ }
}

// --- Téléporteurs (Vault) : zone au sol -> sortie liée, à sens unique -----------------

// Son non spatialisé : le whoosh s'entend dans toute la map, comme demandé.
function whoosh() {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.setValueAtTime(220, audio.currentTime);
    o.frequency.exponentialRampToValueAtTime(880, audio.currentTime + 0.25);
    g.gain.setValueAtTime(0.08, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.3);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.3);
  } catch { /* pas de son disponible : le jeu continue */ }
}

function teleFx(t) {
  whoosh();
  const c = { x: (t.zone.min.x + t.zone.max.x) / 2, z: (t.zone.min.z + t.zone.max.z) / 2 };
  for (const p of [c, t.exit]) {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(1.2, 1.2, 3, 16, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x9b6bff, transparent: true, opacity: 0.6, side: THREE.DoubleSide }),
    );
    m.position.set(p.x, 1.5, p.z);
    scene.add(m);
    effects.fade(m, 0.5);
  }
}

function tickTeleports() {
  for (const t of map.teleports) {
    for (const a of actors) {
      const p = a.pos;
      if (!a.alive || p.y > 0.5) continue; // il faut être au sol, sur le pad
      if (p.x < t.zone.min.x || p.x > t.zone.max.x || p.z < t.zone.min.z || p.z > t.zone.max.z) continue;
      Object.assign(p, { x: t.exit.x, y: t.exit.y, z: t.exit.z });
      if (a.player) {
        a.player.yaw = t.exit.yaw;
        a.player.vel.x = a.player.vel.z = 0;
      }
      teleFx(t);
    }
  }
}

function explode() {
  for (const a of actors) {
    if (a.alive && Math.hypot(a.pos.x - spike.pos.x, a.pos.z - spike.pos.z) < BLAST_RADIUS) kill(a, null, 'Spike');
  }
  const boom = new THREE.Mesh(new THREE.SphereGeometry(BLAST_RADIUS, 20, 12),
    new THREE.MeshBasicMaterial({ color: 0xff7a2e, transparent: true, opacity: 0.45 }));
  boom.position.set(spike.pos.x, spike.pos.y + 1, spike.pos.z);
  scene.add(boom);
  effects.fade(boom, 0.6);
}

// --- Observation (mort) ---------------------------------------------------------------
// Caméra 3e personne derrière un allié vivant. Flèches gauche/droite pour changer de
// cible : ni KeyQ/KeyD (strafe + capacité Q) ni les chiffres (armes) ne sont libres.
let specIdx = 0;
let spectating = null;

function spectate() {
  const allies = actors.filter((a) => a.team === playerActor.team && a.alive && a !== playerActor);
  if (!allies.length) { spectating = null; return; } // plus personne : la caméra reste où elle est
  if (input.consumePress('ArrowRight')) specIdx++;
  if (input.consumePress('ArrowLeft')) specIdx--;
  // L'allié observé peut mourir : le modulo rebascule tout seul sur le suivant.
  const t = allies[((specIdx % allies.length) + allies.length) % allies.length];
  spectating = t;

  const yaw = t.model?.rotation.y ?? 0;
  camera.position.set(t.pos.x + Math.sin(yaw) * 3.2, t.pos.y + 2.3, t.pos.z + Math.cos(yaw) * 3.2);
  camera.lookAt(t.pos.x, t.pos.y + 1.3, t.pos.z);
}

// --- Boucle -------------------------------------------------------------------------------

// G fait défiler l'arme principale sur les 18 : de quoi valider les 6 familles
// hors buy phase.
const PRIMARIES = Object.keys(WEAPONS).filter((k) => !['knife', 'bladestorm'].includes(k));

let baseFov = 75;
function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  baseFov = (2 * Math.atan(Math.tan((H_FOV * Math.PI) / 360) / camera.aspect) * 180) / Math.PI;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// --- Minimap : caméra orthographique fixe (nord = -z toujours en haut), incrustée en
// haut à gauche par scissor sur le canvas principal. Le marqueur joueur vit sur le
// layer 1, que seule la caméra de la minimap regarde.
const minimap = (() => {
  const b = map.bounds;
  const half = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2 + 2;
  const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 1, 100);
  cam.position.set(cx, 50, cz);
  cam.up.set(0, 0, -1);
  cam.lookAt(cx, 0, cz);
  cam.layers.enable(1);
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(1.1, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0x3ddc73 }),
  );
  marker.layers.set(1);
  scene.add(marker);
  return { cam, marker };
})();

function renderMinimap() {
  const s = Math.round(Math.min(innerWidth, innerHeight) * 0.22); // suit le 22vmin du CSS
  minimap.marker.position.set(player.pos.x, 30, player.pos.z);
  const fog = scene.fog;
  scene.fog = null; // vue du dessus : pas de brume
  renderer.setScissorTest(true);
  renderer.setScissor(10, innerHeight - s - 10, s, s);
  renderer.setViewport(10, innerHeight - s - 10, s, s);
  renderer.render(scene, minimap.cam);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
  scene.fog = fog;
}

// --- HUD complet (prompt 7) : remplace le HUD texte des prompts 1-6 ---------------
const hud = new Hud({ actors, playerActor, loadout, arsenal, rm, spike, input });
const viewDir = new THREE.Vector3(); // regard courant, pour l'indicateur directionnel
const indicators = new TeamIndicators(document.getElementById('hudRoot'),
  { scene, camera, actors, playerActor, effects, spike, map });

const clock = new THREE.Clock();
let buyShownFor = -1;

// HUD de debug partagé (Tag Arena/Mine Coop). Jeu entièrement local : pas de
// socket, le ping affiche « — » en permanence, c'est attendu.
const debugHud = createDebugHud(null);
debugHud.show();

// Contexte donné aux bots. Une fumée coupe leur vision : distance 2D du centre
// de chaque zone au segment de visée, sous le rayon = bloqué.
function smokeBetween(a, b) {
  for (const z of effects.zones) {
    if (z.o.kind !== 'smoke') continue;
    const dx = b.x - a.x, dz = b.z - a.z;
    const L2 = dx * dx + dz * dz;
    const t = L2 ? Math.min(1, Math.max(0, ((z.pos.x - a.x) * dx + (z.pos.z - a.z) * dz) / L2)) : 0;
    if (Math.hypot(a.x + t * dx - z.pos.x, a.z + t * dz - z.pos.z) < z.o.radius * 0.9) return true;
  }
  return false;
}
const eye = (p) => new THREE.Vector3(p.x, p.y + 1.4, p.z);
const botCtx = {
  spike, solids, sites, actors, siteCenter,
  siteAt: (p) => siteAt(sites, p),
  roleHolder: (team, role) => actors.find((a) => a.team === team && a.alive && a.role === role),
  canSee: (a, b) => !smokeBetween(a, b) && effects.visible(eye(a), eye(b)),
  hurt: (t, n, by, via) => effects.hurt(t, n, by, via),
  dropSmoke: (p) => effects.zone(p, { kind: 'smoke', radius: 4, life: 15 }),
  healOver: (a) => effects.heals.push({ actor: a, rate: 8, left: 5 }),
  tracer: (a, b) => addTracer(eye(a), eye(b)),
};

renderer.setAnimationLoop(() => {
  const workStart = performance.now(); // pour le FPS moteur, mesuré en fin de frame
  const dt = Math.min(clock.getDelta(), 0.05); // évite de traverser un mur après un changement d'onglet

  const wasAlive = playerActor.alive;
  const attacking = playerActor.team === rm.attackers;
  // Le porteur : le joueur s'il attaque et vit, sinon le premier bot attaquant en vie —
  // un round reste ainsi toujours jouable après la mort du joueur.
  const carrier = actors.find((a) => a.team === rm.attackers && a.alive && a.player)
    ?? actors.find((a) => a.team === rm.attackers && a.alive);

  rm.update(dt);
  // Le menu s'ouvre une fois par round : PRÊT le referme sans qu'il revienne.
  // Les bots achètent au même moment, selon leur ELO et leurs crédits.
  if (rm.phase === 'buy' && buyShownFor !== rm.round) {
    buy.show(rm.timer);
    for (const b of bots) b.buyRound();
    buyShownFor = rm.round;
  }
  if (rm.phase !== 'buy') buy.hide();
  else for (const b of bots) b.tickBuy(dt); // les bots se déclarent prêts un à un
  buy.tick(rm.timer);

  if (input.consumePress('KeyG') && !buy.open) {
    const i = PRIMARIES.indexOf(arsenal.slots[0]);
    arsenal.slots[0] = PRIMARIES[(i + 1) % PRIMARIES.length];
    arsenal.reset(arsenal.slots[0]);
    arsenal.index = -1;
    arsenal.equip(0);
  }

  const key = arsenal.key;
  // Pas de capacité tant que le round n'a pas démarré (cf. arsenal.locked plus bas).
  if (!buy.open && rm.phase !== 'buy' && playerActor.alive) loadout.update(dt, input, ctx);

  // Le drone prend la main sur la caméra : le corps de Sova reste sur place, exposé.
  // Mort : on passe en observation d'un allié — `player.pos` n'est pas touché, il sert
  // encore à `deadLastRound` et à la perte de l'arme principale.
  if (effects.drone) effects.driveDrone(dt, input, camera);
  else if (playerActor.alive) player.update(dt, input, solids, camera);
  else spectate();

  // --- Pose / désamorçage ---
  if (rm.live && playerActor.alive && !effects.drone) {
    const holding = input.down(ACTION);
    if (attacking && carrier === playerActor && spike.state === 'carried') {
      const site = siteAt(sites, player.pos);
      const before = spike.planted;
      spike.tickPlant(dt, holding, !!site, player.pos);
      if (holding && site) player.channel = 0.05; // cloué sur place pendant la pose
      if (!before && spike.planted) loadout.addUlt();
    } else if (!attacking && spike.planted
               && Math.hypot(player.pos.x - spike.pos.x, player.pos.z - spike.pos.z) < 2) {
      const before = spike.state;
      spike.tickDefuse(dt, holding);
      if (holding) player.channel = 0.05;
      if (before !== 'defused' && spike.state === 'defused') loadout.addUlt();
    }
  }

  // --- Bots ---
  if (rm.live) {
    const ctx2 = { ...botCtx, attackers: rm.attackers, carrier, plan: botPlan };
    for (const b of bots) b.update(dt, ctx2);
  }

  // Fin de match : une seule écriture, dans l'historique du mode joué. Les deux
  // branches sont exclusives — le 1v3 ne doit jamais peser sur l'ELO global.
  if (rm.phase === 'match' && !matchRecorded) {
    matchRecorded = true;
    const stats = {
      won: rm.winner === playerActor.team,
      kills: playerActor.matchKills,
      deaths: playerActor.matchDeaths,
    };
    if (mode === '1v3') recordSolo({ ...stats, difficulty });
    else record({
      ...stats,
      roundsWon: rm.score[playerActor.team],
      roundsLost: rm.score[1 - playerActor.team],
    });
  }

  tickTeleports();

  // --- Spike : visuel, bips, explosion ---
  spikeMesh.visible = spike.planted;
  if (spike.planted) {
    spikeMesh.position.set(spike.pos.x, spike.pos.y + 0.16, spike.pos.z);
    beepClock += dt * spike.beepRate;
    if (beepClock >= 1) { beepClock -= 1; beep(); }
  }
  if (spike.state === 'exploded' && spike.pos && !spike.blown) { spike.blown = true; explode(); }

  if (wasAlive && !playerActor.alive) deadLastRound = true;

  // Couteaux épuisés : on rend l'arme principale — ou le pistolet s'il n'y en a pas.
  if (arsenal.abilityWeapon && arsenal.clip.mag <= 0) {
    arsenal.equip(arsenal.slots[0] ? 0 : 1);
    loadout.ultWeapon = false;
  }

  // `rm.phase === 'buy'` et pas `buy.open` : fermer le menu avec PRÊT ne doit pas
  // débloquer le tir avant le début officiel du round.
  arsenal.locked = buy.open || rm.phase === 'buy' || !playerActor.alive
    || loadout.equipped >= 0 || !!effects.drone;
  arsenal.update(dt, input, player, api);
  if (arsenal.key !== key) view.setWeapon(arsenal.w);
  view.update(dt, arsenal, player.speed);
  crosshair.update(dt, arsenal.ads ? 0 : arsenal.spread);
  // En observation, l'arme du joueur mort flotterait dans la vue 3e personne.
  view.root.visible = playerActor.alive;
  crosshair.el.style.display = playerActor.alive ? '' : 'none';

  effects.previewWall(loadout.current?.ghost === 'wall');
  effects.update(dt);
  indicators.update(effects.time);

  // Visée : on rétrécit le FOV. Le viseur DOM reste centré, donc rien d'autre à faire.
  const wantFov = arsenal.ads ? baseFov / arsenal.w.zoom : baseFov;
  if (Math.abs(camera.fov - wantFov) > 0.01) {
    camera.fov += (wantFov - camera.fov) * Math.min(20 * dt, 1);
    camera.updateProjectionMatrix();
  }

  // --- HUD : action en cours puis rafraîchissement complet ---
  let action = null;
  if (rm.live && playerActor.alive) {
    if (attacking && carrier === playerActor && spike.state === 'carried') {
      action = siteAt(sites, player.pos)
        ? { label: 'F POUR POSER', pct: (spike.plant / PLANT_TIME) * 100 }
        : { label: 'PORTE LE SPIKE — REJOINS LE SITE A OU B', pct: 0 };
    } else if (!attacking && spike.planted
               && Math.hypot(player.pos.x - spike.pos.x, player.pos.z - spike.pos.z) < 4) {
      action = { label: 'F POUR DÉSAMORCER', pct: (spike.defuse / DEFUSE_TIME) * 100 };
    }
  }
  hud.update({ time: effects.time, dt, action, spectating, dir: camera.getWorldDirection(viewDir) });

  renderer.render(scene, camera);
  renderMinimap();

  debugHud.markFrame(performance.now() - workStart); // → FPS moteur (non plafonné)
});

// ?test : selftest de la logique pure + état exposé pour le smoke navigateur.
// Le pointer lock n'existe pas en headless, d'où `input` accessible de l'extérieur.
if (location.search.includes('test')) {
  // `history` n'est PAS exposé tel quel : window.history est en lecture seule.
  Object.assign(window, {
    input, loadout, effects, player, camera, arsenal, actors, playerActor, rm, spike, buy,
    map, minimap, bots, hud, indicators, mode, difficulty, botElo, ROUNDS_TO_WIN,
    stats: { solo: soloHistory, global: history },
  });
  import('./selftest.js');
}
