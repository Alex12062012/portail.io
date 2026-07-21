// Clavier + souris (pointer lock).
//
// AZERTY : `event.code` désigne la POSITION physique de la touche sur un clavier US.
// Le bloc ZQSD d'un AZERTY occupe la position de WASD, donc il remonte déjà en
// KeyW/KeyA/KeyS/KeyD. Rien à détecter, rien à remapper : les deux layouts marchent.

const keys = new Set();
const pressed = new Set(); // fronts montants, consommés à la demande
const buttons = new Set();
const clicked = new Set();

export const input = {
  mx: 0,
  my: 0,
  locked: false,
  menu: false, // un overlay (buy menu) a la main : le curseur lui appartient
  down: (code) => keys.has(code),
  consumePress: (code) => pressed.delete(code), // true une seule fois par appui
  mouse: (btn) => buttons.has(btn),
  consumeClick: (btn) => clicked.delete(btn),   // idem, pour le tir semi-auto
  consumeMouse() {
    const d = { x: this.mx, y: this.my };
    this.mx = this.my = 0;
    return d;
  },
};

export function initInput(canvas, overlay) {
  addEventListener('keydown', (e) => {
    if (!keys.has(e.code)) pressed.add(e.code);
    keys.add(e.code);
    // Tab = scoreboard maintenu, flèches = changement de cible en observation :
    // le navigateur ne doit ni déplacer le focus ni faire défiler la page.
    if (e.code === 'Space' || e.code === 'Tab' || e.code.startsWith('Arrow')
        || e.code.startsWith('Control')) e.preventDefault();
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => { keys.clear(); pressed.clear(); buttons.clear(); }); // rien de coincé

  addEventListener('mousedown', (e) => {
    if (!input.locked) return;
    if (!buttons.has(e.button)) clicked.add(e.button);
    buttons.add(e.button);
  });
  addEventListener('mouseup', (e) => buttons.delete(e.button));
  addEventListener('contextmenu', (e) => e.preventDefault()); // clic droit = visée, pas de menu

  // `input.menu` : un overlay a la main (buy menu). On lui laisse le curseur et on
  // ne réaffiche pas l'écran « clic pour jouer » par-dessus.
  document.addEventListener('click', () => {
    if (!input.locked && !input.menu) Promise.resolve(canvas.requestPointerLock()).catch(() => {});
  });
  document.addEventListener('pointerlockchange', () => {
    input.locked = document.pointerLockElement === canvas;
    overlay.style.display = input.locked || input.menu ? 'none' : 'grid';
  });
  document.addEventListener('mousemove', (e) => {
    if (!input.locked) return;
    input.mx += e.movementX;
    input.my += e.movementY;
  });
}
