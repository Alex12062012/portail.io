# Mine Coop — Prompt 6 : Textures

Projet `game-portal` — portail **lexo.io** (toujours minuscules).  
Ce prompt remplace les couleurs plates CSS des blocs par de vraies textures PNG.  
`npm test` doit continuer à passer sans modification.

---

## Fichiers à lire en priorité

| Fichier | Pourquoi |
|---|---|
| `shared/mine-world.js` | BLOCK IDs, BLOCK_META (liste des blocs à texturer) |
| `public/games/mine-coop/render.js` | Rendu actuel des tuiles (`BLOCK_META[id].color`) |
| `public/games/mine-coop/main.js` | Boucle, chargement des ressources |

---

## 1. Textures déjà présentes dans le projet

Le dossier `public/games/mine-coop/assets/textures/` existe déjà et contient ces fichiers (ne pas les toucher, ne pas les recréer) :

| Fichier présent | → Bloc |
|---|---|
| `dirt.png` | BLOCK.DIRT |
| `grass.png` | BLOCK.GRASS (vue de côté) |
| `stone.png` | BLOCK.STONE |
| `cobble.png` | BLOCK.COBBLE |
| `planks.png` | BLOCK.PLANKS |
| `log.png` | BLOCK.LOG |
| `leaves.png` | BLOCK.LEAVES |
| `glass.png` | BLOCK.GLASS |
| `sand.png` | BLOCK.SAND |
| `heart.png` | (pour Prompt 7 — barre de vie, ne pas utiliser ici) |
| `_ore_base_nuggets.png` | (16×16, référence visuelle pour les ores) |
| `_ore_base_crystal.png` | (16×16, référence visuelle pour les ores) |

Les fichiers source sont en **16×16 px** (format pixel art standard Minecraft). Le rendu les étire à `TILE = 32 px` — c'est intentionnel, `imageSmoothingEnabled = false` donne le rendu pixel art correct.

---

## 2. Textures manquantes — à générer par script

Les blocs suivants n'ont pas encore de texture. Génère-les en **16×16 px** (même format que les textures existantes) avec un script Node.js.

**Outil : `pngjs`**
```bash
npm install --save-dev pngjs
node scripts/gen-textures.mjs
```

Crée `scripts/gen-textures.mjs` :

```js
// scripts/gen-textures.mjs
import { PNG } from 'pngjs';
import fs from 'fs';
import path from 'path';

const OUT = 'public/games/mine-coop/assets/textures';
const S = 16;  // 16×16 px

function make(filename, cb) {
  const png = new PNG({ width: S, height: S, colorType: 6 });
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const [r, g, b, a = 255] = cb(x, y);
      png.data[i] = r; png.data[i+1] = g; png.data[i+2] = b; png.data[i+3] = a;
    }
  fs.writeFileSync(path.join(OUT, filename), PNG.sync.write(png));
  console.log('  ✔', filename);
}

const hex = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];

// ── CRAFTING TABLE ────────────────────────────────────────────────────────────
// Fond planches (#b88a4e), grille de lignes foncées, bande de dessus claire
make('crafting_table.png', (x, y) => {
  if (y === 0 || y === 1) return hex('#c8a060');            // dessus clair
  if (x === 0 || x === S-1 || y === S-1) return hex('#5c3a1e');  // bordure
  if (x % 5 === 0 || y % 5 === 0) return hex('#7a5030');   // grille
  return hex('#b88a4e');                                     // fond planche
});

// ── FURNACE ───────────────────────────────────────────────────────────────────
// Fond pierre, porte noire avec lueur orange
make('furnace.png', (x, y) => {
  const cx = x - S/2, cy = y - S/2;
  // Porte ovale centrale (5×4 px, centrée)
  if (Math.abs(cx) <= 2 && cy >= 0 && cy <= 3) return [20, 20, 20, 255];
  // Lueur orange autour de la porte
  if (Math.abs(cx) <= 3 && cy >= -1 && cy <= 4) return hex('#c86a10');
  // Boulons (coins)
  if ((x <= 1 || x >= S-2) && y <= 2) return hex('#d0d0d0');
  return hex('#7d7d82');  // fond pierre
});

// ── TORCH ─────────────────────────────────────────────────────────────────────
// Fond transparent, bâton + flamme
make('torch.png', (x, y) => {
  const cx = Math.floor(S/2);
  // Bâton brun (2px large, du bas jusqu'aux 3/4)
  if (Math.abs(x - cx) <= 1 && y >= 6 && y < S) return [...hex('#6b4a2b'), 255];
  // Flamme orange (3×3 en haut du bâton)
  if (Math.abs(x - cx) <= 1 && y >= 3 && y <= 6) return [...hex('#e07820'), 255];
  // Centre flamme jaune
  if (x === cx && y >= 3 && y <= 5) return [...hex('#ffe040'), 255];
  return [0, 0, 0, 0];  // transparent
});

// ── COAL ORE ─────────────────────────────────────────────────────────────────
// Fond pierre + taches noires
const COAL_SPOTS = [[2,3],[6,7],[10,4],[13,10],[5,12]];
make('coal_ore.png', (x, y) => {
  for (const [sx, sy] of COAL_SPOTS)
    if (Math.abs(x-sx) <= 1 && Math.abs(y-sy) <= 1) return hex('#1e1e22');
  if (x % 4 === 0 || y % 4 === 0) return hex('#5a5a60');
  return hex('#7d7d82');
});

// ── IRON ORE ──────────────────────────────────────────────────────────────────
const IRON_SPOTS = [[3,5],[8,3],[12,9],[5,13],[11,12]];
make('iron_ore.png', (x, y) => {
  for (const [sx, sy] of IRON_SPOTS)
    if (Math.abs(x-sx) <= 1 && Math.abs(y-sy) <= 1) return hex('#c8a87a');
  if (x % 4 === 0 || y % 4 === 0) return hex('#5a5a60');
  return hex('#7d7d82');
});

// ── GOLD ORE ──────────────────────────────────────────────────────────────────
const GOLD_SPOTS = [[2,6],[9,3],[13,11],[5,14],[11,7]];
make('gold_ore.png', (x, y) => {
  for (const [sx, sy] of GOLD_SPOTS)
    if (Math.abs(x-sx) <= 1 && Math.abs(y-sy) <= 1) return hex('#e0c030');
  if (x % 4 === 0 || y % 4 === 0) return hex('#5a5a60');
  return hex('#7d7d82');
});

// ── DIAMOND ORE ───────────────────────────────────────────────────────────────
const DIA_SPOTS = [[3,4],[10,2],[14,9],[6,13],[12,11]];
make('diamond_ore.png', (x, y) => {
  for (const [sx, sy] of DIA_SPOTS)
    if (Math.abs(x-sx) <= 1 && Math.abs(y-sy) <= 1) return hex('#5fd6d6');
  if (x % 4 === 0 || y % 4 === 0) return hex('#4a4a52');
  return hex('#6a6a70');
});

// ── CHEST ─────────────────────────────────────────────────────────────────────
make('chest.png', (x, y) => {
  if (x === 0 || x === S-1 || y === 0 || y === S-1) return hex('#5c3a1e');  // contour
  if (y === 7 || y === 8) return hex('#c8a060');      // bande centrale
  if (y >= 6 && y <= 9 && x >= 6 && x <= 9) return hex('#d0b040');  // serrure
  if (y <= 2) return hex('#c8a060');                   // dessus
  return hex('#b88a4e');                               // fond bois
});

// ── BEDROCK ───────────────────────────────────────────────────────────────────
// Motif déterministe
make('bedrock.png', (x, y) => {
  const h = ((x * 374761393 + y * 668265263 + 42 * 2246822519) & 0x7fffffff) / 0x7fffffff;
  if (h < 0.15) return hex('#171719');   // très sombre
  if (h < 0.30) return hex('#3a3a40');   // légèrement plus clair
  return hex('#2b2b30');                 // fond bedrock
});

console.log('\nTextures générées dans', OUT);
```

Exécute le script après l'avoir créé :
```bash
node scripts/gen-textures.mjs
```

Vérifie que ces 8 fichiers apparaissent dans `assets/textures/` :
`crafting_table.png`, `furnace.png`, `torch.png`, `coal_ore.png`, `iron_ore.png`, `gold_ore.png`, `diamond_ore.png`, `chest.png`, `bedrock.png`

---

## 3. Chargement des textures dans `render.js`

### 3a. Table de correspondance

Au début de `render.js` (ou dans un module dédié) :

```js
import { BLOCK } from '/shared/mine-world.js';

const TEX_BASE = '/games/mine-coop/assets/textures/';

const BLOCK_TEX = {
  [BLOCK.DIRT]:           'dirt.png',
  [BLOCK.GRASS]:          'grass.png',
  [BLOCK.STONE]:          'stone.png',
  [BLOCK.COBBLE]:         'cobble.png',
  [BLOCK.SAND]:           'sand.png',
  [BLOCK.LOG]:            'log.png',
  [BLOCK.LEAVES]:         'leaves.png',
  [BLOCK.PLANKS]:         'planks.png',
  [BLOCK.CRAFTING_TABLE]: 'crafting_table.png',
  [BLOCK.FURNACE]:        'furnace.png',
  [BLOCK.TORCH]:          'torch.png',
  [BLOCK.COAL_ORE]:       'coal_ore.png',
  [BLOCK.IRON_ORE]:       'iron_ore.png',
  [BLOCK.GOLD_ORE]:       'gold_ore.png',
  [BLOCK.DIAMOND_ORE]:    'diamond_ore.png',
  [BLOCK.CHEST]:          'chest.png',
  [BLOCK.BEDROCK]:        'bedrock.png',
  [BLOCK.GLASS]:          'glass.png',
};

const textures = new Map();

export function preloadTextures() {
  return Promise.all(
    Object.entries(BLOCK_TEX).map(([id, file]) =>
      new Promise(res => {
        const img = new Image();
        img.onload  = () => { textures.set(Number(id), img); res(); };
        img.onerror = () => { textures.set(Number(id), null); res(); };  // fallback couleur
        img.src = TEX_BASE + file;
      })
    )
  );
}
```

Appelle `await preloadTextures()` dans `main.js` après réception de `game:start`, avant de lancer la boucle de rendu.

### 3b. Fonction de dessin d'une tuile

Remplace le dessin par couleur dans la boucle de rendu des blocs :

```js
function drawTile(ctx, blockId, screenX, screenY) {
  const tex = textures.get(blockId);
  if (tex) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tex, screenX, screenY, TILE, TILE);
  } else {
    // Fallback couleur (texture non chargée ou bloc sans texture)
    const meta = BLOCK_META[blockId];
    if (!meta?.color) return;
    ctx.fillStyle = meta.color;
    ctx.fillRect(screenX, screenY, TILE, TILE);
    if (meta.shade) {
      ctx.fillStyle = meta.shade;
      ctx.fillRect(screenX, screenY + TILE - 4, TILE, 4);
    }
  }
}
```

Définis `ctx.imageSmoothingEnabled = false` une fois en début de frame (avant de dessiner les blocs) pour ne pas le répéter à chaque tuile.

### 3c. Cas spéciaux

**TORCH** (`solid: false`) : la torche est dessinée sur fond transparent. Dans la boucle des tuiles visibles, si `blockId === BLOCK.TORCH`, ne pas `fillRect` le fond — juste `drawImage` la texture (qui est RGBA avec transparence).

**GLASS** : la texture verre existante est opaque en 16×16. La dessiner normalement.

**LADDER, FENCE, DOOR** : pas de texture pour l'instant — le fallback couleur de `BLOCK_META` s'applique automatiquement.

---

## 4. Vérification

1. `npm test` passe sans erreur.
2. `node scripts/gen-textures.mjs` → 8 fichiers créés, aucune erreur.
3. `npm run dev` → ouvrir `/games/mine-coop/` → les blocs affichent les textures (plus de couleurs plates) :
   - Herbe : texture `grass_side` (bande verte + brun)
   - Pierre : grise texturée
   - Cobble : pierres irrégulières
   - Planches : bois clair
   - Minerais : fond pierre + taches de couleur (noir/beige/or/cyan)
4. Aucun carré blanc/magenta : si une texture manque, la couleur de fallback s'affiche.
5. Les textures sont nettes (pas floues) — pixel art 16→32px sans interpolation.
