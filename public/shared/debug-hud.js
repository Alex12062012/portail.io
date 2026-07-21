/**
 * debug-hud.js — HUD de debug réutilisable (FPS écran + FPS moteur + ping),
 * affiché en haut à gauche de l'écran. Conçu pour être repris tel quel par
 * n'importe quel jeu :
 *
 *   import { createDebugHud } from '/shared/debug-hud.js';
 *   const hud = createDebugHud(socket);   // socket.io déjà connecté
 *   hud.show();                           // pendant la partie
 *   hud.hide();                           // hors partie
 *   hud.markFrame(workMs);                // optionnel : durée réelle de la
 *                                         // frame (update+draw) → FPS moteur
 *
 * - FPS écran  : compté via son propre requestAnimationFrame (plafonné par
 *                le taux de rafraîchissement de l'écran).
 * - FPS moteur : 1000 / temps moyen passé à calculer+dessiner une frame,
 *                rapporté par le jeu via markFrame() — non plafonné.
 * - Ping       : aller-retour socket.io mesuré chaque seconde via un ack
 *                (le serveur répond à l'événement 'hud:ping' via l'ack).
 */
export function createDebugHud(socket, opts = {}) {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed', 'top:8px', 'left:8px', 'z-index:1000',
    'background:rgba(8,10,22,.75)', 'color:#9ef01a',
    'font:12px/1.5 Consolas,Menlo,monospace',
    'padding:6px 10px', 'border-radius:8px',
    'pointer-events:none', 'white-space:pre', 'display:none'
  ].join(';');
  document.body.appendChild(el);

  let frames = 0;
  let fps = 0;
  let lastT = performance.now();
  let ping = null;

  // FPS moteur : moyenne glissante des durées de frame rapportées
  const workTimes = [];
  let engineFps = null;

  function markFrame(workMs) {
    if (!(workMs > 0)) workMs = 0.001;
    workTimes.push(workMs);
    if (workTimes.length > 40) workTimes.shift();
  }

  function render() {
    if (workTimes.length >= 5) {
      const avg = workTimes.reduce((a, b) => a + b, 0) / workTimes.length;
      engineFps = Math.round(1000 / avg);
    }
    el.textContent =
      `FPS écran  ${fps}\n` +
      `FPS moteur ${engineFps == null ? '—' : engineFps}\n` +
      `PING ${ping == null ? '—' : ping + ' ms'}`;
  }

  function raf(t) {
    frames++;
    if (t - lastT >= 500) {
      fps = Math.round((frames * 1000) / (t - lastT));
      frames = 0;
      lastT = t;
      render();
    }
    requestAnimationFrame(raf);
  }
  requestAnimationFrame(raf);

  const pingTimer = setInterval(() => {
    if (!socket || !socket.connected) { ping = null; render(); return; }
    const t0 = performance.now();
    socket.emit('hud:ping', () => {
      ping = Math.round(performance.now() - t0);
      render();
    });
  }, opts.interval ?? 1000);

  render();
  return {
    show() { el.style.display = 'block'; },
    hide() { el.style.display = 'none'; },
    markFrame,
    destroy() { clearInterval(pingTimer); el.remove(); }
  };
}
