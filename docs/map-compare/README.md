# Comparaison cartes Tag Arena ↔ références Tag 2

Processus reproductible pour vérifier que les 5 cartes copiées de Tag 2
(`forest`, `ice`, `volcano`, `desert`, `space`) correspondent à l'agencement
du **décor jouable** des captures de référence.

## Générer les captures de jeu

```bash
# prérequis (une fois)
npm install -D playwright
npx playwright install chromium

# capture les 5 cartes (ou des cartes précises)
node scripts/map-compare.mjs
node scripts/map-compare.mjs ice forest
```

Le script lance un serveur local jetable, ouvre chaque carte via le hook DEV
`?debugMap=<id>` (cf. `public/games/tag-arena/main.js`, actif **uniquement en
localhost**, jamais en production), qui rend la carte en **vue d'ensemble
dézoomée, sans réseau, sans joueurs et sans UI**, puis enregistre le canvas
dans `docs/map-compare/<id>-game.png`.

## Captures de référence

Les captures de référence Tag 2 sont en place dans
`docs/map-compare/<id>-reference.png` (`forest`, `ice`, `volcano`, `desert`,
`space`), avec le bon mapping fichier↔thème.

## Comparer

Pour chaque paire `<id>-game.png` / `<id>-reference.png`, ne comparer QUE les
éléments statiques du décor jouable, en proportions et agencement relatif
(le cadrage des références est un zoom partiel suivant un joueur) :

- plateformes : ordre, espacement horizontal, hauteurs relatives, largeurs ;
- rampes/pentes (rendues ici en escaliers de plateformes) ;
- téléporteurs/portails : position + appariement (toujours exactement 2) ;
- bounce pads ;
- piliers (tours de plateformes empilées).

Ignorer : overlay de score, bouton EXIT, joueurs/bots, particules d'explosion,
décor purement thématique (arbres, bannières, drapeaux…) qui est dessiné
procéduralement par thème dans `render.js` et n'est pas un objet plaçable.

## État actuel

Layouts ajustés pour suivre l'agencement des références, et vérifiés
visuellement (`<id>-game.png` vs `<id>-reference.png`). Chaque carte a ses **2
téléporteurs visibles** et reprend les éléments-clés, y compris les **rampes**
diagonales (nouveau type d'objet `ramp`, cf. `shared/tag-map.js`) :

| Carte   | Agencement reproduit |
|---------|----------------------|
| forest  | plateforme élevée gauche → **rampe diagonale** descendant au sol → plateforme centrale basse → plateforme-drapeau droite ; 2 portails au sol (la réf. ne montre pas de portail mais le moteur en exige une paire) |
| ice     | basse gauche → **deux planches inclinées (rampes en V)** → plateforme centrale (sapin) + portail → pilier droit surmonté d'un portail → plateforme haute droite |
| volcano | **colline (rampe) montante** + plateforme-drapeau + portail au sol → pont central de plateformes → portail-anneau → escalier droit |
| desert  | gros rocher élevé gauche → portail au sol → longue plateforme centrale → portail-anneau → **bascule (rampe statique)** + palmier-rocher droite |
| space   | escaliers montants gauche ET droit, plateforme-portail centrale, 2e portail en haut de l'escalier droit |

Pour ré-itérer : ajuster `shared/tag-map.js`, relancer
`node scripts/map-compare.mjs`, recomparer chaque paire.
