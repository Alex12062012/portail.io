# Mine Coop — Prompt 7 : Survie & HUD

Projet `game-portal` — portail **lexo.io** (toujours minuscules).  
`npm test` doit passer sans modification après ce prompt.

---

## Fichiers à lire en priorité

| Fichier | Pourquoi |
|---|---|
| `shared/mine-world.js` | MINE.maxHp, MINE.gravity, constantes physiques, isNight, DAY_LENGTH_S |
| `server/games/mine-coop.js` | Gestion des HP (mine:hp), respawn, zombies, tick |
| `public/games/mine-coop/render.js` | HUD actuel, positionnement des éléments à déplacer |
| `public/games/mine-coop/main.js` | Gestion des états joueur local, socket events |
| `C:\Users\alexa\Downloads\2D Minecraft Original Assets\2D Minecraft Original Assets\Original PNG\Minecraft Kalp.png` | Sprite du cœur à utiliser pour la barre de vie |

---

## 1. Barre de vie — cœurs style Minecraft

### 1a. Asset cœur

Copie `Minecraft Kalp.png` (dossier 2D Minecraft Original Assets) dans :
`public/games/mine-coop/assets/textures/heart.png`

La barre de vie affiche **10 cœurs** (chaque cœur = 10 HP → `MINE.maxHp = 100`).  
Chaque cœur peut être : plein, demi, vide.

### 1b. Rendu des cœurs

Dans `render.js`, crée une fonction `drawHearts(ctx, hp, maxHp)` :

```js
// Dimensions d'un cœur à l'écran
const HEART_SIZE = 18;   // px, carré
const HEART_GAP  = 2;    // px entre cœurs
const HEARTS     = 10;   // nombre total de cœurs

// Position : HUD bas-gauche, juste au-dessus de la hotbar
// (la hotbar est en bas — les cœurs sont 4px au-dessus de la hotbar)
const heartsY = canvas.height - HOTBAR_H - HEART_SIZE - 8;
const heartsX = 8;

function drawHearts(ctx, hp, maxHp) {
  const total  = HEARTS;            // 10 cœurs
  const half   = hp / (maxHp / total); // HP en "demi-cœurs" (0..20)
  for (let i = 0; i < total; i++) {
    const x = heartsX + i * (HEART_SIZE + HEART_GAP);
    // Fond (cœur vide) : dessiner le sprite assombri ou un carré gris foncé
    ctx.globalAlpha = 0.35;
    ctx.drawImage(heartImg, x, heartsY, HEART_SIZE, HEART_SIZE);
    ctx.globalAlpha = 1.0;
    // Remplissage selon les HP restants
    const filled = half - i * 2;   // filled > 1 = plein, 0..1 = demi, ≤ 0 = vide
    if (filled >= 2) {
      // Cœur plein
      ctx.drawImage(heartImg, x, heartsY, HEART_SIZE, HEART_SIZE);
    } else if (filled >= 1) {
      // Demi-cœur : clip la moitié gauche du sprite
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, heartsY, HEART_SIZE / 2, HEART_SIZE);
      ctx.clip();
      ctx.drawImage(heartImg, x, heartsY, HEART_SIZE, HEART_SIZE);
      ctx.restore();
    }
    // ≤ 0 : rien (fond déjà dessiné)
  }
}
```

Si `heartImg` n'est pas encore chargée (chargement async), affiche une barre rouge de fallback.

### 1c. Mise à jour côté serveur — aucune modification nécessaire

Le serveur envoie déjà `mine:hp { id, hp }`. Le client stocke `localPlayer.hp` depuis `game:start` et le met à jour sur `mine:hp`. Utilise cette valeur pour `drawHearts`.

---

## 2. Barre de faim

### 2a. Données serveur

Dans `shared/mine-world.js`, ajouter :
```js
export const MAX_HUNGER = 20;   // valeur max (comme Minecraft)
```

Dans `server/games/mine-coop.js`, ajouter au record joueur :
```js
hunger:     MAX_HUNGER,   // commence au max
hungerAcc:  0,            // accumulateur pour la baisse progressive
```

Dans `tick(dt)`, pour chaque joueur :
```js
// Faim : baisse de 1 point toutes les 30 s en se déplaçant, 60 s au repos
const moving = Math.abs(p.vx) > 10 || Math.abs(p.vy) > 10;
p.hungerAcc += dt / (moving ? 30 : 60);
if (p.hungerAcc >= 1 && p.hunger > 0) {
  p.hungerAcc -= 1;
  p.hunger--;
  emitTo(p.id, 'mine:hunger', { hunger: p.hunger });
}
// Régénération HP si faim > 18 et HP < maxHp
if (p.hunger > 18 && p.hp < MINE.maxHp) {
  p.hp = Math.min(MINE.maxHp, p.hp + dt * 1.5);  // +1.5 HP/s
  emitTo(p.id, 'mine:hp', { id: p.id, hp: Math.round(p.hp) });
}
// Dégâts de famine si faim = 0 (sauf si déjà à 1 HP)
if (p.hunger === 0 && p.hp > 1) {
  p.hp = Math.max(1, p.hp - dt * 0.5);
  emitTo(p.id, 'mine:hp', { id: p.id, hp: Math.round(p.hp) });
}
```

Ajouter `hunger` à `startPayload` et à `snapshot` (dans le `you` initial).

Client : écouter `mine:hunger` et stocker `localPlayer.hunger`.  
Ajouter dans `startPayload` côté client : `localPlayer.hunger = gs.you.hunger ?? MAX_HUNGER`.

### 2b. Manger — consommer de la nourriture

Pour cette v1, les items comestibles sont :
| Item | Restaure |
|---|---|
| (pas d'item nourriture v1) | — |

La faim descend naturellement mais **ne tue pas** (plancher à 1 HP). La barre de faim est présente pour la v1 même si aucun item ne la restaure encore — les items alimentaires arrivent dans Prompt 8 avec les animaux.

### 2c. Rendu de la barre de faim

Dans `render.js`, crée `drawHunger(ctx, hunger)` — symétrique des cœurs mais **à droite**, avec un sprite de poulet 🍗 ou un simple dessin stylisé :

```js
// Icône faim : dessin simple (pas de sprite externe pour v1)
const HUNGER_SIZE = 18;
const HUNGER_GAP  = 2;
const HUNGERS     = 10;   // 10 icônes = 20 points de faim

// Position : même Y que les cœurs, aligné à droite de la hotbar
const hungerEndX = canvas.width - 8;
const hungerY    = heartsY;

function drawHunger(ctx, hunger) {
  const half = hunger;  // 0..20
  for (let i = HUNGERS - 1; i >= 0; i--) {
    const x = hungerEndX - (HUNGERS - i) * (HUNGER_SIZE + HUNGER_GAP);
    // Fond gris (faim vide)
    ctx.fillStyle = '#3a2a1a';
    ctx.beginPath();
    // Dessin simplifié : carré avec légère forme arrondie (ou juste rect)
    ctx.fillRect(x, hungerY, HUNGER_SIZE, HUNGER_SIZE);
    // Remplissage selon faim
    const filled = half - i * 2;
    if (filled >= 2) {
      ctx.fillStyle = '#d0a020';  // jaune-orange = plein
      ctx.fillRect(x, hungerY, HUNGER_SIZE, HUNGER_SIZE);
    } else if (filled >= 1) {
      ctx.fillStyle = '#d0a020';
      ctx.fillRect(x, hungerY, HUNGER_SIZE / 2, HUNGER_SIZE);
    }
    // Contour
    ctx.strokeStyle = '#5a4010';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, hungerY + 0.5, HUNGER_SIZE - 1, HUNGER_SIZE - 1);
  }
}
```

---

## 3. Dégâts de chute

### 3a. Serveur

Dans `server/games/mine-coop.js`, ajouter dans le record joueur :
```js
fallVy: 0,   // vitesse verticale max enregistrée pendant cette chute
```

Dans `handleMove(id, data)` (ou dans le `tick` qui lit les positions) : lire `data.vy`.

Logique dans `tick` (ou à la réception de `handleMove`) :
```js
// Enregistre la vitesse de chute max
if (p.vy > p.fallVy) p.fallVy = p.vy;

// Détection atterrissage : était en l'air (vy > 0), maintenant onGround
if (wasInAir && p.onGround) {
  const dmg = fallDamage(p.fallVy);
  if (dmg > 0) {
    p.hp = Math.max(0, p.hp - dmg);
    emitTo(p.id, 'mine:hp', { id: p.id, hp: Math.round(p.hp) });
    emit('mine:hp', { id: p.id, hp: Math.round(p.hp) });
    p.stats.damage_taken += dmg;
    if (p.hp <= 0) respawnPlayer(p);
  }
  p.fallVy = 0;
}
```

```js
/** Dégâts de chute selon vitesse d'impact (px/s).
 *  En dessous de 3 tuiles de hauteur (~= vy < 480 px/s à l'impact) : pas de dégât.
 *  Formule linéaire au-delà (1 HP par tuile supplémentaire de chute). */
function fallDamage(vy) {
  const SAFE_VY = TILE * 15;       // ~15 tuiles/s ≈ 3 tuiles de chute libre (approx)
  if (vy < SAFE_VY) return 0;
  return Math.floor((vy - SAFE_VY) / (TILE * 5));  // 1 HP par 5 tuiles supplémentaires
}
```

> **Note** : `onGround` et `vy` viennent de `data` envoyé par `mine:move` côté client. Côté serveur on les stocke dans `p.vy` et `p.onGround`. Ajoute `wasInAir = !p.onGround` au début du traitement, avant la mise à jour.

### 3b. Client — feedback visuel

Dans `render.js`, si `localPlayer.hp` diminue soudainement (sans zombie à proximité), afficher un flash rouge sur l'écran (`ctx.fillStyle = 'rgba(200,0,0,0.35)'` pendant 300 ms). Ce flash est déjà probablement présent pour les dégâts de zombies — le réutiliser.

---

## 4. Indicateur jour/nuit — soleil et lune

### 4a. Position dans le HUD

En **haut à droite**, au-dessus des coordonnées X/Y : une petite icône soleil ou lune + heure de jeu.

```
Position : canvas.width - 120, 8
Taille zone : 112 × 28 px
```

### 4b. Rendu

```js
function drawDayNightIndicator(ctx, dayTime) {
  const x = canvas.width - 120, y = 8;
  const w = 112, h = 28;
  // Fond semi-transparent
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  roundRect(ctx, x, y, w, h, 6);
  ctx.fill();

  // Icône + texte
  const night = isNight(dayTime);
  const icon = night ? '🌙' : '☀️';
  // Heure affichée : 0..1 → 0h..24h, avec 0.25 = lever (6h), 0.75 = coucher (18h)
  const gameHour = ((dayTime + 0.75) % 1) * 24;  // 0.25=6h → 0h offset → 0.0=6h
  // Pour simplifier : 0.25 = 6h00, 0.5 = 12h00, 0.75 = 18h00, 0.0 = 0h00
  const h24 = ((dayTime * 24 + 6) % 24) | 0;
  const m   = Math.floor(((dayTime * 24 + 6) % 1) * 60);
  const timeStr = `${String(h24).padStart(2,'0')}:${String(m).padStart(2,'0')}`;

  ctx.font = '14px monospace';
  ctx.fillStyle = night ? '#c8d8f8' : '#fff8c8';
  ctx.textAlign = 'left';
  ctx.fillText(icon + ' ' + timeStr, x + 8, y + 19);
}
```

Helper `roundRect` (si pas déjà présent) :
```js
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
```

### 4c. Transition nuit/jour — assombrissement du ciel

Le rendu du ciel doit déjà utiliser `ambientLight(dayTime)` (défini dans `mine-world.js`).  
Vérifier que le ciel passe progressivement de bleu (#5ba8e8) la journée à noir (#05080e) la nuit, avec un coucher de soleil orangé (#e87830) entre `dayTime ≈ 0.72` et `dayTime ≈ 0.80`.

```js
function skyColor(dayTime) {
  const light = ambientLight(dayTime);
  // Coucher/lever : teinte orangée
  const sunsetZone = dayTime >= 0.70 && dayTime <= 0.82
    || dayTime >= 0.18 && dayTime <= 0.28;
  if (sunsetZone) {
    // Mix bleu-jour → orange → noir-nuit
    const t = light;
    const r = Math.round(232 * t * (1 - t) * 4 + 5 * (1 - light));  // orange au coucher
    const g = Math.round(120 * t * (1 - t) * 2 + 8 * (1 - light));
    const b = Math.round(232 * light + 14 * (1 - light));
    return `rgb(${Math.min(255,r+Math.round(91*light))},${Math.min(255,g+Math.round(168*light))},${b})`;
  }
  // Jour → nuit linéaire
  const rd = Math.round(91  * light + 5  * (1 - light));
  const gd = Math.round(168 * light + 8  * (1 - light));
  const bd = Math.round(232 * light + 14 * (1 - light));
  return `rgb(${rd},${gd},${bd})`;
}
```

---

## 5. Réorganisation du HUD

### Disposition finale (toutes les zones du canvas)

```
┌──────────────────────────────────────────────────┐
│ [FPS+ping]      coordonnées X/Y    [🌙 22:30]   │  ← ligne HUD haut
│                 [téléportation]                   │
│                                                   │
│           (monde, joueurs, zombies)               │
│                                                   │
│ ❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️  [hotbar 9 cases]  🍗🍗🍗🍗🍗🍗🍗🍗🍗🍗 │  ← HUD bas
└──────────────────────────────────────────────────┘
```

Règles de positionnement :
- **Hotbar** : centrée horizontalement, Y = `canvas.height - HOTBAR_H - 4`, taille case 48×48 px.
- **Cœurs** : alignés à gauche (`x=8`), Y = `canvas.height - HOTBAR_H - HEART_SIZE - 10`.
- **Faim** : alignée à droite (`x = canvas.width - 8 - 10*(HUNGER_SIZE+HUNGER_GAP)`), même Y que les cœurs.
- **FPS+ping** (debug-hud.js) : haut-gauche, inchangé.
- **Coordonnées X/Y** : haut-droite, juste en dessous de l'indicateur jour/nuit (déplacer si collision).
- **Indicateur jour/nuit** : coin haut-droit, `x = canvas.width - 120, y = 8`.
- **Téléportation** : sous les coordonnées, haut-droite, comme actuellement.

Barres de vie des **zombies** : restent au-dessus des mobs (inchangé).  
Barres de vie des **autres joueurs** : restent au-dessus des joueurs (inchangé).

---

## 6. Critères de succès

1. `npm test` passe sans erreur.
2. **Cœurs** : barre de 10 cœurs visible en bas à gauche. Prendre des dégâts de zombie → les cœurs diminuent visuellement. Mort → respawn.
3. **Faim** : barre de 10 icônes en bas à droite. Après 30 s de déplacement actif, un point de faim est consommé (testable avec `_setDayTime` ou en attendant).
4. **Chute** : tomber de ≥ 4 tuiles de hauteur → perte de HP (observable sur la barre de cœurs). Chute < 3 tuiles → aucun dégât.
5. **Indicateur jour/nuit** : visible en haut à droite avec l'heure de jeu qui s'écoule. L'icône passe de ☀️ à 🌙 quand la nuit tombe.
6. **Ciel** : la couleur de fond du ciel change progressivement entre jour et nuit — pas de saut brutal.
7. **Hotbar** reste centrée et ne chevauche pas les cœurs/faim.
