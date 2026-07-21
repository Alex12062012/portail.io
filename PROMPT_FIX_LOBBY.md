Dans game-portal, j'ai deux bugs introduits par les modifs non commitées (lobby d'attente de 7s + musique) :

## Bug 1 — la musique ne s'arrête jamais

Dans `public/games/tag-arena/main.js`, `audio.startMusic()` est appelé sur
`game:start`, mais `audio.stopMusic()` (défini dans `audio.js`) n'est jamais
appelé. La musique continue donc de boucler après la fin de la manche et
après un retour au menu.

Ajoute `audio.stopMusic()` :
- dans le handler `socket.on('tag:end', ...)` (fin de manche),
- dans `quitGame()` (et donc `btnQuitGame`/`btnQuitPlaying`),
- dans `btnMenu.onclick`,
- dans `btnNoticeMenu.onclick`,
- dans le handler `socket.on('disconnect', ...)` quand on revient au menu.

Et rappelle `audio.startMusic()` si une nouvelle manche démarre (déjà fait sur
`game:start`, vérifie juste qu'il n'y a pas de double lecture si la musique
n'a pas été stoppée avant un replay).

## Bug 2 — plus de décompte au début de la manche (pendant le lobby de 7s)

Avant le WIP, `render.js` appelait toujours `drawCountdown(view, now)`, donc un
chiffre de temps restant était visible dès le lancement. Le WIP a remplacé ça par :

```js
if (!view.noHud) {
  if (lobby) drawLobby(now); // attente : carte tirée + X/4 (pas de chrono)
  else drawCountdown(view, now);
}
```

Pendant les 7s d'attente (`lobby` non null), `drawCountdown` n'est plus jamais
appelé : le bandeau affiche "🗺️ Carte — X/4" sans aucun temps restant, donc le
joueur ne sait pas combien de temps avant le début de la manche.

Corrige `drawLobby` (et son appelant dans `main.js`/`render.js`) pour qu'il
affiche EN PLUS le temps restant avant le début (`goAt - now`), par exemple :
"🗺️ Forêt de Wello — 3/4 — Début dans 4s".

Détails utiles :
- Côté client, `game.goAt = performance.now() + startDelay * 1000` est déjà
  calculé dans `main.js` (réception de `game:start`).
- `updateLobby()` dans `main.js` ne recalcule le texte qu'à la réception de
  `game:start`/`tag:state` (pas chaque frame) — il faudra soit recalculer le
  texte chaque frame dans `frame()` pendant `game.waiting`, soit passer `goAt`
  à `renderer.setLobby`/`drawLobby` et calculer le compte à rebours directement
  dans `render.js` à chaque `draw()`.
- Le décompte doit s'arrêter/disparaître proprement quand `game.waiting`
  devient `false` (transition déjà gérée dans `frame()` via
  `renderer.setLobby(null)`).

Vérifie avec `npm test` (et idéalement `node tests/browser.mjs` si possible)
que rien n'est cassé après ces deux correctifs.
