# Valorant-like — Prompt 9 : bugs critiques (round, souris, mort)

Projet `game-portal`, mini-jeu `public/games/valorant/`. Ce prompt corrige trois bugs
réels, localisés et vérifiés dans le code actuel (pas des suppositions) :
l'exploit de la phase d'achat, le curseur qui reste capturé à l'écran de fin, et
l'absence totale de mode spectateur après la mort. `npm test` doit continuer à
passer (`node tests/smoke-valorant.mjs` inclus) et les 3 corrections doivent
être couvertes par de nouvelles vérifications dans ce fichier de test.

---

## Fichiers à lire en priorité

| Fichier | Pourquoi |
|---|---|
| `public/games/valorant/js/main.js` | boucle de jeu, `arsenal.locked`, `player.update()` appelé sans condition |
| `public/games/valorant/js/buy_menu.js` | `close()` retire `buy.open` avant que `rm.phase` passe à `'live'` |
| `public/games/valorant/js/round_manager.js` | `phase` ne change qu'au timer à 0, pas au clic sur PRÊT |
| `public/games/valorant/js/input.js` | listener `click` global qui redemande le pointer lock |
| `public/games/valorant/js/ui/hud.js` | `showEnd()` — écran de fin de **match** |
| `public/games/valorant/js/player.js` | `update()` — aucune condition sur `alive` |
| `tests/smoke-valorant.mjs` | tests existants à étendre, pas à dupliquer |

---

## 1. Exploit de la phase d'achat (« Prêt » sort trop tôt du buy)

### Root cause identifiée

Dans `main.js`, `arsenal.locked` dépend de `buy.open`, pas de `rm.phase` :

```js
arsenal.locked = buy.open || !playerActor.alive || loadout.equipped >= 0 || !!effects.drone;
```

`buy_menu.js#close()` met `buy.open = false` dès le clic sur PRÊT — mais
`round_manager.js#update()` ne fait passer `phase` de `'buy'` à `'live'` que
quand `this.timer <= 0`. Entre les deux, `player.update(dt, input, solids, camera)`
tourne sans aucune garde (`main.js`, boucle `renderer.setAnimationLoop`), donc le
joueur peut **bouger et tirer avant le début officiel du round**, sur des bots
encore immobiles (leur IA n'est appelée que `if (rm.live)`).

### Correction demandée

Le round ne doit démarrer (mouvement de combat, dégâts, tir) que quand **tous
les joueurs sont prêts OU que le timer d'achat arrive à zéro** — jamais avant.

- Garder le bouton PRÊT, mais il ne doit plus fermer le buy menu ni débloquer
  l'arsenal à lui seul. Il doit seulement marquer `playerActor.ready = true` et
  griser/désactiver le bouton (texte du style « EN ATTENTE DES AUTRES »).
- Ajoute un état `ready` par acteur (joueur + bots). Un bot doit se marquer
  `ready = true` juste après `buyRound()` (il a fini d'acheter).
- `RoundManager` (ou une fonction dédiée dans `main.js`, au choix le plus
  propre) passe en `'live'` dès que **tous les acteurs vivants sont `ready`**,
  ou quand `timer <= 0` — le premier des deux événements.
- Tant que `phase === 'buy'`, quel que soit l'état de `buy.open` :
  - `arsenal.locked` doit rester vrai ;
  - `player.update` ne doit pas permettre de tirer ni d'infliger de dégâts
    (regarder/se positionner peut rester possible si tu veux garder le buy
    menu fermable sans figer complètement la caméra — mais aucune arme,
    aucun dégât, aucun déclenchement de capacité).
- Le buy menu (l'UI) peut se fermer immédiatement au clic sur PRÊT comme
  aujourd'hui (`buy.hide()` / retour du pointer lock) — c'est seulement le
  déblocage du gameplay qui doit attendre la synchro.

### Vérification

Dans `tests/smoke-valorant.mjs`, après le clic sur `#buy button[data-kind="ready"]`
(ligne ~83), avant l'actuel `ok(!(await page.evaluate(() => window.buy.open))...)`,
ajoute une vérification que malgré PRÊT cliqué, `window.rm.phase === 'buy'` tant
que les bots n'ont pas fini d'acheter, et que tirer ne fait aucun dégât (ex :
`window.arsenal.locked === true` ou équivalent selon l'implémentation retenue).

---

## 2. Souris qui reste capturée par la caméra à l'écran de fin de match

### Root cause identifiée

`ui/hud.js#showEnd()` appelle bien `document.exitPointerLock()`, mais ne
positionne jamais `input.menu = true` (contrairement à `buy_menu.js#show()`
qui le fait). Or dans `input.js` :

```js
document.addEventListener('click', () => {
  if (!input.locked && !input.menu) Promise.resolve(canvas.requestPointerLock()).catch(() => {});
});
```

Ce listener global écoute **tous les clics du document**, y compris ceux sur le
bouton « RELANCER UNE RECHERCHE » de l'écran de fin. Comme `input.menu` reste
`false`, chaque clic sur ce bouton redemande le pointer lock — la caméra
reprend la main sur la souris en plein milieu de l'interaction, exactement le
symptôme décrit.

### Correction demandée

- `Hud#showEnd()` doit mettre `input.menu = true` (comme `BuyMenu#show()`)
  au moment où l'écran de fin apparaît, pour désactiver le listener de
  recapture automatique du pointer lock.
- Généralise si besoin : toute UI qui prend la main sur le curseur (buy menu,
  écran de fin, un futur écran pause) doit suivre la même règle — poser
  `input.menu = true` à l'ouverture. Si tu factorises ça dans une fonction
  commune (`ui/overlay-lock.js` ou équivalent), tant mieux, mais ce n'est pas
  obligatoire : le correctif minimal dans `showEnd()` suffit.
- La bannière de fin de **round** (`phase === 'end'`, texte `#banner`, pas
  d'UI cliquable) n'a pas ce problème — ne rien changer là.

### Vérification

Dans `tests/smoke-valorant.mjs`, à la fin du scénario `jett` (après la
vérification `next.buy` ligne ~209), simule la fin de match : force
`window.rm.score` proche de `ROUNDS_TO_WIN`, laisse un round se conclure, puis
vérifie que `window.input.menu === true` une fois `#endscreen.on` visible, et
qu'un clic sur le document (hors bouton) ne redemande pas le pointer lock
(`document.pointerLockElement` reste `null`).

---

## 3. Aucun mode spectateur : le joueur mort garde une caméra libre

### Root cause identifiée

Dans `main.js`, la boucle appelle sans condition :

```js
if (effects.drone) effects.driveDrone(dt, input, camera);
else player.update(dt, input, solids, camera);
```

`Player#update()` (dans `player.js`) ne teste jamais `playerActor.alive`. Un
joueur mort garde donc un contrôle complet de la caméra en vue première
personne (déplacement bloqué par les collisions de la map, mais mouvement et
regard entièrement libres) — il continue à voir la partie comme s'il était
vivant, sans passer par un vrai système d'observation. Le seul indice de mort
actuel est le texte `#dead` (« MORT ») affiché en overlay, sans changement de
caméra.

### Correction demandée

Implémente un vrai mode spectateur :

- Dès que `playerActor.alive` passe à `false` (et que `rm.live` est vrai),
  la caméra ne doit plus être pilotée par `player.update()`. Elle doit se
  positionner en troisième personne (ou première personne à la discrétion de
  l'implémentation, mais **sur un allié vivant**, pas sur le corps mort du
  joueur) sur le premier allié vivant trouvé.
- Touches de changement de cible : `ArrowLeft` / `ArrowRight` (le sujet
  mentionne aussi Q/D — **attention** : Q et D sont déjà les touches de
  déplacement AZERTY/QWERTY (`KeyQ`/`KeyD` = strafe gauche/droite en layout
  physique) et Q est aussi une capacité d'agent (`KeyQ`) ; les réutiliser pour
  le spectateur créerait un conflit direct. Utilise uniquement les flèches, ou
  si tu veux un doublon clavier, choisis des touches non utilisées ailleurs
  dans `input.js`/`abilities.js` (vérifie `AGENTS` avant de choisir) — pas de
  résurrection de KeyQ/KeyD.
- Le spectateur ne doit cycler que parmi les **alliés vivants**. Si l'allié
  observé meurt à son tour, bascule automatiquement sur le suivant.
  Si plus aucun allié n'est vivant, garde la dernière position/caméra libre
  simple (pas besoin de gérer l'observation des ennemis).
- Affiche le nom du joueur observé (réutilise le style existant du HUD,
  ex. un petit panneau proche de `#dead`).
- Au round suivant (`resetRound`), la caméra doit revenir au joueur normalement
  dès qu'il est vivant.

### Contraintes

- Ne touche pas à `player.pos` du joueur mort (sert encore de référence pour
  `deadLastRound` et l'arme perdue) : ajoute un état caméra séparé plutôt que
  de réutiliser `player.pos` pour l'allié observé.
- Le raycast de tir (`shootOne`, `hittables`) ne doit évidemment pas s'exécuter
  pendant l'observation — vérifie que `arsenal.locked` (ou équivalent) couvre
  bien ce cas ; à priori il l'est déjà via `!playerActor.alive`, confirme-le.

### Vérification

Ajoute un scénario dans `tests/smoke-valorant.mjs` (sur l'agent `jett`, après
la séquence spike existante) : force `window.playerActor.alive = false` et
`window.playerActor.hp = 0` pendant `rm.live`, avance quelques frames, puis
vérifie que la caméra n'est plus pilotée par `window.player` (par ex. la
position de la caméra Three correspond à celle d'un allié vivant, pas à
`window.player.pos`), et que `ArrowRight` change la cible observée.

---

## Vérification finale (les trois points)

1. `npm test` passe en entier (les 6 suites, valorant compris).
2. Rejouer manuellement `npm run dev` → `/games/valorant/` : cliquer PRÊT tôt
   ne doit plus permettre de tirer avant la fin du timer d'achat / que les
   bots soient prêts.
3. Terminer un match : l'écran de fin doit rester cliquable sans que la caméra
   ne bouge quand la souris se déplace vers le bouton.
4. Mourir en cours de round : la vue doit basculer sur un allié vivant,
   changeable aux flèches gauche/droite.
