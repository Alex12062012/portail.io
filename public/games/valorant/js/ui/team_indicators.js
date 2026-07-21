// Identification alliés/ennemis — la règle centrale du jeu (prompt 7).
//
// - Anneau au pied : cyan allié (visible à travers les murs, comme les silhouettes
//   d'équipiers de Valorant), rouge ennemi (occulté normalement ; traverse les murs
//   uniquement pendant une révélation type Recon Bolt).
// - Étiquette DOM projetée au-dessus de la tête : nom + barre de vie pour les alliés,
//   barre de vie seule et brève (~1 s après l'avoir touché) pour un ennemi.
// - Minimap : point cyan par allié (toujours), rouge par ennemi (seulement s'il est
//   vu du joueur ou révélé), triangle jaune pour le spike posé, contours des sites.
import * as THREE from 'three';

const ALLY = 0x35e0c0, ENEMY = 0xff4d4d, GOLD = 0xffc44d;

export class TeamIndicators {
  // deps : { scene, camera, actors, playerActor, effects, spike, map }
  constructor(root, deps) {
    this.d = deps;
    root.insertAdjacentHTML('beforeend', '<div id="labels"></div>');
    this.labels = document.getElementById('labels');
    this.items = [];

    for (const a of deps.actors) {
      if (a === deps.playerActor) continue;
      const ally = a.team === deps.playerActor.team;

      // anneau au pied, attaché au modèle
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.42, 0.56, 24),
        new THREE.MeshBasicMaterial({ color: ally ? ALLY : ENEMY, transparent: true, opacity: 0.85 }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.04;
      if (ally) { ring.material.depthTest = false; ring.renderOrder = 998; }
      a.model.add(ring);

      // Liseré sur le modèle, en renfort de l'anneau : une copie légèrement plus
      // grande rendue en BackSide, seules ses faces arrière restent visibles.
      // Pas de post-processing pour ça — le projet n'en a pas et n'en veut pas.
      const outMat = new THREE.MeshBasicMaterial({ color: ally ? ALLY : ENEMY, side: THREE.BackSide });
      const out = [a.model.userData.body, a.model.userData.head].map((src) => {
        const m = new THREE.Mesh(src.geometry, outMat);
        m.position.copy(src.position);
        m.scale.setScalar(1.07);
        a.model.add(m);
        return m;
      });

      // étiquette DOM
      const tag = document.createElement('div');
      tag.className = `tag${ally ? '' : ' enemy'}`;
      tag.innerHTML = `${ally ? `<div class="n">${a.name}</div>` : ''}<div class="b"><div></div></div>`;
      this.labels.appendChild(tag);

      // point minimap (layer 1 : seule la caméra de la minimap le voit)
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(1.0, 8, 6),
        new THREE.MeshBasicMaterial({ color: ally ? ALLY : ENEMY }),
      );
      dot.layers.set(1);
      deps.scene.add(dot);

      this.items.push({ a, ally, ring, out, tag, bar: tag.querySelector('.b div'), dot });
    }

    // spike posé : triangle jaune (cylindre à 3 faces vu du dessus)
    this.spikeDot = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 1.5, 0.2, 3),
      new THREE.MeshBasicMaterial({ color: GOLD }),
    );
    this.spikeDot.layers.set(1);
    this.spikeDot.visible = false;
    deps.scene.add(this.spikeDot);

    // contours des sites A/B en surbrillance sur la minimap
    for (const s of deps.map.sites) {
      const w = s.max.x - s.min.x, d = s.max.z - s.min.z;
      const frame = [
        [s.min.x + w / 2, s.min.z, w + 0.6, 0.6], [s.min.x + w / 2, s.max.z, w + 0.6, 0.6],
        [s.min.x, s.min.z + d / 2, 0.6, d + 0.6], [s.max.x, s.min.z + d / 2, 0.6, d + 0.6],
      ];
      for (const [x, z, fw, fd] of frame) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(fw, 0.2, fd),
          new THREE.MeshBasicMaterial({ color: 0x4ee1e8 }));
        m.position.set(x, 29, z);
        m.layers.set(1);
        deps.scene.add(m);
      }
    }

    this.v = new THREE.Vector3();
    this.eyeP = new THREE.Vector3();
    this.eyeA = new THREE.Vector3();
  }

  update(time) {
    const { camera, playerActor, effects, spike } = this.d;

    for (const it of this.items) {
      const a = it.a;
      const revealed = (a.revealedUntil ?? 0) > time;
      // Vu du joueur : ligne de vue directe. Sert à l'anneau ennemi révélé et à la minimap.
      let seen = false;
      if (!it.ally && a.alive) {
        this.eyeP.set(playerActor.pos.x, playerActor.pos.y + 1.4, playerActor.pos.z);
        this.eyeA.set(a.pos.x, a.pos.y + 1.4, a.pos.z);
        seen = revealed || effects.visible(this.eyeP, this.eyeA);
      }

      it.ring.visible = a.alive;
      // Révélation : l'anneau ennemi traverse les murs le temps du reveal.
      if (!it.ally) {
        it.ring.material.depthTest = !revealed;
        it.ring.renderOrder = revealed ? 998 : 0;
      }
      // Liseré ennemi seulement quand il est réellement en vue : il ne doit jamais
      // trahir une position à travers un mur (l'anneau allié, lui, le fait exprès).
      for (const o of it.out) o.visible = a.alive && (it.ally || seen);

      // minimap : allié toujours, ennemi seulement si détecté
      it.dot.visible = a.alive && (it.ally || seen);
      if (it.dot.visible) it.dot.position.set(a.pos.x, 30, a.pos.z);

      // étiquette : allié toujours (dans le champ), ennemi ~1 s après l'avoir touché
      const wantTag = a.alive && (it.ally || (a.showHpUntil ?? 0) > time);
      if (wantTag) {
        this.v.set(a.pos.x, a.pos.y + 2.25, a.pos.z).project(camera);
        const front = this.v.z < 1 && Math.abs(this.v.x) < 1.05 && Math.abs(this.v.y) < 1.05;
        it.tag.style.display = front ? '' : 'none';
        if (front) {
          it.tag.style.left = `${(this.v.x * 0.5 + 0.5) * innerWidth}px`;
          it.tag.style.top = `${(-this.v.y * 0.5 + 0.5) * innerHeight}px`;
          it.bar.style.width = `${(a.hp / a.maxHp) * 100}%`;
        }
      } else it.tag.style.display = 'none';
    }

    this.spikeDot.visible = spike.planted;
    if (spike.planted) this.spikeDot.position.set(spike.pos.x, 31, spike.pos.z);
  }
}
