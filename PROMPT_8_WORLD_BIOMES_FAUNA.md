# Mine Coop — Prompt 8 : Monde, Biomes & Faune

Projet `game-portal` — portail **lexo.io** (toujours minuscules).  
`npm test` doit passer sans modification après ce prompt.

---

## Fichiers à lire en priorité

| Fichier | Pourquoi |
|---|---|
| `shared/mine-world.js` | generateWorld, GEN, BLOCK, BLOCK_META, valueNoise2, mulberry32 |
| `shared/mine-physics.js` | stepPlayer, aabbOverlap — les animaux utilisent la même physique |
| `server/games/mine-coop.js` | trySpawnZombie, tick, snapshot — les animaux suivent le même pattern que les zombies |
| `public/games/mine-coop/render.js` | Rendu des entités (joueurs/zombies) — les animaux sont rendus pareil |

---

## 1. Biomes

### 1a. Définition

Trois biomes déterminés par la position X dans le monde (découpage fixe, déterministe) :

| Biome | Colonnes X (indices tuiles) | Caractéristiques |
|---|---|---|
| `forest` | 0 .. 1399 et 2697 .. 4095 | Biome actuel (arbres fréquents, herbe, grottes normales) |
| `desert`  | 1400 .. 1799 et 2297 .. 2696 | Sable en surface, pas d'arbres, cactus décoratifs, grottes plus rares |
| `ocean`   | 1800 .. 2296 (centre du monde sauf spawn) | Eau (AIR bleu visuellement), fond sableux, pas d'arbres, zombies ne spawn pas |

> Le spawn (`SPAWN_TX = 2048`) est en bordure ocean/desert — légèrement dans la zone ocean. Pour éviter que le spawn soit dans l'eau, force le biome `forest` pour les colonnes `SPAWN_TX - GEN.spawnClearW .. SPAWN_TX + GEN.spawnClearW` (déjà aplaties par le plateau de spawn).

### 1b. Implémentation dans `shared/mine-world.js`

Ajouter la fonction de biome :
```js
/**
 * Retourne le biome pour une colonne X donnée (index tuile).
 * Résultat déterministe, pas de bruit — frontières nettes mais lissées via
 * une transition de ±20 tuiles.
 */
export function biomeAt(tx) {
  const cx = tx - WORLD_OFFSET_X;  // X centré
  const ax = Math.abs(cx);
  if (ax <= GEN.spawnClearW + 5) return 'forest';
  if (ax >= 650 && ax <= 900) return 'desert';   // zones désert symétriques
  if (ax <= 250) return 'ocean';                  // centre = océan (sauf spawn)
  return 'forest';
}
```

Ajouter le nouveau bloc :
```js
// Dans BLOCK :
WATER: 22,    // eau (non solide, visuelle, swimable en v1 = juste ralentit le joueur)
CACTUS: 23,   // cactus (solid = true, dégâts au contact)
SAND_DEEP: 15, // SAND déjà défini — pas de changement
```

Dans `BLOCK_META` :
```js
[BLOCK.WATER]: Bm({ solid: false, hardness: 0, drop: null, color: '#2a6fd4', shade: '#1a4a9a', light: false }),
[BLOCK.CACTUS]: Bm({ solid: true, hardness: 0.4, drop: BLOCK.CACTUS, color: '#3d8b3d', shade: '#2a6028' }),
```

Dans `ITEM_META` :
```js
[BLOCK.WATER]:  { name: 'Eau',    stack: 64, glyph: '💧' },
[BLOCK.CACTUS]: { name: 'Cactus', stack: 64, glyph: '🌵' },
```

### 1c. Modifications de `generateWorld` dans `shared/mine-world.js`

Modifier la génération pour tenir compte du biome de chaque colonne :

**Étape C (remplissage des colonnes)** — adapter selon le biome :
```js
for (let tx = 0; tx < WORLD_W; tx++) {
  const biome = biomeAt(tx);
  const top   = surface[tx];
  const base  = tx * WORLD_H;
  for (let ty = 0; ty < WORLD_H; ty++) {
    let v;
    if (ty < top) {
      // Eau dans l'océan (entre surface et un fond de sable)
      v = (biome === 'ocean' && ty >= top - 8) ? BLOCK.WATER : BLOCK.AIR;
    } else if (ty === top) {
      v = biome === 'desert' ? BLOCK.SAND :
          biome === 'ocean'  ? BLOCK.SAND : BLOCK.GRASS;
    } else if (ty <= top + GEN.dirtBand) {
      v = biome === 'desert' || biome === 'ocean' ? BLOCK.SAND : BLOCK.DIRT;
    } else if (ty >= WORLD_H - GEN.bedrockRows) {
      v = BLOCK.BEDROCK;
    } else {
      v = BLOCK.STONE;
    }
    world[base + ty] = v;
  }
}
```

**Étape D (grottes)** — pas de grottes dans l'océan (déjà sous l'eau) :
```js
if (biomeAt(tx) === 'ocean') continue;
```

**Étape F (arbres)** — pas d'arbres dans le désert ni l'océan :
```js
if (biome === 'desert' || biome === 'ocean') continue;
```

**Nouvelle étape G' (cactus dans le désert)** — après les arbres :
```js
for (let tx = 2; tx < WORLD_W - 2; tx++) {
  if (biomeAt(tx) !== 'desert') continue;
  if (rng() > 0.04) continue;              // ~4% de colonnes désert = cactus
  const top = surface[tx];
  if (world[tx * WORLD_H + top] !== BLOCK.SAND) continue;
  const height = 2 + Math.floor(rng() * 2); // cactus 2 ou 3 blocs de haut
  for (let k = 1; k <= height; k++)
    if (inBounds(tx, top - k)) world[tx * WORLD_H + (top - k)] = BLOCK.CACTUS;
}
```

### 1d. Effets du biome en jeu (serveur)

**Eau (BLOCK.WATER)** — dans `mine-physics.js` ou `mine-coop.js` :
- Si le joueur est dans une tuile d'eau : `moveSpeed *= 0.4`, `gravity *= 0.3`, `jumpVel *= 0.6`.
- Pas de noyade en v1.

**Cactus** — dans `tick` (comme les zombies, au contact) :
```js
// Dégâts cactus : si le joueur touche une tuile CACTUS
for (const p of players.values()) {
  const tx = pxToTileX(p.x), ty = pxToTileY(p.y - MINE.playerH / 2);
  for (const [dtx, dty] of [[0,0],[0,1],[1,0],[-1,0]]) {
    if (blockAt(world, tx+dtx, ty+dty) === BLOCK.CACTUS) {
      if (p.hurtCd <= 0) {
        p.hp = Math.max(0, p.hp - 1);
        p.hurtCd = 0.5;
        emitTo(p.id, 'mine:hp', { id: p.id, hp: p.hp });
        emit('mine:hp',           { id: p.id, hp: p.hp });
        if (p.hp <= 0) respawnPlayer(p);
      }
      break;
    }
  }
}
```

**Zombies dans l'océan** — pas de spawn :
```js
// Dans trySpawnZombie
if (biomeAt(pxToTileX(p.x)) === 'ocean') return;
```

---

## 2. Grottes améliorées

### 2a. Second couche de grottes (tunnels)

En plus du bruit de grottes actuel (bruit 2D), ajouter des **tunnels vermiculaires** :

Dans `generateWorld`, nouvelle étape après les grottes actuelles (D'), avant les minerais :

```js
// Tunnels serpentins : marche aléatoire dans la pierre
const TUNNEL_COUNT = 80;
for (let t = 0; t < TUNNEL_COUNT; t++) {
  let tx = 2 + Math.floor(rng() * (WORLD_W - 4));
  let ty = surface[tx] + 10 + Math.floor(rng() * (WORLD_H - surface[tx] - 20));
  let angle = rng() * Math.PI * 2;
  const len = 20 + Math.floor(rng() * 40);
  for (let step = 0; step < len; step++) {
    angle += (rng() - 0.5) * 0.8;  // virage progressif
    tx = Math.round(tx + Math.cos(angle));
    ty = Math.round(ty + Math.sin(angle) * 0.6);  // plus horizontal que vertical
    if (!inBounds(tx, ty) || ty >= WORLD_H - GEN.bedrockRows) break;
    if (world[tileIndex(tx, ty)] === BLOCK.STONE) world[tileIndex(tx, ty)] = BLOCK.AIR;
    // Tunnel de rayon 1 (3×3 autour du point central)
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        if (inBounds(tx+dx, ty+dy) && world[tileIndex(tx+dx,ty+dy)] === BLOCK.STONE)
          world[tileIndex(tx+dx, ty+dy)] = BLOCK.AIR;
  }
}
```

---

## 3. Faune — animaux passifs

### 3a. Types d'animaux

| Animal | Glyph rendu | HP | Drop (mort) | Comportement |
|---|---|---|---|---|
| Poule (`chicken`) | 🐔 22×22 px | 4 | Plumes (aucun item v1) | Marche aléatoire, saute rarement |
| Vache (`cow`) | 🐄 26×30 px | 10 | Cuir (aucun item v1) | Marche lente, ne saute pas |
| Mouton (`sheep`) | 🐑 24×26 px | 8 | Laine (aucun item v1) | Marche lente, broute (immobile parfois) |
| Cochon (`pig`) | 🐷 24×24 px | 10 | (rien v1) | Marche lente |

> **Note v1** : les drops sont définis dans le code mais les items (cuir, laine, plumes) n'existent pas encore comme items dans `mine-world.js`. Pour la v1, les animaux ne lâchent **rien** à la mort — l'infrastructure existe pour ajouter les drops dans un prompt futur. Ajouter un commentaire `// TODO: drop item` à ces endroits.

### 3b. Items futurs à réserver dans `ITEM` (ajouter l'espace mais ne pas implémenter)

```js
// Dans ITEM (réservé pour Prompt 8+ drops) :
// LEATHER: 200, WOOL: 201, FEATHER: 202, PORK: 203, BEEF: 204, EGG: 205
// (Ne pas les ajouter maintenant — juste commenter pour référence)
```

### 3c. Structure de données (`server/games/mine-coop.js`)

Ajouter une nouvelle Map dans `createMineGame` :
```js
const animals = new Map();   // aid -> animal record
let   aSeq    = 1;
let   aSpawnTimer = 0;
const ANIMAL_CAP = 20;       // max d'animaux en vie simultanément
const ANIMAL_SPAWN_EVERY = 8; // s entre tentatives de spawn
```

Structure d'un animal :
```js
{
  id: 'a' + (aSeq++),
  type: 'chicken'|'cow'|'sheep'|'pig',
  x, y,          // px
  vx: 0, vy: 0,  // px/s
  f: 1,          // direction (-1 gauche / 1 droite)
  onGround: false,
  hp, maxHp,
  // IA
  walkDir: 0,    // -1, 0 ou 1
  walkTimer: 0,  // s avant de changer de direction
  idleTimer: 0,  // s d'immobilité restantes
}
```

Constantes par type :
```js
const ANIMAL_META = {
  chicken: { hp: 4,  w: 22, h: 22, speed: 120, jumpChance: 0.02 },
  cow:     { hp: 10, w: 26, h: 30, speed:  80, jumpChance: 0    },
  sheep:   { hp: 8,  w: 24, h: 26, speed:  70, jumpChance: 0    },
  pig:     { hp: 10, w: 24, h: 24, speed:  90, jumpChance: 0.01 },
};
const ANIMAL_TYPES = ['chicken', 'cow', 'sheep', 'pig'];
```

### 3d. IA des animaux (dans `tick`)

```js
// Spawn d'animaux
aSpawnTimer -= dt;
if (aSpawnTimer <= 0 && animals.size < ANIMAL_CAP) {
  aSpawnTimer = ANIMAL_SPAWN_EVERY;
  trySpawnAnimal();
}

// Mise à jour de chaque animal
for (const [aid, a] of animals) {
  const meta = ANIMAL_META[a.type];
  // Physique (réutilise stepPlayer mais avec hitbox animale)
  const state = { x: a.x, y: a.y, vx: a.vx, vy: a.vy,
                  onGround: a.onGround, coyote: 0, jumpBuf: 0 };
  const animalMine = { ...MINE, playerW: meta.w, playerH: meta.h,
                        moveSpeed: meta.speed, jumpVel: 400 };
  stepPlayer(state, world, dt, { left: a.walkDir < 0, right: a.walkDir > 0, jump: false }, animalMine);
  a.x = state.x; a.y = state.y; a.vx = state.vx; a.vy = state.vy;
  a.onGround = state.onGround;

  // Saut aléatoire (poule/cochon)
  if (a.onGround && meta.jumpChance > 0 && Math.random() < meta.jumpChance) {
    a.vy = -350;
    a.onGround = false;
  }

  // Changement de direction IA
  a.walkTimer -= dt;
  if (a.walkTimer <= 0) {
    const r = Math.random();
    if (r < 0.3)      { a.walkDir = 0;  a.walkTimer = 1 + Math.random() * 2; } // pause
    else if (r < 0.65){ a.walkDir = 1;  a.walkTimer = 2 + Math.random() * 3; } // droite
    else               { a.walkDir = -1; a.walkTimer = 2 + Math.random() * 3; } // gauche
    if (a.walkDir !== 0) a.f = a.walkDir;
  }

  // Évitement des bords de monde
  if (a.x < 2 * TILE)             a.walkDir = 1;
  if (a.x > (WORLD_W - 2) * TILE) a.walkDir = -1;

  // Biome : pas d'animaux dans l'océan
  if (biomeAt(pxToTileX(a.x)) === 'ocean') { animals.delete(aid); continue; }
}
```

```js
function trySpawnAnimal() {
  // Cherche un joueur au hasard, spawn proche
  const pArr = [...players.values()];
  if (!pArr.length) return;
  const p = pArr[Math.floor(Math.random() * pArr.length)];
  const side = Math.random() < 0.5 ? -1 : 1;
  const dist = 15 + Math.floor(Math.random() * 20);
  const tx = clampTileX(pxToTileX(p.x) + side * dist);
  if (biomeAt(tx) === 'ocean') return;
  const sy = surfaceYAt(tx);
  if (sy >= WORLD_H - 1) return;
  // 2 tuiles d'air disponibles
  if (solidAt(world, tx, sy - 1) || solidAt(world, tx, sy - 2)) return;
  const type = ANIMAL_TYPES[Math.floor(Math.random() * ANIMAL_TYPES.length)];
  const meta = ANIMAL_META[type];
  animals.set('a' + aSeq, {
    id: 'a' + aSeq++, type,
    x: tx * TILE + TILE / 2, y: sy * TILE,
    vx: 0, vy: 0, f: 1, onGround: false,
    hp: meta.hp, maxHp: meta.hp,
    walkDir: 0, walkTimer: 1, idleTimer: 0
  });
}
```

### 3e. Attaque des animaux — `handleAttack`

Modifier `handleAttack` pour gérer aussi les animaux (en plus des zombies) :

```js
// data.targetId peut être un animal ('a...') ou un zombie ('z...')
if (data.targetId.startsWith('a')) {
  const a = animals.get(data.targetId);
  if (!a) return;
  // Vérifier portée
  if (!withinReach(p, pxToTileX(a.x), pxToTileY(a.y))) return;
  // Calculer dégâts selon outil
  const tool = toolMeta(heldItem(p.inv)?.item);
  const tier = tool?.tier ?? 0;
  const dmg = ZOMBIE.swordDmg[tier] ?? 5;   // réutilise la table sword
  a.hp -= dmg;
  p.stats.damage_dealt += dmg;
  if (a.hp <= 0) {
    animals.delete(data.targetId);
    emit('mine:animalDead', { id: data.targetId });
    // TODO: drop item (cuir, laine, etc.)
  } else {
    emit('mine:animalHit', { id: data.targetId, hp: a.hp });
    // Fuite : l'animal s'écarte du joueur frappeur
    a.walkDir = a.x < p.x ? -1 : 1;
    a.walkTimer = 3;
  }
}
```

### 3f. Snapshot — inclure les animaux

Dans `snapshot()` :
```js
animals: [...animals.values()].map(a => ({
  id: a.id, type: a.type, x: r1(a.x), y: r1(a.y), f: a.f, hp: a.hp
}))
```

### 3g. Sauvegarde des animaux

Les animaux **ne sont pas sauvegardés** (ils respawnent naturellement). Pas de modification à `save()`.

---

## 4. Rendu des animaux (`render.js`)

Dans `render.js`, les animaux reçus dans `mine:state` (champ `animals`) sont rendus comme les zombies mais avec un emoji/glyph différent selon le type.

### Glyphs et couleurs par type

| Type | Couleur corps | Glyph au-dessus |
|---|---|---|
| `chicken` | `#f5deb3` (beige) | 🐔 |
| `cow` | `#8b4513` (brun) | 🐄 |
| `sheep` | `#d3d3d3` (gris clair) | 🐑 |
| `pig` | `#ffb6c1` (rose) | 🐷 |

```js
function drawAnimals(ctx, animals, camX, camY) {
  for (const a of animals) {
    const sx = a.x - camX;
    const sy = a.y - camY;
    const meta = { chicken:{w:22,h:22}, cow:{w:26,h:30}, sheep:{w:24,h:26}, pig:{w:24,h:24} }[a.type];
    const color = { chicken:'#f5deb3', cow:'#8b4513', sheep:'#d3d3d3', pig:'#ffb6c1' }[a.type];
    const glyph = { chicken:'🐔', cow:'🐄', sheep:'🐑', pig:'🐷' }[a.type];
    if (!meta) continue;

    // Corps
    ctx.fillStyle = color;
    ctx.fillRect(sx - meta.w/2, sy - meta.h, meta.w, meta.h);
    // Contour
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx - meta.w/2, sy - meta.h, meta.w, meta.h);

    // Glyph au-dessus
    ctx.font = '14px serif';
    ctx.textAlign = 'center';
    ctx.fillText(glyph, sx, sy - meta.h - 4);

    // Barre de vie si blessé
    if (a.hp < ANIMAL_META_CLIENT[a.type]?.maxHp) {
      const bw = meta.w + 6, bh = 4;
      const bx = sx - bw/2, by = sy - meta.h - 12;
      ctx.fillStyle = '#300';
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = '#3c3';
      ctx.fillRect(bx, by, bw * (a.hp / (ANIMAL_META_CLIENT[a.type]?.maxHp ?? 10)), bh);
    }
  }
}
```

Ajouter côté client dans `main.js` ou `render.js` :
```js
const ANIMAL_META_CLIENT = {
  chicken: { maxHp: 4  },
  cow:     { maxHp: 10 },
  sheep:   { maxHp: 8  },
  pig:     { maxHp: 10 },
};
```

---

## 5. Optimisation performance

### 5a. Rendu — ne pas redessiner ce qui n'a pas changé (dirty regions)

Pour cette v1 simplifiée : s'assurer que la boucle de rendu **ne dessine que les tuiles dans le viewport + marge de 2 tuiles** (normalement déjà le cas). Vérifier qu'il n'y a pas de boucle sur tout le monde.

### 5b. `mine:state` — envoyer seulement les entités proches de chaque joueur

Dans `snapshot()`, au lieu d'envoyer **tous** les zombies et animaux, filtrer par joueur : envoyer seulement les entités dans un rayon de 30 tuiles du joueur.

Modifier le handler `mine:state` dans `tick` pour envoyer un snapshot personnalisé par joueur :
```js
// Au lieu de : emit('mine:state', snapshot())
// Faire :
for (const p of players.values()) {
  const VIEW_TILES = 30;
  const px = p.x, py = p.y;
  const nearZombies = [...zombies.values()].filter(z =>
    Math.abs(z.x - px) < VIEW_TILES * TILE && Math.abs(z.y - py) < VIEW_TILES * TILE
  );
  const nearAnimals = [...animals.values()].filter(a =>
    Math.abs(a.x - px) < VIEW_TILES * TILE && Math.abs(a.y - py) < VIEW_TILES * TILE
  );
  emitTo(p.id, 'mine:state', {
    day: dayTime,
    players: [...players.values()].map(q => ({
      id: q.id, name: q.name, x: r1(q.x), y: r1(q.y),
      vx: r1(q.vx), vy: r1(q.vy), f: q.f, hp: q.hp
    })),
    zombies: nearZombies.map(z => ({ id: z.id, x: r1(z.x), y: r1(z.y), f: z.f, hp: z.hp })),
    animals: nearAnimals.map(a => ({ id: a.id, type: a.type, x: r1(a.x), y: r1(a.y), f: a.f, hp: a.hp })),
  });
}
```

### 5c. Chunk cache — éviter les requêtes en double

Dans `main.js` client, s'assurer que le cache de chunks n'envoie pas de `mine:chunkRequest` pour un chunk déjà en attente de réponse (pas encore reçu mais déjà demandé) :
```js
const pendingChunks = new Set();  // clés 'cx,cy' en cours de chargement
// Avant d'émettre mine:chunkRequest :
if (!chunkCache.has(key) && !pendingChunks.has(key)) {
  pendingChunks.add(key);
  socket.emit('mine:chunkRequest', { cx, cy });
}
// Sur réception mine:chunkData :
pendingChunks.delete(key);
chunkCache.set(key, data);
```

---

## 6. Rendu biome dans le ciel et arrière-plan

Le ciel change de couleur selon le biome où se trouve le joueur local :
- **forest** : bleu clair habituel (`#5ba8e8`)
- **desert** : teinte légèrement plus chaude/orangée (`#7abcec`)
- **ocean** : bleu plus profond (`#3a90d8`), avec une légère ondulation dans l'eau (les tuiles WATER ont déjà une couleur distincte)

Ajouter dans `render.js` :
```js
// En haut de drawSky(ctx, dayTime, playerBiome) :
const baseSkyDay = playerBiome === 'desert' ? [122, 188, 236]
                 : playerBiome === 'ocean'  ? [ 58, 144, 216]
                 : [ 91, 168, 232];  // forest (défaut)
```

---

## 7. Critères de succès

1. `npm test` passe sans erreur.
2. **Biomes** : en partant du spawn vers la gauche/droite, le terrain change (sable, eau). Les frontières sont visibles.
3. **Océan** : pas de zombies ni d'animaux dans la zone centrale (eau). Le joueur se déplace plus lentement dans l'eau.
4. **Désert** : cactus visibles sur le sable. Marcher dans un cactus inflige 1 HP/demi-seconde.
5. **Grottes améliorées** : tunnels horizontaux visibles en plus des grottes rondes de la génération précédente.
6. **Animaux** : 4 types apparaissent dans les biomes forest/desert. Ils marchent, changent de direction, restent à la surface. Frapper un animal avec une épée → perd des HP → disparaît quand HP ≤ 0.
7. **Snapshot filtré** : avec 20+ animaux en jeu, l'inspecteur réseau du navigateur montre que chaque `mine:state` ne contient que les entités proches du joueur (pas 20 animaux à 500 tuiles de distance).
8. **Performance** : avec monde généré + animaux, pas de chute notable de FPS par rapport à avant.
