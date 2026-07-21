// RIDGE — vertical, chokepoints serrés, style Split (40 × 60).
// Donnée pure, aucun import : validée sous node par selftest.js.
//
// Mid étroit (6 m) et VERTICAL : rampe -> plateforme surélevée (h 2) -> rampe, qui relie
// les deux sites par des portes au nord. Chaque site a son "heaven" : une passerelle à
// h 1.8 le long du mur extérieur, accessible uniquement côté spawn défense par une rampe,
// qui surplombe la zone de plant (on en saute, on n'y remonte pas). Les portes de site
// font 3 m : pousser sans utilitaire coûte cher.

const COL = { floor: 0x9fa8b5, wall: 0x3d4652, ramp: 0x5a6472, crate: 0x7a6a4f };

export default {
  name: 'Ridge',
  tag: 'Vertical · chokes serrés',

  solids: [
    // sol + périmètre (h 5 : personne ne regarde par-dessus depuis un heaven)
    { pos: [0, -0.5, 0], size: [40, 1, 60], color: COL.floor },
    { pos: [0, 2.5, -29.75], size: [40, 5, 0.5], color: COL.wall },
    { pos: [0, 2.5, 29.75], size: [40, 5, 0.5], color: COL.wall },
    { pos: [-19.75, 2.5, 0], size: [0.5, 5, 60], color: COL.wall },
    { pos: [19.75, 2.5, 0], size: [0.5, 5, 60], color: COL.wall },

    // murs du mid (x ±3.5), portes vers les sites en z -14..-10, cul-de-sac bouché
    { pos: [-3.5, 2, 6], size: [1, 4, 32], color: COL.wall },
    { pos: [-3.5, 2, -20], size: [1, 4, 12], color: COL.wall },
    { pos: [3.5, 2, 6], size: [1, 4, 32], color: COL.wall },
    { pos: [3.5, 2, -20], size: [1, 4, 12], color: COL.wall },
    { pos: [0, 2, -14.5], size: [7, 4, 1], color: COL.wall },

    // mid vertical : rampe sud -> plateforme h 2 -> rampe nord
    { pos: [0, 1, 10], size: [7, 2, 6], color: COL.ramp, ramp: { axis: 'z', dir: -1 } },
    { pos: [0, 1, 1], size: [7, 2, 12], color: COL.ramp },
    { pos: [0, 1, -8], size: [7, 2, 6], color: COL.ramp, ramp: { axis: 'z', dir: 1 } },

    // mur du spawn défense (portes vers A en x -12..-8, vers B en x 8..12)
    { pos: [-16, 2, -26], size: [8, 4, 1], color: COL.wall },
    { pos: [0, 2, -26], size: [16, 4, 1], color: COL.wall },
    { pos: [16, 2, -26], size: [8, 4, 1], color: COL.wall },

    // murs sud des sites (porte A main x -16..-13, porte B main x 13..16 : 3 m)
    { pos: [-18, 2, -8], size: [4, 4, 1], color: COL.wall },
    { pos: [-8.5, 2, -8], size: [9, 4, 1], color: COL.wall },
    { pos: [8.5, 2, -8], size: [9, 4, 1], color: COL.wall },
    { pos: [18, 2, -8], size: [4, 4, 1], color: COL.wall },

    // heaven A (passerelle ouest) + sa rampe côté spawn défense
    { pos: [-18, 0.9, -18], size: [4, 1.8, 16], color: COL.ramp },
    { pos: [-14, 0.9, -24], size: [4, 1.8, 4], color: COL.ramp, ramp: { axis: 'x', dir: -1 } },
    // heaven B (est), miroir
    { pos: [18, 0.9, -18], size: [4, 1.8, 16], color: COL.ramp },
    { pos: [14, 0.9, -24], size: [4, 1.8, 4], color: COL.ramp, ramp: { axis: 'x', dir: 1 } },

    // caisses : une par site, une par voie d'attaque
    { pos: [-8, 0.6, -14], size: [1.2, 1.2, 1.2], color: COL.crate },
    { pos: [8, 0.6, -14], size: [1.2, 1.2, 1.2], color: COL.crate },
    { pos: [-11, 0.35, 2], size: [2, 0.7, 2], color: COL.crate },
    { pos: [11, 0.35, 2], size: [2, 0.7, 2], color: COL.crate },
  ],

  sites: [
    { name: 'A', min: { x: -14, z: -20 }, max: { x: -6, z: -12 } },
    { name: 'B', min: { x: 6, z: -20 }, max: { x: 14, z: -12 } },
  ],

  attack: { x: 0, z: 26, yaw: 0 },
  defense: { x: 0, z: -28, yaw: Math.PI },

  // Routes des bots (prompt 6). defXHigh grimpe au heaven par sa rampe : seuls
  // les bots à haut ELO la prennent (botParams.holdsHigh).
  nav: {
    atkA: [[-14, 20], [-14, -4], [-14.5, -10], [-10, -16]],
    atkB: [[14, 20], [14, -4], [14.5, -10], [10, -16]],
    defA: [[-10, -27.5], [-10, -22], [-10, -16]],
    defB: [[10, -27.5], [10, -22], [10, -16]],
    defAHigh: [[-10, -27.5], [-10, -24], [-13, -24], [-18, -24], [-18, -14]],
    defBHigh: [[10, -27.5], [10, -24], [13, -24], [18, -24], [18, -14]],
    rotAB: [[-10, -22], [-10, -27.5], [10, -27.5], [10, -22], [10, -16]],
  },
};
