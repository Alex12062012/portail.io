/**
 * render.js — rendu Canvas 2D de Tag Arena.
 * - canvas viewport 1280×720 (VIEW), cartes plus grandes : caméra qui suit
 *   le joueur local (lerp + clamp aux bords de la carte)
 * - vue d'ensemble dézoomée (spectateur éliminé / fin de manche)
 * - 5 thèmes visuels procéduraux (dégradés, parallaxe, textures, décors)
 * - FX : pads, téléporteurs, explosions
 * Tous les décors sont dessinés au Canvas (aucun asset externe).
 */
import { VIEW, PHYS } from '/shared/tag-map.js';

const IT_COL = '#ff3355';

// pseudo-aléatoire déterministe (décors stables d'une frame à l'autre)
const hash = n => {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
};

/* --- crêtes/bords de plateforme (PARTIE 0b) --------------------------------
 * Tous dessinés en coordonnées LOCALES : le dessus de la surface est à y=0 et
 * s'étend sur x ∈ [0, W]. Appelés via translate (plateforme) ou translate+
 * rotate (rampe), pour habiller indifféremment plateformes et rampes. */

// forest : chapeau d'herbe épais et arrondi PAR-DESSUS la planche
function capGrass(ctx, W) {
  ctx.fillStyle = '#52b94a';
  ctx.beginPath();
  ctx.moveTo(0, 5);
  ctx.quadraticCurveTo(-1, -9, 13, -9);
  ctx.lineTo(W - 13, -9);
  ctx.quadraticCurveTo(W + 1, -9, W, 5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.18)'; // reflet doux sur le dessus
  ctx.beginPath();
  ctx.moveTo(8, -5);
  ctx.quadraticCurveTo(W / 2, -11, W - 8, -5);
  ctx.quadraticCurveTo(W / 2, -7, 8, -5);
  ctx.closePath();
  ctx.fill();
}

// ice : crête de neige en dents arrondies sur le dessus
function crestSnow(ctx, W) {
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(0, 4);
  const step = 17;
  for (let x = 0; x < W; x += step) {
    ctx.lineTo(Math.min(x + step / 2, W), -7);
    ctx.lineTo(Math.min(x + step, W), 3);
  }
  ctx.lineTo(W, 4);
  ctx.closePath();
  ctx.fill();
}

// space/halloween : remparts crénelés (merlons) lavande/gris sur le dessus
function crestCrenel(ctx, W) {
  ctx.fillStyle = '#b3abdd';
  const merlon = 15, step = 27;
  for (let x = 3; x + merlon <= W; x += step) ctx.fillRect(x, -8, merlon, 12);
}

// volcano/desert : bord INFÉRIEUR déchiré façon roche (dents irrégulières),
// dessiné juste sous la planche (origine locale = bas de la surface).
function edgeRockTorn(ctx, W, col) {
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(0, -2);
  let x = 0;
  while (x < W) {
    const w = 16 + hash(x * 1.7) * 20;
    const d = 9 + hash(x * 3.1) * 16;
    ctx.lineTo(Math.min(x + w / 2, W), d);
    ctx.lineTo(Math.min(x + w, W), -2);
    x += w;
  }
  ctx.lineTo(W, -2);
  ctx.closePath();
  ctx.fill();
}

/* --- décors halloween/space (PARTIE 5), dessinés en silhouette ou posés --- */
function silTower(ctx, x, base, ht) { // tour de château crénelée
  const w = 52;
  ctx.fillRect(x - w / 2, base - ht, w, ht);
  for (let mx = x - w / 2; mx < x + w / 2 - 3; mx += 17) ctx.fillRect(mx, base - ht - 9, 10, 9);
  // tourelle latérale plus fine, toit pointu
  ctx.fillRect(x + w / 2 - 6, base - ht * 0.78, 18, ht * 0.78);
  ctx.beginPath();
  ctx.moveTo(x + w / 2 - 8, base - ht * 0.78);
  ctx.lineTo(x + w / 2 + 3, base - ht * 0.95);
  ctx.lineTo(x + w / 2 + 14, base - ht * 0.78);
  ctx.closePath(); ctx.fill();
}
function silDeadTree(ctx, x, base, col) { // arbre mort tordu
  ctx.save();
  ctx.strokeStyle = col; ctx.lineCap = 'round';
  ctx.lineWidth = 8;
  ctx.beginPath(); ctx.moveTo(x, base); ctx.quadraticCurveTo(x + 12, base - 70, x - 6, base - 135); ctx.stroke();
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(x + 3, base - 88); ctx.quadraticCurveTo(x + 32, base - 98, x + 40, base - 132); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - 4, base - 110); ctx.quadraticCurveTo(x - 30, base - 120, x - 36, base - 152); ctx.stroke();
  ctx.restore();
}
function drawPumpkin(ctx, x, y) { // citrouille (posée au sol)
  ctx.fillStyle = '#5a3a1e'; ctx.fillRect(x - 2, y - 30, 4, 9); // tige
  ctx.fillStyle = '#e8731f';
  ctx.beginPath(); ctx.ellipse(x, y - 13, 17, 13, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#cf6315';
  ctx.beginPath(); ctx.ellipse(x, y - 13, 6, 13, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#3a1d08'; // visage de jack-o'-lantern
  ctx.beginPath(); ctx.moveTo(x - 10, y - 17); ctx.lineTo(x - 4, y - 12); ctx.lineTo(x - 10, y - 11); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x + 10, y - 17); ctx.lineTo(x + 4, y - 12); ctx.lineTo(x + 10, y - 11); ctx.closePath(); ctx.fill();
  ctx.fillRect(x - 7, y - 9, 14, 3);
}
function drawSlime(ctx, x, y, now) { // blob de slime vert posé sur une marche
  const wob = Math.sin(now / 420 + x) * 1.5;
  ctx.fillStyle = '#5fcf63';
  ctx.beginPath();
  ctx.moveTo(x - 15, y);
  ctx.quadraticCurveTo(x - 17, y - 17 - wob, x, y - 17 - wob);
  ctx.quadraticCurveTo(x + 17, y - 17 - wob, x + 15, y);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(x - 5, y - 11, 3, 0, Math.PI * 2); ctx.arc(x + 5, y - 11, 3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#16361a';
  ctx.beginPath(); ctx.arc(x - 5, y - 11, 1.4, 0, Math.PI * 2); ctx.arc(x + 5, y - 11, 1.4, 0, Math.PI * 2); ctx.fill();
}

/* --- décors-repères positionnés (hook theme.scene) -------------------------
 * Dessinés en coordonnées MONDE, posés sur des plateformes/au sol précis d'une
 * carte (palmier, drapeau, bannière, rochers, fissures de lave…). À la
 * différence de doodad() (répété le long du sol) et bg() (parallaxe), scene()
 * place des éléments uniques calés sur l'agencement de la référence. */

// palmier : tronc courbé marron + couronne de palmes vertes en éventail
function drawPalm(ctx, x, base, h = 96) {
  ctx.save();
  ctx.strokeStyle = '#9c6b3f'; ctx.lineCap = 'round'; ctx.lineWidth = 11;
  ctx.beginPath();
  ctx.moveTo(x, base);
  ctx.quadraticCurveTo(x - 14, base - h * 0.6, x + 6, base - h);
  ctx.stroke();
  // anneaux du tronc
  ctx.strokeStyle = 'rgba(80,50,25,.45)'; ctx.lineWidth = 2;
  for (let k = 1; k <= 4; k++) {
    const t = k / 5, tx = x + (-14 * 2 * t * (1 - t)) + 6 * t * t, ty = base - h * t;
    ctx.beginPath(); ctx.moveTo(tx - 6, ty); ctx.lineTo(tx + 6, ty); ctx.stroke();
  }
  // couronne : palmes
  const top = { x: x + 6, y: base - h };
  for (const [ang, len] of [[-2.5, 56], [-1.9, 64], [-1.15, 60], [-0.5, 50], [-3.0, 48]]) {
    ctx.fillStyle = '#3aa64a';
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.quadraticCurveTo(top.x + Math.cos(ang) * len * 0.6, top.y + Math.sin(ang) * len * 0.6 - 10,
      top.x + Math.cos(ang) * len, top.y + Math.sin(ang) * len);
    ctx.quadraticCurveTo(top.x + Math.cos(ang) * len * 0.6, top.y + Math.sin(ang) * len * 0.6 + 6, top.x, top.y);
    ctx.closePath(); ctx.fill();
  }
  ctx.fillStyle = '#2e8b40';
  ctx.beginPath(); ctx.arc(top.x, top.y, 7, 0, Math.PI * 2); ctx.fill();
  // noix de coco
  ctx.fillStyle = '#6e4527';
  ctx.beginPath(); ctx.arc(top.x - 5, top.y + 5, 4, 0, Math.PI * 2); ctx.arc(top.x + 6, top.y + 6, 4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// acacia (savane) : tronc court + canopée ronde verte aplatie
function drawAcacia(ctx, x, base, h = 70) {
  ctx.save();
  ctx.strokeStyle = '#7a5230'; ctx.lineCap = 'round'; ctx.lineWidth = 9;
  ctx.beginPath(); ctx.moveTo(x, base); ctx.lineTo(x, base - h * 0.55); stroke2(ctx, x, base - h * 0.55, x - 22, base - h * 0.8); stroke2(ctx, x, base - h * 0.55, x + 22, base - h * 0.82);
  ctx.restore();
  ctx.fillStyle = '#5aa84e';
  ctx.beginPath(); ctx.ellipse(x, base - h, 52, 22, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#69bd5b';
  ctx.beginPath(); ctx.ellipse(x - 14, base - h - 6, 30, 15, 0, 0, Math.PI * 2); ctx.fill();
}
function stroke2(ctx, x1, y1, x2, y2) { ctx.save(); ctx.strokeStyle = '#7a5230'; ctx.lineCap = 'round'; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.restore(); }

// rocher arrondi (mesa) montant du sol — support des arbres aux extrémités
function drawRock(ctx, x, baseY, w, h) {
  ctx.fillStyle = '#b98b52';
  ctx.beginPath();
  ctx.moveTo(x - w / 2, baseY);
  ctx.quadraticCurveTo(x - w / 2 - 6, baseY - h * 0.7, x - w * 0.25, baseY - h);
  ctx.lineTo(x + w * 0.25, baseY - h);
  ctx.quadraticCurveTo(x + w / 2 + 6, baseY - h * 0.7, x + w / 2, baseY);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#caa067'; // dessus éclairé (plat, herbe sèche)
  ctx.beginPath(); ctx.ellipse(x, baseY - h, w * 0.25, 8, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(120,85,45,.5)'; ctx.lineWidth = 2; // strates
  for (let k = 1; k <= 2; k++) { ctx.beginPath(); ctx.moveTo(x - w / 2 + 6, baseY - h * 0.3 * k); ctx.lineTo(x + w / 2 - 6, baseY - h * 0.3 * k); ctx.stroke(); }
}

// bannière/tapis suspendu(e) : panneau rose, motif bleu central, liseré or,
// 3 gemmes en losange, frange dorée en bas.
function drawBanner(ctx, x, top, w = 56, h = 76) {
  const l = x - w / 2;
  ctx.fillStyle = '#c8851f'; ctx.fillRect(l - 3, top, w + 6, 6);     // barre du haut (or)
  ctx.fillStyle = '#e85a9c'; ctx.fillRect(l, top + 6, w, h);          // panneau rose
  ctx.strokeStyle = '#f4c542'; ctx.lineWidth = 3;                     // liseré or
  ctx.strokeRect(l + 3, top + 9, w - 6, h - 6);
  ctx.fillStyle = '#3a6fd0';                                          // motif bleu central
  ctx.beginPath();
  ctx.moveTo(x, top + 20); ctx.lineTo(x + 14, top + 6 + h / 2); ctx.lineTo(x, top + h - 6); ctx.lineTo(x - 14, top + 6 + h / 2);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#8fd0ff';
  ctx.beginPath(); ctx.arc(x, top + 6 + h / 2, 6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f4c542';                                          // 3 gemmes losange
  for (const gx of [x - 16, x, x + 16]) { ctx.beginPath(); ctx.moveTo(gx, top + 14); ctx.lineTo(gx + 4, top + 19); ctx.lineTo(gx, top + 24); ctx.lineTo(gx - 4, top + 19); ctx.closePath(); ctx.fill(); }
  ctx.fillStyle = '#f4c542';                                          // frange dorée
  for (let fx = l; fx < l + w; fx += 8) { ctx.beginPath(); ctx.moveTo(fx, top + h + 6); ctx.lineTo(fx + 4, top + h + 15); ctx.lineTo(fx + 8, top + h + 6); ctx.closePath(); ctx.fill(); }
}

// pièce/anneau jaune (animé : reflet pulsé)
function drawCoin(ctx, x, y, now) {
  ctx.fillStyle = '#f4c542';
  ctx.beginPath(); ctx.ellipse(x, y, 8, 9, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffe69a';
  ctx.beginPath(); ctx.ellipse(x - 1.5, y - 1.5, 3.5, 4.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#c8851f'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.ellipse(x, y, 8, 9, 0, 0, Math.PI * 2); ctx.stroke();
}

// petit drapeau rouge sur poteau
function drawFlag(ctx, x, base, h = 64) {
  ctx.strokeStyle = '#d8d8e0'; ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x, base); ctx.lineTo(x, base - h); ctx.stroke();
  ctx.fillStyle = '#e0403f';
  ctx.beginPath(); ctx.moveTo(x, base - h); ctx.lineTo(x + 34, base - h + 12); ctx.lineTo(x, base - h + 24); ctx.closePath(); ctx.fill();
}

// veine de lave organique ramifiée, lumineuse (récursive)
function lavaVein(ctx, x, y, dir, depth, len, clampY) {
  if (depth <= 0) return;
  let cx = x, cy = y;
  const seg = 5;
  ctx.beginPath(); ctx.moveTo(cx, cy);
  for (let s = 0; s < seg; s++) {
    dir += (hash(cx * 0.21 + cy * 0.37 + s + depth) - 0.5) * 1.3;
    cx += Math.cos(dir) * (len / seg);
    cy += Math.sin(dir) * (len / seg);
    cy = Math.max(clampY, Math.min(clampY + 34, cy)); // reste dans la bande du sol
    ctx.lineTo(cx, cy);
  }
  ctx.stroke();
  if (hash(x + depth * 3) > 0.35) lavaVein(ctx, cx, cy, dir + 0.9, depth - 1, len * 0.72, clampY);
  if (hash(x * 1.7 + depth) > 0.45) lavaVein(ctx, cx, cy, dir - 1.0, depth - 1, len * 0.7, clampY);
}
function lavaCracks(ctx, map, now) {
  const gy = map.ground.y + 4;
  const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(now / 650));
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < 18; i++) {
    const x0 = 40 + i * (map.width / 18) + hash(i) * 60;
    ctx.shadowColor = `rgba(255,150,40,${0.85 * pulse})`;
    ctx.shadowBlur = 14;
    ctx.lineWidth = 4;
    ctx.strokeStyle = `rgba(255,${150 + Math.floor(70 * pulse)},50,.92)`;
    lavaVein(ctx, x0, gy, hash(i + 5) > 0.5 ? 0.25 : -0.25, 3, 80, gy);
    ctx.shadowBlur = 0; // cœur jaune vif
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = 'rgba(255,240,170,.9)';
    lavaVein(ctx, x0, gy, hash(i + 5) > 0.5 ? 0.25 : -0.25, 2, 80, gy);
  }
  ctx.restore();
}

// cactus (saguaro) posé au sol
function drawCactus(ctx, x, y) {
  ctx.fillStyle = '#4f9e51';
  ctx.beginPath(); ctx.roundRect(x - 7, y - 52, 14, 52, 7); ctx.fill();
  ctx.beginPath(); ctx.roundRect(x - 24, y - 40, 10, 18, 5); ctx.fill();
  ctx.fillRect(x - 24, y - 26, 18, 8);
  ctx.beginPath(); ctx.roundRect(x + 14, y - 34, 10, 16, 5); ctx.fill();
  ctx.fillRect(x + 6, y - 22, 18, 8);
}

// sapin de fond doux/translucide (forêt) — silhouette arrondie pâle
function softPine(ctx, x, base, th, col) {
  ctx.fillStyle = col;
  for (let k = 0; k < 3; k++) {
    const ww = 96 - k * 22, yy = base - th * (0.30 * k);
    ctx.beginPath();
    ctx.moveTo(x - ww / 2, yy);
    ctx.quadraticCurveTo(x, yy - th * 0.62, x + ww / 2, yy);
    ctx.closePath(); ctx.fill();
  }
}

/* ------------------------------------------------------------------ thèmes
 * Chaque thème définit : le ciel, les couleurs sol/plateformes, une couche
 * de parallaxe (bg), le bord thématique des plateformes/rampes (edge, cf.
 * PARTIE 0b), la déco posée sur les plateformes (platDeco) et des objets posés
 * au sol (doodad).
 */
const THEMES = {
  space: { // réf. halloween : nuit violette, château, citrouilles, slime
    sky: ['#2c1656', '#4a2f72'],
    groundBody: '#3c3560', groundTop: '#b3abdd',
    platBody: '#46406e', platTop: '#b3abdd',
    bg(ctx, px, py, w, h, now) {
      // étoiles scintillantes
      for (let i = 0; i < 80; i++) {
        const x = (hash(i) * 1.6 * w - px * 0.25) % (w + 40) - 20;
        const y = hash(i + 50) * h * 0.8;
        ctx.globalAlpha = 0.15 + 0.4 * (0.5 + 0.5 * Math.sin(now / 900 + i));
        ctx.fillStyle = '#ded3ff';
        ctx.fillRect(((x % (w + 40)) + w + 40) % (w + 40) - 20, y, 1.5 + (i % 3), 1.5 + (i % 3));
      }
      ctx.globalAlpha = 1;
      // deux lunes pâles
      for (const [fx, fy, r] of [[0.2, 0.16, 30], [0.85, 0.12, 21]]) {
        const mx = ((w * fx - px * 0.05) % (w + 300) + w + 300) % (w + 300) - 150;
        ctx.save();
        ctx.shadowColor = 'rgba(255,245,205,.55)'; ctx.shadowBlur = 30;
        ctx.fillStyle = '#fdf3c4';
        ctx.beginPath(); ctx.arc(mx, h * fy, r, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      // silhouettes : tours de château + arbres morts tordus (parallaxe)
      const col = '#1c1138';
      ctx.fillStyle = col;
      for (let i = 0; i < 8; i++) {
        const span = w + 520;
        const x = ((i * 330 - px * 0.3) % span + span) % span - 260;
        const base = h * 0.99;
        if (i % 3 === 2) silDeadTree(ctx, x, base, col);
        else silTower(ctx, x, base, 90 + hash(i) * 70);
      }
    },
    edge(ctx, s, now, isGround) { // remparts crénelés (château halloween)
      if (isGround) return;
      ctx.save(); ctx.translate(s.x, s.y); crestCrenel(ctx, s.w); ctx.restore();
    },
    platDeco(ctx, s, now) { // blobs de slime verts sur certaines marches
      if (hash(s.x * 1.7 + s.y) > 0.5) drawSlime(ctx, s.x + s.w * 0.5, s.y, now);
    },
    doodad(ctx, x, y, i) { drawPumpkin(ctx, x, y); } // citrouilles au sol
  },

  forest: {
    sky: ['#cdeedd', '#93d6b0'],
    groundBody: '#8a5a36', groundTop: '#58c24f',
    platBody: '#8a5a36', platTop: '#58c24f',
    bg(ctx, px, py, w, h) {
      // sapins de fond pâles, arrondis, translucides (vert sauge) — adoucis
      ctx.save();
      for (const [f, col, sc, a] of [[0.2, '#bfe0cb', 1.4, 0.55], [0.4, '#a3d2b4', 1, 0.7]]) {
        ctx.globalAlpha = a;
        for (let i = 0; i < 14; i++) {
          const span = w + 300;
          const x = ((i * 230 - px * f) % span + span) % span - 150;
          const th = (140 + hash(i + f * 9) * 130) * sc;
          softPine(ctx, x, h * 0.98, th, col);
        }
      }
      ctx.restore();
    },
    edge(ctx, s, now) { // chapeau d'herbe épais et arrondi par-dessus la planche
      ctx.save(); ctx.translate(s.x, s.y); capGrass(ctx, s.w); ctx.restore();
    },
    scene(ctx, map, now) {
      // palmier en décor sur le cluster élevé gauche
      drawPalm(ctx, map.platforms[0].x + 60, map.platforms[0].y, 100);
      // rangée de ~6 pièces alignées menant à un petit drapeau rouge, côté droit
      const gy = map.ground.y, x0 = map.width - 440;
      for (let i = 0; i < 6; i++) drawCoin(ctx, x0 + i * 52, gy - 34, now);
      drawFlag(ctx, x0 + 6 * 52 + 16, gy);
    },
    doodad(ctx, x, y, i) {
      if (i % 2) { // champignon
        ctx.fillStyle = '#f2f2e8'; ctx.fillRect(x - 4, y - 16, 8, 16);
        ctx.fillStyle = '#e0403f';
        ctx.beginPath(); ctx.arc(x, y - 16, 14, Math.PI, 0); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(x - 6, y - 21, 2.6, 0, Math.PI * 2); ctx.arc(x + 5, y - 19, 2.2, 0, Math.PI * 2); ctx.fill();
      } else { // sapin
        ctx.fillStyle = '#6e4527'; ctx.fillRect(x - 5, y - 18, 10, 18);
        ctx.fillStyle = '#2e8b57';
        for (let k = 0; k < 3; k++) {
          const ww = 52 - k * 14, yy = y - 14 - k * 22;
          ctx.beginPath(); ctx.moveTo(x - ww / 2, yy); ctx.lineTo(x, yy - 30); ctx.lineTo(x + ww / 2, yy); ctx.closePath(); ctx.fill();
        }
      }
    }
  },

  ice: {
    sky: ['#bfe3ff', '#7fb8e8'],
    groundBody: '#7da7c4', groundTop: '#eef8ff',
    platBody: '#a8d8f0', platTop: '#ffffff',
    bg(ctx, px, py, w, h) {
      for (const [f, col] of [[0.18, '#dceefc'], [0.36, '#bcd9ef']]) {
        ctx.fillStyle = col;
        for (let i = 0; i < 8; i++) {
          const span = w + 500;
          const x = ((i * 420 - px * f) % span + span) % span - 250;
          ctx.beginPath();
          ctx.moveTo(x - 180, h);
          ctx.lineTo(x, h * 0.32 + hash(i + f) * 90);
          ctx.lineTo(x + 180, h);
          ctx.closePath(); ctx.fill();
        }
      }
    },
    edge(ctx, s, now, isGround) { // crête de neige zigzag dessus + stalactites dessous
      ctx.save(); ctx.translate(s.x, s.y); crestSnow(ctx, s.w); ctx.restore();
      if (isGround) return;
      ctx.fillStyle = '#cfeafc';
      for (let x = s.x + 14; x < s.x + s.w - 8; x += 40) {
        const len = 8 + hash(x * 7) * 12;
        ctx.beginPath(); ctx.moveTo(x - 4, s.y + s.h); ctx.lineTo(x, s.y + s.h + len); ctx.lineTo(x + 4, s.y + s.h); ctx.closePath(); ctx.fill();
      }
    },
    doodad(ctx, x, y, i) { // bonhomme de neige
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(x, y - 12, 13, 0, Math.PI * 2); ctx.arc(x, y - 32, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1b1d33';
      ctx.beginPath(); ctx.arc(x - 3, y - 34, 1.4, 0, Math.PI * 2); ctx.arc(x + 3, y - 34, 1.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ff8c42';
      ctx.beginPath(); ctx.moveTo(x, y - 31); ctx.lineTo(x + 8, y - 30); ctx.lineTo(x, y - 28); ctx.closePath(); ctx.fill();
    }
  },

  desert: { // réf. : savane quasi blanc-crème, sol plat, rochers aux extrémités
    sky: ['#fdf4e6', '#ffe7c2'],
    groundBody: '#cf9a52', groundTop: '#ecc987',
    platBody: '#c98f4f', platTop: '#ecc987',
    bg(ctx, px, py, w, h) {
      // soleil pâle haut + buttes-mesa lointaines très douces (pas de dunes ondulées)
      ctx.fillStyle = '#fff7df';
      ctx.beginPath(); ctx.arc(w * 0.82 - px * 0.04, h * 0.18, 48, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#f0d3a4';
      for (let i = 0; i < 5; i++) {
        const span = w + 800;
        const x = ((i * 600 - px * 0.16) % span + span) % span - 400;
        const top = h * 0.74, bw = 260;
        ctx.beginPath();
        ctx.moveTo(x - bw, h); ctx.lineTo(x - bw + 30, top); ctx.lineTo(x + bw - 30, top); ctx.lineTo(x + bw, h);
        ctx.closePath(); ctx.fill();
      }
    },
    edge(ctx, s, now, isGround) { // bord inférieur déchiré (roche/sable)
      if (isGround) return;
      ctx.save(); ctx.translate(s.x, s.y + s.h); edgeRockTorn(ctx, s.w, '#a8763d'); ctx.restore();
    },
    scene(ctx, map, now) {
      const gy = map.ground.y;
      // rocher élevé gauche + acacia + bannière suspendue sous la plateforme
      drawRock(ctx, 96, gy, 150, 250);
      drawAcacia(ctx, 96, gy - 244, 72);
      drawBanner(ctx, map.platforms[0].x + map.platforms[0].w / 2, map.platforms[0].y + map.platforms[0].h);
      // pilier rocheux à l'extrême droite + palmier
      const rx = map.width - 80;
      drawRock(ctx, rx, gy, 130, 232);
      drawPalm(ctx, rx, gy - 226, 96);
      // 1 à 2 cactus, positionnés précisément (plus de série répétée)
      drawCactus(ctx, map.width * 0.42, gy);
      drawCactus(ctx, map.width * 0.66, gy);
    }
  },

  volcano: { // réf. : canyon de lave ENSOLEILLÉ, fond crème/jaune, sol à fissures
    sky: ['#f0c9d8', '#ffe6a0'],
    groundBody: '#3a221a', groundTop: '#5a3320',
    platBody: '#a9743f', platTop: '#c79355',
    bg(ctx, px, py, w, h, now) {
      // halo de soleil chaud en haut
      const sx = w * 0.7 - px * 0.04, sy = h * 0.16;
      const g = ctx.createRadialGradient(sx, sy, 10, sx, sy, 260);
      g.addColorStop(0, 'rgba(255,246,210,.9)'); g.addColorStop(1, 'rgba(255,246,210,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sx, sy, 260, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff3d0'; ctx.beginPath(); ctx.arc(sx, sy, 46, 0, Math.PI * 2); ctx.fill();
      // montagnes/buttes lointaines, silhouette sable-orange clair, douces
      for (const [f, col] of [[0.16, '#efb27e'], [0.32, '#e09a5c']]) {
        ctx.fillStyle = col;
        for (let i = 0; i < 7; i++) {
          const span = w + 700;
          const x = ((i * 430 - px * f) % span + span) % span - 350;
          const pk = h * (0.42 + hash(i + f) * 0.12);
          ctx.beginPath();
          ctx.moveTo(x - 230, h);
          ctx.quadraticCurveTo(x - 70, pk + 20, x, pk);
          ctx.quadraticCurveTo(x + 80, pk + 24, x + 230, h);
          ctx.closePath(); ctx.fill();
        }
      }
    },
    edge(ctx, s, now, isGround) { // bord inférieur déchiré (roche de canyon)
      if (isGround) return;
      ctx.save(); ctx.translate(s.x, s.y + s.h); edgeRockTorn(ctx, s.w, '#6e4326'); ctx.restore();
    },
    scene(ctx, map, now) { // réseau de fissures de lave + drapeau sur la colline
      lavaCracks(ctx, map, now);
      drawFlag(ctx, map.platforms[0].x + 30, map.platforms[0].y);
    }
  }
};

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let map = null;
  let theme = THEMES.space;

  const cam = { x: VIEW.width / 2, y: VIEW.height / 2 };
  let lastDraw = performance.now();

  let effects = []; // { kind, ..., t0, dur }
  let banner = null; // { text, t0, size }
  let lobby = null; // texte persistant affiché pendant l'attente (carte + X/4)
  let lobbyGoAt = null; // performance.now() de début de manche → décompte restant

  function setMap(m) {
    map = m;
    theme = THEMES[m.theme] || THEMES.space;
    cam.x = m.width / 2;
    cam.y = m.height / 2;
    effects = [];
    banner = null;
    lobby = null;
    lobbyGoAt = null;
  }

  /**
   * Affiche/efface le bandeau persistant d'attente (carte tirée + nombre de
   * joueurs). Si `goAt` (timestamp performance.now() du début de manche) est
   * fourni, drawLobby() y ajoute le temps restant, recalculé à chaque frame.
   */
  function setLobby(text, goAt) {
    lobby = text || null;
    lobbyGoAt = (lobby && goAt) ? goAt : null;
  }

  function fx(e) {
    if (!map) return;
    const now = performance.now();
    if (e.kind === 'pad') {
      const pad = map.pads[e.id] || map.pads[0];
      effects.push({ kind: 'ring', x: pad.x + pad.w / 2, y: pad.y, t0: now, dur: 450, color: '#ffd60a' });
    } else if (e.kind === 'teleport') {
      for (const tid of [e.from, e.to]) {
        const tp = map.teleporters[tid] || map.teleporters[0];
        effects.push({ kind: 'burst', x: tp.x + tp.w / 2, y: tp.y + tp.h / 2, t0: now, dur: 500, color: '#7c5cff' });
      }
    }
  }

  function boom(x, y) {
    const now = performance.now();
    const parts = Array.from({ length: 26 }, (_, i) => ({
      ang: (i / 26) * Math.PI * 2 + hash(i) * 0.5,
      speed: 140 + hash(i * 3) * 260,
      size: 3 + hash(i * 7) * 5,
      col: ['#ffd166', '#ff8c42', '#ff3355', '#fff'][i % 4]
    }));
    effects.push({ kind: 'boom', x, y: y - PHYS.playerH / 2, t0: now, dur: 950, parts });
  }

  function flash(text, size = 54) {
    banner = { text, t0: performance.now(), size };
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  // ------------------------------------------------------------- monde
  function drawSurface(s, isGround, now) {
    ctx.fillStyle = isGround ? theme.groundBody : theme.platBody;
    roundRect(s.x, s.y, s.w, s.h, isGround ? 0 : 8);
    ctx.fill();
    ctx.fillStyle = isGround ? theme.groundTop : theme.platTop;
    roundRect(s.x, s.y, s.w, Math.min(6, s.h), isGround ? 0 : 8);
    ctx.fill();
    if (isGround) {
      // texture : cailloux/mouchetures déterministes
      ctx.fillStyle = 'rgba(0,0,0,.18)';
      for (let x = 24; x < map.width - 16; x += 64) {
        const r = 3 + hash(x) * 5;
        ctx.beginPath();
        ctx.ellipse(x + hash(x * 2) * 30, s.y + 14 + hash(x * 3) * (s.h - 22), r, r * 0.7, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (theme.edge) theme.edge(ctx, s, now, isGround);
    if (!isGround && theme.platDeco) theme.platDeco(ctx, s, now);
  }

  // rampe diagonale : planche inclinée (corps + liseré + bord thématique de la
  // PARTIE 0b) dessinée dans le repère tourné du segment (x1,y1)->(x2,y2).
  function drawRamp(r, now) {
    const T = 14;
    const ang = Math.atan2(r.y2 - r.y1, r.x2 - r.x1);
    const len = Math.hypot(r.x2 - r.x1, r.y2 - r.y1);
    ctx.save();
    ctx.translate(r.x1, r.y1);
    ctx.rotate(ang);
    ctx.fillStyle = theme.platBody;
    ctx.fillRect(0, 0, len, T);
    ctx.fillStyle = theme.platTop;
    ctx.fillRect(0, 0, len, 4);
    if (theme.edge) theme.edge(ctx, { x: 0, y: 0, w: len, h: T }, now, false);
    ctx.restore();
  }

  function drawGroundDoodads(now) {
    if (!theme.doodad) return;
    for (let i = 0; i < Math.floor(map.width / 420); i++) {
      const x = 180 + i * 420 + hash(i * 13) * 160;
      // pas de doodad sur les pads/téléporteurs
      const blocked = [...map.pads, ...map.teleporters].some(z => x > z.x - 60 && x < z.x + z.w + 60);
      if (!blocked) theme.doodad(ctx, x, map.ground.y, i, now);
    }
  }

  function drawPad(pad, now) {
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    roundRect(pad.x, pad.y + 6, pad.w, pad.h - 6, 4);
    ctx.fill();
    ctx.fillStyle = '#ffd60a';
    roundRect(pad.x, pad.y, pad.w, 8, 4);
    ctx.fill();
    const phase = (now / 600) % 1;
    for (let i = 0; i < 2; i++) {
      const p = (phase + i * 0.5) % 1;
      const cy = pad.y - 6 - p * 26;
      ctx.globalAlpha = (1 - p) * 0.8;
      ctx.strokeStyle = '#ffd60a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(pad.x + pad.w / 2 - 10, cy + 6);
      ctx.lineTo(pad.x + pad.w / 2, cy);
      ctx.lineTo(pad.x + pad.w / 2 + 10, cy + 6);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // PARTIE 0 : icône de tourbillon/spirale circulaire posée À PLAT sur la
  // surface (disque en perspective) — anneau orange/rouge, spirale cyan qui
  // tourne. Remplace l'ancienne capsule violette verticale, sur les 5 cartes.
  function drawTeleporter(tp, now) {
    const cx = tp.x + tp.w / 2;
    const cy = tp.y + tp.h - 15;   // posé sur la surface (la boîte touche le sol)
    const rx = 30, ry = 17;        // disque aplati (vue de dessus inclinée)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);         // aplatit le cercle en ellipse "au sol"
    // halo + anneau extérieur orange/rouge
    ctx.save();
    ctx.shadowColor = 'rgba(110,170,255,.85)';
    ctx.shadowBlur = 16;
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#ff7a3c';
    ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffd166';
    ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.stroke();
    // fond sombre du portail
    ctx.fillStyle = '#0e1b40';
    ctx.beginPath(); ctx.arc(0, 0, rx - 4, 0, Math.PI * 2); ctx.fill();
    // spirale cyan/bleu (2 bras) qui tourne
    ctx.rotate(now / 650);
    ctx.lineCap = 'round';
    for (let arm = 0; arm < 2; arm++) {
      ctx.beginPath();
      for (let t = 0; t <= 1.001; t += 0.06) {
        const a = arm * Math.PI + t * Math.PI * 2.3;
        const rr = (rx - 6) * t;
        const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
        if (t === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = arm ? '#5fd0ff' : '#c7f2ff';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.fillStyle = '#eafdff'; // cœur lumineux
    ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawPlayer(p, now, mode) {
    const { x, y } = p;
    const w = PHYS.playerW, h = PHYS.playerH;
    ctx.save();
    if (p.imm) ctx.globalAlpha = 0.45 + 0.3 * Math.sin(now / 60);
    if (p.it) { ctx.shadowColor = IT_COL; ctx.shadowBlur = 22; }
    ctx.fillStyle = p.color;
    roundRect(x - w / 2, y - h, w, h, w / 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    if (p.it) {
      ctx.strokeStyle = IT_COL;
      ctx.lineWidth = 3.5;
      roundRect(x - w / 2, y - h, w, h, w / 2);
      ctx.stroke();
    }
    const f = p.f || 1;
    const ey = y - h + 15;
    for (const off of [-6, 6]) {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(x + off + f * 3, ey, 5.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1b1d33';
      ctx.beginPath(); ctx.arc(x + off + f * 5, ey, 2.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    // anneau d'immunité bien visible (vient d'être taggé / vient de rejoindre)
    if (p.imm) {
      ctx.save();
      ctx.globalAlpha = 0.55 + 0.35 * Math.sin(now / 90);
      ctx.strokeStyle = '#9affc6';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 5]);
      ctx.lineDashOffset = -now / 35;
      roundRect(x - w / 2 - 4, y - h - 4, w + 8, h + 8, w / 2 + 4);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    ctx.font = '600 13px Outfit, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = p.me ? '#ffffff' : 'rgba(238, 240, 255, .85)';
    ctx.strokeStyle = 'rgba(0,0,0,.5)';
    ctx.lineWidth = 3;
    const label = (p.bot ? '🤖 ' : '') + p.name;
    ctx.strokeText(label, x, y - h - 10);
    ctx.fillText(label, x, y - h - 10);

    if (p.it) {
      const bob = Math.sin(now / 150) * 3;
      const ty = y - h - 30 + bob;
      ctx.fillStyle = IT_COL;
      ctx.beginPath();
      ctx.moveTo(x - 9, ty - 10);
      ctx.lineTo(x + 9, ty - 10);
      ctx.lineTo(x, ty);
      ctx.closePath();
      ctx.fill();
      if (mode === 'elimination') { // la bombe au-dessus du condamné
        ctx.font = '20px sans-serif';
        ctx.fillText('💣', x, ty - 16);
      }
    }
  }

  function drawEffect(e, now) {
    const p = (now - e.t0) / e.dur;
    if (e.kind === 'ring') {
      ctx.globalAlpha = 1 - p;
      ctx.strokeStyle = e.color;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(e.x, e.y, 8 + p * 46, 0, Math.PI * 2); ctx.stroke();
    } else if (e.kind === 'burst') {
      ctx.globalAlpha = (1 - p) * 0.9;
      ctx.fillStyle = e.color;
      ctx.beginPath(); ctx.arc(e.x, e.y, 4 + p * 40, 0, Math.PI * 2); ctx.fill();
    } else if (e.kind === 'boom') {
      if (p < 0.18) { // flash blanc
        ctx.globalAlpha = (1 - p / 0.18) * 0.9;
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(e.x, e.y, 30 + p * 260, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = Math.max(0, 1 - p);
      ctx.strokeStyle = '#ff8c42';
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(e.x, e.y, 10 + p * 130, 0, Math.PI * 2); ctx.stroke();
      const t = p * (e.dur / 1000);
      for (const part of e.parts) {
        const px = e.x + Math.cos(part.ang) * part.speed * t;
        const py = e.y + Math.sin(part.ang) * part.speed * t + 500 * t * t;
        ctx.fillStyle = part.col;
        ctx.fillRect(px - part.size / 2, py - part.size / 2, part.size, part.size);
      }
      ctx.globalAlpha = 1;
    }
    ctx.globalAlpha = 1;
  }

  function drawWorld(now, view, viewL, viewR) {
    const vis = s => s.x + s.w >= viewL - 60 && s.x <= viewR + 60;
    drawSurface(map.ground, true, now);
    drawGroundDoodads(now);
    for (const pl of map.platforms) if (vis(pl)) drawSurface(pl, false, now);
    if (map.ramps) for (const r of map.ramps) drawRamp(r, now);
    if (theme.scene) theme.scene(ctx, map, now);
    for (const pad of map.pads) if (vis(pad)) drawPad(pad, now);
    for (const tp of map.teleporters) drawTeleporter(tp, now);
    for (const p of view.players) drawPlayer(p, now, view.mode);
    effects = effects.filter(e => now - e.t0 < e.dur);
    for (const e of effects) drawEffect(e, now);
  }

  // ------------------------------------------------------------- UI écran
  function drawCountdown(view, now) {
    const elim = view.mode === 'elimination';
    // élimination : la dernière seconde (palier "💣 1s") dure 1,3 s pour
    // coïncider avec la fin du SFX bomb.m4a (cf. lastSecondExtraMs côté serveur,
    // qui rallonge le cycle réel à 30,3 s). Au-dessus de 1,3 s on retire le
    // 0,3 s d'extra avant d'arrondir, pour garder 30, 29, …, 2 à 1,0 s chacun.
    const t = view.t;
    const s = elim
      ? (t > 1.3 ? Math.ceil(t - 0.3) : (t > 0 ? 1 : 0))
      : Math.max(0, Math.ceil(t));
    const urgent = s <= (elim ? 3 : 10);
    const scale = urgent ? 1 + 0.07 * Math.sin(now / 110) : 1;
    ctx.save();
    ctx.translate(VIEW.width / 2, 40);
    ctx.scale(scale, scale);
    ctx.fillStyle = 'rgba(8, 10, 22, .7)';
    roundRect(elim ? -88 : -56, -26, elim ? 176 : 112, 50, 12);
    ctx.fill();
    ctx.font = "800 28px 'Bungee', Outfit, sans-serif";
    ctx.textAlign = 'center';
    ctx.fillStyle = urgent ? IT_COL : '#eef0ff';
    if (elim) {
      ctx.fillText(`💣 ${s}s`, 0, 11);
    } else {
      const mm = Math.floor(s / 60), ss = String(s % 60).padStart(2, '0');
      ctx.fillText(`${mm}:${ss}`, 0, 11);
    }
    ctx.restore();
    if (elim) {
      ctx.font = '600 14px Outfit, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(238,240,255,.75)';
      ctx.fillText('Prochaine explosion', VIEW.width / 2, 82);
    }
  }

  /**
   * Bandeau persistant d'attente : carte tirée au sort + compteur de joueurs,
   * suivi du temps restant avant le début de la manche (recalculé chaque frame
   * depuis lobbyGoAt). Ex. : "🗺️ Forêt de Wello — 3/4 — Début dans 4s".
   */
  function drawLobby(now) {
    let text = lobby;
    if (lobbyGoAt != null) {
      const s = Math.max(0, Math.ceil((lobbyGoAt - now) / 1000));
      text = `${lobby} — Début dans ${s}s`;
    }
    ctx.save();
    ctx.translate(VIEW.width / 2, 40);
    ctx.font = "800 22px 'Bungee', Outfit, sans-serif";
    ctx.textAlign = 'center';
    const w = ctx.measureText(text).width + 56;
    ctx.fillStyle = 'rgba(8, 10, 22, .7)';
    roundRect(-w / 2, -26, w, 50, 12);
    ctx.fill();
    const pulse = 0.85 + 0.15 * Math.sin(now / 400);
    ctx.fillStyle = `rgba(238, 240, 255, ${pulse})`;
    ctx.fillText(text, 0, 8);
    ctx.restore();
  }

  function drawBanner(now) {
    const age = now - banner.t0;
    if (age > 1800) { banner = null; return; }
    const a = age < 200 ? age / 200 : age > 1400 ? 1 - (age - 1400) / 400 : 1;
    ctx.save();
    ctx.globalAlpha = Math.max(0, a);
    ctx.font = `800 ${banner.size}px 'Bungee', Outfit, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = IT_COL;
    ctx.shadowColor = IT_COL;
    ctx.shadowBlur = 30;
    ctx.fillText(banner.text, VIEW.width / 2, 250);
    ctx.restore();
  }

  /**
   * view = { players, t, mode, focus:{x,y}|null, overview:boolean }
   * - focus  : position suivie par la caméra (joueur local)
   * - overview : vue d'ensemble dézoomée de toute la carte
   */
  function draw(view) {
    if (!map) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastDraw) / 1000);
    lastDraw = now;

    // ---- ciel (espace écran)
    const g = ctx.createLinearGradient(0, 0, 0, VIEW.height);
    g.addColorStop(0, theme.sky[0]);
    g.addColorStop(1, theme.sky[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW.width, VIEW.height);

    if (view.overview) {
      const scale = Math.min(VIEW.width / map.width, VIEW.height / map.height);
      const ox = (VIEW.width - map.width * scale) / 2;
      const oy = (VIEW.height - map.height * scale) / 2;
      theme.bg(ctx, map.width / 2, 0, VIEW.width, VIEW.height, now);
      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(scale, scale);
      drawWorld(now, view, 0, map.width);
      // anneaux de repérage des joueurs (lisibles malgré le dézoom)
      for (const p of view.players) {
        ctx.strokeStyle = p.it ? IT_COL : p.color;
        ctx.lineWidth = 4 / scale;
        ctx.beginPath();
        ctx.arc(p.x, p.y - PHYS.playerH / 2, 36, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    } else {
      // ---- caméra : lerp vers le focus, clamp aux bords
      if (view.focus) {
        const tx = Math.min(Math.max(view.focus.x, VIEW.width / 2), map.width - VIEW.width / 2);
        const ty = Math.min(Math.max(view.focus.y - 60, VIEW.height / 2), map.height - VIEW.height / 2);
        const k = 1 - Math.exp(-8 * dt);
        cam.x += (tx - cam.x) * k;
        cam.y += (ty - cam.y) * k;
      }
      theme.bg(ctx, cam.x, cam.y, VIEW.width, VIEW.height, now);
      ctx.save();
      ctx.translate(Math.round(VIEW.width / 2 - cam.x), Math.round(VIEW.height / 2 - cam.y));
      drawWorld(now, view, cam.x - VIEW.width / 2, cam.x + VIEW.width / 2);
      ctx.restore();
    }

    if (!view.noHud) {
      if (lobby) drawLobby(now); // attente : carte tirée + X/4 (pas de chrono)
      else drawCountdown(view, now);
    }
    if (banner) drawBanner(now);
  }

  return { draw, fx, flash, boom, setMap, setLobby };
}
