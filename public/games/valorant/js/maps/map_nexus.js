// NEXUS — mid ouvert, 3 voies, style Ascent. Taille moyenne (48 × 68).
// Donnée pure, aucun import : validée sous node par selftest.js.
//
// Layout (nord = -z, attaque au sud) :
//   spawn défense (z -34..-20, toute la largeur)
//   [ site A ] [   mid   ] [ site B ]     rooms z -20..-2, mid ouvert de bout en bout
//   spawn attaque (z 20..34), 3 voies : A main / mid / B main
//
// Mid : ligne de vue de ~40 m entre les deux plazas, muret central pour traverser.
// Site B : sa porte sud est bouchée par une grosse caisse à contourner (choix gauche/droite).

const COL = { floor: 0xb9bec4, wall: 0x4a505a, mid: 0x3e5c66, crate: 0x8a7550 };

export default {
  name: 'Nexus',
  tag: 'Mid ouvert · 3 voies',

  solids: [
    // sol + périmètre
    { pos: [0, -0.5, 0], size: [48, 1, 68], color: COL.floor },
    { pos: [0, 2, -33.75], size: [48, 4, 0.5], color: COL.wall },
    { pos: [0, 2, 33.75], size: [48, 4, 0.5], color: COL.wall },
    { pos: [-23.75, 2, 0], size: [0.5, 4, 68], color: COL.wall },
    { pos: [23.75, 2, 0], size: [0.5, 4, 68], color: COL.wall },

    // murs du mid (x ±7), percés du lien mid -> site en z -16..-10
    { pos: [-7, 2, -18], size: [1, 4, 4], color: COL.mid },
    { pos: [-7, 2, 5], size: [1, 4, 30], color: COL.mid },
    { pos: [7, 2, -18], size: [1, 4, 4], color: COL.mid },
    { pos: [7, 2, 5], size: [1, 4, 30], color: COL.mid },

    // site A : mur sud (porte A main x -20..-16), mur nord (porte défense x -13..-9)
    { pos: [-22, 2, -2], size: [4, 4, 1], color: COL.wall },
    { pos: [-11.5, 2, -2], size: [9, 4, 1], color: COL.wall },
    { pos: [-18.5, 2, -20], size: [11, 4, 1], color: COL.wall },
    { pos: [-8, 2, -20], size: [2, 4, 1], color: COL.wall },

    // site B : mur sud (porte x 15..20, bouchée par la caisse), mur nord (porte x 9..13)
    { pos: [11, 2, -2], size: [8, 4, 1], color: COL.wall },
    { pos: [22, 2, -2], size: [4, 4, 1], color: COL.wall },
    { pos: [8, 2, -20], size: [2, 4, 1], color: COL.wall },
    { pos: [18.5, 2, -20], size: [11, 4, 1], color: COL.wall },

    // muret central du mid : couvre la traversée sans couper la ligne de vue debout
    { pos: [0, 0.75, 0], size: [5, 1.5, 1], color: COL.crate },

    // la "porte" de B : caisse dans l'embrasure, on passe à gauche ou à droite (1.3 m)
    { pos: [17.5, 0.9, -2], size: [2.4, 1.8, 1.6], color: COL.crate },

    // caisses de site
    { pos: [-19, 0.6, -13], size: [1.2, 1.2, 1.2], color: COL.crate },
    { pos: [-10, 0.6, -8], size: [1.2, 1.2, 1.2], color: COL.crate },
    { pos: [19, 0.6, -13], size: [1.2, 1.2, 1.2], color: COL.crate },
    { pos: [10, 0.35, -9], size: [2, 0.7, 2], color: COL.crate },
  ],

  sites: [
    { name: 'A', min: { x: -20, z: -16 }, max: { x: -11, z: -6 } },
    { name: 'B', min: { x: 11, z: -16 }, max: { x: 20, z: -6 } },
  ],

  attack: { x: 0, z: 30, yaw: 0 },
  defense: { x: 0, z: -30, yaw: Math.PI },

  // Routes des bots (prompt 6). atk/def : du spawn au site ; rotAB : de A vers B
  // (inversée pour B -> A). Chaque segment est validé marchable par selftest.js.
  // atkB passe par x 15.65 : l'unique bande libre entre la porte et la caisse.
  nav: {
    atkA: [[-14, 24], [-18, 6], [-18, -4], [-15.5, -11]],
    atkB: [[14, 24], [15.65, 4], [15.65, -4], [15.5, -11]],
    defA: [[-11, -24], [-11, -16], [-15, -11]],
    defB: [[11, -24], [11, -16], [15, -11]],
    rotAB: [[-13, -14], [-11, -22], [11, -22], [11, -14], [15.5, -11]],
  },
};
