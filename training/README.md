# Entraînement des bots Valorant (self-play, MAP-Elites)

Améliore le gameplay en faisant **jouer les bots contre eux-mêmes**, la nuit, sur
ton **CPU**. Le résultat : une palette de **styles distincts** (agressif, passif,
mobile, ancré…) tous compétents, chargés automatiquement par le jeu → des bots
plus variés et plus humains à affronter.

## Lancer une nuit d'entraînement

```bash
node training/train.mjs --hours 8      # s'arrête tout seul après 8 h
node training/train.mjs                 # tourne jusqu'à Ctrl-C
```

Ça remplit une grille de styles (axe *agressivité* × axe *mobilité*) et, dans
chaque case, optimise la compétence du bot. Toutes les ~15 s, deux fichiers sont
écrits (sûrs même si tu coupes) :

- `training/archive.json` — l'archive complète (permet de **reprendre** plus tard,
  relance simplement la même commande). Non versionné.
- `public/games/valorant/js/bots/profiles.json` — les profils **chargés par le
  jeu**. C'est le livrable : dès qu'il est mis à jour, les bots en profitent.

Options : `--bins 8` (finesse de la grille), `--matches 3` (matchs par évaluation,
plus = moins de bruit mais plus lent), `--workers N` (par défaut : cœurs − 1),
`--out fichier.json` (autre archive).

## Pourquoi pas le GPU ?

Ta RTX 3060 ne servirait quasiment à rien ici : le « cerveau » d'un bot est
minuscule. Le facteur limitant, c'est **combien de matchs/seconde** on simule —
c'est du CPU. La boucle utilise donc tous tes cœurs (`worker_threads`) et tourne
des **centaines de matchs par seconde**, soit des millions d'évaluations en une
nuit. Aucune dépendance à installer, aucun Python, aucun CUDA.

## Comment ça marche

1. `env.mjs` joue un match **bot-vs-bot headless** en réutilisant *exactement* le
   simulateur du jeu (`server/games/valorant.js`) — donc les bots entraînés se
   comportent en partie comme à l'entraînement. La récompense vient de
   `points.js` (kills, pose du spike, rounds gagnés, déplacement).
2. `train.mjs` fait tourner une recherche **Quality-Diversity (MAP-Elites)** :
   au lieu de converger vers un seul bot « optimal » (robotique), elle garde le
   meilleur bot de **chaque style** → variété.
3. `export.mjs` écarte les styles les plus faibles et écrit `profiles.json`.
4. Le jeu (`bot_controller.js`, via `bot_profile.js`) charge ces profils et en
   donne un **jeu varié** aux bots, calé sur la difficulté choisie (le niveau
   d'une partie ne dégrade que la *compétence*, jamais le *style*).

Sans `profiles.json`, le jeu retombe sur le comportement historique piloté par
l'ELO — rien ne casse.

## Regénérer `profiles.json` depuis une archive existante

```bash
node training/export.mjs
```
