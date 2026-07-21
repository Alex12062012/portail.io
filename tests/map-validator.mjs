/**
 * map-validator.mjs — vérifie qu'une carte de Tag Arena est jouable :
 * dimensions, plateformes dans les bornes, pads posés sur une surface,
 * téléporteurs dont la destination atterrit sur une surface, spawns posés,
 * et surtout : TOUTES les surfaces atteignables depuis le sol (BFS via
 * sauts, bounce pads et téléporteurs, avec les capacités de PHYS).
 */
import { PHYS } from '../shared/tag-map.js';

const JUMP_H = (PHYS.jumpVel ** 2) / (2 * PHYS.gravity); // ≈ 163 px
const RISE_MAX = Math.floor(JUMP_H - 25);                // marge d'atterrissage
const GAP_UP = 100;     // écart horizontal max pour un saut montant
const GAP_FLAT = 220;   // écart max pour un saut à plat / descendant
const HW = PHYS.playerW / 2;

const padHeight = power => (power ** 2) / (2 * PHYS.gravity);

function gapX(a, b) {
  // écart horizontal entre deux intervalles [x, x+w]
  if (a.x + a.w < b.x) return b.x - (a.x + a.w);
  if (b.x + b.w < a.x) return a.x - (b.x + b.w);
  return 0;
}

function onSurface(surfaces, x, y) {
  return surfaces.find(s => Math.abs(s.y - y) < 0.5 && x + HW > s.x && x - HW < s.x + s.w);
}

export function validateMap(map) {
  const errors = [];
  const err = m => errors.push(`[${map.id}] ${m}`);

  // ---- dimensions
  if (!(map.width >= 2400 && map.width <= 3200)) err(`largeur ${map.width} hors [2400, 3200]`);
  if (!(map.height >= 900 && map.height <= 1200)) err(`hauteur ${map.height} hors [900, 1200]`);
  const g = map.ground;
  if (!g || g.x !== 0 || g.w !== map.width || g.y !== map.height - g.h) {
    err('le sol doit couvrir toute la largeur en bas de la carte');
  }

  const surfaces = [{ ...g, ground: true }, ...map.platforms];

  // ---- plateformes dans les bornes + espacement vertical
  for (const p of map.platforms) {
    if (p.x < 0 || p.x + p.w > map.width) err(`plateforme hors bornes x: ${JSON.stringify(p)}`);
    if (p.y < 140) err(`plateforme trop haute (pas de marge de saut): ${JSON.stringify(p)}`);
    if (p.y >= g.y) err(`plateforme sous le sol: ${JSON.stringify(p)}`);
    for (const q of map.platforms) {
      if (p === q) continue;
      const dy = q.y - p.y;
      if (dy > 0 && dy < 70 && gapX(p, q) === 0) {
        err(`plateformes trop proches verticalement (${dy}px): ${JSON.stringify(p)} / ${JSON.stringify(q)}`);
      }
    }
  }

  // ---- rampes (pentes diagonales) : segment (x1,y1)->(x2,y2), x1 < x2,
  // endpoints dans les bornes. Les rampes sont praticables mais ne portent pas
  // l'atteignabilité (chaque plateforme reste joignable par saut/pad/téléport).
  for (const r of map.ramps || []) {
    if ([r.x1, r.y1, r.x2, r.y2].some(v => typeof v !== 'number')) {
      err(`rampe incomplète (x1,y1,x2,y2 requis): ${JSON.stringify(r)}`);
      continue;
    }
    if (!(r.x1 < r.x2)) err(`rampe : x1 doit être < x2: ${JSON.stringify(r)}`);
    for (const [px, py] of [[r.x1, r.y1], [r.x2, r.y2]]) {
      if (px < 0 || px > map.width) err(`rampe hors bornes x: ${JSON.stringify(r)}`);
      if (py < 140 || py > g.y) err(`rampe hors bornes y: ${JSON.stringify(r)}`);
    }
  }

  // ---- pads : >= 2, posés sur une surface
  if (!map.pads || map.pads.length < 2) err('il faut au moins 2 bounce pads');
  for (const pad of map.pads || []) {
    const support = surfaces.find(s =>
      Math.abs(pad.y + pad.h - s.y) < 0.5 && pad.x >= s.x - 4 && pad.x + pad.w <= s.x + s.w + 4);
    if (!support) err(`pad non posé sur une surface: ${JSON.stringify(pad)}`);
    if (!(pad.power >= 900)) err(`pad trop faible (power ${pad.power})`);
  }

  // ---- téléporteurs : exactement 2, destinations posées
  if (!map.teleporters || map.teleporters.length !== 2) {
    err('il faut exactement 2 téléporteurs (une paire)');
  } else {
    for (const tp of map.teleporters) {
      const cx = tp.x + tp.w / 2;
      if (!onSurface(surfaces, cx, tp.y + tp.h)) {
        err(`téléporteur dont la sortie n'est pas posée sur une surface: ${JSON.stringify(tp)}`);
      }
    }
  }

  // ---- spawns : 4, posés
  if (!map.spawns || map.spawns.length !== 4) err('il faut 4 spawns');
  for (const s of map.spawns || []) {
    if (!onSurface(surfaces, s.x, s.y)) err(`spawn dans le vide: ${JSON.stringify(s)}`);
    if (s.x < HW || s.x > map.width - HW) err(`spawn hors bornes: ${JSON.stringify(s)}`);
  }

  // ---- atteignabilité : BFS depuis le sol
  const idx = s => surfaces.indexOf(s);
  const reached = new Set([0]); // 0 = sol
  let frontier = [surfaces[0]];
  while (frontier.length) {
    const next = [];
    for (const a of frontier) {
      for (const b of surfaces) {
        if (reached.has(idx(b))) continue;
        const rise = a.y - b.y; // > 0 = b est plus haut
        const gap = gapX(a, b);
        let ok = false;
        // saut normal
        if (rise <= RISE_MAX && gap <= (rise > 0 ? GAP_UP : GAP_FLAT)) ok = true;
        // bounce pad posé sur a
        if (!ok) {
          for (const pad of map.pads || []) {
            const support = Math.abs(pad.y + pad.h - a.y) < 0.5 &&
              pad.x >= a.x - 4 && pad.x + pad.w <= a.x + a.w + 4;
            if (!support) continue;
            const hPad = padHeight(pad.power);
            const riseFromPad = a.y - b.y;
            const padBox = { x: pad.x - 20, w: pad.w + 40 };
            if (riseFromPad <= hPad - 30 && gapX(padBox, b) <= 200) { ok = true; break; }
          }
        }
        // téléporteur dont la zone est accessible depuis a
        if (!ok && map.teleporters?.length === 2) {
          for (const tp of map.teleporters) {
            const standsOnA = Math.abs(tp.y + tp.h - a.y) < 0.5 &&
              tp.x + tp.w > a.x && tp.x < a.x + a.w;
            if (!standsOnA) continue;
            const dest = map.teleporters[tp.id === 0 ? 1 : 0];
            const landing = onSurface(surfaces, dest.x + dest.w / 2, dest.y + dest.h);
            if (landing === b) { ok = true; break; }
          }
        }
        if (ok) { reached.add(idx(b)); next.push(b); }
      }
    }
    frontier = next;
  }
  for (const s of surfaces) {
    if (!reached.has(idx(s))) err(`surface inatteignable: ${JSON.stringify(s)}`);
  }

  return errors;
}
