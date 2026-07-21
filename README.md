# ⚡ portail.io — portail de mini-jeux multijoueurs

Portail de mini-jeux jouables entre amis, hébergé sur un PC et accessible aux
autres via un tunnel **ngrok**. Stack : **Express + Socket.io + Canvas 2D**,
HTML/CSS/JS vanilla (aucun framework front).

Premier jeu inclus : **Tag Arena** — le jeu du chat en platformer 2D online
(2 à 4 joueurs, bots inclus en partie publique), inspiré de TAG 2 (WeLoPlay).

## Lancement

```bash
npm install
npm start            # serveur sur http://localhost:3000 + tunnel ngrok public
npm run server-only  # sans ngrok (LAN uniquement)
npm run dev          # sans ngrok + redémarrage auto à chaque modif
```

Le tunnel ngrok lit le token dans la variable d'environnement `NGROK_AUTHTOKEN`
(gratuit sur https://dashboard.ngrok.com). Sans token, le serveur démarre quand
même en local et affiche un avertissement.

## Tag Arena — règles

### Deux modes, choisis automatiquement au lancement de la manche

- **3-4 joueurs → mode élimination** (mode standard) : toutes les **15 s**, le
  joueur qui est « it » (💣 au-dessus de la tête) **explose** et devient
  spectateur (écran « VOUS AVEZ EXPLOSÉ » en vue d'ensemble dézoomée, bouton
  EXIT). Un nouveau « it » est tiré au sort parmi les survivants. Le dernier
  survivant gagne ; les autres sont classés par ordre d'élimination inversé
  (1ᵉʳ explosé = dernier).
- **Exactement 2 joueurs → mode classique** : timer de **90 s**, le joueur
  « it » quand le temps est écoulé perd.

Mécanique commune : le contact transfère le rôle « it » (immunité d'1 s pour
l'ex-chat), bounce pads et téléporteurs actifs, serveur autoritaire sur le
« it », les timers, les explosions et le classement.

### 5 cartes, caméra qui suit le joueur

Chaque manche tire au sort une carte parmi **9** (sans répéter celle de la
manche précédente du salon). Les cartes (2400-3200 × 900-1200 px) sont plus
grandes que la zone visible : la **caméra suit le joueur local** (lerp +
clamp aux bords). Les écrans spectateur/fin affichent une **vue d'ensemble
dézoomée** de la carte entière.

| id      | Nom              | Thème visuel                                   |
|---------|------------------|------------------------------------------------|
| space   | Station Kepler   | espace : étoiles, planète à anneau, antennes   |
| forest  | Forêt de Wello   | forêt : sapins, herbe, racines, champignons    |
| ice     | Banquise Polaire | glace : montagnes, stalactites, bonhomme de neige |
| desert  | Dunes Rouges     | désert : soleil, dunes, cactus                 |
| volcano | Cœur du Volcan   | volcan : lave, braises, pics de basalte        |

Les 5 cartes reprennent l'agencement de cartes du jeu « Tag 2 » (cf.
docs/map-compare/).

**Assets : 100 % procédural Canvas** (dégradés, formes, parallaxe) — aucun
asset externe n'est embarqué, donc aucune licence tierce. (Le téléchargement
des packs CC0 Kenney.nl a été tenté mais le site est derrière une protection
anti-bot ; le rendu procédural prévu en repli a été utilisé pour les 5 thèmes.)

Les layouts des 5 cartes sont vérifiés par `tests/map-validator.mjs` :
plateformes toutes atteignables (sauts ≈163 px max, bounce pads,
téléporteurs), pads posés, sorties de téléporteurs posées, 4 spawns posés.

### HUD de debug (réutilisable)

`public/shared/debug-hud.js` affiche en haut à gauche :
- **FPS écran** : fréquence réelle de rafraîchissement (requestAnimationFrame) ;
- **FPS moteur** : `1000 / temps moyen de calcul+dessin d'une frame`, non
  plafonné par l'écran (le jeu appelle `hud.markFrame(workMs)`) ;
- **PING** : aller-retour socket.io mesuré chaque seconde via un ack.

## Structure

```
game-portal/
├── server/
│   ├── server.js          # Express + Socket.io + ngrok + registre GAMES
│   ├── rooms.js           # salons génériques (code 4 lettres)
│   └── games/
│       └── tag-arena.js   # tags, timers, explosions, classement, bots, carte/manche
├── shared/                # importé PAR LE SERVEUR ET LE CLIENT (servi sur /shared)
│   ├── tag-map.js         # PHYS, TAG, VIEW + les 5 cartes (MAPS)
│   └── tag-physics.js     # pas de simulation joueur (opts.map = carte jouée)
├── public/
│   ├── index.html         # portail : pseudo + grille de cartes de jeu
│   ├── portal.js / portal.css
│   ├── shared/
│   │   └── debug-hud.js   # HUD FPS écran + FPS moteur + ping, réutilisable
│   └── games/
│       └── tag-arena/     # client : écrans, caméra, 5 thèmes (render.js), réseau
├── docs/reference-tag2/   # screenshots de référence (TAG 2)
└── tests/                 # maps, unitaires, smoke (node tests/…), navigateur
```

## Événements Socket.io

Génériques (salons) : `room:create`, `room:join`, `room:leave`, `room:start`
(ack), `quickplay` (ack), `room:update`, `game:start` (porte `mapId` + `mode`),
`hud:ping` (ack).

Tag Arena : `tag:move` (client→, ~25 Hz), `tag:state` (serveur→, 30 Hz, avec
`mode`, compte à rebours `t`, flag `dead`), `tag:tagged`, `tag:fx`,
`tag:boom` (élimination : `{ playerId, name, x, y, place, remaining }`),
`tag:end` (classique : perdant/gagnants ; élimination : `winnerId` +
`ranking`).

## Ajouter un futur jeu au portail

1. **Serveur** : créer `server/games/<mon-jeu>.js` exportant une factory
   `create(io, room, { onEnd })` (voir `tag-arena.js` comme modèle).
2. **Registre** : l'ajouter dans `GAMES` de `server/server.js` et router ses
   événements (`monjeu:*`) vers `room.game`.
3. **Client** : créer `public/games/<mon-jeu>/`. Réutiliser
   `/shared/debug-hud.js` et le flux salons existant.
4. **Portail** : remplacer la carte « Bientôt disponible » de
   `public/index.html` par une carte active.

## Tests

```bash
npm test                 # cartes + unitaires + smoke (~50 s, vraie explosion à 15 s)
node tests/maps.mjs      # validation de jouabilité des 5 cartes
node tests/unit-tag.mjs  # élimination (période 1 s), classique 1v1, choix de carte
node tests/smoke.mjs     # serveur réel + clients socket.io simulés
node tests/browser.mjs   # Chrome réel : thèmes, HUD, explosion, 1v1 (npm i --no-save puppeteer-core)
```
