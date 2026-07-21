Contexte : tu as précédemment créé "game-portal" (portail "lexo.io" — nom **entièrement en
minuscules**, ne jamais écrire "Lexo"/"LEXO" — Poki-like) avec page d'accueil + pseudo
(`public/index.html`, `public/portal.js`), système de salons génériques à code 4 lettres
(`server/rooms.js` + registre `GAMES` dans `server/server.js`), et le jeu "Tag Arena"
(`server/games/tag-arena.js` côté serveur, `public/games/tag-arena/` côté client,
constantes/physique partagées dans `shared/tag-map.js` et `shared/tag-physics.js` servies
en statique sous `/shared/`). Je veux ajouter un deuxième jeu, "Mine Coop", dans ce même
projet, SANS casser Tag Arena ni le portail.

Le pseudo est stocké dans `localStorage('lexo.name')` (clé déjà renommée depuis
`jolt.name`) — utilise bien `lexo.*` pour toute nouvelle clé `localStorage` que Mine Coop
ajouterait (ex. mute audio éventuel), jamais `jolt.*`.

## 0. Conventions existantes à suivre (regarde ces fichiers avant de commencer)

- **Registre de jeux** : `server/server.js` a un objet `GAMES` —
  `{ 'tag-arena': { minPlayers, maxPlayers, create: (io, room, opts) => createTagGame(io, room, opts) } }`.
  Ajoute une entrée `'mine-coop'` qui pointe vers une factory `createMineGame(io, room, opts)`
  exportée par un nouveau `server/games/mine-coop.js`.
- **Cycle de vie d'un salon** (`server/rooms.js`, `RoomManager`) : `room = { code, gameType,
  isPublic, status: 'lobby'|'playing'|'ended', hostId, players: Map, game, createdAt,
  endedAt }`. Ne modifie pas `rooms.js` sauf si vraiment nécessaire — Mine Coop doit s'en
  servir tel quel (création/jonction par code 4 lettres, `room.players`, `broadcastRoom`).
- **Démarrage de partie** (`startGame()` dans `server/server.js`) : appelle
  `def.create(io, room, opts)`, puis `room.game.addHuman(p.id, p.name)` pour chaque joueur,
  puis `room.game.start()`. Le `opts` actuel contient `onEnd`/`startDelaySeconds`
  (spécifiques à Tag Arena, pensés pour son lobby d'attente de 7 s + bots). Mine Coop n'a
  pas besoin de ce délai ni de `onEnd` (pas de "fin de manche") : adapte `startGame()` pour
  ne passer ces options qu'au jeu qui les utilise (ou fais en sorte que
  `createMineGame` les ignore proprement) — et que `room.game.start()` pour Mine Coop
  démarre la partie immédiatement (pas de lobby d'attente).
- **Boucle de simulation 30 Hz** (`setInterval` dans `server.js`) appelle
  `room.game.tick(dt)` pour tout salon `status === 'playing'`. `createMineGame` doit donc
  exposer `tick(dt)` (zombies, cycle jour/nuit, sauvegarde périodique).
- **Événements socket par jeu** : Tag Arena utilise `tag:move`, `tag:fx`, etc., routés dans
  `server.js` via `room.game.handleXxx(socket.id, data)` si `room?.game && room.status ===
  'playing'`. Fais pareil pour Mine Coop avec un préfixe `mine:` (ex. `mine:move`,
  `mine:break`, `mine:place`, `mine:chunkRequest`, `mine:craft`, `mine:teleport`,
  `mine:hit`...). Ajoute les handlers correspondants dans `createMineGame` et leur routage
  dans `server.js`, sans toucher aux handlers `tag:*`.
- **Modules partagés serveur/client** : suis le modèle de `shared/tag-map.js` /
  `shared/tag-physics.js` (servis en statique sous `/shared/` par `server.js`). Crée par
  ex. `shared/mine-world.js` (constantes du monde + génération + helpers de
  coordonnées/offset) et `shared/mine-physics.js` (pas de simulation joueur, collisions
  avec la grille de blocs) — importables tels quels par le serveur (`server/games/mine-coop.js`)
  ET par le client (`public/games/mine-coop/main.js` via `/shared/mine-world.js`).
- **Client** : crée `public/games/mine-coop/` avec la même organisation que
  `public/games/tag-arena/` : `index.html` (écrans `screenMenu` → `screenLobby` →
  `screenGame`, mini-bar "← Portail" comme Tag Arena), `main.js`, `render.js`, `mine.css`.
  Réutilise `/shared/debug-hud.js` tel quel (`createDebugHud(socket)`, `hud.show()` /
  `hud.hide()` en haut à gauche).
- **Portail** : dans `public/index.html`, remplace la carte `.card-soon` ("Mystère…") par
  une carte `.card-active` "Mine Coop" (`<a class="card card-active" id="cardMine"
  href="/games/mine-coop/">`), sur le modèle de la carte `#cardTag`. Dans `public/portal.js`,
  ajoute le même garde-fou pseudo que pour `#cardTag` sur `#cardMine`.

## 1. Intégration au portail

- Carte "Mine Coop" active sur la page d'accueil (cf. ci-dessus).
- Type de jeu `'mine-coop'` dans `GAMES`, réutilisant `room:create` / `room:join` /
  `room:leave` / `room:start` existants. Écran de salon (`screenLobby` de Mine Coop, ou
  réutilisation du même flow que Tag Arena) : "Créer un monde" et "Rejoindre" (saisie du
  code). Jusqu'à 4 joueurs par salon (`minPlayers: 1, maxPlayers: 4` dans
  `GAMES['mine-coop']` — un monde solo doit pouvoir démarrer).
- **Code de monde personnalisable** (pour retrouver/recharger sa sauvegarde, cf. section
  3) : sur l'écran "Créer un monde", ajoute un champ optionnel "Code du monde" (4 à 8
  caractères alphanumériques, normalisés en majuscules). Si le joueur le remplit :
  - si `saves/<CODE>.json` existe déjà, le salon est créé avec ce code et le monde
    sauvegardé est rechargé tel quel (cf. section 3) ;
  - sinon, un nouveau salon est créé avec ce code (vérifie via `RoomManager` qu'il n'est
    pas déjà pris par un salon actif — sinon erreur "code déjà utilisé", le joueur en
    choisit un autre).
  Si le champ est laissé vide : comportement actuel inchangé — `RoomManager.genCode()`
  génère un code aléatoire à 4 lettres (comme Tag Arena) et un nouveau monde est généré
  avec une seed aléatoire. N'adapte `room:create`/`RoomManager` que pour
  `gameType === 'mine-coop'` — ne change rien pour Tag Arena.
- Les pseudos (gérés par le portail via `localStorage('lexo.name')`, transmis comme pour
  Tag Arena) s'affichent au-dessus de chaque personnage en jeu.

## 2. Le jeu "Mine Coop" — 2D façon Terraria simplifié, coop

- Vue de côté, monde en grille de blocs (tiles) de 32×32 px. Taille du monde fixée à
  **4096 tuiles de large sur 256 de haut** (~1 million de cases) — "énorme" à l'échelle du
  joueur (des dizaines de minutes de marche d'un bout à l'autre) tout en restant gérable en
  mémoire/JSON (quelques Mo). Ne dépasse pas cet ordre de grandeur sans bonne raison.
- **Coordonnées affichées (HUD + téléportation)** : X centré sur le spawn, donc X va
  d'environ **-2048 à +2048** (spawn = X=0, bords du monde à X≈±2048). Y : 0 en haut,
  croissant vers le bas, jusqu'à 256. En interne, le tableau du monde utilise des indices
  0..4096 ; applique un offset constant (offset = 2048) uniquement à l'affichage et à la
  saisie des coordonnées X côté HUD/téléportation. Mets cette constante `WORLD_OFFSET_X` et
  les helpers de conversion dans `shared/mine-world.js` pour qu'ils soient partagés
  serveur/client.
- **Génération du monde** : génère le tableau 2D complet du monde **en une seule passe**, à
  la création du salon, à partir de la seed — PAS de génération par chunks séparés à
  raccorder ensuite (source de bugs de raccord, à éviter complètement). Une fois ce tableau
  unique généré, il est stocké tel quel en mémoire et sauvegardé sur disque. Contenu :
  - Heightmap de surface (bruit/valeurs pseudo-aléatoires lissées) déterminant le niveau du
    sol par colonne.
  - Couches sous la surface : herbe en surface, terre sur quelques blocs, puis pierre en
    profondeur, bedrock indestructible tout en bas.
  - Grottes : creusées dans la pierre via automate cellulaire ou bruit 2D appliqué sur
    l'ensemble du tableau (un seul tableau → pas de problème de raccord).
  - Filons de minerais (charbon, fer, et plus rares : or/diamant), plus rares en profondeur
    croissante pour les meilleurs.
  - Quelques arbres sur les zones d'herbe (tronc + feuillage, destructibles → bois).
- **Réseau / rendu** : le tableau complet ne doit JAMAIS être envoyé en entier au client.
  Découpe-le uniquement à des fins de **transmission réseau** en chunks de transmission
  (ex. 32×32 tuiles) : le serveur envoie au client les chunks autour de sa position, dès
  qu'il approche d'une zone non encore reçue (`mine:chunkRequest` → `mine:chunkData` par
  ex.). C'est une optimisation réseau sur des données déjà cohérentes, pas une nouvelle
  génération par chunk.
- **Caméra** : suit le joueur, n'affiche que la portion visible du monde autour de lui
  (même esprit que la caméra de `render.js` de Tag Arena : lerp + clamp aux bords).
- **HUD** :
  - Haut gauche : réutilise `/shared/debug-hud.js` (FPS + ping), identique à Tag Arena.
  - Haut droite : coordonnées X/Y actuelles du joueur (mises à jour en continu, dans le
    repère centré décrit ci-dessus), + panneau de téléportation juste à côté (champs X/Y +
    bouton "Téléporter", et raccourci clavier ex. touche `M` qui met le panneau en focus).
- Déplacement : gravité, marche gauche/droite, saut, collisions avec les blocs (module
  `shared/mine-physics.js`, sur le modèle de `shared/tag-physics.js`).
- Minage / construction :
  - Clic gauche maintenu sur un bloc adjacent/à portée = mine le bloc (vitesse selon la
    dureté du bloc et l'outil équipé) ; le bloc rejoint l'inventaire.
  - Clic droit = pose le bloc sélectionné dans la hotbar à l'emplacement ciblé (si valide).
- Inventaire : hotbar de 9 emplacements + inventaire étendu, empilement des ressources à
  la façon de Minecraft : limite de **64 par pile** pour la plupart des items (blocs,
  minerais, lingots, charbon, bois, planches, bâtons...). Exception : les outils
  (pioche/hache/épée, tous tiers bois/pierre/fer) ne sont PAS empilables (max 1 par
  emplacement, comme dans Minecraft). Si tu introduis d'autres items non couverts ici (ex.
  torches, seaux...), choisis une limite cohérente avec les conventions Minecraft (la
  plupart des objets = 64, outils/armures = 1, quelques objets spéciaux type
  projectiles/oeufs = 16) et documente brièvement ton choix en commentaire.
- Craft basique : table de craft → progression d'outils : bois → planches → pioche/hache/
  épée en bois → outils en pierre → fer (fondu via un four avec charbon comme combustible)
  → outils en fer. Les outils de meilleur tier minent plus vite et débloquent les minerais
  plus durs.
- Cycle jour/nuit : rotation complète ~10 minutes, assombrissement visuel progressif la
  nuit.
- Monstres : la nuit, zombies lents apparaissent (surface + zones sombres), marchent vers
  le joueur le plus proche, dégâts au contact. Barre de vie du joueur, attaque à l'épée
  pour les éliminer ; zombies restants disparaissent au lever du jour.
- Téléportation par coordonnées : panneau haut droite (ou touche `M`), saisie X/Y,
  "Téléporter" → déplacement instantané, coordonnées bornées aux limites du monde (dans le
  repère centré `WORLD_OFFSET_X`).

## 3. Sauvegarde persistante

- Le monde (grille modifiée par rapport à la génération initiale, ou grille complète si
  plus simple) + inventaires des joueurs sauvegardés côté serveur dans `saves/`, fichier
  nommé par le code du salon (ex. `saves/<CODE>.json`). Ajoute `saves/` au `.gitignore`
  existant (qui contient déjà `node_modules/`, `*.log`, `.env`, `tests/artifacts/`).
- Sauvegarde périodique (ex. toutes les 30 s, via `tick`) + à la déconnexion du dernier
  joueur du salon (`leaveCurrent`/`removePlayer` côté `server.js` — vérifie comment Tag
  Arena gère déjà `room.players.size === 0` dans `rooms.js`).
- Si un salon est recréé/rejoint avec le même code (auto-généré ou personnalisé, cf.
  section 1), recharge le monde sauvegardé tel quel — le code est donc ce que le joueur
  doit noter/réutiliser pour retrouver son monde plus tard.
- Limite : 5 mondes max sur disque (volontairement bas — pas un usage serveur). Une 6e
  sauvegarde supprime automatiquement la moins récemment utilisée (LRU, basé sur la date
  de dernière sauvegarde/accès), qu'elle ait un code auto-généré ou personnalisé.
  Documente ce comportement dans le README, et affiche un avertissement clair côté client
  si la création d'un monde va provoquer la suppression d'un ancien (ex. liste des codes
  sauvegardés visible avant de créer un nouveau monde, si simple à faire).

## Critères de succès (vérifie toi-même avant de conclure)

1. Tag Arena fonctionne toujours exactement comme avant (relance `npm test`) — vérifie
   après tes changements.
2. La page d'accueil affiche 2 cartes actives : Tag Arena et Mine Coop, avec le nom du
   portail toujours "lexo.io" (minuscules).
3. Créer un monde Mine Coop génère un code + un monde "énorme" cohérent (surface, grottes,
   minerais, arbres) sans trous/incohérences visibles aux raccords.
4. Avec 2 onglets dans le même salon : les deux joueurs se voient bouger, miner et poser
   des blocs en temps réel, voient leurs pseudos respectifs, et l'inventaire/le craft
   fonctionnent.
5. HUD haut gauche (FPS + ping, repris de Tag Arena) fonctionne ; panneau haut droit
   affiche les coordonnées X/Y en temps réel ; la téléportation par coordonnées fonctionne
   et reste dans les limites du monde.
6. Quitter le salon puis le rejoindre avec le même code restaure le monde tel qu'il était
   laissé (blocs minés/posés conservés).
7. La nuit tombe après le délai prévu, des zombies apparaissent et infligent des dégâts, le
   joueur peut les combattre ; ils disparaissent au matin.
8. Crée 6 mondes différents et vérifie que le plus ancien non utilisé est bien supprimé
   automatiquement (limite de 5).

## Contraintes

- Ne casse pas Tag Arena ni le portail existants — réutilise leur structure (`GAMES`,
  `RoomManager`, `/shared/`, `debug-hud.js`), n'en crée pas une parallèle.
- Monde fixe énorme + sauvegarde simple sur disque — pas de système de chunks infinis
  générés à la volée (trop complexe, source de bugs de raccord).
- Écris ton propre code, adapté à la structure de game-portal. Inspiration libre
  (architecture/idées uniquement, ne copie aucun code) : projets open-source comme
  "dunarr/multiplayer-socket-io-game" ou "Overv/WebCraft" pour la façon de structurer la
  synchro client/serveur d'un monde de blocs en multijoueur.
- Documente dans le README : taille du monde choisie et pourquoi, format de sauvegarde,
  comportement de la limite à 5 sauvegardes, et comment ajouter un futur 3e jeu au portail
  (section déjà présente dans le README — mets-la à jour si l'ajout de Mine Coop change la
  procédure).
