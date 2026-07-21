Dans `game-portal`, deux choses à corriger sur Tag Arena / le portail (modifs non
commitées : lobby d'attente de 7s + musique), plus un renommage global.

## 1. La musique ne s'arrête jamais

Dans `public/games/tag-arena/main.js`, `audio.startMusic()` est appelé sur
`game:start`, mais `audio.stopMusic()` (défini dans `audio.js`) n'est jamais appelé. La
musique continue donc de boucler après la fin de la manche et après un retour au menu.

Ajoute `audio.stopMusic()` :
- dans le handler `socket.on('tag:end', ...)` (fin de manche),
- dans `quitGame()` (et donc `btnQuitGame`/`btnQuitPlaying`),
- dans `btnMenu.onclick`,
- dans `btnNoticeMenu.onclick`,
- dans le handler `socket.on('disconnect', ...)` quand on revient au menu.

Et vérifie que `audio.startMusic()` (déjà appelé sur `game:start`) ne joue pas en double si
une nouvelle manche démarre sans que la musique précédente ait été stoppée (replay).

## 2. Plus de décompte au début de la manche (pendant le lobby de 7s)

Avant le WIP, `render.js` appelait toujours `drawCountdown(view, now)`, donc un chiffre de
temps restant était visible dès le lancement. Le WIP a remplacé ça par :

```js
if (!view.noHud) {
  if (lobby) drawLobby(now); // attente : carte tirée + X/4 (pas de chrono)
  else drawCountdown(view, now);
}
```

Pendant les 7s d'attente (`lobby` non null), `drawCountdown` n'est plus jamais appelé : le
bandeau affiche "🗺️ Carte — X/4" sans aucun temps restant, donc le joueur ne sait pas
combien de temps avant le début de la manche.

Corrige `drawLobby` (et son appelant dans `main.js`/`render.js`) pour qu'il affiche EN PLUS
le temps restant avant le début (`goAt - now`), par exemple : "🗺️ Forêt de Wello — 3/4 —
Début dans 4s".

Détails utiles :
- Côté client, `game.goAt = performance.now() + startDelay * 1000` est déjà calculé dans
  `main.js` (réception de `game:start`).
- `updateLobby()` dans `main.js` ne recalcule le texte qu'à la réception de
  `game:start`/`tag:state` (pas chaque frame) — il faudra soit recalculer le texte chaque
  frame dans `frame()` pendant `game.waiting`, soit passer `goAt` à
  `renderer.setLobby`/`drawLobby` et calculer le compte à rebours directement dans
  `render.js` à chaque `draw()`.
- Le décompte doit s'arrêter/disparaître proprement quand `game.waiting` devient `false`
  (transition déjà gérée dans `frame()` via `renderer.setLobby(null)`).

## 3. Renommage "JOLT.io" → "lexo.io" (minuscules strictes)

Renomme le portail "JOLT.io" en "lexo.io" partout. Le nom est **entièrement en
minuscules** : "lexo.io" / "lexo" — ne mets JAMAIS "Lexo" ni "LEXO" (y compris dans le
logo : le `<span>` actuellement `JOLT<span class="dotio">.io</span>` doit devenir
`lexo<span class="dotio">.io</span>`, pas `LEXO`/`Lexo`).

Remplacements :
- "JOLT.io" / "JOLT" → "lexo.io" / "lexo" partout, en minuscules strictes (titres, logo,
  footer, commentaires, README, description package.json, message console au démarrage).
- Clés `localStorage` : `jolt.name` → `lexo.name`, `jolt.tag.muted` → `lexo.tag.muted` (et
  toute autre clé préfixée `jolt.*` trouvée) — déjà en minuscules, juste changer le
  préfixe.

Fichiers concernés (cherche "jolt"/"JOLT" en insensible à la casse pour être exhaustif,
hors `node_modules/`) :
- `package.json` (description)
- `README.md` (titre)
- `server/server.js` (commentaire d'en-tête + log de démarrage "⚡ JOLT.io lancé !")
- `public/index.html` (title, logo, texte de la carte "Bientôt disponible"/Mine Coop,
  footer, modal pseudo)
- `public/portal.css` (commentaire d'en-tête)
- `public/portal.js` (`NAME_KEY = 'jolt.name'`, commentaire)
- `public/games/tag-arena/index.html` (title, logo)
- `public/games/tag-arena/main.js` (lecture de `localStorage.getItem('jolt.name')`)
- `public/games/tag-arena/audio.js` (`MUTE_KEY = 'jolt.tag.muted'`)

Garde la même structure visuelle du logo (icône + nom + ".io" en style différent), juste
le texte "JOLT" → "lexo" (minuscules) — sauf si tu juges qu'une autre icône que ⚡ convient
mieux au nom "lexo", dans ce cas propose-le mais n'en fais pas une refonte visuelle
complète.

## Vérification

Lance `npm test` (et idéalement `node tests/browser.mjs` si possible) pour vérifier que
rien n'est cassé après ces trois changements.
