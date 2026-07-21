# Renommage : lexo.io → portail.io + logo portail animé

Projet `game-portal`. Ce prompt renomme le portail de **lexo.io** à **portail.io** partout, et remplace le logo éclair ⚡ par une version animée du portail de Tag Arena.  
`npm test` doit passer sans modification après ce prompt.

---

## Fichiers à lire en priorité

| Fichier | Pourquoi |
|---|---|
| `public/index.html` | Logo, titre, footer, modal |
| `public/portal.css` | Styles `.logo`, `.bolt` |
| `public/portal.js` | Clé localStorage `lexo.name` |
| `public/favicon.svg` | Favicon actuel (éclair jaune) |
| `public/games/tag-arena/render.js` | Lignes ~655–690 : code de rendu du portail (référence visuelle) |
| `public/games/tag-arena/main.js` | Chercher `lexo.name` |
| `public/games/mine-coop/main.js` | Chercher `lexo.name`, `lexo.mine.*` |
| `server/server.js` | Références textuelles à lexo |
| `README.md` | Références à lexo |
| `package.json` | Champ `description` |

---

## 1. Renommage global lexo → portail

Remplace **toutes** les occurrences visibles/textuelles (commentaires inclus) selon ces règles :

| Ancien | Nouveau | Scope |
|---|---|---|
| `lexo.io` | `portail.io` | HTML visible, titres, footer, commentaires |
| `lexo` (nom du portail seul) | `portail` | Commentaires, descriptions, README |
| `lexo.name` (clé localStorage) | `portail.name` | `portal.js`, `tag-arena/main.js`, `mine-coop/main.js` |
| `lexo.tag.muted` | `portail.tag.muted` | `tag-arena/main.js` (ou `audio.js`) |
| `lexo.mine.keybinds` | `portail.mine.keybinds` | `mine-coop/main.js` |
| `lexo.name` dans `PROMPT_*.md` | laisser tel quel | (fichiers prompt = documentation, pas exécutés) |

**Migration localStorage** : dans `public/portal.js`, au chargement de la page, ajouter une migration silencieuse :
```js
// Migration lexo.name → portail.name (une seule fois)
if (!localStorage.getItem('portail.name') && localStorage.getItem('lexo.name')) {
  localStorage.setItem('portail.name', localStorage.getItem('lexo.name'));
  localStorage.removeItem('lexo.name');
}
```
Même migration dans `tag-arena/main.js` pour `lexo.tag.muted` → `portail.tag.muted`.

---

## 2. Logo portail animé — SVG inline dans `index.html`

### 2a. Remplacer le logo texte dans le header

Actuellement :
```html
<div class="logo"><span class="bolt">⚡</span>lexo<span class="dotio">.io</span></div>
```

Remplacer par :
```html
<div class="logo">
  <span class="portal-icon">
    <svg class="portal-svg" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <!-- Anneau extérieur orange -->
      <circle cx="20" cy="20" r="18" fill="#0e1b40"
              stroke="#ff7a3c" stroke-width="2.5"/>
      <!-- Anneau intérieur doré -->
      <circle cx="20" cy="20" r="16" fill="none"
              stroke="#ffd166" stroke-width="1"/>
      <!-- Groupe spirale (tourne via CSS) -->
      <g class="portal-spin">
        <!-- Bras 1 — cyan -->
        <path d="M20,20 Q25,13 30,10 Q33,18 28,22 Q23,25 18,20"
              fill="none" stroke="#5fd0ff" stroke-width="1.8" stroke-linecap="round"/>
        <!-- Bras 2 — bleu clair -->
        <path d="M20,20 Q15,27 10,30 Q7,22 12,18 Q17,15 22,20"
              fill="none" stroke="#c7f2ff" stroke-width="1.8" stroke-linecap="round"/>
      </g>
      <!-- Cœur lumineux -->
      <circle cx="20" cy="20" r="2" fill="#eafdff"/>
    </svg>
  </span>portail<span class="dotio">.io</span>
</div>
```

Même changement dans la modal `#nameModal` :
```html
<div class="logo big">
  <span class="portal-icon">
    <!-- même SVG, class="portal-svg big" -->
    <svg class="portal-svg big" viewBox="0 0 40 40" ...>...</svg>
  </span>portail<span class="dotio">.io</span>
</div>
```

### 2b. Styles CSS à ajouter/modifier dans `portal.css`

Remplacer `.bolt { color: var(--accent); }` par :

```css
/* Logo portail */
.portal-icon {
  display: inline-flex;
  align-items: center;
  vertical-align: middle;
  margin-right: 6px;
}

.portal-svg {
  width: 28px;
  height: 28px;
  filter: drop-shadow(0 0 6px rgba(255, 122, 60, 0.7));
}

.portal-svg.big {
  width: 36px;
  height: 36px;
}

/* Animation de rotation de la spirale */
@keyframes portal-rotate {
  from { transform-origin: 20px 20px; transform: rotate(0deg); }
  to   { transform-origin: 20px 20px; transform: rotate(360deg); }
}

.portal-spin {
  transform-origin: 20px 20px;
  animation: portal-rotate 1.3s linear infinite;
}
```

### 2c. Footer et titre HTML

```html
<!-- <title> -->
<title>portail.io — mini-jeux entre amis</title>

<!-- footer -->
<footer>portail.io — hébergé chez ton pote, propulsé par ngrok ⚡</footer>
```

---

## 3. Favicon — `public/favicon.svg`

Remplacer le contenu de `favicon.svg` par une version statique du portail (les favicons n'animent pas) :

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0e1020"/>
  <!-- Anneau orange -->
  <circle cx="32" cy="32" r="28" fill="#0e1b40"
          stroke="#ff7a3c" stroke-width="4"/>
  <!-- Anneau doré -->
  <circle cx="32" cy="32" r="25" fill="none"
          stroke="#ffd166" stroke-width="1.5"/>
  <!-- Bras spirale 1 (cyan) -->
  <path d="M32,32 Q40,20 48,15 Q53,28 44,35 Q37,40 29,32"
        fill="none" stroke="#5fd0ff" stroke-width="3" stroke-linecap="round"/>
  <!-- Bras spirale 2 (bleu clair) -->
  <path d="M32,32 Q24,44 16,49 Q11,36 20,29 Q27,24 35,32"
        fill="none" stroke="#c7f2ff" stroke-width="3" stroke-linecap="round"/>
  <!-- Cœur -->
  <circle cx="32" cy="32" r="4" fill="#eafdff"/>
</svg>
```

---

## 4. `package.json`

```json
"description": "portail.io — portail de mini-jeux multijoueurs (Express + Socket.io + Canvas 2D). npm start lance le serveur + un tunnel ngrok."
```

---

## 5. `README.md`

Remplacer toutes les occurrences de `lexo.io` par `portail.io` et `lexo` (quand désigne le portail) par `portail` dans le README. Ne pas modifier les noms de fichiers ni les chemins techniques.

---

## 6. Vérification

1. `npm test` passe sans erreur.
2. Page d'accueil : le logo affiche un portail animé (spirale cyan qui tourne) + "portail.io".
3. Favicon dans l'onglet du navigateur : portail orange/cyan (pas l'éclair).
4. Modal de pseudo : même logo portail animé.
5. Les clés localStorage `lexo.name` / `lexo.tag.muted` n'existent plus après premier chargement — remplacées par `portail.name` / `portail.tag.muted`.
6. `grep -r "lexo" public/ server/ shared/` (hors fichiers `PROMPT_*.md`) → zéro résultat.
7. Tag Arena et Mine Coop fonctionnent toujours (pseudo lu depuis `portail.name`).
