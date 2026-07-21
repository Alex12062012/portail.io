# Mine Coop — reprise : construire le client (v1 complète)

## Contexte

Projet `game-portal` (portail **lexo.io** — toujours en minuscules strictes, jamais
"Lexo"/"LEXO"). Le **back-end de Mine Coop est entièrement terminé** par une session
précédente. Il reste à construire **le client** (`public/games/mine-coop/`) et à brancher
Mine Coop sur le portail. Lis les fichiers listés ci-dessous avant d'écrire une ligne.

---

## Ce qui existe déjà — NE PAS retoucher sans raison

| Fichier | Rôle |
|---|---|
| `shared/mine-world.js` | Constantes, génération, BLOCK/ITEM/RECIPE, encode/decode, helpers |
| `shared/mine-physics.js` | Physique joueur (createPlayerState, stepPlayer, aabbOverlap) |
| `server/games/mine-coop.js` | Logique serveur complète |
| `server/mine-save.js` | Persistance LRU (5 mondes max), readSave/writeSave |
| `server/server.js` | Registre GAMES mis à jour, routage `mine:*`, `mine:savesInfo` |

Le modèle client à suivre est `public/games/tag-arena/` (index.html / main.js /
render.js / audio.js / tag.css). Réutilise `/shared/debug-hud.js` tel quel pour
le HUD FPS+ping en haut à gauche (même API que Tag Arena).

---

## Ce qu'il faut construire

### 1. Portail (`public/index.html` + `public/portal.js`)

Dans `public/index.html`, remplace la carte `.card-soon` ("Mystère…") par :
```html
<a class="card card-active" id="cardMine" href="/games/mine-coop/">
  <!-- même structure que #cardTag -->
</a>
```
Dans `public/portal.js`, ajoute le même garde-fou pseudo sur `#cardMine` que sur
`#cardTag` (lecture de `localStorage('lexo.name')`, blocage si vide).

### 2. `public/games/mine-coop/` — structure complète

```
public/games/mine-coop/
  index.html     ← 3 écrans : screenMenu / screenLobby / screenGame
  main.js        ← socket, loop, physique locale, envoi mine:move
  render.js      ← rendu canvas (monde, joueurs, zombies, HUD)
  mine.css       ← styles propres à Mine Coop
```

---

## Protocole socket — contrats exacts à respecter

### Émissions CLIENT → SERVEUR

| Événement | Payload |
|---|---|
| `room:create` | `{ gameType:'mine-coop', name, worldCode? }` — worldCode optionnel (4-8 alphanum, majuscules) |
| `room:join` | `{ code, name }` |
| `room:start` | *(aucun payload)* |
| `mine:move` | `{ x, y, vx, vy, f }` — position px, vitesses, direction (-1/1) |
| `mine:select` | `{ slot }` — hotbar 0-8 |
| `mine:break` | `{ tx, ty }` — tuile à miner |
| `mine:place` | `{ tx, ty }` — tuile à poser (bloc de la hotbar sélectionnée) |
| `mine:chunkRequest` | `{ cx, cy }` — index chunk réseau (cx 0..127, cy 0..7) |
| `mine:craft` | `{ recipeId }` |
| `mine:smelt` | *(aucun payload)* — smelt le four du joueur |
| `mine:teleport` | `{ tx, ty }` — tuile de destination |
| `mine:attack` | `{ targetId }` — id zombie |
| `mine:savesInfo` | *(callback)* → `{ saves:[{code,lastSaved}], max:5 }` |

### Réceptions SERVEUR → CLIENT

| Événement | Payload clé |
|---|---|
| `game:start` | `{ gameType, code, seed, spawn:{x,y}, dayTime, you:{id,hp,inv}, players:[{id,name,x,y,hp}] }` |
| `mine:state` | `{ day, players:[{id,name,x,y,vx,vy,f,hp}], zombies:[{id,x,y,f,hp}] }` (15 Hz) |
| `mine:chunkData` | `{ cx, cy, data: Uint8Array encodé en base64 ou Array }` |
| `mine:blockSet` | `{ tx, ty, block }` — mise à jour temps réel d'une tuile |
| `mine:hp` | `{ id, hp }` — dégât/soin |
| `mine:respawn` | `{ id, x, y }` — réapparition joueur |
| `mine:zombieDead` | `{ id, x, y }` |
| `mine:zombieHit` | `{ id, hp }` |
| `room:update` | État du salon (lobby : liste joueurs, statut) |

### Payload `startPayload` (reçu dans `game:start`)

```js
{
  gameType: 'mine-coop',
  code: 'ABCD',            // code du salon
  seed: 123456789,         // seed uint32 (pour affichage éventuel)
  spawn: { x, y },         // position px de départ du joueur local
  dayTime: 0.2,            // 0..1, 0=minuit, 0.25=lever, 0.5=midi, 0.75=coucher
  you: { id, hp, inv },    // état initial du joueur local
  players: [{id,name,x,y,hp}]  // tous les joueurs (y compris soi-même)
}
```

### Inventaire (`inv`)

```js
inv = {
  hotbar: Array(9),         // slots 0-8
  bag: Array(27),           // inventaire étendu
  furnace: { fuel, input, output }
}
// chaque slot : null  OU  { item: <id numérique>, count: 1..64 }
```

---

## Constantes utiles (dans `shared/mine-world.js`)

```js
import {
  TILE,            // 32 px
  WORLD_W, WORLD_H,
  WORLD_OFFSET_X,  // 2048 — X affiché = tx - WORLD_OFFSET_X
  CHUNK,           // 32 tuiles/chunk réseau
  CHUNKS_X, CHUNKS_Y, // 128, 8
  DAY_LENGTH_S,    // 600 s = 10 min
  SPAWN_TX,        // colonne de spawn (X affiché = 0)
  BLOCK, BLOCK_META, ITEM, ITEM_META, RECIPE_BY_ID,
  blockAt, solidAt, tileIndex, inBounds,
  displayXToTileX, pxToTileX, pxToTileY,
  decodeWorld, encodeChunk,
  isNight          // isNight(dayTime) → boolean
} from '/shared/mine-world.js';
```

---

## Fonctionnalités à implémenter côté client

### screenMenu
- Champ pseudo (pré-rempli depuis `localStorage('lexo.name')`).
- Bouton "Créer un monde" : ouvre un sous-panel avec champ optionnel "Code du monde"
  (4-8 alphanum) + appel `mine:savesInfo` pour afficher la liste des sauvegardes
  existantes et avertir si une suppression LRU est imminente (déjà 5 mondes).
- Bouton "Rejoindre" : champ code salon (4 lettres générées).
- Mini-bar "← Portail" (lien retour vers `/`), comme Tag Arena.

### screenLobby
- Affiche le code du salon + liste des joueurs connectés.
- Bouton "Démarrer" (hôte uniquement) → `room:start`.
- Bouton "Quitter" → `room:leave`.

### screenGame — canvas plein écran
- **Caméra** : suit le joueur local, lerp + clamp aux bords du monde.
- **Chunks** : le client maintient un cache `Map<"cx,cy", Uint8Array>`. À chaque
  frame, calcule quels chunks sont dans/près du viewport et demande ceux qui
  manquent via `mine:chunkRequest`. Applique les `mine:blockSet` au cache local.
- **Rendu monde** : ne dessine que les tuiles visibles (viewport + marge). Couleur
  de fond dépend de `dayTime` (ciel bleu → nuit noire via gradient). Le
  `BLOCK_META[id].color` (chaîne CSS) suffit pour une v1 (pas de textures).
- **Joueurs** : rectangle 22×44 px couleur distincte (index dans `players`), nom
  au-dessus, barre de vie rouge/verte.
- **Zombies** : dessinés depuis `mine:state`, couleur verte.
- **HUD haut gauche** : `createDebugHud(socket)` depuis `/shared/debug-hud.js`
  (FPS + ping).
- **HUD haut droite** :
  - Coordonnées X/Y affichées en temps réel (X = `Math.round(px/TILE) -
    WORLD_OFFSET_X`, Y = `Math.round(py/TILE)`).
  - Panneau téléportation (champs X/Y + bouton "Téléporter", touche `M` pour focus).
    Envoie `mine:teleport` puis met à jour la position locale immédiatement.
- **Hotbar** : 9 cases en bas de l'écran, case sélectionnée mise en valeur, clic
  ou touches 1-9 pour sélectionner (`mine:select`).
- **Minage** : clic gauche maintenu sur tuile dans `MINE.reachTiles` de portée →
  barre de progression locale (basée sur `BLOCK_META[id].hardness`), quand pleine
  → envoie `mine:break`. Le serveur confirme via `mine:blockSet` (bloc → AIR).
- **Pose** : clic droit sur tuile vide à portée → `mine:place`.
- **Attaque** : touche `E` ou clic droit sur zombie → `mine:attack { targetId }`.
- **Inventaire étendu** : touche `I` → overlay avec le bag + table de craft.
  Craft : liste des recettes disponibles selon inventaire, clic → `mine:craft`.

### Physique locale (client-side prediction)
Utilise `createPlayerState` + `stepPlayer` de `/shared/mine-physics.js`, en
appliquant la grille reçue par chunks. Inputs : flèches gauche/droite + espace
(saut). Envoie `mine:move` à ~25 Hz avec la position calculée localement. Applique
les positions des autres joueurs reçues dans `mine:state` sans prédiction (lerp
simple).

---

## Critères de succès v1 (vérifie toi-même avant de conclure)

1. `npm test` passe sans erreur — Tag Arena est intact.
2. Page d'accueil : 2 cartes actives (Tag Arena + Mine Coop), nom "lexo.io" en
   minuscules.
3. Créer un monde (code auto ou perso) → spawn dans un monde généré, blocs visibles.
4. 2 onglets dans le même salon : les deux joueurs se voient bouger en temps réel.
5. Minage (clic gauche maintenu) + pose (clic droit) fonctionnent et se propagent
   à l'autre joueur via `mine:blockSet`.
6. Hotbar affiche l'inventaire, sélection au clic/touche 1-9.
7. HUD haut droite : coordonnées X/Y en temps réel, téléportation fonctionnelle.
8. Cycle jour/nuit visible (fond du ciel qui change).
9. Quitter puis rejoindre avec le même code → blocs minés conservés.
