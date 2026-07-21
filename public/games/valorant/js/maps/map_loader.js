// Chargement des maps : géométrie, colliders, sites A/B, spawns, téléporteurs, bornes
// pour la minimap. Reprend les helpers de l'ex map_test.js (remplacée au prompt 5).
//
// Les fichiers de map sont de la donnée pure et Three n'est importé qu'à l'intérieur
// de buildMap : ce module se charge donc tel quel sous node, où selftest.js valide
// les trois maps (spawns hors des murs, sites posables, sorties de téléporteur saines).
import nexus from './map_nexus.js';
import vault from './map_vault.js';
import ridge from './map_ridge.js';

export const MAPS = { nexus, vault, ridge };

export function toCollider({ pos: [x, y, z], size: [w, h, d], ramp }) {
  return {
    min: { x: x - w / 2, y: y - h / 2, z: z - d / 2 },
    max: { x: x + w / 2, y: y + h / 2, z: z + d / 2 },
    ramp,
  };
}

// Site contenant ce point, ou null. Test 2D : la hauteur n'entre pas en compte.
export function siteAt(sites, p) {
  return sites.find((s) => p.x >= s.min.x && p.x <= s.max.x && p.z >= s.min.z && p.z <= s.max.z) ?? null;
}

export function siteCenter(s) {
  return { x: (s.min.x + s.max.x) / 2, z: (s.min.z + s.max.z) / 2 };
}

// 5 emplacements par camp (spec prompt 5), écartés pour ne pas s'empiler.
export const spawnSet = ({ x, z, yaw }) => [0, 1, 2, 3, 4].map((i) => ({ x: x + (i - 2) * 1.8, y: 0, z, yaw }));

export async function buildMap(id, scene) {
  const THREE = await import('three');
  const def = MAPS[id];

  // Une rampe est rendue en écrasant les sommets hauts du côté bas de la boîte :
  // le mesh épouse alors exactement la surface calculée par surfaceY().
  const rampGeometry = (w, h, d, ramp) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      if (p.getY(i) <= 0) continue;
      const c = ramp.axis === 'x' ? p.getX(i) : p.getZ(i);
      const lowSide = ramp.dir > 0 ? c < 0 : c > 0;
      if (lowSide) p.setY(i, -h / 2);
    }
    geo.computeVertexNormals();
    return geo;
  };

  // Marquage au sol (site, pad de téléporteur). Hors de `meshes` : une balle ne s'y arrête pas.
  const patch = (min, max, color, y = 0.02) => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(max.x - min.x, 0.04, max.z - min.z),
      new THREE.MeshLambertMaterial({ color }),
    );
    m.position.set((min.x + max.x) / 2, y, (min.z + max.z) / 2);
    scene.add(m);
  };

  const meshes = [];
  for (const s of def.solids) {
    const [w, h, d] = s.size;
    const geo = s.ramp ? rampGeometry(w, h, d, s.ramp) : new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: s.color }));
    mesh.position.set(...s.pos);
    scene.add(mesh);
    meshes.push(mesh);
  }
  for (const s of def.sites) patch(s.min, s.max, 0x8c5a3c);

  // Repères de cheminement vers A et B, semés le long des routes d'attaque déjà
  // définies dans `nav` (pas de second système de trajet). Volontairement discrets :
  // c'est un rappel de direction, pas un guidage automatique.
  const markGeo = new THREE.PlaneGeometry(0.45, 0.85);
  const markMat = new THREE.MeshBasicMaterial({ color: 0x4ee1e8, transparent: true, opacity: 0.14 });
  for (const key of ['atkA', 'atkB']) {
    const route = def.nav?.[key];
    if (!route) continue;
    const pts = [[def.attack.x, def.attack.z], ...route];
    for (let i = 1; i < pts.length; i++) {
      const [fx, fz] = pts[i - 1], [tx, tz] = pts[i];
      const len = Math.hypot(tx - fx, tz - fz);
      for (let d = 3; d < len; d += 5) {
        const m = new THREE.Mesh(markGeo, markMat);
        m.rotation.x = -Math.PI / 2;
        m.rotation.z = -Math.atan2(tx - fx, tz - fz);
        m.position.set(fx + ((tx - fx) * d) / len, 0.03, fz + ((tz - fz) * d) / len);
        scene.add(m);
      }
    }
  }

  for (const t of def.teleports ?? []) {
    patch(t.zone.min, t.zone.max, 0x7c4dd4);                                     // pad
    patch({ x: t.exit.x - 1, z: t.exit.z - 1 }, { x: t.exit.x + 1, z: t.exit.z + 1 }, 0xb49aff); // sortie
  }

  const solids = def.solids.map(toCollider);
  const bounds = {
    min: { x: Math.min(...solids.map((s) => s.min.x)), z: Math.min(...solids.map((s) => s.min.z)) },
    max: { x: Math.max(...solids.map((s) => s.max.x)), z: Math.max(...solids.map((s) => s.max.z)) },
  };
  const spawnAttack = spawnSet(def.attack);
  const spawnDefense = spawnSet(def.defense);

  return {
    name: def.name, solids, meshes, sites: def.sites, teleports: def.teleports ?? [],
    spawnAttack, spawnDefense, spawn: spawnAttack[0], bounds, nav: def.nav,
  };
}

// --- Écran de sélection, même patron que agent_select.js ---------------------------

const CSS = `
#mappick{position:fixed;inset:0;z-index:4;display:grid;place-content:center;gap:22px;
      background:#0d1117;font:13px/1.5 ui-monospace,Consolas,monospace;color:#cfe3ee}
#mappick h1{margin:0;text-align:center;font-size:20px;letter-spacing:.22em;color:#4ee1e8;font-weight:600}
#mappick .row{display:flex;gap:14px}
#mappick button{width:190px;padding:16px 14px;text-align:left;cursor:pointer;color:inherit;font:inherit;
      background:#151b22;border:1px solid #263039;border-top:3px solid #4ee1e8;transition:.12s}
#mappick button:hover{background:#1c242d;transform:translateY(-3px)}
#mappick .n{font-size:15px;letter-spacing:.1em;color:#4ee1e8;margin-bottom:9px}
#mappick .t{opacity:.6}`;

export function selectMap() {
  document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`);

  const cards = Object.entries(MAPS).map(([key, m]) => `
    <button data-map="${key}">
      <div class="n">${m.name.toUpperCase()}</div>
      <div class="t">${m.tag}</div>
    </button>`).join('');

  document.body.insertAdjacentHTML('beforeend',
    `<div id="mappick"><h1>CHOISIS TA MAP</h1><div class="row">${cards}</div></div>`);

  const root = document.getElementById('mappick');
  return new Promise((resolve) => {
    root.addEventListener('click', (e) => {
      const key = e.target.closest('button')?.dataset.map;
      if (!key) return;
      root.remove();
      resolve(key);
    });
  });
}
