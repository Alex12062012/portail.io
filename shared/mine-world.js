/**
 * mine-world.js — constantes + génération + helpers du monde de Mine Coop.
 * Module PARTAGÉ : importé par le serveur (server/games/mine-coop.js, génération
 * + autorité sur la grille) ET par le client (public/games/mine-coop/, miroir
 * local + rendu). Aucun import Node : ce fichier est servi tel quel au
 * navigateur sous /shared (comme tag-map.js).
 *
 * Repère : grille de tuiles 32×32 px, WORLD_W×WORLD_H. Index TUILE column-major
 * (tx*WORLD_H+ty) → une colonne est contiguë en mémoire (génération colonne par
 * colonne + découpe en chunks réseau efficaces). Y croît vers le bas (0 = ciel).
 * X affiché centré sur le spawn via WORLD_OFFSET_X (spawn = X affiché 0).
 */

// ----------------------------------------------------------------- constantes
export const TILE = 32;                       // px par tuile (carrée)
export const WORLD_W = 4096;                  // tuiles de large (index X 0..4095)
export const WORLD_H = 256;                   // tuiles de haut  (index Y 0..255)
export const WORLD_TILES = WORLD_W * WORLD_H; // 1 048 576
export const WORLD_PX_W = WORLD_W * TILE;     // 131072
export const WORLD_PX_H = WORLD_H * TILE;     // 8192

export const WORLD_OFFSET_X = 2048;           // X affiché = txAffiché = tx - OFFSET
export const CHUNK = 32;                       // tuiles/chunk (DÉCOUPE RÉSEAU only)
export const CHUNKS_X = WORLD_W / CHUNK;       // 128
export const CHUNKS_Y = WORLD_H / CHUNK;       // 8  → 1024 chunks
export const SPAWN_TX = WORLD_OFFSET_X;        // colonne de spawn (X affiché 0)

export const VIEW = { width: 1280, height: 720 }; // viewport canvas (comme tag)

export const DAY_LENGTH_S = 600;               // cycle jour/nuit complet (10 min)

// Paramètres de génération (figés ici → serveur et client génèrent à l'identique)
export const GEN = Object.freeze({
  seaLevel: 72,        // hauteur de surface de base (Y tuiles depuis le haut)
  surfaceAmp: 22,      // ± collines autour de seaLevel
  dirtBand: 5,         // tuiles de terre sous l'herbe
  bedrockRows: 2,      // rangées indestructibles tout en bas
  caveThreshold: 0.40, // bruit < ce seuil ET dans la pierre → creusé en air
  caveScale: 0.085,    // fréquence du bruit de grottes
  treeChance: 0.06,    // proba d'arbre par colonne d'herbe éligible
  spawnClearW: 7        // demi-largeur (tuiles) du plateau de spawn dégagé
});

// Constantes physiques du joueur (consommées par mine-physics.js)
export const MINE = Object.freeze({
  gravity: 1500, moveSpeed: 280, jumpVel: 620, maxFall: 1100,
  groundAccel: 2600, airAccel: 1700, groundFriction: 2600, airFriction: 400,
  coyoteTime: 0.08, jumpBuffer: 0.12,
  playerW: 22, playerH: 44,   // < TILE de large (passe un puits 1-large), 2 tuiles de haut
  reachTiles: 4.5,            // portée minage/pose (tuiles) — le serveur re-valide
  maxHp: 100
});

// ------------------------------------------------------------ index & helpers
/** Index column-major dans le Uint8Array du monde. */
export const tileIndex = (tx, ty) => tx * WORLD_H + ty;
export const newWorldArray = () => new Uint8Array(WORLD_TILES);

export const inBounds = (tx, ty) => tx >= 0 && tx < WORLD_W && ty >= 0 && ty < WORLD_H;

// X interne (tuile) <-> X affiché (centré sur le spawn) ; Y : pas d'offset
export const tileXToDisplayX = tx => tx - WORLD_OFFSET_X;
export const displayXToTileX = dx => dx + WORLD_OFFSET_X;
export const clampTileX = tx => Math.min(WORLD_W - 1, Math.max(0, tx | 0));
export const clampTileY = ty => Math.min(WORLD_H - 1, Math.max(0, ty | 0));

// pixels (monde) <-> tuiles
export const pxToTileX = px => Math.floor(px / TILE);
export const pxToTileY = py => Math.floor(py / TILE);

// ------------------------------------------------------------------ chunks
export const chunkCoord = (tx, ty) => ({ cx: (tx / CHUNK) | 0, cy: (ty / CHUNK) | 0 });
export const chunkKey = (cx, cy) => cx + ':' + cy;

/** Liste des chunks dans un rayon de Chebyshev r autour d'une tuile. */
export function chunksAround(tx, ty, r) {
  const { cx, cy } = chunkCoord(tx, ty);
  const out = [];
  for (let x = cx - r; x <= cx + r; x++)
    for (let y = cy - r; y <= cy + r; y++)
      if (x >= 0 && x < CHUNKS_X && y >= 0 && y < CHUNKS_Y) out.push({ cx: x, cy: y });
  return out;
}

// ------------------------------------------------------------- blocs & items
// Tiers d'outils : 0 main, 1 bois, 2 pierre, 3 fer.
export const TIER = Object.freeze({ HAND: 0, WOOD: 1, STONE: 2, IRON: 3 });
export const TIER_SPEED = [1, 2, 4, 6];     // multiplicateur de vitesse de minage par tier
export const WRONG_TOOL = 0.5;              // main / mauvais outil sur bloc dur (demi-vitesse)

// Ids de BLOCS (0 = air). STABLES (persistés dans les sauvegardes) — ne jamais renuméroter.
// Tous < 100 : un bloc plaçable est aussi un item (itemId === blockId).
export const BLOCK = Object.freeze({
  AIR: 0, BEDROCK: 1, STONE: 2, DIRT: 3, GRASS: 4, COBBLE: 5,
  COAL_ORE: 6, IRON_ORE: 7, GOLD_ORE: 8, DIAMOND_ORE: 9,
  LOG: 10, LEAVES: 11, PLANKS: 12, CRAFTING_TABLE: 13, FURNACE: 14,
  SAND: 15, TORCH: 16,
  CHEST: 17,   // coffre (contenu partagé en coop)
  GLASS: 18,   // verre (sable fondu) — ne drop rien sans Silk Touch
  LADDER: 19,  // échelle (non solide en v1)
  FENCE: 20,   // clôture (hitbox pleine tuile en v1)
  DOOR: 21     // porte (non solide en v1, décorative)
});

// Ids d'ITEMS non-blocs (matériaux + outils) : >= 100 pour ne jamais entrer en
// collision avec un id de bloc.
export const ITEM = Object.freeze({
  STICK: 100, COAL: 101, CHARCOAL: 102, RAW_IRON: 103, IRON_INGOT: 104,
  GOLD: 105, DIAMOND: 106,
  WOOD_PICKAXE: 110, WOOD_AXE: 111, WOOD_SWORD: 112,
  STONE_PICKAXE: 120, STONE_AXE: 121, STONE_SWORD: 122,
  IRON_PICKAXE: 130, IRON_AXE: 131, IRON_SWORD: 132,
  WOOD_SHOVEL: 133, STONE_SHOVEL: 134, IRON_SHOVEL: 135
});

export const itemIsBlock = id => id > 0 && id < 100;     // pont item<->bloc

/**
 * Méta des blocs : hardness (numérateur du temps de minage), tool (type d'outil
 * requis pour récolter — null = mains/n'importe), minTier (tier minimum pour
 * obtenir un DROP ; en dessous le bloc casse mais ne donne rien), drop (itemId),
 * solid, color/shade (rendu canvas), light (bloque la lumière).
 */
function Bm(o) {
  return Object.freeze({ solid: true, hardness: 0.5, tool: null, minTier: 0,
    drop: null, light: true, ...o });
}
export const BLOCK_META = Object.freeze({
  [BLOCK.AIR]:     Bm({ solid: false, hardness: 0, light: false, color: null }),
  [BLOCK.BEDROCK]: Bm({ hardness: Infinity, color: '#2b2b30', shade: '#171719' }),
  [BLOCK.STONE]:   Bm({ hardness: 3.0, tool: 'pickaxe', minTier: TIER.WOOD, drop: BLOCK.COBBLE, color: '#7d7d82', shade: '#5a5a5e' }),
  [BLOCK.DIRT]:    Bm({ hardness: 0.6, drop: BLOCK.DIRT, color: '#7a5230', shade: '#5b3d24' }),
  [BLOCK.GRASS]:   Bm({ hardness: 0.7, drop: BLOCK.DIRT, color: '#5aa845', shade: '#3f7d30' }),
  [BLOCK.COBBLE]:  Bm({ hardness: 3.0, tool: 'pickaxe', minTier: TIER.WOOD, drop: BLOCK.COBBLE, color: '#8a8a90', shade: '#63636a' }),
  [BLOCK.COAL_ORE]: Bm({ hardness: 4.0, tool: 'pickaxe', minTier: TIER.WOOD, drop: ITEM.COAL, color: '#5b5b60', shade: '#1e1e22' }),
  [BLOCK.IRON_ORE]: Bm({ hardness: 6.0, tool: 'pickaxe', minTier: TIER.STONE, drop: ITEM.RAW_IRON, color: '#8a7866', shade: '#6a5a4a' }),
  [BLOCK.GOLD_ORE]: Bm({ hardness: 6.0, tool: 'pickaxe', minTier: TIER.IRON, drop: ITEM.GOLD, color: '#b69a3e', shade: '#8a722a' }),
  [BLOCK.DIAMOND_ORE]: Bm({ hardness: 7.0, tool: 'pickaxe', minTier: TIER.IRON, drop: ITEM.DIAMOND, color: '#5fd6d6', shade: '#3a9c9c' }),
  [BLOCK.LOG]:     Bm({ hardness: 1.5, tool: 'axe', drop: BLOCK.LOG, color: '#6b4a2b', shade: '#4d351e' }),
  [BLOCK.LEAVES]:  Bm({ hardness: 0.3, drop: null, light: false, color: '#3f8f3a', shade: '#2c6a28' }),
  [BLOCK.PLANKS]:  Bm({ hardness: 2.0, tool: 'axe', drop: BLOCK.PLANKS, color: '#b88a4e', shade: '#956d3a' }),
  [BLOCK.CRAFTING_TABLE]: Bm({ hardness: 2.0, tool: 'axe', drop: BLOCK.CRAFTING_TABLE, color: '#a06f3a', shade: '#6d4a26' }),
  [BLOCK.FURNACE]: Bm({ hardness: 4.0, tool: 'pickaxe', minTier: TIER.WOOD, drop: BLOCK.FURNACE, color: '#5c5c60', shade: '#3a3a3e' }),
  [BLOCK.SAND]:    Bm({ hardness: 0.5, drop: BLOCK.SAND, color: '#d9c98a', shade: '#bba968' }),
  [BLOCK.TORCH]:   Bm({ solid: false, hardness: 0.05, drop: BLOCK.TORCH, light: false, color: '#ffce54', shade: '#c8851f' }),
  [BLOCK.CHEST]:   Bm({ hardness: 2.5, tool: 'axe', drop: BLOCK.CHEST, color: '#8B6914', shade: '#5c430d' }),
  [BLOCK.GLASS]:   Bm({ hardness: 0.3, tool: null, drop: null, light: false, color: '#c8e8f8', shade: '#8abccc' }),
  [BLOCK.LADDER]:  Bm({ solid: false, hardness: 0.4, tool: 'axe', drop: BLOCK.LADDER, light: false, color: '#a07840', shade: '#6d5228' }),
  [BLOCK.FENCE]:   Bm({ hardness: 2.0, tool: 'axe', drop: BLOCK.FENCE, color: '#b88a4e', shade: '#956d3a' }),
  [BLOCK.DOOR]:    Bm({ solid: false, hardness: 3.0, tool: 'axe', drop: BLOCK.DOOR, light: false, color: '#b88a4e', shade: '#956d3a' })
});

/** Méta des items : name (FR), stack (taille de pile), tool (type), tier, glyph (rendu). */
export const ITEM_META = Object.freeze({
  // blocs (name/glyph pour l'inventaire ; stack 64)
  [BLOCK.DIRT]: { name: 'Terre', stack: 64, glyph: '🟫' },
  [BLOCK.GRASS]: { name: 'Herbe', stack: 64, glyph: '🟩' },
  [BLOCK.STONE]: { name: 'Pierre', stack: 64, glyph: '🪨' },
  [BLOCK.COBBLE]: { name: 'Pierres', stack: 64, glyph: '🧱' },
  [BLOCK.SAND]: { name: 'Sable', stack: 64, glyph: '🟨' },
  [BLOCK.LOG]: { name: 'Bûche', stack: 64, glyph: '🪵' },
  [BLOCK.LEAVES]: { name: 'Feuilles', stack: 64, glyph: '🌿' },
  [BLOCK.PLANKS]: { name: 'Planches', stack: 64, glyph: '🟧' },
  [BLOCK.CRAFTING_TABLE]: { name: 'Établi', stack: 64, glyph: '🛠️' },
  [BLOCK.FURNACE]: { name: 'Fourneau', stack: 64, glyph: '🔥' },
  [BLOCK.TORCH]: { name: 'Torche', stack: 64, glyph: '🕯️' },
  [BLOCK.CHEST]: { name: 'Coffre', stack: 64, glyph: '📦' },
  [BLOCK.GLASS]: { name: 'Verre', stack: 64, glyph: '🪟' },
  [BLOCK.LADDER]: { name: 'Échelle', stack: 64, glyph: '🪜' },
  [BLOCK.FENCE]: { name: 'Clôture', stack: 64, glyph: '🚧' },
  [BLOCK.DOOR]: { name: 'Porte', stack: 64, glyph: '🚪' },
  [BLOCK.COAL_ORE]: { name: 'Minerai de charbon', stack: 64, glyph: '⬛' },
  [BLOCK.IRON_ORE]: { name: 'Minerai de fer', stack: 64, glyph: '⬜' },
  [BLOCK.GOLD_ORE]: { name: "Minerai d'or", stack: 64, glyph: '🟡' },
  [BLOCK.DIAMOND_ORE]: { name: 'Minerai de diamant', stack: 64, glyph: '🔷' },
  // matériaux
  [ITEM.STICK]: { name: 'Bâton', stack: 64, glyph: '🥢' },
  [ITEM.COAL]: { name: 'Charbon', stack: 64, glyph: '⬛', fuel: 8 },
  [ITEM.CHARCOAL]: { name: 'Charbon de bois', stack: 64, glyph: '🔲', fuel: 8 },
  [ITEM.RAW_IRON]: { name: 'Fer brut', stack: 64, glyph: '🔩' },
  [ITEM.IRON_INGOT]: { name: 'Lingot de fer', stack: 64, glyph: '⚙️' },
  [ITEM.GOLD]: { name: "Pépite d'or", stack: 64, glyph: '🟡' },
  [ITEM.DIAMOND]: { name: 'Diamant', stack: 64, glyph: '💎' },
  // outils (stack 1)
  [ITEM.WOOD_PICKAXE]: { name: 'Pioche en bois', stack: 1, tool: 'pickaxe', tier: TIER.WOOD, glyph: '⛏️' },
  [ITEM.WOOD_AXE]: { name: 'Hache en bois', stack: 1, tool: 'axe', tier: TIER.WOOD, glyph: '🪓' },
  [ITEM.WOOD_SWORD]: { name: 'Épée en bois', stack: 1, tool: 'sword', tier: TIER.WOOD, glyph: '🗡️' },
  [ITEM.STONE_PICKAXE]: { name: 'Pioche en pierre', stack: 1, tool: 'pickaxe', tier: TIER.STONE, glyph: '⛏️' },
  [ITEM.STONE_AXE]: { name: 'Hache en pierre', stack: 1, tool: 'axe', tier: TIER.STONE, glyph: '🪓' },
  [ITEM.STONE_SWORD]: { name: 'Épée en pierre', stack: 1, tool: 'sword', tier: TIER.STONE, glyph: '🗡️' },
  [ITEM.IRON_PICKAXE]: { name: 'Pioche en fer', stack: 1, tool: 'pickaxe', tier: TIER.IRON, glyph: '⛏️' },
  [ITEM.IRON_AXE]: { name: 'Hache en fer', stack: 1, tool: 'axe', tier: TIER.IRON, glyph: '🪓' },
  [ITEM.IRON_SWORD]: { name: 'Épée en fer', stack: 1, tool: 'sword', tier: TIER.IRON, glyph: '🗡️' },
  // pelles (tool 'shovel' — bonus de vitesse sur terre/herbe/sable via tool:null)
  [ITEM.WOOD_SHOVEL]: { name: 'Pelle en bois', stack: 1, tool: 'shovel', tier: TIER.WOOD, glyph: '🥄' },
  [ITEM.STONE_SHOVEL]: { name: 'Pelle en pierre', stack: 1, tool: 'shovel', tier: TIER.STONE, glyph: '🥄' },
  [ITEM.IRON_SHOVEL]: { name: 'Pelle en fer', stack: 1, tool: 'shovel', tier: TIER.IRON, glyph: '🥄' }
});

export const stackOf = itemId => ITEM_META[itemId]?.stack ?? 64;
export const toolMeta = itemId => { const m = ITEM_META[itemId]; return m && m.tool ? m : null; };
export const itemName = itemId => ITEM_META[itemId]?.name ?? (itemIsBlock(itemId) ? (BLOCK_META[itemId] ? 'Bloc' : '?') : '?');
export const itemGlyph = itemId => ITEM_META[itemId]?.glyph ?? '▫️';

// ------------------------------------------------------------- accès grille
export function blockAt(world, tx, ty) {
  if (!inBounds(tx, ty)) return ty < 0 ? BLOCK.AIR : BLOCK.BEDROCK;
  return world[tileIndex(tx, ty)];
}
export const isSolidId = id => (BLOCK_META[id] || BLOCK_META[BLOCK.AIR]).solid;
export function solidAt(world, tx, ty) {
  if (ty < 0) return false;                 // au-dessus du monde = ciel ouvert
  if (tx < 0 || tx >= WORLD_W || ty >= WORLD_H) return true; // bords/fond = mur
  return isSolidId(world[tileIndex(tx, ty)]);
}

/**
 * Temps de minage (s) d'un bloc avec l'outil tenu. Même formule client (prédiction
 * des fissures) et serveur (autorité sur la casse). tool = méta-outil ou null (main).
 */
export function miningSeconds(blockId, tool) {
  const m = BLOCK_META[blockId];
  if (!m || !Number.isFinite(m.hardness) || m.hardness <= 0) {
    return (m && m.hardness === 0) ? 0 : Infinity; // air = 0, bedrock = Infinity
  }
  const tier = tool ? tool.tier : 0;
  let speed;
  if (m.tool === null) speed = TIER_SPEED[tier];               // bloc tendre : tout va
  else if (tool && tool.tool === m.tool) speed = TIER_SPEED[tier]; // bon outil
  else speed = WRONG_TOOL;                                     // main / mauvais outil
  return m.hardness / speed;
}
/** Le bloc lâche-t-il un drop avec ce tier d'outil ? (règle Minecraft). */
export const canDrop = (blockId, tier) => tier >= (BLOCK_META[blockId]?.minTier ?? 0);

// ------------------------------------------------------------------ recettes
/**
 * Recette façonnée (shaped) : `pattern` = tableau de chaînes, chaque caractère =
 * une cellule (gauche→droite), `_` = vide ; `key` mappe lettre → itemId. La
 * correspondance est tentée normale ET en miroir horizontal (haches/pelles).
 * Recette sans forme (shapeless) : `shapeless: true` + `in: [[itemId,count],…]`.
 * station: 'none' = grille 2×2 (inventaire), 'table' = grille 3×3 (établi).
 */
export const RECIPES = [
  // ── 2×2 (inventaire) ───────────────────────────────────────────────────────
  { id: 'planks', station: 'none', shapeless: true,
    in: [[BLOCK.LOG, 1]], out: [BLOCK.PLANKS, 4] },
  { id: 'sticks', station: 'none',
    pattern: ['P_', 'P_'], key: { P: BLOCK.PLANKS }, out: [ITEM.STICK, 4] },
  { id: 'crafting_table', station: 'none',
    pattern: ['PP', 'PP'], key: { P: BLOCK.PLANKS }, out: [BLOCK.CRAFTING_TABLE, 1] },
  { id: 'torch', station: 'none', shapeless: true,
    in: [[ITEM.COAL, 1], [ITEM.STICK, 1]], out: [BLOCK.TORCH, 4] },
  { id: 'torch_charcoal', station: 'none', shapeless: true,
    in: [[ITEM.CHARCOAL, 1], [ITEM.STICK, 1]], out: [BLOCK.TORCH, 4] },

  // ── 3×3 (établi) ───────────────────────────────────────────────────────────
  { id: 'wood_pickaxe', station: 'table',
    pattern: ['PPP', '_S_', '_S_'], key: { P: BLOCK.PLANKS, S: ITEM.STICK }, out: [ITEM.WOOD_PICKAXE, 1] },
  { id: 'wood_axe', station: 'table',
    pattern: ['PP_', 'PS_', '_S_'], key: { P: BLOCK.PLANKS, S: ITEM.STICK }, out: [ITEM.WOOD_AXE, 1] },
  { id: 'wood_sword', station: 'table',
    pattern: ['_P_', '_P_', '_S_'], key: { P: BLOCK.PLANKS, S: ITEM.STICK }, out: [ITEM.WOOD_SWORD, 1] },
  { id: 'wood_shovel', station: 'table',
    pattern: ['_P_', '_S_', '_S_'], key: { P: BLOCK.PLANKS, S: ITEM.STICK }, out: [ITEM.WOOD_SHOVEL, 1] },
  { id: 'stone_pickaxe', station: 'table',
    pattern: ['CCC', '_S_', '_S_'], key: { C: BLOCK.COBBLE, S: ITEM.STICK }, out: [ITEM.STONE_PICKAXE, 1] },
  { id: 'stone_axe', station: 'table',
    pattern: ['CC_', 'CS_', '_S_'], key: { C: BLOCK.COBBLE, S: ITEM.STICK }, out: [ITEM.STONE_AXE, 1] },
  { id: 'stone_sword', station: 'table',
    pattern: ['_C_', '_C_', '_S_'], key: { C: BLOCK.COBBLE, S: ITEM.STICK }, out: [ITEM.STONE_SWORD, 1] },
  { id: 'stone_shovel', station: 'table',
    pattern: ['_C_', '_S_', '_S_'], key: { C: BLOCK.COBBLE, S: ITEM.STICK }, out: [ITEM.STONE_SHOVEL, 1] },
  { id: 'iron_pickaxe', station: 'table',
    pattern: ['III', '_S_', '_S_'], key: { I: ITEM.IRON_INGOT, S: ITEM.STICK }, out: [ITEM.IRON_PICKAXE, 1] },
  { id: 'iron_axe', station: 'table',
    pattern: ['II_', 'IS_', '_S_'], key: { I: ITEM.IRON_INGOT, S: ITEM.STICK }, out: [ITEM.IRON_AXE, 1] },
  { id: 'iron_sword', station: 'table',
    pattern: ['_I_', '_I_', '_S_'], key: { I: ITEM.IRON_INGOT, S: ITEM.STICK }, out: [ITEM.IRON_SWORD, 1] },
  { id: 'iron_shovel', station: 'table',
    pattern: ['_I_', '_S_', '_S_'], key: { I: ITEM.IRON_INGOT, S: ITEM.STICK }, out: [ITEM.IRON_SHOVEL, 1] },
  // structures
  { id: 'furnace', station: 'table',
    pattern: ['CCC', 'C_C', 'CCC'], key: { C: BLOCK.COBBLE }, out: [BLOCK.FURNACE, 1] },
  { id: 'chest', station: 'table',
    pattern: ['PPP', 'P_P', 'PPP'], key: { P: BLOCK.PLANKS }, out: [BLOCK.CHEST, 1] },
  { id: 'ladder', station: 'table',
    pattern: ['S_S', 'SSS', 'S_S'], key: { S: ITEM.STICK }, out: [BLOCK.LADDER, 3] },
  { id: 'fence', station: 'table',
    pattern: ['___', 'PSP', 'PSP'], key: { P: BLOCK.PLANKS, S: ITEM.STICK }, out: [BLOCK.FENCE, 3] },
  { id: 'door', station: 'table',
    pattern: ['PP_', 'PP_', 'PP_'], key: { P: BLOCK.PLANKS }, out: [BLOCK.DOOR, 3] }
];
export const RECIPE_BY_ID = Object.freeze(Object.fromEntries(RECIPES.map(r => [r.id, r])));

/** Ingrédients consommés par une recette : [[itemId,count],…] (shaped ou shapeless). */
export function recipeCost(recipe) {
  if (recipe.shapeless) return recipe.in.map(([id, n]) => [id, n]);
  const counts = {};
  for (const row of recipe.pattern)
    for (const ch of row)
      if (ch !== '_') { const id = recipe.key[ch]; counts[id] = (counts[id] || 0) + 1; }
  return Object.entries(counts).map(([id, n]) => [Number(id), n]);
}

/**
 * Cherche la recette correspondant à une grille de craft.
 * @param grid  tableau plat de slots ({item,count}|null) : Array(4)=2×2, Array(9)=3×3.
 * @param stationAvailable  'none' | 'table' (les recettes 'table' exigent 'table').
 * @returns la recette ou null. Gère shaped (bounding-box + miroir H) et shapeless.
 */
export function matchRecipe(grid, stationAvailable) {
  const size = grid.length === 4 ? 2 : 3;
  const stationRank = { none: 0, table: 1 };
  const rank = stationRank[stationAvailable] ?? 0;

  for (const r of RECIPES) {
    if (stationRank[r.station] > rank) continue;

    if (r.shapeless) {
      const have = {};
      for (const s of grid) if (s) have[s.item] = (have[s.item] || 0) + s.count;
      let ok = true;
      for (const [id, need] of r.in) {
        if ((have[id] || 0) < need) { ok = false; break; }
        have[id] -= need;
      }
      if (ok && Object.values(have).every(v => v === 0)) return r;
      continue;
    }

    const pRows = r.pattern;
    // bounding-box du CONTENU du pattern (ignore rangées/colonnes de remplissage)
    let pMinR = pRows.length, pMaxR = -1, pMinC = pRows[0].length, pMaxC = -1;
    for (let row = 0; row < pRows.length; row++)
      for (let col = 0; col < pRows[row].length; col++)
        if (pRows[row][col] !== '_') {
          pMinR = Math.min(pMinR, row); pMaxR = Math.max(pMaxR, row);
          pMinC = Math.min(pMinC, col); pMaxC = Math.max(pMaxC, col);
        }
    const pH = pMaxR - pMinR + 1, pW = pMaxC - pMinC + 1;
    // bounding-box de la grille remplie
    let minR = size, maxR = -1, minC = size, maxC = -1;
    for (let row = 0; row < size; row++)
      for (let col = 0; col < size; col++)
        if (grid[row * size + col]) {
          minR = Math.min(minR, row); maxR = Math.max(maxR, row);
          minC = Math.min(minC, col); maxC = Math.max(maxC, col);
        }
    if (maxR < 0) continue;
    if (maxR - minR + 1 !== pH || maxC - minC + 1 !== pW) continue;

    for (const mirror of [false, true]) {
      let match = true;
      for (let row = 0; row < pH && match; row++)
        for (let col = 0; col < pW && match; col++) {
          const pc = mirror ? pW - 1 - col : col;
          const ch = pRows[pMinR + row][pMinC + pc];
          const slot = grid[(minR + row) * size + (minC + col)];
          if (ch === '_') { if (slot) match = false; }
          else if (!slot || slot.item !== r.key[ch]) match = false;
        }
      if (match) return r;
    }
  }
  return null;
}

/** Crée un contenu de coffre vide (27 slots). */
export const makeChestContents = () => new Array(27).fill(null);
// Fonte (près d'un fourneau) : minerai/entrée → sortie, en secondes ; combustible = item à .fuel.
export const SMELT = Object.freeze({
  [ITEM.RAW_IRON]: { out: ITEM.IRON_INGOT, seconds: 8 },
  [BLOCK.LOG]: { out: ITEM.CHARCOAL, seconds: 8 }
});

// --------------------------------------------------------------- jour / nuit
/** Lumière ambiante 0..1 (1 = plein jour, plancher la nuit) à partir de dayTime∈[0,1). */
export function ambientLight(dayTime) {
  const NIGHT_MIN = 0.16;
  const t = ((dayTime - 0.375) % 1 + 1) % 1;          // 0 = midi
  const c = 0.5 + 0.5 * Math.cos(t * Math.PI * 2);    // 1 à midi, 0 à minuit
  return NIGHT_MIN + (1 - NIGHT_MIN) * c;
}
/** Fenêtre nocturne (apparition des zombies). */
export const isNight = dayTime => dayTime >= 0.55 && dayTime < 0.95;

// ------------------------------------------------------- codec de sauvegarde
// RLE sur le flux d'octets column-major (longues séries air/pierre/bedrock) puis
// base64 maison (pas de Buffer — ce module tourne aussi dans le navigateur).
export function rleEncode(u8) {
  const out = [];
  for (let i = 0; i < u8.length;) {
    const v = u8[i]; let n = 1;
    while (i + n < u8.length && u8[i + n] === v) n++;
    out.push(v);
    let m = n;
    do { const b = m & 0x7f; m >>= 7; out.push(m ? (b | 0x80) : b); } while (m);
    i += n;
  }
  return Uint8Array.from(out);
}
export function rleDecode(enc, outLen) {
  const out = new Uint8Array(outLen);
  let oi = 0, i = 0;
  while (i < enc.length) {
    const v = enc[i++];
    let n = 0, shift = 0, b;
    do { b = enc[i++]; n |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    out.fill(v, oi, oi + n); oi += n;
  }
  return out;
}
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function bytesToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 3) {
    const a = u8[i], b = u8[i + 1], c = u8[i + 2];
    const n = (a << 16) | ((b || 0) << 8) | (c || 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] +
      (i + 1 < u8.length ? B64[(n >> 6) & 63] : '=') +
      (i + 2 < u8.length ? B64[n & 63] : '=');
  }
  return s;
}
const B64INV = (() => { const m = {}; for (let i = 0; i < B64.length; i++) m[B64[i]] = i; return m; })();
export function b64ToBytes(str) {
  const clean = str.replace(/=+$/, '');
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64INV[clean[i]] << 18) | (B64INV[clean[i + 1]] << 12) |
      ((B64INV[clean[i + 2]] || 0) << 6) | (B64INV[clean[i + 3]] || 0);
    out.push((n >> 16) & 255);
    if (clean[i + 2] !== undefined) out.push((n >> 8) & 255);
    if (clean[i + 3] !== undefined) out.push(n & 255);
  }
  return Uint8Array.from(out);
}

export const SAVE_VERSION = 1;
/** Monde complet -> chaîne (base64 du RLE) pour le fichier de sauvegarde. */
export const encodeWorld = world => bytesToB64(rleEncode(world));
/** Chaîne -> Uint8Array(WORLD_TILES). Lève si la taille décodée est incohérente. */
export function decodeWorld(str) {
  const out = rleDecode(b64ToBytes(str), WORLD_TILES);
  if (out.length !== WORLD_TILES) throw new Error('decodeWorld: taille incohérente');
  return out;
}

/** Extrait un chunk (CHUNK×CHUNK, column-major interne) encodé base64+RLE. */
export function encodeChunk(world, cx, cy) {
  const x0 = cx * CHUNK, y0 = cy * CHUNK;
  const buf = new Uint8Array(CHUNK * CHUNK);
  let k = 0;
  for (let tx = x0; tx < x0 + CHUNK; tx++)
    for (let ty = y0; ty < y0 + CHUNK; ty++) buf[k++] = blockAt(world, tx, ty);
  return bytesToB64(rleEncode(buf));
}
/** Décode un chunk -> Uint8Array(CHUNK*CHUNK) (même ordre column-major). */
export const decodeChunk = str => rleDecode(b64ToBytes(str), CHUNK * CHUNK);

// ----------------------------------------------------------- génération
/** PRNG déterministe mulberry32 (aucun Math.random dans la génération). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// hash spatial pour bruit de valeur (indépendant de l'ordre → serveur == client)
function hash2(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + (seed | 0) * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth = t => t * t * (3 - 2 * t);
function valueNoise2(x, y, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed);
  const u = smooth(fx), v = smooth(fy);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/**
 * Génère TOUT le monde en une seule passe déterministe depuis seed.
 * Retourne { world:Uint8Array(WORLD_TILES), surface:Int16Array(WORLD_W), spawnTileX,
 *            spawn:{x,y} en pixels, seed }.
 */
export function generateWorld(seed) {
  seed = seed >>> 0;
  const rng = mulberry32(seed);
  const world = newWorldArray();            // 0 = AIR partout
  const surface = new Int16Array(WORLD_W);
  const spawnTileX = SPAWN_TX;
  const maxSurface = WORLD_H - GEN.bedrockRows - 8;

  // (A) carte de hauteurs : somme d'octaves de bruit 1-D
  for (let tx = 0; tx < WORLD_W; tx++) {
    let n = 0, amp = 1, freq = 0.012, norm = 0;
    for (let o = 0; o < 4; o++) { n += valueNoise2(tx * freq, 0.5, seed) * amp; norm += amp; amp *= 0.5; freq *= 2; }
    let h = GEN.seaLevel + Math.round((n / norm - 0.5) * 2 * GEN.surfaceAmp);
    surface[tx] = Math.max(10, Math.min(maxSurface, h));
  }
  // (B) plateau de spawn dégagé (surface plate autour de la colonne de spawn)
  const hs = surface[spawnTileX];
  for (let tx = spawnTileX - GEN.spawnClearW; tx <= spawnTileX + GEN.spawnClearW; tx++)
    if (tx >= 0 && tx < WORLD_W) surface[tx] = hs;

  // (C) remplissage des colonnes : herbe / terre / pierre / bedrock
  for (let tx = 0; tx < WORLD_W; tx++) {
    const top = surface[tx];
    const base = tx * WORLD_H;
    for (let ty = 0; ty < WORLD_H; ty++) {
      let v;
      if (ty < top) v = BLOCK.AIR;
      else if (ty === top) v = BLOCK.GRASS;
      else if (ty <= top + GEN.dirtBand) v = BLOCK.DIRT;
      else if (ty >= WORLD_H - GEN.bedrockRows) v = BLOCK.BEDROCK;
      else v = BLOCK.STONE;
      world[base + ty] = v;
    }
  }
  // (D) grottes : seuil de bruit 2-D sur la PIERRE seulement (pas de raccords)
  for (let tx = 0; tx < WORLD_W; tx++) {
    const base = tx * WORLD_H;
    const top = surface[tx];
    for (let ty = top + GEN.dirtBand + 1; ty < WORLD_H - GEN.bedrockRows; ty++) {
      if (world[base + ty] !== BLOCK.STONE) continue;
      const c = valueNoise2(tx * GEN.caveScale, ty * GEN.caveScale, seed ^ 0x51ed) * 0.65
        + valueNoise2(tx * GEN.caveScale * 2.3, ty * GEN.caveScale * 2.3, seed ^ 0x9e37) * 0.35;
      const depth01 = (ty - top) / (WORLD_H - top);
      if (c < GEN.caveThreshold + 0.05 * (1 - depth01)) world[base + ty] = BLOCK.AIR;
    }
  }
  // (E) filons de minerais (remplacent uniquement la PIERRE ; plus rares en profondeur)
  const placeOre = (oreId, count, minY, maxY, vein) => {
    for (let i = 0; i < count; i++) {
      let tx = 2 + Math.floor(rng() * (WORLD_W - 4));
      let ty = minY + Math.floor(rng() * Math.max(1, maxY - minY));
      for (let v = 0; v < vein; v++) {
        if (inBounds(tx, ty) && world[tileIndex(tx, ty)] === BLOCK.STONE) world[tileIndex(tx, ty)] = oreId;
        tx += (rng() < 0.5 ? -1 : 1);
        ty += (rng() < 0.5 ? -1 : 1);
      }
    }
  };
  placeOre(BLOCK.COAL_ORE, 2600, GEN.seaLevel + 4, WORLD_H - 3, 5);
  placeOre(BLOCK.IRON_ORE, 1500, 96, WORLD_H - 3, 4);
  placeOre(BLOCK.GOLD_ORE, 420, 168, WORLD_H - 3, 3);
  placeOre(BLOCK.DIAMOND_ORE, 200, 200, WORLD_H - 3, 3);

  // (F) arbres sur l'herbe (terrain plat, espacés, hors spawn)
  let lastTreeX = -99;
  const setIfAir = (tx, ty, v) => { if (inBounds(tx, ty) && world[tileIndex(tx, ty)] === BLOCK.AIR) world[tileIndex(tx, ty)] = v; };
  for (let tx = 2; tx < WORLD_W - 2; tx++) {
    const top = surface[tx];
    if (world[tx * WORLD_H + top] !== BLOCK.GRASS) continue;
    if (Math.abs(top - surface[tx - 1]) > 1 || Math.abs(top - surface[tx + 1]) > 1) continue;
    if (Math.abs(tx - spawnTileX) <= GEN.spawnClearW) continue;
    if (tx - lastTreeX < 3) continue;
    if (rng() >= GEN.treeChance) continue;
    const th = 4 + Math.floor(rng() * 3);            // tronc 4..6
    for (let k = 1; k <= th; k++) setIfAir(tx, top - k, BLOCK.LOG);
    for (let lx = -2; lx <= 2; lx++)
      for (let ly = -th - 1; ly <= -th + 1; ly++)
        if (Math.abs(lx) + Math.abs(ly + th) <= 3) setIfAir(tx + lx, top + ly, BLOCK.LEAVES);
    lastTreeX = tx;
  }
  // (G) sécurité du spawn : 2 tuiles d'air au-dessus + sol solide dessous
  world[spawnTileX * WORLD_H + hs - 1] = BLOCK.AIR;
  world[spawnTileX * WORLD_H + hs - 2] = BLOCK.AIR;
  if (!isSolidId(world[spawnTileX * WORLD_H + hs])) world[spawnTileX * WORLD_H + hs] = BLOCK.GRASS;

  const spawn = { x: spawnTileX * TILE + TILE / 2, y: hs * TILE };
  return { world, surface, spawnTileX, spawn, seed };
}

// ----------------------------------------------------------- inventaire
// Représentation partagée serveur (autorité) / client (prédiction + UI craft).
// inv = { hotbar:[9], main:[27], sel:0 } ; slot = { item:itemId, count } | null.
export const HOTBAR_SIZE = 9;
export const MAIN_SIZE = 27;
export const makeInv = () => ({
  hotbar: new Array(HOTBAR_SIZE).fill(null),
  main: new Array(MAIN_SIZE).fill(null),
  sel: 0
});
/** Slots dans l'ordre de remplissage : hotbar d'abord, puis l'inventaire étendu. */
export function* invSlots(inv) {
  for (let i = 0; i < HOTBAR_SIZE; i++) yield ['hotbar', i, inv.hotbar[i]];
  for (let i = 0; i < MAIN_SIZE; i++) yield ['main', i, inv.main[i]];
}
export function invCount(inv, itemId) {
  let n = 0;
  for (const [, , s] of invSlots(inv)) if (s && s.item === itemId) n += s.count;
  return n;
}
/** Ajoute count exemplaires ; retourne le reliquat qui n'a pas tenu (0 = tout placé). */
export function invAdd(inv, itemId, count) {
  const max = stackOf(itemId);
  if (max > 1) {
    for (const [g, i, s] of invSlots(inv)) {
      if (count <= 0) break;
      if (s && s.item === itemId && s.count < max) {
        const take = Math.min(max - s.count, count);
        s.count += take; count -= take;
      }
    }
  }
  for (const [g, i, s] of invSlots(inv)) {
    if (count <= 0) break;
    if (!s) { const take = Math.min(max, count); inv[g][i] = { item: itemId, count: take }; count -= take; }
  }
  return count;
}
/** Retire exactement count exemplaires ; false (sans muter) si insuffisant. */
export function invRemove(inv, itemId, count) {
  if (invCount(inv, itemId) < count) return false;
  for (const [g, i, s] of invSlots(inv)) {
    if (count <= 0) break;
    if (s && s.item === itemId) {
      const take = Math.min(s.count, count);
      s.count -= take; count -= take;
      if (s.count === 0) inv[g][i] = null;
    }
  }
  return true;
}
export const heldItem = inv => inv.hotbar[inv.sel] || null;
