// Effets de capacités, côté Three : projectiles, zones, mur, drone, faisceaux.
//
// abilities.js ne connaît que les callbacks exposés par `ctx()` — toute la géométrie
// et tout le raycast vivent ici. Les zones réutilisent surfaceY() de player.js pour
// se poser sur les rampes.
import * as THREE from 'three';
import { surfaceY } from './player.js';

// Aspect des zones. `blocks` = opaque, coupe la vue (fumées).
const KIND = {
  smoke: { color: 0xdfe4ea, opacity: 0.98, blocks: true },
  fire:  { color: 0xff5a1f, opacity: 0.34 },
  slow:  { color: 0x74dcf2, opacity: 0.26 },
  stim:  { color: 0xffc44d, opacity: 0.24 },
  laser: { color: 0xff3b30, opacity: 0.32, tall: true },
};

const EYE = 0.9;            // hauteur du centre d'un acteur au-dessus de ses pieds
const GRAV_PROJ = 1;        // les gravités des capacités sont déjà en m/s²
const mat = (color, opacity) =>
  new THREE.MeshBasicMaterial({ color, opacity, transparent: opacity < 1, depthWrite: opacity > 0.9 });

// Le point est-il dans un solide ? surfaceY gère les rampes, donc les pentes aussi.
function inside(p, solids) {
  for (const s of solids) {
    if (p.x < s.min.x || p.x > s.max.x || p.z < s.min.z || p.z > s.max.z) continue;
    if (p.y >= s.min.y && p.y <= surfaceY(s, p.x, p.z)) return s;
  }
  return null;
}

const center = (a) => new THREE.Vector3(a.pos.x, a.pos.y + EYE, a.pos.z);
const flatDist = (p, a) => Math.hypot(p.x - a.pos.x, p.z - a.pos.z);

export class Effects {
  // world : { scene, camera, solids, meshes, hittables, actors, player, arsenal, kill }
  constructor(world) {
    this.w = world;
    this.time = 0;
    this.projectiles = [];
    this.zones = [];
    this.pending = [];   // effets à retirer de la scène en fin de frame
    this.heals = [];
    this.markers = new Map(); // acteur -> losange de révélation
    this.drone = null;
    this.wallYaw = 0;
    this.ghost = null;
    this.ray = new THREE.Raycaster();
  }

  // --- Visée ---------------------------------------------------------------------

  aim() {
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();
    this.w.camera.getWorldPosition(origin);
    this.w.camera.getWorldDirection(dir);
    return { origin, dir };
  }

  // Premier point de la map visé, ou un point à `max` mètres devant si on vise le vide.
  aimPoint(max = 60) {
    const { origin, dir } = this.aim();
    this.ray.set(origin, dir);
    this.ray.far = max;
    const hit = this.ray.intersectObjects(this.w.meshes, false)[0];
    return hit ? hit.point : origin.clone().addScaledVector(dir, max);
  }

  // Vue dégagée entre deux points ? Sert aux révélations (Recon Bolt, dard du drone).
  visible(from, to) {
    const dir = to.clone().sub(from);
    const len = dir.length();
    this.ray.set(from, dir.normalize());
    this.ray.far = len - 0.1;
    return this.ray.intersectObjects(this.w.meshes, false).length === 0;
  }

  // --- Dégâts / soin ---------------------------------------------------------------

  // Point d'entrée unique des dégâts : l'armure absorbe avant les PV.
  // `via` : le nom d'arme/capacité affiché au killfeed si le coup tue.
  hurt(actor, amount, by, via) {
    if (!actor.alive) return;
    const absorbed = Math.min(actor.shield ?? 0, amount);
    actor.shield -= absorbed;
    actor.hp -= amount - absorbed;
    if (by) {
      // Assists : on retient qui a touché récemment (consommé par kill()).
      (actor.recentHits ??= []).push({ by, t: this.time });
      if (actor.recentHits.length > 8) actor.recentHits.shift();
      // Barre de vie ennemie : brièvement visible après que le JOUEUR l'a touché.
      if (by === this.w.playerActor) actor.showHpUntil = this.time + 1;
      // Indicateur directionnel : uniquement des dégâts RÉELS sur le joueur.
      if (actor === this.w.playerActor) this.w.onPlayerHurt?.(by.pos);
    }
    if (actor.hp <= 0) { actor.hp = 0; this.w.kill(actor, by, via); }
  }

  reveal(actor, seconds) {
    if (!actor.alive) return;
    actor.revealedUntil = Math.max(actor.revealedUntil ?? 0, this.time + seconds);
  }

  // --- Callbacks appelés par abilities.js -------------------------------------------

  ctx() {
    return {
      lob: (o) => this.lob(o),
      sky: (o) => this.sky(o),
      impulse: (vy) => { this.w.player.vel.y = vy; this.w.player.grounded = false; },
      dash: (speed) => this.dash(speed),
      drone: (o) => this.spawnDrone(o),
      beam: (o) => this.beam(o),
      barrier: (o) => this.barrier(o),
      rotate: () => { this.wallYaw += Math.PI / 2; return false; },
      heal: (o) => this.heal(o),
      revive: (o) => this.revive(o),
      equipWeapon: (key) => this.w.arsenal.equipAbilityWeapon(key),
    };
  }

  // Dash : impulsion horizontale dans le sens du déplacement, ou du regard à l'arrêt.
  dash(speed) {
    const p = this.w.player;
    let { x, z } = p.vel;
    if (Math.hypot(x, z) < 0.5) { x = -Math.sin(p.yaw); z = -Math.cos(p.yaw); }
    const len = Math.hypot(x, z);
    p.vel.x = (x / len) * speed;
    p.vel.z = (z / len) * speed;
  }

  lob(o) {
    const { origin, dir } = this.aim();
    const geo = new THREE.SphereGeometry(o.kind === 'smoke' ? 0.12 : 0.09, 8, 6);
    const mesh = new THREE.Mesh(geo, mat(KIND[o.kind]?.color ?? 0xffffff, 1));
    mesh.position.copy(origin).addScaledVector(dir, 0.5);
    this.w.scene.add(mesh);
    this.projectiles.push({
      mesh, o,
      vel: dir.clone().multiplyScalar(o.speed),
      bounces: o.bounces ?? 0,
      life: 6,
    });
  }

  // Fumée d'appui / frappe orbitale : tombe du ciel sur le point visé.
  sky(o) {
    const p = this.aimPoint();
    this.zone(p, { ...o, drop: true });
  }

  zone(p, o) {
    const k = KIND[o.kind];
    const r = o.radius;
    const geo = k.blocks
      ? new THREE.SphereGeometry(r, 20, 14)
      : new THREE.CylinderGeometry(r, r, k.tall ? 14 : 0.6, 24, 1, true);
    const mesh = new THREE.Mesh(geo, mat(k.color, k.opacity));
    mesh.material.side = THREE.DoubleSide;
    mesh.position.set(p.x, p.y + (k.blocks ? r * 0.7 : k.tall ? 7 : 0.3), p.z);
    if (o.drop) mesh.scale.setScalar(0.01);
    this.w.scene.add(mesh);
    this.zones.push({ mesh, o, pos: { x: p.x, y: p.y, z: p.z }, life: o.life, grow: o.drop ? 0 : 1 });
  }

  // Hunter's Fury : ligne d'énergie qui traverse tout, sur la largeur de la map.
  beam(o) {
    const { origin, dir } = this.aim();
    const from = origin.clone();
    from.y = this.w.player.pos.y + EYE; // à hauteur de torse, pas dans l'axe du regard vertical
    const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize();

    for (const a of this.w.actors) {
      if (!a.alive || a.team === this.w.player.team) continue;
      const to = center(a).sub(from);
      const along = to.dot(flat);
      if (along <= 0) continue;
      if (to.addScaledVector(flat, -along).length() > o.width) continue;
      this.hurt(a, o.damage, this.w.playerActor, "Hunter's Fury");
      this.reveal(a, 2);
    }

    const len = 120;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(o.width * 2, 0.5, len), mat(0x7ce9ff, 0.55));
    mesh.position.copy(from).addScaledVector(flat, len / 2);
    mesh.lookAt(mesh.position.clone().add(flat));
    this.w.scene.add(mesh);
    this.fade(mesh, 0.6);
  }

  // --- Mur de Sage -------------------------------------------------------------------

  // Aperçu fantôme tant que Barrier Orb est équipée (`ghost: 'wall'` dans abilities.js).
  previewWall(show) {
    if (!show) {
      if (this.ghost) { this.w.scene.remove(this.ghost); this.ghost = null; }
      return;
    }
    if (!this.ghost) {
      this.ghost = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.6, 0.25), mat(0xcfeedc, 0.35));
      this.w.scene.add(this.ghost);
    }
    const p = this.aimPoint(12);
    this.ghost.position.set(p.x, p.y + 0.8, p.z);
    this.ghost.rotation.y = this.wallYaw;
  }

  barrier(o) {
    const p = this.aimPoint(12);
    const yaw = this.wallYaw;
    const seg = { w: 1.4, h: 1.6, d: 0.25 };

    for (let i = -1; i <= 1; i++) {
      const cx = p.x + Math.cos(yaw) * i * seg.w;
      const cz = p.z - Math.sin(yaw) * i * seg.w;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(seg.w, seg.h, seg.d), mat(0xbfe8d6, 0.85));
      mesh.position.set(cx, p.y + seg.h / 2, cz);
      mesh.rotation.y = yaw;

      // Le collider reste aligné aux axes : à 45° l'emprise serait fausse, mais le
      // mur ne se pose qu'à 0° ou 90° (rotation par quart de tour).
      const alongZ = Math.abs(Math.cos(yaw)) < 0.5;
      const hw = (alongZ ? seg.d : seg.w) / 2;
      const hd = (alongZ ? seg.w : seg.d) / 2;
      const solid = {
        min: { x: cx - hw, y: p.y, z: cz - hd },
        max: { x: cx + hw, y: p.y + seg.h, z: cz + hd },
      };

      const remove = () => {
        this.w.scene.remove(mesh);
        for (const arr of [this.w.solids, this.w.hittables]) {
          const j = arr.indexOf(arr === this.w.solids ? solid : mesh);
          if (j >= 0) arr.splice(j, 1);
        }
      };
      mesh.userData.destructible = { hp: o.hp, remove };

      this.w.solids.push(solid);
      this.w.hittables.push(mesh);
      this.fade(mesh, o.life, remove);
      // Fortification : +200 PV après 2 s, comme dans Valorant.
      setTimeout(() => { if (mesh.userData.destructible.hp > 0) mesh.userData.destructible.hp = o.fortified; }, 2000);
    }
  }

  // --- Soin / résurrection -------------------------------------------------------------

  heal(o) {
    const target = o.self ? this.w.playerActor : this.aimedAlly();
    if (!target || !target.alive || target.hp >= target.maxHp) return false; // charge non consommée
    this.heals.push({ actor: target, rate: o.amount / o.over, left: o.over });
    return true;
  }

  // Allié visé à moins de 30 m. Renvoie null s'il n'y en a pas (pas d'alliés avant le prompt 6).
  aimedAlly() {
    const { origin, dir } = this.aim();
    let best = null;
    let bestDot = 0.985; // ~10° de tolérance
    for (const a of this.w.actors) {
      if (!a.alive || a.team !== this.w.player.team || a === this.w.playerActor) continue;
      const to = center(a).sub(origin);
      if (to.length() > 30) continue;
      const dot = to.normalize().dot(dir);
      if (dot > bestDot) { bestDot = dot; best = a; }
    }
    return best;
  }

  revive(o) {
    const dead = this.w.actors.find((a) => a.team === this.w.player.team && !a.alive);
    if (!dead) return false;
    // Channel : Sage est immobilisée le temps de l'incantation.
    this.w.player.channel = o.channel;
    setTimeout(() => this.w.revive(dead), o.channel * 1000);
    return true;
  }

  // --- Drone ---------------------------------------------------------------------------

  spawnDrone(o) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), mat(0x2a4a9e, 1));
    const { origin, dir } = this.aim();
    mesh.position.copy(origin).addScaledVector(dir, 1);
    mesh.userData.destructible = { hp: o.hp, remove: () => this.killDrone() };
    this.w.scene.add(mesh);
    this.w.hittables.push(mesh);
    this.drone = {
      mesh, life: o.life, darts: 1,
      yaw: this.w.player.yaw, pitch: this.w.player.pitch,
      vel: new THREE.Vector3(),
    };
  }

  killDrone() {
    if (!this.drone) return;
    this.w.scene.remove(this.drone.mesh);
    const i = this.w.hittables.indexOf(this.drone.mesh);
    if (i >= 0) this.w.hittables.splice(i, 1);
    this.drone = null;
  }

  // Pilotage : la caméra passe derrière le drone, ZQSD le déplace, clic tire le dard.
  driveDrone(dt, input, camera) {
    const d = this.drone;
    if (input.locked) {
      const m = input.consumeMouse();
      d.yaw -= m.x * 0.0022;
      d.pitch = Math.max(-1.4, Math.min(1.4, d.pitch - m.y * 0.0022));
    }

    const f = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0);
    const r = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0);
    const up = (input.down('Space') ? 1 : 0) - (input.down('ControlLeft') ? 1 : 0);
    const dir = new THREE.Vector3(-Math.sin(d.yaw), 0, -Math.cos(d.yaw));
    const side = new THREE.Vector3(Math.cos(d.yaw), 0, -Math.sin(d.yaw));
    const wish = dir.multiplyScalar(f).add(side.multiplyScalar(r));
    wish.y = up;
    d.vel.lerp(wish.multiplyScalar(7), Math.min(8 * dt, 1));

    const next = d.mesh.position.clone().addScaledVector(d.vel, dt);
    if (!inside(next, this.w.solids)) d.mesh.position.copy(next);
    else d.vel.set(0, 0, 0);

    if (d.darts > 0 && input.consumeClick(0)) {
      d.darts--;
      const look = new THREE.Vector3(
        -Math.sin(d.yaw) * Math.cos(d.pitch), Math.sin(d.pitch), -Math.cos(d.yaw) * Math.cos(d.pitch),
      );
      this.ray.set(d.mesh.position, look);
      this.ray.far = 60;
      const hit = this.ray.intersectObjects(this.w.hittables, false)[0];
      const actor = hit?.object.parent?.userData.actor;
      if (actor) this.reveal(actor, 8);
    }

    camera.rotation.set(d.pitch, d.yaw, 0);
    const back = new THREE.Vector3(Math.sin(d.yaw), 0.35, Math.cos(d.yaw)).multiplyScalar(1.4);
    camera.position.copy(d.mesh.position).add(back);

    d.life -= dt;
    if (d.life <= 0) this.killDrone();
  }

  // --- Boucle -----------------------------------------------------------------------------

  fade(mesh, seconds, onEnd) {
    this.pending.push({ mesh, left: seconds, onEnd });
  }

  update(dt) {
    this.time += dt;
    const p = this.w.player;
    p.zoneMult = 1;
    p.buff = 1;

    this.stepProjectiles(dt);
    this.stepZones(dt);

    for (const h of this.heals) {
      const take = Math.min(h.rate * dt, h.actor.maxHp - h.actor.hp);
      h.actor.hp += take;
      h.left -= dt;
    }
    this.heals = this.heals.filter((h) => h.left > 0 && h.actor.hp < h.actor.maxHp);

    for (const f of this.pending) {
      f.left -= dt;
      if (f.left > 0) continue;
      if (f.onEnd) f.onEnd();
      else this.w.scene.remove(f.mesh);
    }
    this.pending = this.pending.filter((f) => f.left > 0);

    this.updateMarkers();
  }

  stepProjectiles(dt) {
    for (const pr of this.projectiles) {
      pr.vel.y -= (pr.o.gravity ?? 10) * GRAV_PROJ * dt;
      pr.life -= dt;

      // Axe par axe, comme les collisions du joueur : la normale du rebond est gratuite.
      let landed = pr.life <= 0;
      for (const ax of ['x', 'y', 'z']) {
        const prev = pr.mesh.position[ax];
        pr.mesh.position[ax] += pr.vel[ax] * dt;
        if (!inside(pr.mesh.position, this.w.solids)) continue;
        pr.mesh.position[ax] = prev;
        if (pr.bounces > 0) { pr.vel[ax] *= -0.5; }
        else landed = true;
      }
      if (pr.bounces > 0 && pr.vel.lengthSq() < 4) landed = true;
      if (landed) { this.land(pr); pr.dead = true; }
      else if (pr.bounces > 0 && pr.vel.lengthSq() < pr.o.speed * pr.o.speed * 0.3) pr.bounces--;
    }
    this.projectiles = this.projectiles.filter((pr) => !pr.dead);
  }

  land(pr) {
    const o = pr.o;
    const p = pr.mesh.position;
    this.w.scene.remove(pr.mesh);

    if (o.kind === 'shock') {
      // 1 à 75 dégâts selon la distance au centre de l'explosion.
      for (const a of this.w.actors) {
        if (!a.alive) continue;
        const d = center(a).distanceTo(p);
        if (d > o.radius) continue;
        this.hurt(a, Math.max(1, Math.round(o.damage * (1 - d / o.radius))), this.w.playerActor, 'Shock Bolt');
      }
      const boom = new THREE.Mesh(new THREE.SphereGeometry(o.radius, 16, 10), mat(0x7ce9ff, 0.4));
      boom.position.copy(p);
      this.w.scene.add(boom);
      this.fade(boom, 0.25);
      return;
    }

    if (o.kind === 'recon') {
      const mesh = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.5, 6), mat(0x2a4a9e, 1));
      mesh.position.copy(p);
      const remove = () => {
        this.w.scene.remove(mesh);
        const i = this.w.hittables.indexOf(mesh);
        if (i >= 0) this.w.hittables.splice(i, 1);
      };
      mesh.userData.destructible = { hp: o.hp, remove };
      this.w.scene.add(mesh);
      this.w.hittables.push(mesh);
      this.fade(mesh, o.life, remove);

      // 3 pulsations : chacune révèle ce qui est en vue directe de la flèche.
      const gap = (o.life / o.pulses) * 1000;
      for (let i = 0; i < o.pulses; i++) {
        setTimeout(() => {
          if (mesh.userData.destructible.hp <= 0) return;
          const ring = new THREE.Mesh(new THREE.SphereGeometry(o.radius, 16, 10),
            new THREE.MeshBasicMaterial({ color: 0x7ce9ff, wireframe: true, transparent: true, opacity: 0.25 }));
          ring.position.copy(p);
          this.w.scene.add(ring);
          this.fade(ring, 0.4);
          for (const a of this.w.actors) {
            if (!a.alive || a.team === this.w.player.team) continue;
            if (center(a).distanceTo(p) < o.radius && this.visible(p, center(a))) this.reveal(a, 2.5);
          }
        }, i * gap + 200);
      }
      return;
    }

    this.zone(p, o); // smoke / fire / slow / stim
  }

  stepZones(dt) {
    for (const z of this.zones) {
      z.life -= dt;
      if (z.grow < 1) {
        z.grow = Math.min(1, z.grow + dt * 2.5);
        z.mesh.scale.setScalar(z.grow);
      }
      const o = z.o;
      if (!o.dps && !o.slow && o.kind !== 'stim') continue;

      for (const a of this.w.actors) {
        if (!a.alive || flatDist(z.pos, a) > o.radius) continue;
        if (Math.abs(a.pos.y - z.pos.y) > 3) continue;
        // Seul le joueur pose des zones (les bots blessent via ctx.hurt) : le kill lui revient.
        if (o.dps) this.hurt(a, o.dps * dt, this.w.playerActor, o.kind === 'laser' ? 'Orbital Strike' : 'Incendiary');
        if (!a.player) continue;
        if (o.slow) a.player.zoneMult = Math.min(a.player.zoneMult, o.slow);
        // Stim Beacon : zone neutre, elle profite à qui entre dedans.
        if (o.kind === 'stim') { a.player.zoneMult = Math.max(a.player.zoneMult, 1.1); a.player.buff = 1.1; }
      }
    }
    for (const z of this.zones) if (z.life <= 0) this.w.scene.remove(z.mesh);
    this.zones = this.zones.filter((z) => z.life > 0);
  }

  // Losange au-dessus des acteurs révélés, visible à travers les murs.
  updateMarkers() {
    for (const a of this.w.actors) {
      const on = a.alive && (a.revealedUntil ?? 0) > this.time;
      let m = this.markers.get(a);
      if (on && !m) {
        m = new THREE.Mesh(new THREE.OctahedronGeometry(0.18),
          new THREE.MeshBasicMaterial({ color: 0xff4d4d, depthTest: false, transparent: true }));
        m.renderOrder = 999;
        this.w.scene.add(m);
        this.markers.set(a, m);
      }
      if (!m) continue;
      m.visible = on;
      if (on) {
        m.position.set(a.pos.x, a.pos.y + 2.3, a.pos.z);
        m.rotation.y = this.time * 2;
      }
    }
  }
}
