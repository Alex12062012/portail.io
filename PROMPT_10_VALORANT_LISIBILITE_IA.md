# Valorant-like — Prompt 10 : lisibilité du combat, IA des bots, repères visuels

Projet `game-portal`, mini-jeu `public/games/valorant/`. Ce prompt fait suite au
Prompt 9 (bugs critiques — à traiter d'abord, celui-ci en dépend pour les tests
de fin de round/match). Il couvre les améliorations de gameplay demandées :
certaines existent déjà partiellement dans le code, ce prompt précise quoi
garder, quoi étendre, quoi construire depuis zéro. `npm test` doit continuer à
passer.

---

## Fichiers à lire en priorité

| Fichier | Pourquoi |
|---|---|
| `public/games/valorant/js/ui/team_indicators.js` | identification alliés/ennemis **déjà implémentée** — à étendre, pas à refaire |
| `public/games/valorant/js/bots/bot_controller.js` | IA actuelle — mouvement, achat, `holdSite` |
| `public/games/valorant/js/bots/bot_difficulty.js` | traduction ELO -> paramètres de comportement |
| `public/games/valorant/js/main.js` | `shootOne()`, `api.onHit`, boucle bots (`if (rm.live)`) |
| `public/games/valorant/js/effects.js` | `hurt()` — point d'entrée unique des dégâts, à instrumenter pour l'indicateur de dégâts |
| `public/games/valorant/js/ui/hud.js` | HUD à étendre pour le texte ATTAQUE/DÉFENSE et l'indicateur de dégâts |
| `public/games/valorant/js/maps/map_loader.js`, `js/maps/map_*.js` | données des sites A/B pour les repères au sol |
| `public/games/valorant/js/spike.js` | pose/désamorçage — logique déjà complète, seul l'habillage visuel change |

---

## 0. Ce qui existe déjà — ne pas reconstruire

Avant de coder, sache que ces trois points du cahier des charges sont **déjà
faits, au moins partiellement** :

- **Identification alliés/ennemis** (`ui/team_indicators.js`) : anneau au sol
  cyan (allié) / rouge (ennemi), étiquette nom + vie au-dessus de la tête,
  points sur la minimap. Le problème n'est donc pas une absence du système,
  mais sa discrétion (anneau au sol seul, facile à perdre en plein combat).
  → Section 3 ci-dessous : à **améliorer**, pas à créer.
- **Pose / désamorçage du spike** (`main.js` + `spike.js` + `ui/hud.js`) :
  le texte « F POUR POSER » / « F POUR DÉSAMORCER », la progression
  (`spike.plant` / `PLANT_TIME`, `spike.defuse` / `DEFUSE_TIME`), l'interruption
  en quittant la zone ou en relâchant la touche (`spike.js#tickPlant/tickDefuse`)
  sont déjà en place. La seule chose qui manque vraiment est la forme visuelle
  du HUD (`#action .p div` est une barre linéaire, pas un cercle de
  progression). → Section 6 : petite retouche CSS/HTML, pas une nouvelle
  fonctionnalité.
- **Info attaque/défense** : déjà affichée en permanence dans `#topbar .round`
  (`ROUND X · ATTAQUE` / `DÉFENSE`). Ce qui manque, c'est le **grand texte
  centré et temporaire** en début de round. → Section 7 : ajout, pas refonte.

---

## 1. IA des bots : rôles différenciés (priorité la plus utile de ce prompt)

### Constat sur le code actuel

`BotController` (dans `bot_controller.js`) applique la même logique à tous les
bots d'une équipe : les attaquants suivent un plan de site unique partagé
(`botPlan` dans `main.js`, tiré une fois par round côté attaque), les
défenseurs se répartissent A/B seulement via `newRound(i)` (pair/impair). Il
n'y a pas de rôle nommé, pas de comportement individualisé au-delà de ce
split A/B. Lis le fichier en entier avant de modifier — certaines briques
(navigation par `nav`, `smartBuy`, soin sous 55 pv) sont déjà là et doivent
être réutilisées, pas dupliquées.

### Correction demandée

Ajoute un système de rôle assigné à chaque `BotController` au début du match
(`newRound` ou constructeur) :

**Attaque** (rôles à répartir entre les bots attaquants, un plan à 3 bots max) :
- `entry` : pousse en premier vers le site retenu par `botPlan`, priorité au
  contact rapide.
- `support` : suit l'entry avec un délai/décalage de distance (ne doit pas se
  superposer à sa trajectoire), couvre ses angles.
- `lurker` : ignore `botPlan`, part vers l'autre site ou une zone isolée de la
  map, cherche des cibles séparées du groupe.

**Défense** :
- `anchor` : reste sur un site (comportement proche de l'existant `holdSite`).
- `roamer` : patrouille entre les deux sites / zones médianes, ne se fixe pas.
- `rotator` : part sur un site par défaut mais rotate vers l'autre si une info
  crédible existe (spike posé ailleurs, ou — plus simple à implémenter —
  détection qu'aucun ennemi ne s'est montré de son côté après un délai).

### Contraintes

- Avec `TEAM_SIZE = 3` (`round_manager.js`), assigne les rôles avec une
  répartition simple et déterministe (ex. par index de bot dans son équipe :
  index 0 = entry/anchor, 1 = support/roamer, 2 = lurker/rotator) plutôt qu'un
  tirage aléatoire qui rendrait le comportement imprévisible à tester.
- Les bots doivent **rester coordonnés sur l'objectif** (le round doit être
  gagnable/perdable normalement, le spike doit pouvoir être posé et
  désamorcé) — ce n'est pas une IA totalement indépendante, juste une
  diversification des trajectoires et du timing.
- Réutilise `botCtx`/`ctx2` déjà construits dans `main.js` (`canSee`,
  `dropSmoke`, `healOver`, etc.) plutôt que d'ajouter de nouveaux callbacks
  si l'existant suffit.
- `bot_difficulty.js` (ELO -> précision, réactivité, `smartBuy`) ne doit pas
  être dupliqué par le système de rôle : le rôle change le *quoi faire*, l'ELO
  change le *à quel point c'est bien exécuté*. Garde cette séparation.

### Vérification

Ajoute un test dans `tests/smoke-valorant.mjs` (ou `js/selftest.js` si la
logique de rôle est pure/sans Three) qui vérifie qu'après `resetRound`, les 3
bots d'une même équipe n'ont pas tous le même rôle, et que ce rôle est stable
sur un round (ne change pas à chaque frame).

---

## 2. Bullet tracers

### Constat

`shootOne()` dans `main.js` fait un raycast pur (`ray.intersectObjects`), sans
aucune trace visuelle. Aucune ligne, aucun effet de tir n'est actuellement
dessiné dans `effects.js` pour les balles (contrairement aux capacités qui ont
toutes un mesh).

### Correction demandée

- Dans `api.trace()` (ou juste après, dans `shootOne`/l'appelant), quand un
  tir part, ajoute un effet visuel bref reliant l'origine du tir (canon de
  l'arme, pas forcément la caméra si `weapon_view.js` expose une position de
  bouche) au point d'impact (`hit.point` si touché, sinon le point à portée
  max du rayon).
- Style : une fine ligne (`THREE.Line` avec `BufferGeometry`, ou un cylindre
  très fin étiré) qui `fade` sur ~0.05–0.08 s — réutilise le mécanisme
  `effects.fade(mesh, seconds)` déjà présent dans `effects.js`.
- Couleur discrète (blanc/jaune pâle légèrement transparent), pas un laser
  saturé — le cahier des charges insiste sur « ne pas rendre les tirs trop
  visibles ».
- Applique-le aussi bien aux tirs du joueur qu'aux tirs des bots (vérifie
  comment les bots tirent actuellement — `bot_controller.js` — pour brancher
  le tracer au même endroit que les dégâts, pas seulement côté joueur).
- Attention perf : ne garde pas une géométrie par tir indéfiniment — la liste
  doit rester courte (fade rapide + suppression, comme les autres effets de
  `effects.js`).

### Vérification

`tests/smoke-valorant.mjs` : après un tir (la séquence existante clique déjà
la souris pour les capacités ; ajoute un tir arme à feu explicite), vérifie
qu'un objet tracer apparaît dans la scène puis disparaît (compte les enfants
de `scene` avant/après, ou expose un compteur dédié sur `window.effects`).

---

## 3. Renforcer l'identification alliés/ennemis (pas la recréer)

### Correction demandée

En plus de l'anneau au sol existant (`team_indicators.js`), ajoute un
**contour/outline lumineux sur le modèle** (`character.js` expose déjà
`model.userData.head` / `.body`) :

- Allié : liseré vert discret.
- Ennemi : liseré rouge, **uniquement quand visible** (ne pas trahir la
  position à travers les murs — contrairement à l'anneau allié qui, lui, est
  volontairement visible à travers les murs comme dans Valorant ; garde cette
  distinction, ne l'aligne pas sur l'ennemi).
- Techniquement : un second mesh légèrement plus grand en `BackSide` derrière
  le modèle (technique d'outline classique en Three.js), ou un
  `MeshBasicMaterial` en `wireframe`/emissive si plus simple à intégrer sans
  toucher au pipeline de rendu existant (le projet n'a pas de post-processing
  actuellement — ne pas en introduire pour ce seul besoin).
- Doit suivre les mêmes règles de mise à jour que le reste de
  `team_indicators.js#update()` : visible seulement si `alive`, recalculé
  chaque frame avec la position du modèle.

### Contraintes

- Ne remplace pas l'anneau existant, ajoute l'outline en complément.
- Reste cohérent avec les couleurs déjà définies (`ALLY`/`ENEMY` dans
  `team_indicators.js`) — ne réintroduis pas une nouvelle palette.

---

## 4. Indicateur de dégâts directionnel (façon Fortnite)

### Correction demandée

Dans `effects.js#hurt()`, à chaque fois que `actor === playerActor` et que
`by` est défini (pas les dégâts du spike/`null`), calcule la direction de la
source de dégâts par rapport à l'orientation de la caméra du joueur, et
déclenche un indicateur HUD (nouvel élément DOM, ex. un arc autour du viseur
dans `hud.js` ou un nouveau petit module `ui/damage_indicator.js`) :

- Apparaît quasi instantanément (pas d'animation d'entrée notable).
- Disparaît en fondu après ~1–1.5 s.
- Plusieurs coups rapprochés doivent pouvoir afficher plusieurs indicateurs
  (ou au minimum rafraîchir la direction sans creuser un bug d'accumulation
  DOM infinie — nettoie les éléments expirés).
- **Ne pas** afficher d'indicateur pour les pas ou les tirs qui ratent — action
  strictement liée à `hurt()` recevant des dégâts réels sur le joueur.

### Indicateur directionnel du spike

- Quand `spike.planted` est vrai et que le joueur est défenseur (ou attaquant
  ayant perdu sa ligne de vue sur le site), affiche un repère discret (flèche
  ou point sur un anneau autour du HUD) pointant vers `spike.pos`. Peut
  réutiliser des données déjà calculées pour `indicators.spikeDot` côté
  minimap (`team_indicators.js`) plutôt que recalculer une direction depuis
  zéro.
- Rappel explicite du cahier des charges : **aucun indicateur pour les pas,
  les tirs ennemis (hors dégâts reçus) ou tout autre son** — uniquement
  dégâts reçus et position du spike posé.

### Vérification

Ajoute dans `tests/smoke-valorant.mjs` une vérification qu'après avoir
provoqué des dégâts sur `playerActor` (via `effects.hurt` ou en exposant un
hook de test), un élément d'indicateur de dégâts apparaît dans le DOM puis
disparaît après son délai.

---

## 5. Repères au sol vers les sites A/B

### Correction demandée

Dans `map_loader.js` (ou un nouveau module dédié appelé depuis `main.js` après
`buildMap`), ajoute un marquage discret au sol guidant vers les sites, à partir
des données déjà présentes (`sites`, `nav` par map). Par exemple : une ligne de
petits marqueurs semi-transparents au sol le long du chemin le plus direct
depuis chaque spawn d'attaque vers chaque site (réutilise les routes de `nav`
si elles couvrent déjà ce trajet, ne recrée pas un système de pathfinding
séparé).

### Contraintes

- Discret : opacité faible, pas de flèches énormes façon jeu casual — le
  cahier des charges est explicite sur ce point (« ne pas transformer le jeu
  en guidage automatique »).
- Un marquage figé (posé une fois au chargement de la map) suffit ; pas besoin
  de recalcul dynamique par round.

---

## 6. Habillage circulaire de la progression pose/désamorçage

Seule retouche visuelle (la logique de `spike.js` ne bouge pas) :

- Dans `ui/hud.js` et `css/hud.css`, remplace ou complète la barre linéaire
  `#action .p div` par un anneau de progression (`conic-gradient` CSS suffit,
  pas besoin de SVG/canvas dédié) rempli de 0 à 100 % selon `s.action.pct`.
- Garde le texte (« F POUR POSER » / « F POUR DÉSAMORCER ») visible à côté ou
  au centre de l'anneau.

---

## 7. Bannière ATTAQUE / DÉFENSE en début de round

### Correction demandée

Dans `ui/hud.js`, au moment où un nouveau round démarre côté joueur (détecte
le changement de `rm.round`, ou branche-toi sur l'appel à `resetRound` côté
`main.js` si plus simple), affiche un grand texte centré et temporaire :

- 🔴 ATTAQUE si `playerActor.team === rm.attackers`, 🟢 DÉFENSE sinon (utilise
  les couleurs déjà présentes dans la palette du HUD, pas besoin d'introduire
  du rouge/vert saturé si ça jure avec le reste de l'UI existante — l'intention
  du texte prime sur la couleur exacte).
- Grande taille, disparition en fondu après ~1.5–2 s (ne bloque pas l'input).
- Ne doit pas se redéclencher à chaque frame — un seul affichage par round
  (garde un flag `bannerShownFor = rm.round`, sur le modèle de `buyShownFor`
  déjà présent dans `main.js`).

---

## Vérification finale

1. `npm test` passe en entier.
2. `npm run dev` → `/games/valorant/` : vérifier à l'œil les tracers, l'outline
   allié/ennemi, l'indicateur de dégâts, la bannière de round, l'anneau de
   progression du spike, et observer au moins un round complet pour confirmer
   que les 3 bots d'une équipe ne se comportent plus de façon identique.
3. Repasser sur le Prompt 9 : les nouveaux tests ajoutés ici ne doivent pas
   dépendre d'un comportement que le Prompt 9 a corrigé entre-temps (ordre
   d'exécution : Prompt 9 puis Prompt 10).
