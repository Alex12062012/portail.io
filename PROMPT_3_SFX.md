Dans `game-portal`, j'ai ajouté 3 nouveaux fichiers audio à la racine du projet :
`bombe 5sec.m4a` (8.0 s), `saut bump.mp3`, `teleporteur.mp3`. Intègre-les dans Tag Arena.

## 1. Déplacer et renommer les fichiers

Déplace-les vers `public/games/tag-arena/assets/audio/` (où se trouve déjà
`music-bg.mp3`) en les renommant sans espaces :
- `bombe 5sec.m4a` → `bomb.m4a`
- `saut bump.mp3` → `bump.mp3`
- `teleporteur.mp3` → `teleport.mp3`

Mets à jour `public/games/tag-arena/assets/audio/CREDITS.md` (même format de
tableau que pour `music-bg.mp3`) en ajoutant une ligne pour chacun des 3
nouveaux fichiers — source/licence "fichier fourni par l'auteur du projet,
usage interne" si tu n'as pas d'autre info.

## 2. SFX `bump.mp3` et `teleport.mp3` — branchement simple

Dans `public/games/tag-arena/audio.js`, ajoute deux effets courts (pattern
`new Audio(BASE + '...')`, volume raisonnable ex. 0.5, pas de `loop`), exposés
via l'objet retourné par `createAudioManager()`, ex. `playPad()` et
`playTeleport()`.

Câble-les dans `public/games/tag-arena/main.js` là où les effets `tag:fx` sont
déjà gérés (réception `socket.on('tag:fx', ...)` ligne ~249, et émission côté
local lignes ~409-414 pour `kind === 'pad'` et `kind === 'teleport'`) :
- `kind === 'pad'` (bounce pad) → joue `bump.mp3`
- `kind === 'teleport'` → joue `teleport.mp3`

Joue le son aussi bien quand c'est le joueur local qui déclenche l'effet que
quand un autre joueur le déclenche (les deux endroits où `renderer.fx(...)`
est appelé).

## 3. SFX `bomb.m4a` — synchronisation avec le décompte d'explosion (mode élimination)

### a. Déclenchement à exactement 5s avant l'explosion

Le serveur envoie `tag:state` à 30 Hz avec `t` = temps restant avant la
prochaine explosion (`snapshot()` dans `server/games/tag-arena.js`, champ
`t: Math.max(0, (deadline - now) / 1000)`, mode `'elimination'`).

Côté client (`public/games/tag-arena/main.js`, dans `applyState`/
`socket.on('tag:state', ...)`), détecte le passage de `t` au-dessus de 5s vers
`t <= 5` (en mode élimination, hors phase `game.waiting`) et joue alors
`bomb.m4a` une seule fois via `audio.playBomb()` (à ajouter dans `audio.js`,
même pattern que `bump`/`teleport`, sans loop). Réarme ce déclencheur à chaque
nouveau cycle d'explosion (après `tag:boom`/`tag:tagged`, quand `deadline` est
recalculé côté serveur et que `t` remonte au-dessus de 5).

### b. La dernière seconde du décompte doit durer 1.3s au lieu de 1s

But : faire correspondre visuellement le décompte "💣 1s" avec la fin du SFX
`bomb.m4a`. Le décompte doit donc s'écouler ainsi : 30, 29, ..., 2 (chacun
affiché 1.0s), puis **1 affiché pendant 1.3s**, puis explosion.

Ça implique deux changements liés :

- **Serveur** (`server/games/tag-arena.js`) : la durée totale réelle entre
  deux explosions passe de `elimSeconds` (30s) à `elimSeconds + 0.3s` (30.3s).
  Ajoute une constante (ex. `TAG.lastSecondExtraMs = 300` dans
  `shared/tag-map.js`, ou une constante locale dans `tag-arena.js`) et
  ajoute-la à chaque calcul de `deadline` en mode élimination (lignes ~156 et
  ~404/423 : `deadline = goAt/Date.now() + elimSeconds * 1000 + EXTRA_MS`).
  Ne change pas `elimSeconds`/`opts.eliminationSeconds` lui-même (utilisé par
  les tests) — ajoute juste l'extra au calcul du deadline.

- **Client** (`drawCountdown` dans `public/games/tag-arena/render.js`, ligne
  ~806, `const s = Math.max(0, Math.ceil(view.t));`) : en mode élimination
  uniquement, remplace ce calcul pour que le palier `s === 1` dure 1.3s :
  ```
  s = t > 1.3 ? Math.ceil(t - 0.3) : (t > 0 ? 1 : 0)
  ```
  (en mode classique, garde `Math.ceil(view.t)` tel quel — seul le mode
  élimination est concerné).

Vérifie que le déclenchement du SFX `bomb.m4a` (point a, sur `t <= 5` côté
client) reste cohérent avec ce nouveau total de 30.3s — le SFX démarre donc
quand il reste 5s réelles avant `tag:boom`, et le décompte affiché passe par
"💣 5s" → ... → "💣 1s" (affiché 1.3s) → explosion.

## Vérification

Lance `npm test`. Teste aussi en jouant une manche élimination (3-4 joueurs)
pour confirmer à l'oreille que `bomb.m4a` démarre quand le décompte affiche
"💣 5s" et que l'explosion arrive à la fin du fichier (8s de musique pour 5s de
décompte + 1.3s de palier final + marge — pas besoin que le fichier entier
soit joué, juste que son début coïncide avec t=5s).
