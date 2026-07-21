/**
 * tag-map.js — cartes + constantes de Tag Arena.
 * Module partagé : importé par le serveur (simulation des bots)
 * ET par le client (physique du joueur local, rendu).
 * Repère canvas : y vers le bas. (x, y) d'un joueur = milieu de ses pieds.
 *
 * 5 cartes (MAPS) — space, forest, ice, desert, volcano — qui reprennent
 * l'agencement de cartes du jeu "Tag 2" (références dans docs/map-compare/) :
 * silhouette des plateformes, rampes
 * rendues en escaliers, paire de portails-tourbillon (= teleporters) et bounce
 * pads, calés sur les dimensions de chaque carte. Les décors (arbres,
 * bannières, drapeaux…) sont thématiques et dessinés procéduralement par
 * render.js — il n'existe pas de type de décor plaçable. Tous les layouts sont
 * vérifiés par tests/map-validator.mjs (atteignabilité de chaque surface via
 * sauts/pads/téléporteurs, pads posés, sorties de téléporteurs posées, 4 spawns
 * posés).
 */

/** Taille de la fenêtre de rendu (viewport caméra) — les cartes sont plus grandes. */
export const VIEW = { width: 1280, height: 720 };

export const PHYS = {
  gravity: 1500,          // px/s²
  moveSpeed: 320,         // vitesse horizontale max (px/s)
  itSpeedMul: 1.55,       // le chat ("it") est nettement plus rapide pour pouvoir rattraper
  groundAccel: 2600,
  airAccel: 1700,
  groundFriction: 2400,
  airFriction: 400,
  jumpVel: 700,           // hauteur de saut ≈ 163 px (couches espacées de ~120 px)
  maxFall: 950,
  coyoteTime: 0.08,       // s de grâce pour sauter après avoir quitté un bord
  jumpBuffer: 0.12,       // s de mémorisation d'un appui saut avant l'atterrissage
  playerW: 34,
  playerH: 46,
  teleportCooldown: 1.0   // s avant de pouvoir re-téléporter (anti aller-retour)
};

export const TAG = {
  roundSeconds: 90,         // mode classique (1 contre 1) : durée de la manche
  eliminationSeconds: 30,   // mode élimination (3-4 joueurs) : le "it" explose toutes les 30 s
  // rallonge la DERNIÈRE seconde du décompte d'explosion (mode élimination) :
  // le cycle réel dure eliminationSeconds + 0,3 s, pour que le palier "💣 1s"
  // tienne 1,3 s et coïncide visuellement avec la fin du SFX bomb.m4a.
  lastSecondExtraMs: 300,
  distance: 56,             // distance centre-à-centre déclenchant un tag (marge anti-latence)
  immunitySeconds: 0.6,     // immunité du joueur qui vient d'être détaggé
  joinImmunitySeconds: 2.0, // immunité d'un humain qui rejoint une partie en cours
  maxPlayers: 4,
  minPlayers: 2
};

/* Types d'objets d'une carte :
 *  - ground       : { x, y, w, h }            sol solide pleine largeur
 *  - platforms[]  : { x, y, w, h }            plateformes one-way (haut solide,
 *                                             traversables par en dessous)
 *  - ramps[]      : { x1, y1, x2, y2 }         pente diagonale praticable : la
 *                   surface va du point (x1,y1) au point (x2,y2) (x1 < x2). Le y
 *                   de contact suit la pente (on marche dessus en montant/
 *                   descendant) ; one-way comme les plateformes. Sert aux rampes
 *                   et à la "bascule" statique. N'intervient pas dans le calcul
 *                   d'atteignabilité (les plateformes restent joignables au saut).
 *  - pads[]       : { id, x, y, w, h, power }  bounce pads (propulsion verticale)
 *  - teleporters[]: { id, x, y, w, h }         paire 0 ↔ 1 (portails-tourbillon)
 *  - spawns[]     : { x, y }                   points d'apparition (posés au sol)
 *
 * Les cartes : sol solide pleine largeur, plateformes one-way (traversables
 * par en dessous), bounce pads posés au sol, paire de téléporteurs (0 ↔ 1).
 * Les plateformes sont placées sur une grille verticale de paliers espacés de
 * 110px (palier 0 = atteignable directement depuis le sol), ce qui garantit
 * l'espacement vertical (>=70px) et l'atteignabilité par sauts successifs
 * (rise <= 138px, écart montant <= 100px). */
export const MAPS = [
  {
    // Réf. "halloween" Tag 2 : nuit sombre, escaliers de plateformes montants
    // de part et d'autre, deux portails. Adapté au thème "space" (ciel nocturne).
    id: 'space', name: 'Station Kepler', theme: 'space',
    width: 2480, height: 960,
    ground: { x: 0, y: 920, w: 2480, h: 40 },
    platforms: [
      // escalier montant gauche : marches serrées (adjacentes) du sol vers le haut
      { x: 80, y: 805, w: 150, h: 16 },
      { x: 230, y: 695, w: 150, h: 16 },
      { x: 380, y: 585, w: 150, h: 16 },
      { x: 530, y: 475, w: 150, h: 16 },
      // plateforme-portail centrale
      { x: 1080, y: 805, w: 200, h: 16 },
      // escalier montant droit : marches serrées, portail au sommet
      { x: 1700, y: 805, w: 150, h: 16 },
      { x: 1850, y: 695, w: 150, h: 16 },
      { x: 2000, y: 585, w: 150, h: 16 },
      { x: 2150, y: 475, w: 150, h: 16 }
    ],
    pads: [
      { id: 0, x: 760, y: 906, w: 80, h: 14, power: 1100 },
      { id: 1, x: 1540, y: 906, w: 80, h: 14, power: 1100 }
    ],
    teleporters: [
      { id: 0, x: 1140, y: 725, w: 30, h: 80 }, // sur la plateforme centrale
      { id: 1, x: 2210, y: 395, w: 30, h: 80 }  // au sommet de l'escalier droit
    ],
    spawns: [{ x: 200, y: 920 }, { x: 900, y: 920 }, { x: 1500, y: 920 }, { x: 2300, y: 920 }]
  },
  {
    // Réf. "forêt/jungle" Tag 2 : cluster élevé gauche (palmier), rampe
    // descendante vers le centre bas, plateforme centrale basse, plateforme
    // élevée droite (drapeau) sur un tronc.
    id: 'forest', name: 'Forêt de Wello', theme: 'forest',
    width: 2480, height: 960,
    ground: { x: 0, y: 920, w: 2480, h: 40 },
    platforms: [
      // cluster élevé gauche (palmier)
      { x: 80, y: 695, w: 220, h: 16 },
      { x: 120, y: 805, w: 160, h: 16 },  // base (accès au saut)
      // plateforme centrale basse
      { x: 1080, y: 805, w: 200, h: 16 },
      // plateforme élevée droite (drapeau) + base "tronc"
      { x: 1980, y: 695, w: 220, h: 16 },
      { x: 2010, y: 805, w: 160, h: 16 }
    ],
    ramps: [
      // LA rampe diagonale de la réf : bord droit de la plateforme gauche → sol
      { x1: 300, y1: 695, x2: 560, y2: 920 }
    ],
    pads: [
      { id: 0, x: 820, y: 906, w: 80, h: 14, power: 1100 },
      { id: 1, x: 1500, y: 906, w: 80, h: 14, power: 1100 }
    ],
    teleporters: [
      { id: 0, x: 700, y: 840, w: 30, h: 80 },   // au sol, zone centre-gauche
      { id: 1, x: 1760, y: 840, w: 30, h: 80 }   // au sol, zone centre-droite
    ],
    spawns: [{ x: 200, y: 920 }, { x: 900, y: 920 }, { x: 1500, y: 920 }, { x: 2300, y: 920 }]
  },
  {
    // Réf. "glace" Tag 2 : plateforme basse gauche (bonhomme de neige), deux
    // planches en rampe au centre-gauche, plateforme centrale (sapin) avec
    // portail, pilier droit surmonté d'un portail, plateforme haute extrême-droite.
    id: 'ice', name: 'Banquise Polaire', theme: 'ice',
    width: 2440, height: 960,
    ground: { x: 0, y: 920, w: 2440, h: 40 },
    platforms: [
      // basse gauche
      { x: 120, y: 805, w: 180, h: 16 },
      // plateforme centrale (sapin) + portail
      { x: 1000, y: 805, w: 240, h: 16 },
      // pilier droit (tour) surmonté d'un portail
      { x: 1560, y: 805, w: 160, h: 16 },
      { x: 1580, y: 695, w: 160, h: 16 },
      { x: 1600, y: 585, w: 160, h: 16 },
      // extrême-droite : arbre mort + plateforme haute
      { x: 1980, y: 805, w: 180, h: 16 },
      { x: 2180, y: 805, w: 180, h: 16 },
      { x: 2200, y: 695, w: 160, h: 16 },
      { x: 2220, y: 585, w: 140, h: 16 }
    ],
    ramps: [
      // les deux planches inclinées de la réf (forme en V touchant le sol)
      { x1: 360, y1: 740, x2: 600, y2: 920 },
      { x1: 640, y1: 920, x2: 880, y2: 740 }
    ],
    pads: [
      { id: 0, x: 300, y: 906, w: 80, h: 14, power: 1100 },
      { id: 1, x: 1300, y: 906, w: 80, h: 14, power: 1100 }
    ],
    teleporters: [
      { id: 0, x: 1010, y: 725, w: 30, h: 80 }, // sur la plateforme centrale (sapin)
      { id: 1, x: 1660, y: 505, w: 30, h: 80 }  // sommet du pilier droit
    ],
    spawns: [{ x: 200, y: 920 }, { x: 700, y: 920 }, { x: 1400, y: 920 }, { x: 2200, y: 920 }]
  },
  {
    // Réf. "désert/savane" Tag 2 : rocher élevé gauche (acacia + bannières),
    // portail-tourbillon au sol centre-gauche, longue plateforme centrale,
    // portail-anneau centre-droit, "bascule" (plank) + palmier sur rocher à droite.
    id: 'desert', name: 'Dunes Rouges', theme: 'desert',
    width: 2560, height: 960,
    ground: { x: 0, y: 920, w: 2560, h: 40 },
    platforms: [
      // gros rocher élevé gauche (acacia + bannières)
      { x: 120, y: 695, w: 200, h: 16 },
      { x: 140, y: 805, w: 160, h: 16 },  // base du rocher (accès au saut)
      // longue plateforme centrale
      { x: 1040, y: 805, w: 280, h: 16 },
      // petite plateforme portail centre-droit
      { x: 1640, y: 805, w: 180, h: 16 },
      // palmier sur rocher (extrême droite)
      { x: 2380, y: 805, w: 160, h: 16 }
    ],
    ramps: [
      // "bascule"/plank statique de la réf : extrémité gauche au sol, montante
      { x1: 2060, y1: 920, x2: 2320, y2: 820 }
    ],
    pads: [
      { id: 0, x: 560, y: 906, w: 80, h: 14, power: 1000 },
      { id: 1, x: 1340, y: 906, w: 80, h: 14, power: 1100 },
      { id: 2, x: 1920, y: 906, w: 80, h: 14, power: 1200 }
    ],
    teleporters: [
      { id: 0, x: 760, y: 840, w: 30, h: 80 },  // tourbillon au sol centre-gauche
      { id: 1, x: 1700, y: 725, w: 30, h: 80 }  // anneau sur la plateforme centre-droit
    ],
    spawns: [{ x: 200, y: 920 }, { x: 900, y: 920 }, { x: 1700, y: 920 }, { x: 2400, y: 920 }]
  },
  {
    // Réf. "volcan/lave" Tag 2 : colline montante gauche (drapeau) + portail au
    // sol, pont de plateformes flottantes au centre, portail-anneau centre-droit,
    // plateformes en escalier à droite.
    id: 'volcano', name: 'Cœur du Volcan', theme: 'volcano',
    width: 2440, height: 960,
    ground: { x: 0, y: 920, w: 2440, h: 40 },
    platforms: [
      // plateforme-drapeau élevée gauche (sommet de la colline) + base
      { x: 280, y: 695, w: 180, h: 16 },
      { x: 300, y: 805, w: 140, h: 16 },
      // pont central de plateformes flottantes
      { x: 760, y: 805, w: 200, h: 16 },
      { x: 1040, y: 805, w: 200, h: 16 },
      { x: 1320, y: 805, w: 200, h: 16 },
      // plateforme portail centre-droit
      { x: 1480, y: 805, w: 180, h: 16 },
      { x: 1500, y: 695, w: 160, h: 16 },
      // escalier droit
      { x: 1820, y: 805, w: 180, h: 16 },
      { x: 1860, y: 695, w: 160, h: 16 },
      { x: 1900, y: 585, w: 160, h: 16 },
      { x: 2120, y: 805, w: 180, h: 16 },
      { x: 2200, y: 695, w: 160, h: 16 }
    ],
    ramps: [
      // colline de lave montante (sol bas-gauche → sommet de la plateforme-drapeau)
      { x1: 40, y1: 920, x2: 300, y2: 695 }
    ],
    pads: [
      { id: 0, x: 600, y: 906, w: 80, h: 14, power: 1100 },
      { id: 1, x: 2000, y: 906, w: 80, h: 14, power: 1100 }
    ],
    teleporters: [
      { id: 0, x: 430, y: 840, w: 30, h: 80 },  // tourbillon au sol bas-gauche
      { id: 1, x: 1560, y: 615, w: 30, h: 80 }  // anneau sur la plateforme centre-droit
    ],
    spawns: [{ x: 200, y: 920 }, { x: 900, y: 920 }, { x: 1500, y: 920 }, { x: 2200, y: 920 }]
  }
];
