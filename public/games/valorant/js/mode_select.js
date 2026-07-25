// Écrans de choix du mode puis de la difficulté (prompt 14), sur le modèle
// visuel d'agent_select.js / selectMap().
//
// La difficulté manuelle n'existe QUE pour le 1v3 : le 3v3 garde son
// matchmaking par ELO global (skill_tracker.js), intouché.
//
// Modes : '3v3' = EN LIGNE (serveur autoritaire, vrais joueurs + bots) ;
// '1v3' = défi solo local ; '3v3-local' = 3v3 contre bots 100 % local, réservé
// aux tests (le moteur local sert aussi au 1v3).
//
// Mode test : `?mode=1v3&diff=hard` saute directement au choix voulu. Un `?test`
// sans `mode` vaut '3v3-local' — c'est ce qui laisse le smoke navigateur (qui
// joue une partie locale) inchangé, sans dépendre d'un serveur.
import { soloWins } from './skill_tracker.js';

// ELO injecté dans botParams() à la place de globalElo(). 1600 est le plafond
// de skillOf() dans bot_difficulty.js : monter plus haut ne changerait rien.
export const DIFFICULTIES = {
  easy: { name: 'Facile', elo: 850, tag: 'réagit lentement, vise le corps' },
  normal: { name: 'Moyen', elo: 1150, tag: 'joue proprement, sans excès' },
  hard: { name: 'Difficile', elo: 1450, tag: 'réactif, cherche la tête' },
  nightmare: { name: 'Cauchemar', elo: 1600, tag: 'réaction minimale, précision maximale' },
};

const params = new URLSearchParams(location.search);
const testing = params.has('test');

const CSS = `
#modepick{position:fixed;inset:0;z-index:4;display:grid;place-content:center;gap:22px;
      background:#0d1117;font:13px/1.5 ui-monospace,Consolas,monospace;color:#cfe3ee}
#modepick h1{margin:0;text-align:center;font-size:20px;letter-spacing:.22em;color:#4ee1e8;font-weight:600}
#modepick .row{display:flex;gap:14px}
#modepick button{width:200px;padding:16px 14px;text-align:left;cursor:pointer;color:inherit;font:inherit;
      background:#151b22;border:1px solid #263039;border-top:3px solid #4ee1e8;transition:.12s}
#modepick button:hover{background:#1c242d;transform:translateY(-3px)}
#modepick .n{font-size:15px;letter-spacing:.1em;color:#4ee1e8;margin-bottom:9px}
#modepick .t{opacity:.6}
#modepick .w{margin-top:9px;font-size:11px;color:#ffc44d}`;

let styled = false;

// items : [{ key, name, tag, note? }] -> promesse résolue avec la clé cliquée.
function chooser(title, items) {
  if (!styled) { document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`); styled = true; }
  const cards = items.map((i) => `
    <button data-key="${i.key}">
      <div class="n">${i.name.toUpperCase()}</div>
      <div class="t">${i.tag}</div>
      ${i.note ? `<div class="w">${i.note}</div>` : ''}
    </button>`).join('');

  document.body.insertAdjacentHTML('beforeend',
    `<div id="modepick"><h1>${title}</h1><div class="row">${cards}</div></div>`);

  const root = document.getElementById('modepick');
  return new Promise((resolve) => {
    root.addEventListener('click', (e) => {
      const key = e.target.closest('button')?.dataset.key;
      if (!key) return;
      root.remove();
      resolve(key);
    });
  });
}

export function selectMode() {
  const forced = params.get('mode') ?? (testing ? '3v3-local' : null);
  if (forced === '3v3' || forced === '3v3-local' || forced === '1v3') return Promise.resolve(forced);
  return chooser('CHOISIS TON MODE', [
    { key: '3v3', name: '3v3 en ligne', tag: 'vrais joueurs, places libres comblées par des bots' },
    { key: '1v3', name: '1v3 — défi solo', tag: 'seul contre 3, difficulté au choix' },
  ]);
}

export function selectDifficulty() {
  const forced = params.get('diff') ?? (testing ? 'normal' : null);
  if (forced && DIFFICULTIES[forced]) return Promise.resolve(forced);
  return chooser('CHOISIS TA DIFFICULTÉ', Object.entries(DIFFICULTIES).map(([key, d]) => {
    const wins = soloWins(key);
    return { key, name: d.name, tag: d.tag, note: wins ? `${wins} victoire${wins > 1 ? 's' : ''}` : '' };
  }));
}
