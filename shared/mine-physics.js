/**
 * mine-physics.js — pas de simulation d'un corps (joueur ou zombie) de Mine Coop.
 * Module PARTAGÉ : le client l'utilise pour son joueur local, le serveur pour les
 * zombies (et pour clamp/valider). Collisions AABB contre la GRILLE de blocs (via
 * solidAt) — l'analogue de tag-physics.js, mais monde de tuiles au lieu de
 * plateformes. (x, y) = milieu des pieds ; Y croît vers le bas.
 */
import { MINE, TILE, WORLD_PX_W, WORLD_PX_H, solidAt, pxToTileX, pxToTileY } from './mine-world.js';

const HW = MINE.playerW / 2;   // demi-largeur
const PH = MINE.playerH;       // hauteur (haut = y - PH, pieds = y)

export function createPlayerState(x, y) {
  return {
    x, y, vx: 0, vy: 0,
    f: 1,                  // facing : -1 gauche, 1 droite
    onGround: false,
    coyote: 0, jumpBuf: 0,
    hp: MINE.maxHp, maxHp: MINE.maxHp
  };
}

/** L'AABB centrée en (x,y) chevauche-t-elle un bloc solide ? */
function hitsSolid(world, x, y) {
  const tx0 = pxToTileX(x - HW + 0.001), tx1 = pxToTileX(x + HW - 0.001);
  const ty0 = pxToTileY(y - PH + 0.001), ty1 = pxToTileY(y - 0.001);
  for (let tx = tx0; tx <= tx1; tx++)
    for (let ty = ty0; ty <= ty1; ty++)
      if (solidAt(world, tx, ty)) return true;
  return false;
}

/**
 * Avance un corps de dt s. input : { left, right, jumpPressed, jumpHeld }.
 * opts : { world (REQUIS : Uint8Array), speedMul }. Résolution X puis Y contre la
 * grille. Mute l'état et retourne { grounded }.
 */
export function stepPlayer(state, input, dt, opts = {}) {
  const world = opts.world;
  const maxSpeed = MINE.moveSpeed * (opts.speedMul || 1);

  // ---- horizontal (accel / friction — même modèle que tag)
  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  if (dir !== 0) {
    state.vx += dir * (state.onGround ? MINE.groundAccel : MINE.airAccel) * dt;
    state.f = dir;
  } else {
    const fric = (state.onGround ? MINE.groundFriction : MINE.airFriction) * dt;
    state.vx = Math.abs(state.vx) <= fric ? 0 : state.vx - Math.sign(state.vx) * fric;
  }
  if (Math.abs(state.vx) > maxSpeed) state.vx = Math.sign(state.vx) * maxSpeed;

  // ---- timers + saut (coyote + buffer)
  state.coyote = Math.max(0, state.coyote - dt);
  state.jumpBuf = Math.max(0, state.jumpBuf - dt);
  if (input.jumpPressed) state.jumpBuf = MINE.jumpBuffer;
  if (state.jumpBuf > 0 && (state.onGround || state.coyote > 0)) {
    state.vy = -MINE.jumpVel; state.onGround = false; state.coyote = 0; state.jumpBuf = 0;
  }
  if (!input.jumpHeld && state.vy < -300) state.vy = -300; // saut écourté

  // ---- résolution X
  let nx = state.x + state.vx * dt;
  nx = Math.max(HW, Math.min(WORLD_PX_W - HW, nx));
  if (!hitsSolid(world, nx, state.y)) {
    state.x = nx;
  } else {
    const tile = pxToTileX(state.vx > 0 ? nx + HW : nx - HW);
    state.x = state.vx > 0 ? tile * TILE - HW - 0.001 : (tile + 1) * TILE + HW + 0.001;
    state.vx = 0;
  }

  // ---- résolution Y (gravité)
  state.vy = Math.min(MINE.maxFall, state.vy + MINE.gravity * dt);
  const wasGround = state.onGround;
  state.onGround = false;
  let ny = state.y + state.vy * dt;
  ny = Math.max(PH, Math.min(WORLD_PX_H, ny));
  if (!hitsSolid(world, state.x, ny)) {
    state.y = ny;
  } else if (state.vy > 0) {                 // atterrissage (pieds sur le sol)
    const tile = pxToTileY(ny);
    state.y = tile * TILE - 0.001;
    state.vy = 0; state.onGround = true;
  } else {                                   // tête contre un plafond
    const tile = pxToTileY(ny - PH);
    state.y = (tile + 1) * TILE + PH + 0.001;
    state.vy = 0;
  }

  if (wasGround && !state.onGround) state.coyote = MINE.coyoteTime;
  return { grounded: state.onGround };
}

/** Chevauchement de deux AABB (px). Utilisé par les dégâts au contact / l'épée. */
export function aabbOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/** AABB d'un corps centré pieds en (x,y) -> { x, y, w, h } (coin haut-gauche). */
export function bodyAabb(x, y) {
  return { x: x - HW, y: y - PH, w: MINE.playerW, h: PH };
}
