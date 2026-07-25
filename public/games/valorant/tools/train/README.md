# Entraînement des bots par rôle (self-play CPU, CMA-ES)

Optimise **6 rôles** (`entry`, `support`, `lurker` en attaque · `anchor`, `roamer`,
`rotator` en défense) sur **4 tranches d'ELO** (1000-1500 → 2500-3000), en 100 % JS,
headless, sans GPU ni Python. Un worker Node par rôle.

```bash
node public/games/valorant/tools/train/train.js              # jusqu'à convergence
node public/games/valorant/tools/train/train.js --hours 10   # arrêt garanti
node public/games/valorant/tools/train/train.js --roles entry,lurker
node public/games/valorant/tools/train/train.test.js         # tests
```

Sorties : `../../models/best_{role}_{tranche}.json` (le livrable), `checkpoint_*.json`
(un par tranche franchie), `index.json` (manifeste), `../../logs/training_{role}_*.jsonl`
(une ligne par génération).

## Ce que ça optimise

Un individu = un vecteur de 7 gènes, ceux que le contrôleur **lit réellement**
(`bot_profile.js`) : `reaction` (reaction_delay), `aimError` (aim_precision inversée),
`abilityChance` (ability_usage_rate), `aggression`, `roam` (positioning_weight),
`fireInterval`, `headshotChance`. Les bornes de `RANGES` sont le garde-fou anti-aimbot
(réaction jamais sous 0,18 s, visée jamais parfaite).

> Pas de `spike_priority` : rien ne le lit dans `bot_controller.js`, ce serait un gène
> mort — donc du bruit ajouté à la fitness. À rajouter le jour où le contrôleur en tient
> compte.

CMA-ES (`cmaes.js`, écrit à la main, décomposition de Jacobi incluse) : population 20,
10 matchs par individu, ~2,3 s par génération et par rôle (mesuré, 12 cœurs).

Pas de recherche : `SIGMA0 = 0.15`, borné à `SIGMA_MAX = 0.4`. L'espace est le cube unité
`[0,1]^7` — au-delà de 0,4 on échantillonne quasiment tout le domaine à chaque tirage et
CMA-ES dégénère en recherche aléatoire (observé : sigma plafonnait à 1,0 en 10 gens).

## Barème (`REWARD_CONFIG` / `ROLE_REWARD` en tête de `reward-shaping.js`)

| Base | | Par rôle | |
|---|---|---|---|
| kill | +100 | entry : 1er kill du site < 10 s | +40 |
| round gagné | +150 | support : kill < 2,2 s après un entry allié | +30 |
| spike posé | +60 | lurker : kill dans le dos (> 120°) | +50 |
| spike désamorcé | +80 | anchor : encore sur son site à la fin | +40 |
| mort | -60 | anchor : quitte son site sans contact | -30 |
| round perdu | -80 | roamer : rotation suivie d'un contact < 5 s | +20 |
| sans pose, après 30 s | -1/s | rotator : arrivée < 14 s après le 1er contact | +35 |

Le déplacement ne rapporte plus rien (`movement: 0`) : la récompense dense de
`points.js` produisait des bots qui tournent en rond pour marquer.

Les rôles sont attribués **par index dans l'équipe** et le camp alterne à chaque round :
l'index 0 est `entry` en attaque et `anchor` en défense. Le barème de base compte dans
tous les rounds, les bonus de rôle seulement dans les rounds où le bot porte ce rôle.

## Estimation d'ELO — ce que le chiffre vaut

Tous les 10 générations : 20 matchs contre une référence d'ELO connu, puis
`ELO = ELO_réf + 400·log10(wr/(1-wr))` (winrate borné à ±une demi-partie).

La référence démarre au bot scripté **le plus faible** (`REF_ELO = 800`, le plancher où
`skillOf` sature à 0) et **monte par paliers** : dès que le winrate de validation dépasse
`PROMOTE_WINRATE = 0.75`, le champion devient l'adversaire de référence avec l'ELO qu'on
vient de lui estimer, et CMA-ES repart de lui (curriculum learning) avec un pas neuf.

Pourquoi pas une référence fixe : `botParams` **sature à 1600**: au-delà, un bot scripté
n'est pas plus fort. Contre une référence figée le winrate colle à 100 % dès la 10ᵉ
génération, `estimateElo` rend le clamp au lieu d'une mesure, et le niveau ne monte
jamais. Partir de 800 place aussi la première estimation saturée (1436) *dans* la tranche
1000-1500 au lieu de la sauter — sans quoi le débutant héritait d'un modèle 1500-2000.
L'échelle reste **relative** (comme tout Elo) : c'est un ancrage, pas une mesure absolue.

Early stopping : `PATIENCE = 20` générations sans amélioration → on resserre sigma de
20 % (exploration locale), et on s'arrête si ça stagne déjà dans la tranche la plus haute.

## Utilisation en jeu

`bot_controller.js` expose `registerModels(list)` (registre pur) et
`getModelForBot(role, elo)` (tranche la plus proche). Le chargement reste chez
l'appelant : `server.js` lit `models/best_*.json` avec `fs`, `main.js` récupère
`models/index.json` par `fetch` (un navigateur ne peut pas lister un dossier).

Priorité : **modèle de rôle** > profil de style (`training/`, MAP-Elites) > ELO scripté.
`models/` vide → comportement historique, aucune régression.

Bascule à chaud : `syncModel()` est appelée à chaque changement de rôle (`newRound`,
`promote`) et à chaque montée d'ELO (`boost`, équipe qui perd). Le bot n'est jamais
recréé. Entre deux tranches, `boost()` continue de faire monter la compétence.

## Limites mesurées (20 matchs × 3 places, bots par défaut)

- **Backstab quasi inexistant** : 4 kills sur 853 dépassent 120°. `combat()` fait pivoter
  chaque bot vers l'ennemi visible le plus proche et `canSee` est symétrique — une
  victime fait donc presque toujours face à son tueur. Le bonus `lurker` est correct
  mais très rare ; il ne deviendra vivant que si l'IA gagne des angles morts.
- **Trades rares** : les rounds 3v3 se terminent souvent au premier kill, donc peu
  d'enchaînements entry → support dans les 2,2 s.
- **Entry** : le 1er kill sur site tombe à 12,3 s en médiane (16 % des rounds sous 10 s) —
  le bonus se déclenche, mais c'est une récompense éparse. `ROLE_REWARD.entry.withinSeconds`
  est la constante à monter si on la veut plus dense.
