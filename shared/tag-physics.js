/**
 * tag-physics.js — pas de simulation d'un joueur de Tag Arena.
 * Module partagé : le client l'utilise pour son joueur local,
 * le serveur l'utilise pour les bots. Même code = même physique.
 * La carte jouée est passée via opts.map (une entrée de MAPS).
 */
import { PHYS } from './tag-map.js';

const HW = PHYS.playerW / 2;
const EPS = 0.01;
// marge verticale pour "coller" un joueur à une rampe (pente) : doit dépasser
// la dénivelée parcourue en un pas horizontal sur la pente la plus raide
// (~moveSpeed*itSpeedMul*dt ≈ 17px à 30 Hz), sinon on décollerait de la pente.
const RAMP_SNAP = 28;

export function createPhysState(x, y) {
  return {
    x, y,              // (x, y) = milieu des pieds
    vx: 0, vy: 0,
    f: 1,              // facing : -1 gauche, 1 droite
    onGround: false,
    coyote: 0,
    jumpBuf: 0,
    tpCooldown: 0,
    jumping: false,    // vitesse ascendante issue d'un saut (et pas d'un pad)
    inTp: false        // encore dans une zone de téléporteur depuis l'arrivée
  };
}

function overlapX(p, rect) {
  return p.x + HW > rect.x && p.x - HW < rect.x + rect.w;
}

function boxOverlap(p, rect) {
  return overlapX(p, rect) && p.y > rect.y && p.y - PHYS.playerH < rect.y + rect.h;
}

/**
 * Avance la simulation d'un joueur de dt secondes (à appeler à 30-60 Hz).
 * input : { left, right, jumpPressed (front montant), jumpHeld (maintenu) }
 * opts  : { map (REQUIS — une entrée de MAPS), speedMul (ex. PHYS.itSpeedMul) }
 * Retourne les événements déclenchés pendant ce pas :
 *   { kind:'jump' } | { kind:'pad', id } | { kind:'teleport', from, to }
 */
export function stepPlayer(p, input, dt, opts = {}) {
  const map = opts.map;
  const events = [];
  const maxSpeed = PHYS.moveSpeed * (opts.speedMul || 1);

  // ---- horizontal
  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  if (dir !== 0) {
    const accel = p.onGround ? PHYS.groundAccel : PHYS.airAccel;
    p.vx += dir * accel * dt;
    p.f = dir;
  } else {
    const fric = (p.onGround ? PHYS.groundFriction : PHYS.airFriction) * dt;
    if (Math.abs(p.vx) <= fric) p.vx = 0;
    else p.vx -= Math.sign(p.vx) * fric;
  }
  if (Math.abs(p.vx) > maxSpeed) p.vx = Math.sign(p.vx) * maxSpeed;
  p.x += p.vx * dt;
  if (p.x < HW) { p.x = HW; p.vx = 0; }
  if (p.x > map.width - HW) { p.x = map.width - HW; p.vx = 0; }

  // ---- timers
  p.coyote = Math.max(0, p.coyote - dt);
  p.jumpBuf = Math.max(0, p.jumpBuf - dt);
  p.tpCooldown = Math.max(0, p.tpCooldown - dt);
  if (input.jumpPressed) p.jumpBuf = PHYS.jumpBuffer;

  // ---- saut (coyote time + jump buffer)
  if (p.jumpBuf > 0 && (p.onGround || p.coyote > 0)) {
    p.vy = -PHYS.jumpVel;
    p.onGround = false;
    p.coyote = 0;
    p.jumpBuf = 0;
    p.jumping = true;
    events.push({ kind: 'jump' });
  }
  // saut écourté si la touche est relâchée pendant la montée
  // (uniquement pour un vrai saut — pas pour la propulsion d'un pad)
  if (!input.jumpHeld && p.jumping && p.vy < -320) p.vy = -320;

  // ---- vertical + atterrissage (sol solide, plateformes one-way)
  p.vy += PHYS.gravity * dt;
  if (p.vy > PHYS.maxFall) p.vy = PHYS.maxFall;
  const prevY = p.y;
  p.y += p.vy * dt;

  const wasGround = p.onGround;
  p.onGround = false;
  if (p.vy >= 0) {
    for (const s of [map.ground, ...map.platforms]) {
      if (!overlapX(p, s)) continue;
      if (prevY <= s.y + EPS && p.y >= s.y) {
        p.y = s.y;
        p.vy = 0;
        p.onGround = true;
        p.jumping = false;
        break;
      }
    }
  }
  // ---- rampes (pentes diagonales) : surface dont le y suit la pente, le long
  // du segment (x1,y1)->(x2,y2). One-way comme les plateformes (franchissable
  // par en dessous : on ne colle que si vy>=0 et qu'on était au-dessus/proche).
  if (p.vy >= 0 && map.ramps) {
    for (const r of map.ramps) {
      if (p.x < r.x1 || p.x > r.x2) continue;
      const sy = r.y1 + (r.y2 - r.y1) * ((p.x - r.x1) / (r.x2 - r.x1));
      if (p.y >= sy - RAMP_SNAP && prevY <= sy + RAMP_SNAP) {
        p.y = sy;
        p.vy = 0;
        p.onGround = true;
        p.jumping = false;
      }
    }
  }

  if (wasGround && !p.onGround) p.coyote = PHYS.coyoteTime;

  // plafond du monde
  if (p.y - PHYS.playerH < 0) {
    p.y = PHYS.playerH;
    if (p.vy < 0) p.vy = 0;
  }

  // ---- bounce pads (propulsion verticale au contact)
  for (const pad of map.pads) {
    if (p.vy >= -1 && boxOverlap(p, pad)) {
      p.vy = -pad.power;
      p.onGround = false;
      p.coyote = 0;
      p.jumping = false; // propulsion non écourtable
      events.push({ kind: 'pad', id: pad.id });
      break;
    }
  }

  // ---- téléporteurs : il faut être SORTI de la zone d'arrivée pour pouvoir
  // re-téléporter (sinon un joueur immobile ferait du ping-pong), avec en plus
  // le cooldown anti aller-retour.
  if (!map.teleporters.some(tp => boxOverlap(p, tp))) p.inTp = false;
  if (!p.inTp && p.tpCooldown <= 0) {
    for (const tp of map.teleporters) {
      if (!boxOverlap(p, tp)) continue;
      const dest = map.teleporters[tp.id === 0 ? 1 : 0];
      p.x = dest.x + dest.w / 2;
      p.y = dest.y + dest.h;
      p.vy = 0;
      p.jumping = false;
      p.inTp = true; // on arrive dans la zone de l'autre téléporteur
      p.tpCooldown = PHYS.teleportCooldown;
      events.push({ kind: 'teleport', from: tp.id, to: dest.id });
      break;
    }
  }

  return events;
}

/** Centre du corps (le tag se mesure centre à centre). */
export function centerOf(p) {
  return { x: p.x, y: p.y - PHYS.playerH / 2 };
}

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
