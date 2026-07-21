# Valorant-like — Prompt 15 : HUD de debug (FPS)

Projet `game-portal`, mini-jeu `public/games/valorant/`. Reprend tel quel le
HUD de debug déjà utilisé par Tag Arena et Mine Coop
(`public/shared/debug-hud.js` — FPS écran + FPS moteur + ping), affiché en
haut à gauche. Rien à créer, uniquement le brancher. `npm test` doit
continuer à passer.

## Fichiers à lire en priorité

| Fichier | Pourquoi |
|---|---|
| `public/shared/debug-hud.js` | le module à réutiliser tel quel, ne pas dupliquer/adapter |
| `public/games/tag-arena/main.js` (lignes ~12, ~27, ~40, ~454) | référence d'intégration : import, création, `show()`/`hide()`, `markFrame()` |
| `public/games/mine-coop/main.js` (lignes ~28, ~40, ~57, ~884) | même référence, deuxième exemple |
| `public/games/valorant/js/main.js` | boucle `renderer.setAnimationLoop`, à instrumenter |

## Différence à gérer : pas de socket.io en valorant

Tag Arena et Mine Coop appellent `createDebugHud(socket)` avec un vrai socket
connecté (le ping mesure l'aller-retour serveur). Le jeu valorant est
entièrement local, sans réseau applicatif. `createDebugHud` tolère déjà
l'absence de socket (`if (!socket || !socket.connected) { ping = null; ... }`
dans `debug-hud.js`) : appelle-le avec `createDebugHud(null)`. Le ping
affichera `—` en permanence, c'est attendu, ne cherche pas à simuler un ping.

## Correction demandée

Dans `public/games/valorant/js/main.js` :

- `import { createDebugHud } from '/shared/debug-hud.js';`
- Crée le hud une fois, avant la boucle de rendu : `const debugHud =
  createDebugHud(null);`
- Affiche-le pendant la partie. Ce jeu n'a pas d'écran menu/lobby séparé du
  jeu comme Tag Arena/Mine Coop (le rendu 3D démarre dès que la map est
  chargée) — `debugHud.show()` peut donc être appelé une fois juste avant
  `renderer.setAnimationLoop(...)`, pas besoin de logique show/hide par écran.
- Mesure le temps de calcul réel de chaque frame et rapporte-le via
  `markFrame()`, sur le modèle exact de Tag Arena/Mine Coop : chronomètre en
  tout début du callback de la boucle (`performance.now()`), et appelle
  `debugHud.markFrame(performance.now() - work0)` juste avant
  `renderer.render(scene, camera)` (ou juste après, au choix — l'important
  est que l'intervalle mesuré couvre tout le travail de la frame : bots,
  physique, effets, HUD — pas seulement le rendu Three).

## Contraintes

- N'introduis aucune dépendance socket.io côté valorant pour faire
  fonctionner ce HUD — `createDebugHud(null)` suffit, c'est prévu pour ça.
- Ne modifie pas `debug-hud.js` : s'il ne convient pas tel quel pour un détail
  quelconque, dis-le au lieu de le divergent silencieusement — les deux
  autres jeux en dépendent.

## Vérification

1. `npm test` passe en entier.
2. `npm run dev` → `/games/valorant/` : le HUD apparaît en haut à gauche avec
   `FPS écran`, `FPS moteur`, et `PING —`.
