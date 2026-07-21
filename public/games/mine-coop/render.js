/**
 * render.js — rendu Canvas 2D de Mine Coop.
 * - viewport 1280×720 (VIEW) ; le monde fait 4096×256 tuiles → caméra qui suit
 *   le joueur local (lerp + clamp aux bords du monde).
 * - le monde n'est PAS dessiné en entier : seules les tuiles visibles le sont,
 *   lues via view.blockAt(tx,ty) (cache de chunks côté main.js ; -1 = pas encore
 *   reçu). La couleur d'un bloc vient de BLOCK_META[id].color (pas de textures).
 * - ciel jour/nuit : dégradé interpolé depuis dayTime via ambientLight(), plus
 *   un assombrissement en profondeur (grottes) et un voile nocturne.
 * - joueurs (22×44, nom + barre de vie), zombies (verts), surbrillance de la
 *   tuile visée + progression de minage.
 */
import {
  TILE, VIEW, WORLD_PX_W, WORLD_PX_H, WORLD_H,
  BLOCK, BLOCK_META, MINE, GEN, ambientLight
} from '/shared/mine-world.js';

const PW = MINE.playerW, PH = MINE.playerH;
// profondeur (px) à partir de laquelle le fond devient « grotte » sombre
const HORIZON_PX = GEN.seaLevel * TILE;
const CAVE_DARK = '#0a0e1c';

// --- couleurs ciel jour → nuit (interpolées par la lumière ambiante) --------
const SKY_DAY = { top: '#74b9ff', bot: '#cfe9ff' };
const SKY_NIGHT = { top: '#05070f', bot: '#0c1430' };

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a, b, t) {
  const x = hexToRgb(a), y = hexToRgb(b);
  const r = Math.round(x[0] + (y[0] - x[0]) * t);
  const g = Math.round(x[1] + (y[1] - x[1]) * t);
  const bl = Math.round(x[2] + (y[2] - x[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const cam = { x: VIEW.width / 2, y: VIEW.height / 2, init: false };

  function clampCam() {
    cam.x = Math.max(VIEW.width / 2, Math.min(cam.x, WORLD_PX_W - VIEW.width / 2));
    cam.y = Math.max(VIEW.height / 2, Math.min(cam.y, WORLD_PX_H - VIEW.height / 2));
  }

  /** Centre la caméra immédiatement (au spawn / téléportation). */
  function centerOn(x, y) { cam.x = x; cam.y = y - 60; cam.init = true; clampCam(); }
  function getCamera() { return { x: cam.x, y: cam.y }; }
  /** Coord. écran (résolution interne 1280×720) → coord. monde (px). */
  function screenToWorld(sx, sy) {
    return { x: cam.x - VIEW.width / 2 + sx, y: cam.y - VIEW.height / 2 + sy };
  }

  function drawBlock(id, x, y) {
    const m = BLOCK_META[id];
    if (!m || !m.color) return;
    if (id === BLOCK.TORCH) {                       // petite torche (non pleine)
      ctx.fillStyle = '#6b4a2b';
      ctx.fillRect(x + TILE / 2 - 2, y + 10, 4, TILE - 12);
      ctx.fillStyle = m.color;
      ctx.beginPath(); ctx.arc(x + TILE / 2, y + 9, 5, 0, Math.PI * 2); ctx.fill();
      return;
    }
    ctx.fillStyle = m.color;
    ctx.fillRect(x, y, TILE, TILE);
    // relief : liseré clair en haut, ombre en bas (lecture « blocs »)
    ctx.fillStyle = 'rgba(255,255,255,.07)';
    ctx.fillRect(x, y, TILE, 3);
    ctx.fillStyle = m.shade || 'rgba(0,0,0,.18)';
    ctx.fillRect(x, y + TILE - 4, TILE, 4);
    ctx.strokeStyle = 'rgba(0,0,0,.10)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
  }

  function drawBody(x, y, color, f, label, hp, maxHp, now) {
    const left = x - PW / 2, top = y - PH;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(left, top, PW, PH, 6); else ctx.rect(left, top, PW, PH);
    ctx.fill();
    // yeux (direction)
    const dir = f || 1, ey = top + 14;
    for (const off of [-5, 5]) {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(x + off + dir * 2, ey, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#10121f';
      ctx.beginPath(); ctx.arc(x + off + dir * 3, ey, 1.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    // barre de vie
    if (maxHp) {
      const bw = 30, bh = 4, bx = x - bw / 2, by = top - 8;
      const r = Math.max(0, Math.min(1, hp / maxHp));
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
      ctx.fillStyle = r > 0.5 ? '#4fcf5a' : r > 0.25 ? '#f0c23a' : '#e0403f';
      ctx.fillRect(bx, by, bw * r, bh);
    }
    // nom
    if (label) {
      ctx.font = '600 12px Outfit, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.fillStyle = '#eef0ff';
      ctx.strokeText(label, x, top - 14);
      ctx.fillText(label, x, top - 14);
    }
  }

  /**
   * view = {
   *   focus:{x,y}, dayTime, blockAt(tx,ty)->id|-1,
   *   players:[{x,y,f,hp,maxHp,name,color,me}], zombies:[{x,y,f,hp,maxHp}],
   *   aim:{tx,ty,valid}|null, mining:{tx,ty,progress}|null
   * }
   */
  /**
   * Avance la caméra (lerp vers le joueur local, clamp aux bords). À appeler
   * AVANT toute conversion écran↔monde du frame (visée souris, minage) pour que
   * la surbrillance et le rendu partagent EXACTEMENT la même caméra — sinon la
   * tuile visée « retarde » d'une frame quand le joueur bouge.
   */
  function update(focus, dt) {
    if (!focus) return;
    if (!cam.init) { centerOn(focus.x, focus.y); return; }
    const k = 1 - Math.exp(-9 * Math.min(0.05, dt));
    cam.x += (focus.x - cam.x) * k;
    cam.y += ((focus.y - 60) - cam.y) * k;
    clampCam();
  }

  function draw(view) {
    const now = performance.now();
    const amb = ambientLight(view.dayTime ?? 0.3);
    const t = Math.max(0, Math.min(1, (amb - 0.16) / (1 - 0.16))); // 0 nuit, 1 jour

    // ---- ciel (espace écran) : dégradé jour/nuit
    const g = ctx.createLinearGradient(0, 0, 0, VIEW.height);
    g.addColorStop(0, mix(SKY_NIGHT.top, SKY_DAY.top, t));
    g.addColorStop(1, mix(SKY_NIGHT.bot, SKY_DAY.bot, t));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW.width, VIEW.height);

    const camL = cam.x - VIEW.width / 2, camT = cam.y - VIEW.height / 2;
    ctx.save();
    ctx.translate(Math.round(-camL), Math.round(-camT));

    // ---- assombrissement en profondeur (grottes) : voile sombre sous l'horizon
    const top = camT, bottom = camT + VIEW.height;
    if (bottom > HORIZON_PX) {
      const fadeEnd = HORIZON_PX + 26 * TILE;
      const gy = ctx.createLinearGradient(0, HORIZON_PX, 0, fadeEnd);
      gy.addColorStop(0, 'rgba(10,14,28,0)');
      gy.addColorStop(1, CAVE_DARK);
      ctx.fillStyle = gy;
      ctx.fillRect(camL - 8, HORIZON_PX, VIEW.width + 16, Math.max(0, bottom - HORIZON_PX) + 8);
      if (bottom > fadeEnd) { ctx.fillStyle = CAVE_DARK; ctx.fillRect(camL - 8, fadeEnd, VIEW.width + 16, bottom - fadeEnd + 8); }
    }

    // ---- tuiles visibles
    const tx0 = Math.floor(camL / TILE) - 1, tx1 = Math.floor((camL + VIEW.width) / TILE) + 1;
    const ty0 = Math.max(0, Math.floor(camT / TILE) - 1);
    const ty1 = Math.min(WORLD_H - 1, Math.floor((camT + VIEW.height) / TILE) + 1);
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const id = view.blockAt(tx, ty);
        if (id === BLOCK.AIR) continue;            // air = fond (ciel / grotte)
        if (id === -1) {                            // chunk pas encore reçu
          ctx.fillStyle = '#11162a';
          ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
          continue;
        }
        drawBlock(id, tx * TILE, ty * TILE);
      }
    }

    // ---- voile nocturne (sur le décor, sous les entités → joueurs lisibles)
    if (t < 1) {
      ctx.fillStyle = `rgba(4,6,16,${(1 - t) * 0.42})`;
      ctx.fillRect(camL - 8, camT - 8, VIEW.width + 16, VIEW.height + 16);
    }

    // ---- tuile visée + minage
    if (view.aim) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = view.aim.valid ? 'rgba(255,255,255,.85)' : 'rgba(255,90,110,.7)';
      ctx.strokeRect(view.aim.tx * TILE + 1, view.aim.ty * TILE + 1, TILE - 2, TILE - 2);
    }
    if (view.mining) {
      const mx = view.mining.tx * TILE, my = view.mining.ty * TILE;
      ctx.fillStyle = `rgba(0,0,0,${0.15 + view.mining.progress * 0.45})`;
      ctx.fillRect(mx, my, TILE, TILE);
      // barre de progression au-dessus de la tuile
      const p = Math.max(0, Math.min(1, view.mining.progress));
      ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(mx + 3, my - 7, TILE - 6, 4);
      ctx.fillStyle = '#9ef01a'; ctx.fillRect(mx + 3, my - 7, (TILE - 6) * p, 4);
    }

    // ---- zombies
    for (const z of view.zombies) drawBody(z.x, z.y, '#5fae3a', z.f, null, z.hp, z.maxHp ?? 20, now);
    // ---- joueurs (local en dernier, par-dessus)
    const sorted = view.players.slice().sort((a, b) => (a.me ? 1 : 0) - (b.me ? 1 : 0));
    for (const p of sorted) drawBody(p.x, p.y, p.color, p.f, p.name, p.hp, p.maxHp ?? MINE.maxHp, now);

    ctx.restore();
  }

  return { draw, update, centerOn, getCamera, screenToWorld };
}
