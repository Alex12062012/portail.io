// Modèle d'arme en vue FPS : 3 boîtes (carcasse, canon, chargeur) accrochées à la caméra.
// Silhouette dérivée de la classe d'arme — assez pour distinguer un pistolet d'un Odin.
import * as THREE from 'three';

// [longueur carcasse, longueur canon, rayon canon, hauteur chargeur]
const SHAPE = {
  pistol:  [0.16, 0.10, 0.022, 0.10],
  smg:     [0.26, 0.16, 0.024, 0.14],
  shotgun: [0.30, 0.30, 0.034, 0.06],
  rifle:   [0.32, 0.26, 0.026, 0.15],
  sniper:  [0.36, 0.40, 0.030, 0.09],
  heavy:   [0.34, 0.30, 0.038, 0.20],
  melee:   [0.06, 0.20, 0.012, 0.04],
};

const HIP = new THREE.Vector3(0.20, -0.15, -0.40);
const AIM = new THREE.Vector3(0, -0.055, -0.28); // en visée : ramené dans l'axe

const MAT_BODY = new THREE.MeshLambertMaterial({ color: 0x2b3038 });
const MAT_METAL = new THREE.MeshLambertMaterial({ color: 0x8a9199 });

export class WeaponView {
  constructor(camera) {
    this.root = new THREE.Group();
    this.root.position.copy(HIP);
    camera.add(this.root);
    this.parts = null;
    this.bobPhase = 0;
  }

  setWeapon(w) {
    if (this.parts) this.root.remove(this.parts);
    const [bl, ln, br, mh] = SHAPE[w.class] ?? SHAPE.rifle;
    const g = new THREE.Group();

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.075, bl), MAT_BODY);
    body.position.z = -bl / 2;

    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(br, br, ln, 8),
      w.class === 'melee' ? MAT_METAL : MAT_BODY,
    );
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.012, -bl - ln / 2);

    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.045, mh, 0.06), MAT_METAL);
    mag.position.set(0, -0.035 - mh / 2, -bl * 0.55);

    g.add(body, barrel, mag);
    this.mag = mag;
    this.magY = mag.position.y;
    this.parts = g;
    this.root.add(g);
  }

  // `arsenal` fournit kick (0→1 après un tir), reloading et ads.
  update(dt, arsenal, speed) {
    if (!this.parts) return;
    const k = arsenal.kick;

    // Balancement de marche, deux fois plus lent que le head-bob pour ne pas battre avec lui.
    this.bobPhase += speed * dt;
    const amp = Math.min(speed / 5.5, 1) * 0.012;

    const dest = arsenal.ads ? AIM : HIP;
    this.root.position.lerp(dest, Math.min(18 * dt, 1));
    this.root.position.x += Math.sin(this.bobPhase * 2.5) * amp;
    this.root.position.y += Math.abs(Math.cos(this.bobPhase * 2.5)) * amp * 0.6;

    // Recul visuel : l'arme recule et pique vers le haut.
    this.parts.position.z = k * 0.045;
    this.parts.rotation.x = k * 0.22;

    // Rechargement : l'arme bascule hors du champ et revient, sur toute la durée
    // propre à l'arme (reloadTotal) ; le chargeur tombe puis se replace au milieu.
    const r = arsenal.reloading;
    if (r > 0) {
      const p = 1 - r / (arsenal.reloadTotal || r); // 0 → 1 du début à la fin
      this.parts.rotation.z = Math.sin(p * Math.PI) * 0.9;
      const out = Math.sin(Math.PI * Math.min(Math.max((p - 0.15) / 0.7, 0), 1));
      this.mag.position.y = this.magY - out * 0.1;
    } else {
      this.parts.rotation.z = 0;
      this.mag.position.y = this.magY;
    }
  }
}
