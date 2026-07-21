// Viseur dynamique : 4 branches en DOM, écartées par le spread courant.
// DOM plutôt que canvas : c'est 4 divs et une transform, le canvas n'apporterait rien.

const GAP_MIN = 3;   // px, écart minimum au repos
const GAP_MAX = 46;  // px, écart au spread maximum
const SMOOTH = 14;   // lissage de l'écart (le viseur ne saute pas)
const FLASH = 0.12;  // durée du flash de hit, en secondes

const CSS = `
#xh{position:fixed;left:50%;top:50%;z-index:1;pointer-events:none;
    width:0;height:0;color:#4ee1e8;transition:color .05s}
#xh.hit{color:#ffb02e}
#xh i{position:absolute;display:block;background:currentColor;border-radius:1px}
#xh i.v{width:2px;height:9px;margin-left:-1px}
#xh i.h{width:9px;height:2px;margin-top:-1px}
#xh .dot{width:2px;height:2px;margin:-1px 0 0 -1px}`;

export class Crosshair {
  constructor() {
    document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`);
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div id="xh"><i class="v t"></i><i class="v b"></i><i class="h l"></i><i class="h r"></i><i class="dot"></i></div>`,
    );
    this.el = document.getElementById('xh');
    this.arms = ['.t', '.b', '.l', '.r'].map((s) => this.el.querySelector(s));
    this.gap = GAP_MIN;
    this.flash = 0;
  }

  hit() { this.flash = FLASH; }

  // `spreadDeg` vient de Arsenal.spread ; 0 = laser.
  update(dt, spreadDeg) {
    const target = GAP_MIN + Math.min(spreadDeg / 6, 1) * (GAP_MAX - GAP_MIN);
    this.gap += (target - this.gap) * Math.min(SMOOTH * dt, 1);
    const g = this.gap;
    const [t, b, l, r] = this.arms;
    t.style.transform = `translateY(${-g - 9}px)`;
    b.style.transform = `translateY(${g}px)`;
    l.style.transform = `translateX(${-g - 9}px)`;
    r.style.transform = `translateX(${g}px)`;

    this.flash = Math.max(0, this.flash - dt);
    this.el.classList.toggle('hit', this.flash > 0);
  }
}
