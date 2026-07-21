# Mine Coop — Prompt 5 : Inventaire, Craft, Coffre, ESC, Stats

Projet `game-portal` — portail **lexo.io** (toujours en minuscules strictes).  
Lit les fichiers indiqués avant d'écrire une ligne. Le back-end et le client v1 existent déjà.  
Ce prompt étend le jeu sans casser Tag Arena ni les tests existants (`npm test` doit passer).

---

## Fichiers à lire en priorité

| Fichier | Pourquoi |
|---|---|
| `shared/mine-world.js` | BLOCK/ITEM IDs, BLOCK_META, ITEM_META, RECIPES, helpers inventaire |
| `server/games/mine-coop.js` | Handlers existants, structure `player`, `save()`, `setBlock()` |
| `server/server.js` | Registre GAMES, routage `mine:*`, helper `routeMine` |
| `public/games/mine-coop/main.js` | Gestion clavier, boucle, socket events |
| `public/games/mine-coop/render.js` | Rendu hotbar, HUD |
| `tests/smoke-mine.mjs` | Tests existants à ne PAS casser |

---

## 1. Nouveaux blocs & items — `shared/mine-world.js`

### 1a. Nouveaux IDs de BLOCS (ajouter à BLOCK, ne jamais renuméroter les existants)

```js
// Existants jusqu'à TORCH: 16
CHEST:  17,   // coffre (partagé coop)
GLASS:  18,   // verre (sable fondu)
LADDER: 19,   // échelle (solid = false, grimpable — pour v1 : solid = false, pas de gravité au contact)
FENCE:  20,   // clôture (solid = true, hauteur réduite visuellement mais hitbox pleine tuile en v1)
DOOR:   21,   // porte (1 tuile, solid = false quand "ouverte" — pour v1 : solid = false, décoratif)
```

### 1b. Nouveaux IDs d'ITEMS (ajouter à ITEM, tous ≥ 100, après IRON_SWORD: 132)

```js
WOOD_SHOVEL:  133,
STONE_SHOVEL: 134,
IRON_SHOVEL:  135,
```

### 1c. BLOCK_META — ajouter les entrées pour les nouveaux blocs

```js
[BLOCK.CHEST]:  Bm({ hardness: 2.5, tool: 'axe', drop: BLOCK.CHEST,  color: '#8B6914', shade: '#5c430d' }),
[BLOCK.GLASS]:  Bm({ hardness: 0.3, tool: null,   drop: null,         color: '#c8e8f8', shade: '#8abccc', light: false }),
// GLASS ne drop rien (comme Minecraft sans Silk Touch)
[BLOCK.LADDER]: Bm({ solid: false,  hardness: 0.4, tool: 'axe', drop: BLOCK.LADDER, color: '#a07840', shade: '#6d5228', light: false }),
[BLOCK.FENCE]:  Bm({ hardness: 2.0, tool: 'axe',  drop: BLOCK.FENCE,  color: '#b88a4e', shade: '#956d3a' }),
[BLOCK.DOOR]:   Bm({ solid: false,  hardness: 3.0, tool: 'axe', drop: BLOCK.DOOR,   color: '#b88a4e', shade: '#956d3a', light: false }),
```

### 1d. ITEM_META — ajouter les entrées pour les nouveaux items et blocs

```js
// Nouveaux blocs (dans ITEM_META)
[BLOCK.CHEST]:  { name: 'Coffre',   stack: 64, glyph: '📦' },
[BLOCK.GLASS]:  { name: 'Verre',    stack: 64, glyph: '🪟' },
[BLOCK.LADDER]: { name: 'Échelle',  stack: 64, glyph: '🪜' },
[BLOCK.FENCE]:  { name: 'Clôture', stack: 64, glyph: '🚧' },
[BLOCK.DOOR]:   { name: 'Porte',    stack: 64, glyph: '🚪' },
// Nouvelles pelles (stack 1, comme tous les outils)
[ITEM.WOOD_SHOVEL]:  { name: 'Pelle en bois',   stack: 1, tool: 'shovel', tier: TIER.WOOD,  glyph: '⛏️' },
[ITEM.STONE_SHOVEL]: { name: 'Pelle en pierre', stack: 1, tool: 'shovel', tier: TIER.STONE, glyph: '⛏️' },
[ITEM.IRON_SHOVEL]:  { name: 'Pelle en fer',    stack: 1, tool: 'shovel', tier: TIER.IRON,  glyph: '⛏️' },
```

Pour DIRT, GRASS, SAND : garde `tool: null` (minables à la main ou avec n'importe quel outil).  
La pelle donne un bonus de vitesse via le chemin `m.tool === null → speed = TIER_SPEED[tier]` déjà en place — pas besoin de modifier la formule.

---

## 2. Système de craft — remplacement par grilles positionnelles

### 2a. Nouveau format de recette dans `shared/mine-world.js`

Remplace le tableau `RECIPES` existant (shapeless) par un nouveau format qui supporte les deux styles :

```js
/**
 * Recette façonnée (shaped) : `pattern` est un tableau de chaînes, chaque
 * caractère = une cellule (de gauche à droite), `_` = vide.
 * Recette sans forme (shapeless) : `shapeless: true` + `in: [[itemId,count],...]`.
 *
 * La correspondance est tentée dans les deux sens miroir horizontal (pour les
 * haches/pelles qui ont une version gauche et droite dans Minecraft).
 *
 * station: 'none' = grille 2×2 dans l'inventaire (max 2 lignes de 2 colonnes)
 *          'table' = grille 3×3 à l'établi (max 3 lignes de 3 colonnes)
 */
export const RECIPES = [
  // ── 2×2 (inventaire) ─────────────────────────────────────────────────────
  { id: 'planks',         station: 'none', shapeless: true,
    in: [[BLOCK.LOG, 1]], out: [BLOCK.PLANKS, 4] },
  { id: 'sticks',         station: 'none',
    pattern: ['P_', 'P_'], key: { P: BLOCK.PLANKS }, out: [ITEM.STICK, 4] },
  { id: 'crafting_table', station: 'none',
    pattern: ['PP', 'PP'], key: { P: BLOCK.PLANKS }, out: [BLOCK.CRAFTING_TABLE, 1] },
  { id: 'torch',          station: 'none', shapeless: true,
    in: [[ITEM.COAL, 1], [ITEM.STICK, 1]], out: [BLOCK.TORCH, 4] },
  { id: 'torch_charcoal', station: 'none', shapeless: true,
    in: [[ITEM.CHARCOAL, 1], [ITEM.STICK, 1]], out: [BLOCK.TORCH, 4] },

  // ── 3×3 (établi) ─────────────────────────────────────────────────────────
  // Outils bois (P=PLANKS, S=STICK)
  { id: 'wood_pickaxe',   station: 'table',
    pattern: ['PPP', '_S_', '_S_'], key: { P: BLOCK.PLANKS, S: ITEM.STICK }, out: [ITEM.WOOD_PICKAXE,  1] },
  { id: 'wood_axe',       station: 'table',
    pattern: ['PP_', 'PS_', '_S_'], key: { P: BLOCK.PLANKS, S: ITEM.STICK }, out: [ITEM.WOOD_AXE,      1] },
  { id: 'wood_sword',     station: 'table',
    pattern: ['_P_', '_P_', '_S_'], key: { P: BLOCK.PLANKS, S: ITEM.STICK }, out: [ITEM.WOOD_SWORD,    1] },
  { id: 'wood_shovel',    station: 'table',
    pattern: ['_P_', '_S_', '_S_'], key: { P: BLOCK.PLANKS, S: ITEM.STICK }, out: [ITEM.WOOD_SHOVEL,   1] },
  // Outils pierre (C=COBBLE, S=STICK)
  { id: 'stone_pickaxe',  station: 'table',
    pattern: ['CCC', '_S_', '_S_'], key: { C: BLOCK.COBBLE, S: ITEM.STICK }, out: [ITEM.STONE_PICKAXE, 1] },
  { id: 'stone_axe',      station: 'table',
    pattern: ['CC_', 'CS_', '_S_'], key: { C: BLOCK.COBBLE, S: ITEM.STICK }, out: [ITEM.STONE_AXE,     1] },
  { id: 'stone_sword',    station: 'table',
    pattern: ['_C_', '_C_', '_S_'], key: { C: BLOCK.COBBLE, S: ITEM.STICK }, out: [ITEM.STONE_SWORD,   1] },
  { id: 'stone_shovel',   station: 'table',
    pattern: ['_C_', '_S_', '_S_'], key: { C: BLOCK.COBBLE, S: ITEM.STICK }, out: [ITEM.STONE_SHOVEL,  1] },
  // Outils fer (I=IRON_INGOT, S=STICK)
  { id: 'iron_pickaxe',   station: 'table',
    pattern: ['III', '_S_', '_S_'], key: { I: ITEM.IRON_INGOT, S: ITEM.STICK }, out: [ITEM.IRON_PICKAXE,  1] },
  { id: 'iron_axe',       station: 'table',
    pattern: ['II_', 'IS_', '_S_'], key: { I: ITEM.IRON_INGOT, S: ITEM.STICK }, out: [ITEM.IRON_AXE,      1] },
  { id: 'iron_sword',     station: 'table',
    pattern: ['_I_', '_I_', '_S_'], key: { I: ITEM.IRON_INGOT, S: ITEM.STICK }, out: [ITEM.IRON_SWORD,    1] },
  { id: 'iron_shovel',    station: 'table',
    pattern: ['_I_', '_S_', '_S_'], key: { I: ITEM.IRON_INGOT, S: ITEM.STICK }, out: [ITEM.IRON_SHOVEL,   1] },
  // Structures (C=COBBLE, P=PLANKS, S=STICK)
  { id: 'furnace',        station: 'table',
    pattern: ['CCC', 'C_C', 'CCC'], key: { C: BLOCK.COBBLE  }, out: [BLOCK.FURNACE, 1] },
  { id: 'chest',          station: 'table',
    pattern: ['PPP', 'P_P', 'PPP'], key: { P: BLOCK.PLANKS  }, out: [BLOCK.CHEST,   1] },
  { id: 'ladder',         station: 'table',
    pattern: ['S_S', 'SSS', 'S_S'], key: { S: ITEM.STICK    }, out: [BLOCK.LADDER,  3] },
  { id: 'fence',          station: 'table',
    pattern: ['___', 'PSP', 'PSP'], key: { P: BLOCK.PLANKS, S: ITEM.STICK }, out: [BLOCK.FENCE, 3] },
  { id: 'door',           station: 'table',
    pattern: ['PP_', 'PP_', 'PP_'], key: { P: BLOCK.PLANKS  }, out: [BLOCK.DOOR,    3] },
];
```

Garde `RECIPE_BY_ID` (utilisé par le serveur) :
```js
export const RECIPE_BY_ID = Object.freeze(Object.fromEntries(RECIPES.map(r => [r.id, r])));
```

### 2b. Fonction `matchRecipe` à ajouter dans `shared/mine-world.js`

```js
/**
 * Vérifie si une grille de craft correspond à une recette.
 *
 * @param grid   Tableau plat de slots (Array(4) pour 2×2, Array(9) pour 3×3).
 *               Chaque élément = { item: itemId, count } | null.
 * @param stationAvailable  'none' | 'table'
 * @returns recette correspondante ou null
 *
 * Algorithme :
 * 1. Extrait la bounding-box non vide de la grille (supprime rangées/colonnes vides).
 * 2. Pour chaque recette dont station <= stationAvailable :
 *    a. Extrait la bounding-box du pattern de la recette.
 *    b. Compare dimensions.
 *    c. Tente la correspondance normale, puis en miroir horizontal.
 *    d. Pour les recettes shapeless : vérifie que la grille contient exactement les
 *       ingrédients requis (en totalisant par itemId), rien de plus.
 */
export function matchRecipe(grid, stationAvailable) {
  const size = grid.length === 4 ? 2 : 3;
  const stationRank = { none: 0, table: 1 };
  const rank = stationRank[stationAvailable] ?? 0;

  for (const r of RECIPES) {
    if (stationRank[r.station] > rank) continue;

    if (r.shapeless) {
      // Vérifie que la grille contient exactement les ingrédients
      const have = {};
      for (const s of grid) if (s) have[s.item] = (have[s.item] || 0) + s.count;
      let ok = true;
      for (const [id, need] of r.in) {
        if ((have[id] || 0) < need) { ok = false; break; }
        have[id] -= need;
      }
      // Rien de plus dans la grille
      if (ok && Object.values(have).every(v => v === 0)) return r;
      continue;
    }

    // Shaped : extraire la bounding box du pattern
    const pRows = r.pattern;
    const pCols = pRows[0].length;
    const pR = pRows.length;

    // Extraire la bounding box de la grille remplie
    let minR = size, maxR = -1, minC = size, maxC = -1;
    for (let row = 0; row < size; row++)
      for (let col = 0; col < size; col++)
        if (grid[row * size + col]) {
          minR = Math.min(minR, row); maxR = Math.max(maxR, row);
          minC = Math.min(minC, col); maxC = Math.max(maxC, col);
        }
    if (maxR < 0) continue; // grille vide

    const gR = maxR - minR + 1;
    const gC = maxC - minC + 1;
    if (gR !== pR || gC !== pCols) continue;

    // Essaie normal + miroir horizontal
    for (const mirror of [false, true]) {
      let match = true;
      for (let row = 0; row < pR && match; row++) {
        for (let col = 0; col < pCols && match; col++) {
          const pc = mirror ? pCols - 1 - col : col;
          const ch = pRows[row][pc];
          const slot = grid[(minR + row) * size + (minC + col)];
          if (ch === '_') { if (slot) match = false; }
          else {
            const need = r.key[ch];
            if (!slot || slot.item !== need) match = false;
          }
        }
      }
      if (match) return r;
    }
  }
  return null;
}
```

### 2c. Helper coffre

```js
/** Crée un contenu de coffre vide (27 slots). */
export const makeChestContents = () => new Array(27).fill(null);
```

---

## 3. Modifications `server/games/mine-coop.js`

### 3a. Nouvel import

Ajouter à la ligne d'import de `mine-world.js` :
```js
BLOCK.CHEST, BLOCK.GLASS, BLOCK.LADDER, BLOCK.FENCE, BLOCK.DOOR,
ITEM.WOOD_SHOVEL, ITEM.STONE_SHOVEL, ITEM.IRON_SHOVEL,
matchRecipe, makeChestContents, stackOf,
```
(Adapter la ligne `import {` existante — ne pas créer un second import.)

### 3b. État du jeu — coffres et stats

Dans `createMineGame`, ajouter juste après la déclaration de `world, seed, dayTime` :

```js
const chests = new Map();  // clé 'tx,ty' → Array(27) (slots)
```

Lors du rechargement depuis `opts.save`, restaurer les coffres :
```js
if (opts.save.chests) {
  for (const [key, slots] of Object.entries(opts.save.chests))
    chests.set(key, slots);
}
```

Dans la structure de chaque joueur `p`, ajouter :
```js
stats: {
  blocks_mined: {}, blocks_placed: {},
  items_crafted: {}, zombies_killed: 0,
  damage_dealt: 0,  damage_taken: 0,
  distance_walked: 0, jumps: 0,
  playtime_seconds: 0, manual_saves: 0
}
```
(Restaurer depuis `opts.save.playerStats?.[name]` si disponible.)

### 3c. Instrumentation des stats dans les handlers existants

Dans `handleBreak` (quand le bloc est cassé et un drop est ajouté) :
```js
p.stats.blocks_mined[block] = (p.stats.blocks_mined[block] || 0) + 1;
```

Dans `handlePlace` (quand un bloc est posé) :
```js
p.stats.blocks_placed[item] = (p.stats.blocks_placed[item] || 0) + 1;
```

Dans `handleAttack` (quand un zombie est tué) :
```js
p.stats.zombies_killed++;
p.stats.damage_dealt += dmg;
```

Dans la logique de dégâts zombies (quand un joueur est touché) :
```js
p.stats.damage_taken += ZOMBIE.dmg;
```

Dans `tick`, chaque ~1 s :
```js
for (const p of players.values()) p.stats.playtime_seconds += dt;
```

### 3d. Nouveaux handlers à ajouter

#### `handleInvMove(id, data)`
Déplace un slot dans l'inventaire du joueur ou entre inventaire et coffre.
```
data = {
  from: { section: 'hotbar'|'bag'|'chest', idx: number, chestPos?: {tx,ty} },
  to:   { section: 'hotbar'|'bag'|'chest', idx: number, chestPos?: {tx,ty} },
  splitHalf?: boolean,  // si true, prend la moitié du stack source
  placeOne?:  boolean,  // si true, dépose 1 seul dans la destination
}
```

Logique :
1. Si `section === 'chest'`, vérifier que le joueur est à portée du coffre (`withinReach` sur la tuile).  
   Si le coffre n'existe pas dans la Map `chests`, l'initialiser avec `makeChestContents()`.
2. Lire le slot source, calculer la quantité selon splitHalf/placeOne.
3. Valider que la destination accepte (même item ou vide, respect de `stackOf`).
4. Muter les deux slots.
5. `sendInv(p)` au joueur.
6. Si un coffre est impliqué, émettre `mine:chestUpdate { tx, ty, slots }` à **toute la room** (pas seulement le joueur) — ainsi tous les joueurs voient le coffre changer en temps réel.
7. Marquer `dirty = true`.

#### `handleCraftGrid(id, data)`
```
data = { grid: Array(4 ou 9) }  // slots actuels de la grille de craft du client
```

1. `const station = nearStation(p, BLOCK.CRAFTING_TABLE) ? 'table' : 'none'`
2. `const r = matchRecipe(data.grid, station)` — si null, ignore.
3. Pour chaque ingrédient consommé par la recette : `invRemove(p.inv, itemId, count)`.  
   Pour les recettes shapeless, consommer exactement les quantités dans `r.in`.  
   Pour les recettes shaped, consommer 1 exemplaire par case non vide (en respectant le count de la recette pour les cas shapeless intégrés).
4. `invAdd(p.inv, r.out[0], r.out[1])`.
5. Mettre à jour les stats :  
   ```js
   p.stats.items_crafted[r.id] = (p.stats.items_crafted[r.id] || 0) + 1;
   ```
6. `sendInv(p)`.
7. `dirty = true`.

> **Note sur la consommation des ingrédients shaped** : pour une recette shaped, chaque cellule non `_` consomme **1** exemplaire de l'item correspondant — sauf si l'item apparaît plusieurs fois dans le pattern (ex. `PPP` pour 3 cases = 3 planches). Compter les occurrences de chaque lettre dans le pattern pour savoir combien consommer.

#### `handleChestOpen(id, data)`
```
data = { tx, ty }
```
1. Vérifier que `blockAt(world, tx, ty) === BLOCK.CHEST`.
2. Vérifier `withinReach(p, tx, ty)`.
3. Si pas de coffre dans la Map : `chests.set(key, makeChestContents())`.
4. Répondre : `emitTo(id, 'mine:chestData', { tx, ty, slots: chests.get(key) })`.

#### `handleStatInc(id, data)`
```
data = { key: 'jumps'|'distance_walked', val: number }
```
Incrémente `p.stats[data.key] += data.val` (uniquement pour jumps et distance_walked — les autres stats sont gérées côté serveur).

#### `handleSave(id)`
Déclenche `save()` immédiatement.  
Incrémente `p.stats.manual_saves++`.  
Répondre : `emitTo(id, 'mine:saveOk', { ts: Date.now() })`.

#### `handleSetCode(id, data, cb)`
```
data = { newCode: string }  // 4-8 alphanum, normalisé majuscules
```
1. Valider format : `/^[A-Z0-9]{4,8}$/`.
2. Vérifier que le nouveau code n'est pas déjà pris par un autre salon actif (via `room` — le serveur doit passer l'accès à `rooms.getRoom` ou une fonction équivalente ; voir section 4 pour le câblage dans server.js).
3. Renommer le fichier save si existant : `mine-save.js` expose déjà `writeSave` — utilise `readSave` (si exporté) pour lire l'ancien, `writeSave` sur le nouveau code, puis supprimer l'ancien.
4. Mettre à jour `room.code` (et `io.in(ancienCode).socketsLeave(ancienCode); io.in(ancienCode).socketsJoin(newCode)` pour le channel socket).
5. Émettre `mine:codeChanged { newCode }` à toute la room.
6. Callback `cb({ ok: true, newCode })`.

#### `handleStatsRequest(id)`
Répondre : `emitTo(id, 'mine:statsData', { stats: p.stats })`.

### 3e. Modifier `save()` pour inclure coffres et stats

```js
function save() {
  const inventories = {}, playerStats = {}, chestsObj = {};
  for (const [name, inv] of invByName) inventories[name] = inv;
  for (const p of players.values()) {
    inventories[p.name] = deepInv(p.inv);
    playerStats[p.name] = p.stats;
  }
  for (const [key, slots] of chests) chestsObj[key] = slots;
  writeSave(room.code, {
    version: 1, code: room.code, seed, dayTime,
    world: encodeWorld(world), inventories, chests: chestsObj, playerStats
  });
  dirty = false;
}
```

### 3f. Exporter les nouveaux handlers

Ajouter au `return { ... }` final :
```js
handleInvMove, handleCraftGrid, handleChestOpen, handleStatInc, handleSave, handleSetCode, handleStatsRequest,
```

---

## 4. Modifications `server/server.js`

Ajouter après les routes `mine:*` existantes (dans `routeMine` ou directement) :

```js
routeMine('mine:invMove',      'handleInvMove');
routeMine('mine:craftGrid',    'handleCraftGrid');
routeMine('mine:chestOpen',    'handleChestOpen');
routeMine('mine:statInc',      'handleStatInc');
routeMine('mine:save',         'handleSave');
routeMine('mine:statsRequest', 'handleStatsRequest');
```

Pour `mine:setCode` (a besoin d'un callback et d'accès aux rooms) :
```js
socket.on('mine:setCode', (data, cb) => {
  const room = rooms.getRoom(socket.data.roomCode);
  if (!room?.game || room.status !== 'playing') return cb?.({ ok: false });
  room.game.handleSetCode(socket.id, data, cb, rooms);
});
```
Adapter la signature de `handleSetCode` en conséquence (ajouter `rooms` en paramètre) pour vérifier les conflits de code.

---

## 5. Client — `public/games/mine-coop/`

### 5a. `main.js` — ajouts

#### Keybinds
```js
// Keybinds par défaut
const DEFAULT_KEYBINDS = {
  moveLeft:    'ArrowLeft',
  moveRight:   'ArrowRight',
  jump:        'Space',
  openInv:     'Tab',
  attack:      'KeyE',
  teleport:    'KeyM',
  slot1: 'Digit1', slot2: 'Digit2', slot3: 'Digit3',
  slot4: 'Digit4', slot5: 'Digit5', slot6: 'Digit6',
  slot7: 'Digit7', slot8: 'Digit8', slot9: 'Digit9',
};
// Charge depuis localStorage, fusionne avec les défauts (nouvelles touches = défaut)
const KB_STORAGE_KEY = 'lexo.mine.keybinds';
let keybinds = { ...DEFAULT_KEYBINDS, ...(JSON.parse(localStorage.getItem(KB_STORAGE_KEY) || 'null') ?? {}) };
const saveKeybinds = () => localStorage.setItem(KB_STORAGE_KEY, JSON.stringify(keybinds));
```

Toutes les lectures de touches clavier dans `main.js` doivent utiliser `keybinds.xxx` au lieu de chaînes littérales.

#### État de l'inventaire côté client
```js
let invState = null;          // reçu via 'mine:inv'
let craftGrid2 = new Array(4).fill(null);  // grille 2×2
let craftGrid3 = new Array(9).fill(null);  // grille 3×3
let heldSlot   = null;        // { slot: {item,count}, origin: {section,idx} } | null (drag)
let chestState = null;        // { tx, ty, slots: Array(27) } | null (coffre ouvert)
let invOpen    = false;
let chestOpen  = false;
let escOpen    = false;
let statsData  = null;        // reçu via 'mine:statsData'
let nearTable  = false;       // vrai si joueur à portée d'un établi (recalculé côté client)
```

Écouter les événements serveur :
```js
socket.on('mine:inv',         inv  => { invState = inv; renderInvUI(); });
socket.on('mine:chestData',   data => { chestState = data; renderChestUI(); });
socket.on('mine:chestUpdate', data => { if (chestState && chestState.tx === data.tx && chestState.ty === data.ty) { chestState.slots = data.slots; renderChestUI(); } });
socket.on('mine:saveOk',      data => showToast(`Sauvegardé — ${new Date(data.ts).toLocaleTimeString()}`));
socket.on('mine:codeChanged', data => { showToast(`Nouveau code : ${data.newCode}`); /* mettre à jour l'affichage du code */ });
socket.on('mine:statsData',   data => { statsData = data.stats; renderStatsUI(); });
```

#### Calcul `nearTable` côté client
Dans la boucle principale (après mise à jour de la physique) :
```js
nearTable = isNearBlock(localPlayer, BLOCK.CRAFTING_TABLE);
// isNearBlock : même logique que nearStation côté serveur, utilise blockAt sur le cache de chunks
```

#### Envoi de stats incrémentales
Compter sauts et distance dans la boucle physique ; envoyer par lots toutes les 5 s :
```js
let pendingStats = { jumps: 0, distance_walked: 0 };
// ... dans la boucle ...
if (justJumped) pendingStats.jumps++;
pendingStats.distance_walked += Math.abs(dx) / TILE;  // dx = déplacement en px cette frame

setInterval(() => {
  if (pendingStats.jumps > 0) socket.emit('mine:statInc', { key: 'jumps', val: pendingStats.jumps });
  if (pendingStats.distance_walked > 0.1) socket.emit('mine:statInc', { key: 'distance_walked', val: Math.round(pendingStats.distance_walked) });
  pendingStats = { jumps: 0, distance_walked: 0 };
}, 5000);
```

### 5b. Inventaire UI (superposition Canvas ou DOM)

Utilise du **DOM pur** (divs/canvas superposé) — pas de canvas WebGL.  
Toutes les UI sont des `<div>` avec `position: absolute`, superposées au canvas de jeu.

#### Structure HTML à ajouter dans `index.html` (à l'intérieur de `#screenGame`)

```html
<!-- Overlay inventaire (Tab) -->
<div id="invOverlay" class="inv-overlay hidden">
  <div id="invPanel" class="inv-panel">
    <div id="craftSection">
      <div id="craftGrid" class="craft-grid-2x2"></div>
      <span class="craft-arrow">→</span>
      <div id="craftOutput" class="craft-output"></div>
    </div>
    <div id="bagSection">
      <div id="hotbarGrid" class="slot-grid"></div>
      <div id="bagGrid"    class="slot-grid bag"></div>
    </div>
  </div>
</div>

<!-- Overlay coffre -->
<div id="chestOverlay" class="inv-overlay hidden">
  <div id="chestPanel" class="inv-panel">
    <div class="panel-title">Coffre</div>
    <div id="chestGrid" class="slot-grid chest"></div>
    <hr>
    <div id="chestHotbar" class="slot-grid"></div>
    <div id="chestBagGrid" class="slot-grid bag"></div>
  </div>
</div>

<!-- Overlay ESC -->
<div id="escOverlay" class="inv-overlay hidden">
  <div id="escPanel" class="esc-panel">
    <h2>Menu</h2>
    <button id="escResume">Reprendre</button>
    <button id="escSave">Sauvegarder</button>
    <button id="escStats">Statistiques</button>
    <button id="escSetCode">Changer de code</button>
    <button id="escKeybinds">Touches</button>
    <button id="escQuit">Quitter</button>
  </div>
  <!-- Sous-panneau keybinds -->
  <div id="keybindPanel" class="keybind-panel hidden">
    <h3>Configurer les touches</h3>
    <div id="keybindList"></div>
    <button id="keybindBack">← Retour</button>
  </div>
  <!-- Sous-panneau stats -->
  <div id="statsPanel" class="stats-panel hidden">
    <h3>Statistiques</h3>
    <div id="statsContent"></div>
    <button id="statsBack">← Retour</button>
  </div>
  <!-- Sous-panneau set code -->
  <div id="setCodePanel" class="set-code-panel hidden">
    <h3>Changer de code monde</h3>
    <input id="newCodeInput" type="text" maxlength="8" placeholder="4-8 car. alphanum.">
    <button id="setCodeConfirm">Confirmer</button>
    <div id="setCodeError" class="error-msg"></div>
    <button id="setCodeBack">← Retour</button>
  </div>
</div>

<!-- Curseur fantôme (item tenu lors du drag) -->
<div id="dragGhost" class="drag-ghost hidden"></div>
```

#### Logique des slots (commun à tous les panneaux)

Chaque slot est un `<div class="inv-slot">` avec :
- `data-section="hotbar|bag|chest|craft-in|craft-out"`
- `data-idx="0"` etc.
- Contenu : `<span class="slot-glyph">🪵</span><span class="slot-count">x3</span>` si non vide.

**Drag & drop** :
- `mousedown` sur un slot non vide et non de sortie → `heldSlot = {slot, origin}`; masquer le slot source ; afficher `#dragGhost` avec le glyph et le count.
- `mousemove` → déplacer le ghost avec la souris.
- `mouseup` sur un slot de destination → appeler `doInvMove(origin, dest)` → émettre `mine:invMove`.
- `mouseup` hors de tout slot → annuler (replacer dans l'origin).
- Clic droit sur un slot non vide (sans drag en cours) → `splitHalf: true`.
- Clic droit sur un slot de destination pendant un drag → `placeOne: true`.
- Shift+click sur un slot → déplacer toute la pile vers l'autre section (hotbar ↔ bag, ou inventaire ↔ coffre).

**Slot de sortie du craft** :
- Calculé à chaque changement de la grille : `matchRecipe(craftGrid2 ou craftGrid3, nearTable ? 'table' : 'none')`.
- Affiche le résultat prévisualisé (grisé légèrement = preview).
- Clic → émettre `mine:craftGrid { grid: craftGrid }` ; le serveur valide, déduit les ingrédients, envoie `mine:inv` mis à jour ; le client vide la grille craft.

#### Ouvrir/fermer les UI

```
Tab         → toggle inventaire (ferme coffre/ESC si ouverts)
Clic droit  → si sur un bloc CHEST à portée → ferme inv, ouvre coffre (emit mine:chestOpen)
Escape      → si inv/coffre ouvert → ferme ; sinon toggle menu ESC
```

Quand une UI est ouverte : bloquer les inputs de déplacement/minage (mais garder la boucle de rendu active).

### 5c. Menu ESC — comportement des boutons

| Bouton | Action |
|---|---|
| Reprendre | Ferme l'overlay ESC |
| Sauvegarder | Émet `mine:save` ; affiche toast "Sauvegarde en cours…" |
| Statistiques | Émet `mine:statsRequest` ; affiche `#statsPanel` avec les données reçues |
| Changer de code | Affiche `#setCodePanel` |
| Touches | Affiche `#keybindPanel` |
| Quitter | Émet `room:leave` et redirige vers `/` |

### 5d. Panel Keybinds

- Affiche un tableau des actions configurables avec leur touche actuelle.
- Clic sur une ligne → mode "En attente d'une touche…" (input focus sur la ligne).
- Prochain `keydown` → nouvelle touche (`e.code`, ex. `'KeyA'`, `'Space'`).
- Vérifier les conflits : si `e.code` est déjà utilisé pour une autre action, afficher "⚠️ Conflit avec [action]" en rouge, et proposer d'écraser ou d'annuler.
- Si confirmé : `keybinds[action] = e.code; saveKeybinds()`.

Actions configurables et noms FR :

| Clé | Nom affiché |
|---|---|
| moveLeft | Aller à gauche |
| moveRight | Aller à droite |
| jump | Sauter |
| openInv | Ouvrir l'inventaire |
| attack | Attaquer |
| teleport | Focus téléportation |
| slot1..slot9 | Hotbar 1..9 |

### 5e. Panel Stats

Affiche les statistiques dans un format lisible :

```
Blocs minés        : 342 (pierre: 120, terre: 80, ...)
Blocs posés        : 45
Items craftés      : 12 (pioche en bois: 3, ...)
Zombies tués       : 7
Dégâts infligés    : 91
Dégâts reçus       : 48
Distance parcourue : 1 243 tuiles
Sauts              : 87
Temps de jeu       : 23 min 14 s
Sauvegardes manuelles : 2
```

### 5f. `render.js` — hotbar et feedback craft

La hotbar existante (bas de l'écran) continue d'utiliser `BLOCK_META[id].color` pour le fond des cases.  
Ajouter dans la hotbar : si le slot actif correspond à un outil, afficher son glyph (depuis `ITEM_META[id].glyph`).  
Ajouter une petite icône 🛠️ à côté des coordonnées si `nearTable === true`.

### 5g. `mine.css` — styles de l'inventaire

Ajouter les styles pour :
- `.inv-overlay` : `position:absolute; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.55); display:flex; align-items:center; justify-content:center; z-index:20;`
- `.inv-panel`, `.esc-panel` : fond sombre arrondi, padding, max-width raisonnable.
- `.inv-slot` : carré 48px, bordure, fond `#1a1a1a`, cursor pointer, `:hover` highlight.
- `.inv-slot.active` : bordure blanche (slot sélectionné dans la hotbar).
- `.slot-count` : petit texte bas-droit, blanc.
- `.slot-glyph` : centré, font-size 24px.
- `.drag-ghost` : position fixed, pointer-events:none, z-index:100, même style qu'un slot.
- `.craft-grid-2x2` : CSS grid 2×2.
- `.slot-grid.chest` : grid 9×3 (27 slots).
- `.keybind-panel`, `.stats-panel`, `.set-code-panel` : panneaux secondaires stylisés.
- `.error-msg` : couleur rouge.
- `.hidden` : `display:none !important`.

---

## 6. Clic droit sur bloc CHEST — câblage dans `main.js`

Dans le handler `contextmenu` (clic droit actuel, qui gère la pose de bloc) :
- Si le bloc ciblé est `BLOCK.CHEST` et le joueur est à portée :
  - Ne pas poser de bloc.
  - Fermer l'inventaire si ouvert.
  - Émettre `mine:chestOpen { tx, ty }`.
  - (Le serveur répond avec `mine:chestData`, géré au § 5a.)

---

## 7. Critères de succès (vérifie toi-même avant de conclure)

1. `npm test` passe sans erreur — Tag Arena intact.
2. **Inventaire Tab** : ouvre/ferme la grille 2×2 + hotbar + bag. Drag & drop entre les sections fonctionne, stack splitting (clic droit) fonctionne, shift-click déplace toute la pile.
3. **Craft 2×2** : crafting_table depuis 4 planches → fonctionne dans l'inventaire. La prévisualisation apparaît avant de cliquer. Consomme bien les ingrédients.
4. **Craft 3×3** : à portée d'un établi posé, la grille passe à 3×3. Pioche en bois (`PPP / _S_ / _S_`) → fonctionne. Miroir (axe gauche/droite) → fonctionne. Le serveur refuse si pas à portée d'un établi.
5. **Coffre** : poser un coffre, clic droit → ouvre l'UI. Déplacer des items dedans. Ouvrir le même coffre depuis un 2e onglet → les deux voient les mêmes items. Miner le coffre → le coffre disparaît (les items du coffre sont perdus, comportement v1 accepté).
6. **ESC menu** : touche Escape → menu avec 5 boutons. Sauvegarder → toast. Quitter → retour au portail.
7. **Keybinds** : changer une touche → la nouvelle touche fonctionne en jeu → persisté après rechargement (F5).
8. **Conflict warning** : assigner une touche déjà utilisée affiche bien l'avertissement.
9. **Stats** : après quelques minutes de jeu, le panneau stats affiche des valeurs non nulles pour au moins : blocs minés, temps de jeu, distance parcourue, sauts.
10. **Toutes les recettes** : crafting_table, furnace, chest, pioche/hache/épée/pelle (bois/pierre/fer), torche (charbon + charbon de bois), ladder, fence, door — toutes craftables.
