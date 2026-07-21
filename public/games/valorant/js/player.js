// Contrôleur joueur.
// Mouvement type Source/CS : accélération + friction. Le contre-strafe en sort tout seul,
// pas besoin de code dédié — appuyer dans le sens opposé applique l'accélération contre
// la vélocité et l'annule en ~0.08 s.
// Collisions maison : le joueur est un point testé contre des boîtes gonflées de son rayon.

export const WALK_SPEED = 5.5; // m/s
const CROUCH_MULT = 0.5;
const ACCEL = 12;        // formule Source : accel * dt * wishSpeed appliqué par frame
const AIR_ACCEL = 2;     // contrôle aérien volontairement faible
const FRICTION = 8;
const STOP_SPEED = 3;
const GRAVITY = 22;
const JUMP_SPEED = 6;    // ≈ 0.82 m de hauteur de saut
const RADIUS = 0.35;
const H_STAND = 1.85;
const H_CROUCH = 1.25;
const EYE_DROP = 0.2;    // yeux 20 cm sous le sommet
const STEP_HEIGHT = 0.35; // marche/rampe franchissable sans sauter
const CROUCH_LERP = 10;
const STILL_SPEED = 0.5; // en dessous : considéré immobile
const STILL_TIME = 0.3;  // immobile ce temps-là => précision maximale
const SENSITIVITY = 0.0022; // rad / pixel
const BOB_AMPLITUDE = 0.022;
const BOB_FREQ = 5;

// --- Collisions (fonctions pures, testées dans selftest.js) ---------------------

// Hauteur de la surface haute d'un solide au point (x,z), ou null si hors emprise.
// `r` gonfle l'emprise du rayon du joueur.
export function surfaceY(s, x, z, r = 0) {
  if (x < s.min.x - r || x > s.max.x + r || z < s.min.z - r || z > s.max.z + r) return null;
  if (!s.ramp) return s.max.y;
  const a = s.ramp.axis;
  const p = a === 'x' ? x : z;
  const t = Math.min(Math.max((p - s.min[a]) / (s.max[a] - s.min[a]), 0), 1);
  const u = s.ramp.dir > 0 ? t : 1 - t;
  return s.min.y + u * (s.max.y - s.min.y);
}

// Sol le plus haut supportant le joueur (-Infinity au-dessus du vide).
export function groundHeight(pos, solids) {
  let g = -Infinity;
  for (const s of solids) {
    const y = surfaceY(s, pos.x, pos.z, RADIUS);
    if (y !== null && y <= pos.y + STEP_HEIGHT && y > g) g = y;
  }
  return g;
}

// Le joueur (cylindre rayon RADIUS, hauteur h, pieds en pos.y) traverse-t-il un solide ?
// Une rampe ne bloque que si sa surface est trop haute pour être enjambée : sinon on monte dessus.
export function blocked(pos, solids, h) {
  for (const s of solids) {
    const top = surfaceY(s, pos.x, pos.z, RADIUS);
    if (top === null) continue;
    if (top > pos.y + STEP_HEIGHT && s.min.y < pos.y + h) return true;
  }
  return false;
}

// --- Helpers mouvement ---------------------------------------------------------

function wishDir(input, yaw) {
  const f = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0);
  const r = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0);
  if (!f && !r) return { x: 0, z: 0 };
  const sin = Math.sin(yaw), cos = Math.cos(yaw); // yaw 0 => on regarde -Z
  const x = f * -sin + r * cos;
  const z = f * -cos - r * sin;
  const len = Math.hypot(x, z);
  return { x: x / len, z: z / len };
}

function accelerate(vel, wish, wishSpeed, accel, dt) {
  const current = vel.x * wish.x + vel.z * wish.z;
  const add = wishSpeed - current;
  if (add <= 0) return;
  const a = Math.min(accel * dt * wishSpeed, add);
  vel.x += wish.x * a;
  vel.z += wish.z * a;
}

function friction(vel, dt) {
  const speed = Math.hypot(vel.x, vel.z);
  if (speed < 1e-4) { vel.x = vel.z = 0; return; }
  const drop = Math.max(speed, STOP_SPEED) * FRICTION * dt;
  const k = Math.max(speed - drop, 0) / speed;
  vel.x *= k;
  vel.z *= k;
}

// --- Joueur --------------------------------------------------------------------

export class Player {
  constructor(spawn) {
    this.pos = { x: spawn.x, y: spawn.y, z: spawn.z }; // pieds
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = spawn.yaw ?? 0;
    this.pitch = 0;
    this.height = H_STAND;
    this.grounded = false;
    this.crouching = false;
    this.speed = 0;
    this.spread = 1;  // 0 = précision parfaite, 1 = pire cas
    // Le recul déplace la caméra (comme Valorant/CS) : les balles partent d'où on regarde,
    // donc un seul mécanisme suffit pour dévier à la fois la vue ET le tir. Écrit par Arsenal.
    this.recoilYaw = 0;
    this.recoilPitch = 0;
    this.speedMult = 1; // < 1 quand une arme lourde tire
    this.zoneMult = 1;  // Slow Orb (0.5) ou Stim Beacon (1.1) — écrit par Effects
    this.buff = 1;      // cadence de tir et rechargement (Stim Beacon)
    this.channel = 0;   // incantation en cours (résurrection de Sage) : immobilisé
    this.team = 0;
    this.stillTime = 0;
    this.bobPhase = 0;
    this.headBob = true;
  }

  update(dt, input, solids, camera) {
    if (input.locked) this.look(input);
    if (input.consumePress('KeyB')) this.headBob = !this.headBob;
    this.move(dt, input, solids);
    this.updateSpread(dt);
    this.applyCamera(dt, camera);
  }

  look(input) {
    const m = input.consumeMouse();
    this.yaw -= m.x * SENSITIVITY;
    this.pitch -= m.y * SENSITIVITY;
    const lim = Math.PI / 2 - 0.01;
    this.pitch = Math.min(Math.max(this.pitch, -lim), lim);
  }

  move(dt, input, solids) {
    // Incantation (résurrection de Sage) : cloué sur place, donc vulnérable.
    this.channel = Math.max(0, this.channel - dt);
    const wish = this.channel > 0 ? { x: 0, z: 0 } : wishDir(input, this.yaw);
    this.crouching = input.down('ControlLeft') || input.down('ControlRight');

    // Transition debout <-> accroupi. Pas de test de dégagement au-dessus :
    // rien dans la map de test ne surplombe le joueur.
    const target = this.crouching ? H_CROUCH : H_STAND;
    this.height += (target - this.height) * Math.min(CROUCH_LERP * dt, 1);

    const wishSpeed = WALK_SPEED * (this.crouching ? CROUCH_MULT : 1) * this.speedMult * this.zoneMult;
    const wasGrounded = this.grounded;

    if (this.grounded) {
      friction(this.vel, dt);
      accelerate(this.vel, wish, wishSpeed, ACCEL, dt);
      if (input.down('Space') && this.channel <= 0) { this.vel.y = JUMP_SPEED; this.grounded = false; }
    } else {
      accelerate(this.vel, wish, wishSpeed, AIR_ACCEL, dt);
      this.vel.y -= GRAVITY * dt;
    }

    // Horizontal, un axe à la fois : on glisse le long des murs au lieu de s'y coller.
    for (const axis of ['x', 'z']) {
      const prev = this.pos[axis];
      this.pos[axis] += this.vel[axis] * dt;
      if (blocked(this.pos, solids, this.height)) {
        this.pos[axis] = prev;
        this.vel[axis] = 0;
      }
    }

    // Vertical. Le 2e cas colle le joueur au sol quand il descend une rampe ou une
    // petite marche, sinon il rebondit à chaque frame en descente.
    this.pos.y += this.vel.y * dt;
    const g = groundHeight(this.pos, solids);
    const stepDown = wasGrounded && g > -Infinity && this.pos.y - g <= STEP_HEIGHT;
    if (this.vel.y <= 0 && (this.pos.y <= g || stepDown)) {
      this.pos.y = g;
      this.vel.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }

    this.speed = Math.hypot(this.vel.x, this.vel.z);
  }

  updateSpread(dt) {
    if (this.speed < STILL_SPEED && this.grounded) this.stillTime += dt;
    else this.stillTime = 0;

    let s = Math.min(this.speed / WALK_SPEED, 1);
    if (!this.grounded) s = 1;                    // en l'air : pire cas
    if (this.stillTime >= STILL_TIME) s = 0;      // immobile 0.3 s : précision max
    if (this.crouching) s *= 0.5;
    this.spread = s;
  }

  applyCamera(dt, camera) {
    this.bobPhase += this.speed * dt;
    const amp = Math.min(this.speed / WALK_SPEED, 1) * BOB_AMPLITUDE;
    const bob = this.headBob && this.grounded ? Math.sin(this.bobPhase * BOB_FREQ) * amp : 0;
    camera.position.set(this.pos.x, this.pos.y + this.height - EYE_DROP + bob, this.pos.z);
    camera.rotation.y = this.yaw + this.recoilYaw;
    camera.rotation.x = this.pitch + this.recoilPitch;
  }
}
