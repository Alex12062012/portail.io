// Écran de sélection d'agent : 4 cartes à la couleur du modèle capsule+sphère.
// Résout la promesse avec la clé de l'agent choisi, puis se retire du DOM.
import { AGENTS, label } from './abilities.js';

const CSS = `
#pick{position:fixed;inset:0;z-index:4;display:grid;place-content:center;gap:22px;
      background:#0d1117;font:13px/1.5 ui-monospace,Consolas,monospace;color:#cfe3ee}
#pick h1{margin:0;text-align:center;font-size:20px;letter-spacing:.22em;color:#4ee1e8;font-weight:600}
#pick .row{display:flex;gap:14px}
#pick button{width:190px;padding:16px 14px;text-align:left;cursor:pointer;color:inherit;font:inherit;
      background:#151b22;border:1px solid #263039;border-top:3px solid var(--c);transition:.12s}
#pick button:hover{background:#1c242d;transform:translateY(-3px)}
#pick .dot{width:34px;height:34px;border-radius:50%;background:var(--c);margin-bottom:10px}
#pick .n{font-size:15px;letter-spacing:.1em;color:var(--c)}
#pick .r{opacity:.55;margin-bottom:9px}
#pick li{list-style:none;opacity:.75}
#pick ul{margin:0;padding:0}
#pick b{color:#4ee1e8;font-weight:600}`;

export function selectAgent() {
  document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`);

  const cards = Object.entries(AGENTS).map(([key, a]) => `
    <button data-key="${key}" style="--c:#${a.color.toString(16).padStart(6, '0')}">
      <div class="dot"></div>
      <div class="n">${a.name.toUpperCase()}</div>
      <div class="r">${a.role}</div>
      <ul>${a.abilities.map((b) => `<li><b>${label(b.key)}</b> ${b.name}</li>`).join('')}</ul>
    </button>`).join('');

  document.body.insertAdjacentHTML('beforeend',
    `<div id="pick"><h1>CHOISIS TON AGENT</h1><div class="row">${cards}</div></div>`);

  const root = document.getElementById('pick');
  return new Promise((resolve) => {
    root.addEventListener('click', (e) => {
      const key = e.target.closest('button')?.dataset.key;
      if (!key) return;
      root.remove();
      resolve(key);
    });
  });
}
