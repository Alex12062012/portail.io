// VAULT — pas de mid, téléporteurs, style Bind. Compacte (40 × 52), plus petite que Nexus.
// Donnée pure, aucun import : validée sous node par selftest.js.
//
// Un bloc central plein interdit tout couloir direct entre les sites : depuis le spawn
// attaque, A ne s'atteint que par le couloir ouest et B que par le couloir est, chacun
// en S (deux chicanes de 4 m de large -> combat rapproché). Les défenseurs ont un lien
// A<->B derrière le bloc. Deux téléporteurs À SENS UNIQUE dans la plaza d'attaque
// permettent de basculer d'un abord de site à l'autre (effet + son audibles partout).

const COL = { floor: 0xc9b28f, wall: 0x6b5b45, crate: 0x8a7550 };

export default {
  name: 'Vault',
  tag: 'Sans mid · téléporteurs',

  solids: [
    // sol + périmètre
    { pos: [0, -0.5, 0], size: [40, 1, 52], color: COL.floor },
    { pos: [0, 2, -25.75], size: [40, 4, 0.5], color: COL.wall },
    { pos: [0, 2, 25.75], size: [40, 4, 0.5], color: COL.wall },
    { pos: [-19.75, 2, 0], size: [0.5, 4, 52], color: COL.wall },
    { pos: [19.75, 2, 0], size: [0.5, 4, 52], color: COL.wall },

    // bloc central plein : aucun mid
    { pos: [0, 2, -2], size: [16, 4, 24], color: COL.wall },

    // mur du spawn défense (portes vers A en x -16..-12, vers B en x 12..16)
    { pos: [-18, 2, -20], size: [4, 4, 1], color: COL.wall },
    { pos: [0, 2, -20], size: [24, 4, 1], color: COL.wall },
    { pos: [18, 2, -20], size: [4, 4, 1], color: COL.wall },

    // couloir ouest en S : chicane côté périmètre puis côté bloc
    { pos: [-16, 2, 6], size: [8, 4, 1], color: COL.wall },
    { pos: [-12, 2, -3], size: [8, 4, 1], color: COL.wall },
    // couloir est, miroir
    { pos: [16, 2, 6], size: [8, 4, 1], color: COL.wall },
    { pos: [12, 2, -3], size: [8, 4, 1], color: COL.wall },

    // caisses de site
    { pos: [-11, 0.6, -19], size: [1.2, 1.2, 1.2], color: COL.crate },
    { pos: [11, 0.6, -19], size: [1.2, 1.2, 1.2], color: COL.crate },
  ],

  sites: [
    { name: 'A', min: { x: -18, z: -18 }, max: { x: -10, z: -9 } },
    { name: 'B', min: { x: 10, z: -18 }, max: { x: 18, z: -9 } },
  ],

  // Pads dans les coins de la plaza d'attaque, sorties à l'abord opposé — jamais
  // sur un pad (sens unique, pas de boucle possible).
  teleports: [
    { zone: { min: { x: -19, z: 16 }, max: { x: -15, z: 20 } }, exit: { x: 13, y: 0, z: 18, yaw: 0 } },
    { zone: { min: { x: 15, z: 16 }, max: { x: 19, z: 20 } }, exit: { x: -13, y: 0, z: 18, yaw: 0 } },
  ],

  attack: { x: 0, z: 22, yaw: 0 },
  defense: { x: 0, z: -23, yaw: Math.PI },

  // Routes des bots (prompt 6). Les atk serpentent les deux chicanes de leur
  // couloir ; rotAB passe par le lien défenseur derrière le bloc central.
  nav: {
    atkA: [[-14, 12], [-10, 4], [-18, 0], [-18, -8], [-14, -13.5]],
    atkB: [[14, 12], [10, 4], [18, 0], [18, -8], [14, -13.5]],
    defA: [[-14, -22], [-14, -14]],
    defB: [[14, -22], [14, -14]],
    rotAB: [[-14, -14], [-14, -17], [0, -17], [14, -17], [14, -14]],
  },
};
