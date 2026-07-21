// Indicateur directionnel autour du viseur (prompt 10).
//
// Deux choses, et deux seulement : les dégâts REÇUS (arc rouge, ~1.3 s) et la
// position du spike posé (repère doré, permanent). Rien sur les pas, les tirs
// qui ratent ou les sons — c'est explicitement hors périmètre.
//
// La direction est stockée en coordonnées monde et l'angle recalculé chaque
// frame : l'arc reste ancré sur la source même quand le joueur tourne la tête.
//
// Aucun import : le regard arrive en paramètre, donc `bearing` est vérifiable
// sous node (selftest.js).

const LIFE = 1.3;
const FADE = 0.45; // dernières secondes en fondu

// Angle signé entre le regard et une cible, en degrés horaires (0 = devant,
// +90 = à droite) — c'est exactement ce qu'attend `rotate()` en CSS.
export function bearing(fx, fz, dx, dz) {
  return (Math.atan2(fx * dz - fz * dx, fx * dx + fz * dz) * 180) / Math.PI;
}

export class DamageIndicator {
  constructor(root) {
    root.insertAdjacentHTML('beforeend', '<div id="dmgring"><div class="spike"></div></div>');
    this.el = document.getElementById('dmgring');
    this.spikeEl = this.el.querySelector('.spike');
    this.items = [];
  }

  add(pos) {
    const el = document.createElement('div');
    el.className = 'hitdir';
    this.el.appendChild(el);
    this.items.push({ el, x: pos.x, z: pos.z, left: LIFE });
  }

  // f : direction du regard (Vector3 ou {x,z}), fournie par la boucle de jeu.
  update(dt, f, pos, spike) {
    for (const it of this.items) {
      it.left -= dt;
      if (it.left <= 0) { it.el.remove(); continue; } // pas d'accumulation DOM
      it.el.style.transform = `rotate(${bearing(f.x, f.z, it.x - pos.x, it.z - pos.z)}deg)`;
      it.el.style.opacity = Math.min(1, it.left / FADE);
    }
    this.items = this.items.filter((it) => it.left > 0);

    const on = spike.planted && !!spike.pos;
    this.spikeEl.style.display = on ? '' : 'none';
    if (on) {
      this.spikeEl.style.transform =
        `rotate(${bearing(f.x, f.z, spike.pos.x - pos.x, spike.pos.z - pos.z)}deg)`;
    }
  }
}
