Renomme le portail "JOLT.io" en "lexo.io" partout dans `game-portal/`. Le nom est
**entièrement en minuscules** : "lexo.io" / "lexo" — ne mets JAMAIS "Lexo" ni "LEXO"
(y compris dans le logo, les titres, le `<span>` actuellement en majuscules type
`JOLT<span class="dotio">.io</span>` → doit devenir `lexo<span class="dotio">.io</span>`,
pas `LEXO`/`Lexo`). Remplacements :

- "JOLT.io" / "JOLT" → "lexo.io" / "lexo" partout, en minuscules strictes (titres, logo,
  footer, commentaires, README, description package.json, message console au démarrage).
- Clés `localStorage` : `jolt.name` → `lexo.name`, `jolt.tag.muted` → `lexo.tag.muted`
  (et toute autre clé préfixée `jolt.*` trouvée) — déjà en minuscules, juste changer le
  préfixe.

Fichiers concernés (cherche "jolt"/"JOLT" en insensible à la casse pour être exhaustif,
hors `node_modules/`) :
- `package.json` (description)
- `README.md` (titre)
- `server/server.js` (commentaire d'en-tête + log de démarrage "⚡ JOLT.io lancé !")
- `public/index.html` (title, logo `<span class="bolt">⚡</span>JOLT<span class="dotio">.io</span>`,
  texte de la carte "Bientôt disponible"/Mine Coop, footer, modal pseudo)
- `public/portal.css` (commentaire d'en-tête)
- `public/portal.js` (`NAME_KEY = 'jolt.name'`, commentaire)
- `public/games/tag-arena/index.html` (title, logo)
- `public/games/tag-arena/main.js` (lecture de `localStorage.getItem('jolt.name')`)
- `public/games/tag-arena/audio.js` (`MUTE_KEY = 'jolt.tag.muted'`)

Garde la même structure visuelle du logo (icône + nom + ".io" en style différent), juste
le texte "JOLT" → "lexo" (minuscules) — sauf si tu juges qu'une autre icône que ⚡ convient
mieux au nom "lexo", dans ce cas propose-le mais n'en fais pas une refonte visuelle
complète.

Si tu ajoutes Mine Coop (`PROMPT_MINE_COOP.md`) dans le même run ou après, utilise bien
"lexo.io"/"lexo.*" (minuscules strictes) dès la création de ses fichiers (pas "JOLT").

Vérifie avec `npm test` que rien n'est cassé après le renommage.
