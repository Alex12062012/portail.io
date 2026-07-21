# Valorant-like — Prompt 14 : mode 1v3 (défi solo, difficulté au choix)

Projet `game-portal`, mini-jeu `public/games/valorant/`. Ajoute un second mode
de jeu : le joueur seul contre 3 bots, avec une difficulté choisie à la main
plutôt que déduite de l'ELO global. S'appuie directement sur `reassignRoles()`
et `promote()` du Prompt 13 (`bots/bot_controller.js`) : c'est ce qui permet
aux 3 bots adverses de se réorganiser quand l'un d'eux meurt, sans quoi le
mode perdrait tout son intérêt (2 bots livrés à eux-mêmes après la mort de
l'`entry`). `npm test` doit continuer à passer.

Décisions déjà tranchées (ne pas les rouvrir) :
- Le sélecteur de difficulté manuel n'existe **que** pour le 1v3. Le 3v3
  classique garde son matchmaking par ELO global (`skill_tracker.js`),
  inchangé.
- Les résultats du 1v3 **ne comptent pas** dans `globalElo()`/`recentElo()` —
  historique séparé.

---

## Fichiers à lire en priorité

| Fichier | Pourquoi |
|---|---|
| `public/games/valorant/js/main.js` | assemblage des acteurs, boucle, `resetRound` — c'est le fichier le plus touché |
| `public/games/valorant/js/matchmaking.js` | `assignTeams()` suppose deux équipes de même taille — à généraliser |
| `public/games/valorant/js/round_manager.js` | `TEAM_SIZE` — vérifie qu'aucune logique de `RoundManager` lui-même n'en dépend (normalement non : il ne lit que `players`/`aliveCount`) |
| `public/games/valorant/js/skill_tracker.js` | historique ELO — à ne PAS mélanger avec les stats 1v3 |
| `public/games/valorant/js/bots/bot_controller.js` | `reassignRoles`, `promote`, `boost()`/`LOSS_BOOST` — comportement à réutiliser tel quel |
| `public/games/valorant/js/agent_select.js` | modèle d'écran à suivre pour le nouveau sélecteur de mode/difficulté |
| `public/games/valorant/js/ui/scoreboard.js`, `ui/team_indicators.js` | vérifier qu'aucune des deux ne suppose une taille d'équipe fixe (normalement non — elles itèrent `actors` sans compter) |
| `tests/smoke-valorant.mjs` | modèle pour le nouveau fichier de test 1v3 |

---

## 1. Écran de sélection du mode

Avant l'écran de sélection d'agent (ou juste après, au choix le plus simple à
brancher — regarde l'ordre actuel `selectMap()` -> `selectAgent()` ->
`searchMatch()` dans `main.js`), insère un écran « 3V3 CLASSIQUE » vs
« 1V3 — DÉFI SOLO », sur le modèle visuel de `agent_select.js` (même CSS,
mêmes boutons). Crée `mode_select.js` (nouveau fichier, à côté de
`agent_select.js`) qui résout une promesse avec `'3v3'` ou `'1v3'`.

## 2. Écran de difficulté (uniquement si 1v3)

Si le mode choisi est `'1v3'`, affiche un second écran (même famille de
composant) avec 4 niveaux :

| Niveau | ELO équivalent injecté dans `botParams()` |
|---|---|
| Facile | 850 |
| Moyen | 1150 |
| Difficile | 1450 |
| Cauchemar | 1600 (le plafond de `skillOf()` — inutile d'aller au-delà, `bot_difficulty.js` clampe déjà à 1600) |

Ces valeurs alimentent directement `new BotController(actor, elo, nav)` à la
place de `baseElo` (qui reste réservé au 3v3, calculé via `globalElo()`).

## 3. Équipes asymétriques

### Constat

`matchmaking.js#assignTeams(players, size = TEAM_SIZE)` distribue les bots
avec une **seule** taille pour les deux équipes. Il faut pouvoir dire
« équipe du joueur : 1, équipe adverse : 3 ».

### Correction demandée

- Généralise `assignTeams` pour accepter une taille par équipe, par exemple
  `assignTeams(players, sizes = [TEAM_SIZE, TEAM_SIZE])`, en gardant la
  signature à un seul `size` fonctionnelle par défaut (rétrocompatible avec
  le 3v3 et son cas particulier « 3 joueurs réels », que tu ne dois pas
  toucher).
- Pour le 1v3 : le joueur est seul dans son équipe (0 bot allié), l'équipe
  adverse a 3 bots. Pas besoin de passer par `searchMatch()` (l'écran
  « RECHERCHE D'UNE PARTIE… » n'a pas de sens quand il n'y a personne à
  chercher) : construis directement le `lobby` équivalent
  (`{ playerTeam, teams }`) sans afficher cet écran, et enchaîne sur le
  chargement de la map.
- Dans `main.js`, la boucle de création des bots (`for (let team = 0; team <
  2; team++) { for (let i = 0; i < lobby.teams[team].bots; i++) { ... } }`)
  doit fonctionner sans modification si `lobby.teams` porte déjà les bons
  effectifs — vérifie-le plutôt que de dupliquer cette boucle.
- Les 3 `BotController` de l'équipe adverse reçoivent l'ELO de la difficulté
  choisie (section 2), pas `globalElo()`.

### `LOSS_BOOST` : garder actif, volontairement

Ne désactive pas la montée en ELO des bots perdants (`boost()`,
`onRoundEnd` dans `main.js`) en 1v3. C'est voulu : la difficulté choisie est
un **point de départ**, pas un plafond — si le joueur domine les bots
« Facile », ils doivent monter en niveau round après round comme en 3v3,
sinon le mode devient trivial pour un joueur au-dessus de cette difficulté
dès le round 2. Ne rouvre pas cette décision sans qu'on en parle.

## 4. Rôles côté adverse

Rien à coder ici en principe : `reassignRoles()`/`promote()` (Prompt 13) sont
déjà génériques sur la taille d'équipe (`team.filter((t) => t.actor.alive)`
ne suppose pas 3 acteurs). Vérifie simplement, une fois le 1v3 assemblé, que
les 3 bots adverses reçoivent bien `entry`/`support`/`lurker` (attaque) ou
`anchor`/`roamer`/`rotator` (défense) via le même chemin que le 3v3
(`resetRound()` dans `main.js`), et que tuer l'`entry` promeut bien le
`support` en test manuel.

## 5. Historique séparé

Dans `skill_tracker.js`, n'ajoute rien qui touche `record()`/`history()`/
`globalElo()`/`recentElo()` — ces fonctions restent réservées au 3v3. Ajoute
des fonctions dédiées au 1v3, sur le même modèle (stockage injectable pour
rester testable sous node), par exemple :

```js
const SOLO_KEY = 'valorant-like.solo-history';
export function recordSolo(match, s = store()) { ... } // { date, difficulty, won, kills, deaths }
export function soloHistory(s = store()) { ... }
```

Sur l'écran de difficulté (section 2), affiche pour info le nombre de
victoires déjà obtenues à chaque niveau (`soloHistory().filter(...)`) — pas
obligatoire si ça complique l'écran, mais utile et peu coûteux.

À la fin d'un match 1v3, appelle `recordSolo(...)` à l'endroit où `main.js`
appelle déjà `record(...)` pour le 3v3 (`rm.phase === 'match' &&
!matchRecorded`) — les deux branches doivent être mutuellement exclusives
selon le mode choisi en section 1.

## 6. Test

Crée `tests/smoke-valorant-1v3.mjs` (nouveau fichier, sur le modèle de
`tests/smoke-valorant.mjs` : lance le serveur, ouvre `/games/valorant/?test`
avec un moyen déterministe de sélectionner le mode 1v3 et une difficulté sans
dépendre du hasard — ajoute un paramètre d'URL, ex. `?test&mode=1v3&diff=hard`,
lu par `mode_select.js`/l'écran de difficulté pour sauter directement au choix
correspondant en mode test, comme `?test` le fait déjà pour raccourcir
`searchMatch`).

Vérifie au minimum :
- `window.actors.length === 4` (1 joueur + 3 bots), tous sur l'équipe adverse
  au joueur.
- Les 3 bots adverses ont des rôles distincts après `resetRound`.
- Tuer le bot `entry` (via `effects.hurt`, pas un accès direct à `alive`,
  comme corrigé au Prompt 13) promeut un autre bot à `entry`.
- Un round complet peut se terminer (victoire ou défaite), et
  `soloHistory()` contient une entrée de plus après coup, sans que
  `history()` (le 3v3) n'en gagne une.

Ajoute `node tests/smoke-valorant-1v3.mjs` à la chaîne `test` de
`package.json`, à la suite de `smoke-valorant.mjs`.

---

## Vérification finale

1. `npm test` passe en entier (toutes les suites, 1v3 compris).
2. `npm run dev` → `/games/valorant/` : choisir 1V3, une difficulté, jouer un
   round, vérifier que tuer le bot de tête fait effectivement bouger un autre
   bot vers l'avant plutôt que de laisser l'équipe passive.
3. Vérifier manuellement que le 3v3 classique n'a subi aucune régression
   (écran de recherche, matchmaking par ELO, historique global inchangés).
