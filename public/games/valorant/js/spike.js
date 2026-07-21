// Le spike : pose, désamorçage, détonation.
// Machine à états pure, sans Three ni DOM — tourne sous node (voir selftest.js).
//
//   carried --pose 4s sur un site--> planted --mèche 45s--> exploded
//                                       `--désamorçage 7s--> defused

export const PLANT_TIME = 4;
export const FUSE_TIME = 45;
export const DEFUSE_TIME = 7;
export const DEFUSE_CHECKPOINT = 3.5; // au-delà, la progression est acquise
export const BLAST_RADIUS = 8;

export class Spike {
  constructor() { this.reset(); }

  reset() {
    this.state = 'carried';
    this.plant = 0;
    this.defuse = 0;
    this.saved = 0;        // progression de désamorçage acquise au checkpoint
    this.fuse = FUSE_TIME;
    this.pos = null;
    this.blown = false;       // l'explosion n'est jouée qu'une fois
    this.everPlanted = false; // la prime de pose reste due même si le round est perdu
  }

  get planted() { return this.state === 'planted'; }
  get over() { return this.state === 'exploded' || this.state === 'defused'; }

  // Cadence des bips : 1/s, double sous 20 s, triple sous 10 s.
  get beepRate() { return this.fuse <= 10 ? 3 : this.fuse <= 20 ? 2 : 1; }

  // `holding` : la touche d'action est maintenue. `onSite` : le porteur est sur un site.
  // Lâcher ou sortir du site remet la pose à zéro — aucune progression conservée.
  tickPlant(dt, holding, onSite, pos) {
    if (this.state !== 'carried') return;
    if (!holding || !onSite) { this.plant = 0; return; }
    this.plant += dt;
    if (this.plant < PLANT_TIME) return;
    this.state = 'planted';
    this.everPlanted = true;
    this.pos = { x: pos.x, y: pos.y, z: pos.z };
  }

  // Le désamorçage, lui, garde son checkpoint : n'importe quel défenseur peut reprendre.
  tickDefuse(dt, holding) {
    if (this.state !== 'planted') return;
    if (!holding) { this.defuse = this.saved; return; }
    this.defuse += dt;
    if (this.defuse >= DEFUSE_CHECKPOINT) this.saved = DEFUSE_CHECKPOINT;
    if (this.defuse >= DEFUSE_TIME) this.state = 'defused';
  }

  // Mèche. À appeler chaque frame une fois posé.
  tick(dt) {
    if (this.state !== 'planted') return;
    this.fuse -= dt;
    if (this.fuse <= 0) { this.fuse = 0; this.state = 'exploded'; }
  }
}
