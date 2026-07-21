// Buy menu : overlay d'achat pendant la buy phase.
// Armes par catégorie, armures, charges de capacités. Grisé si trop cher.
//
// Le pointer lock doit être relâché pour rendre le curseur : `input.menu` prévient
// input.js de ne pas réafficher l'écran « clic pour jouer » pendant ce temps, et le
// bouton PRÊT reprend le lock — c'est un vrai geste utilisateur, donc le navigateur
// l'accepte.
import { WEAPONS } from './weapons.js';
import { SHIELDS } from './economy.js';
import { label } from './abilities.js';

const ORDER = ['pistol', 'smg', 'shotgun', 'rifle', 'sniper', 'heavy'];
const TITLE = { pistol: 'Pistolets', smg: 'SMG', shotgun: 'Shotguns', rifle: 'Rifles', sniper: 'Snipers', heavy: 'Lourdes' };

const CSS = `
#buy{position:fixed;inset:0;z-index:3;display:none;grid-template-rows:auto 1fr auto;gap:14px;
     padding:20px 26px;background:rgba(8,12,16,.93);color:#cfe3ee;
     font:12px/1.5 ui-monospace,Consolas,monospace;overflow:auto}
#buy.on{display:grid}
#buy header{display:flex;justify-content:space-between;align-items:baseline;
     border-bottom:1px solid #263039;padding-bottom:8px;letter-spacing:.18em}
#buy header b{color:#4ee1e8;font-size:16px}
#buy .cr{color:#ffc44d;font-size:15px}
#buy .cols{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start}
#buy section{min-width:150px}
#buy h3{margin:0 0 6px;font-size:11px;letter-spacing:.16em;opacity:.5;font-weight:400}
#buy button{display:block;width:100%;margin-bottom:4px;padding:6px 9px;text-align:left;
     color:inherit;font:inherit;background:#151b22;border:1px solid #263039;cursor:pointer}
#buy button:hover:not(:disabled){background:#1f2831;border-color:#4ee1e8}
#buy button:disabled{opacity:.3;cursor:default}
#buy button i{float:right;font-style:normal;color:#ffc44d}
#buy button.have{border-color:#3f9d6a}
#buy .ready{justify-self:center;width:220px;text-align:center;padding:10px;
     background:#12333a;border-color:#4ee1e8;color:#4ee1e8;letter-spacing:.2em}`;

export class BuyMenu {
  // deps : { input, canvas, wallet, arsenal, loadout, actor }
  constructor(deps) {
    this.d = deps;
    document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`);
    document.body.insertAdjacentHTML('beforeend', '<div id="buy"></div>');
    this.el = document.getElementById('buy');
    this.open = false;
    this.el.addEventListener('click', (e) => this.onClick(e));
  }

  show(seconds) {
    this.open = true;
    this.seconds = seconds;
    this.d.input.menu = true;
    this.el.classList.add('on');
    if (document.pointerLockElement) document.exitPointerLock();
    this.render();
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    this.d.input.menu = false;
    this.el.classList.remove('on');
  }

  // PRÊT : marque le joueur prêt et rend la souris au jeu. Le round ne démarre pas
  // pour autant — RoundManager attend que TOUT le monde soit prêt (ou le timer).
  close() {
    this.d.actor.ready = true;
    this.hide();
    Promise.resolve(this.d.canvas.requestPointerLock()).catch(() => {});
  }

  onClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    const { kind, key } = b.dataset;
    if (kind === 'ready') return this.close();
    if (kind === 'weapon') this.buyWeapon(key);
    if (kind === 'shield') this.buyShield(key);
    if (kind === 'ability') this.d.loadout.buyCharge(+key, this.d.wallet);
    this.render();
  }

  buyWeapon(key) {
    const w = WEAPONS[key];
    const { wallet, arsenal } = this.d;
    if (!wallet.spend(w.price)) return;
    // Un pistolet remplace le secondaire, tout le reste remplace la principale.
    const slot = w.class === 'pistol' ? 1 : 0;
    arsenal.slots[slot] = key;
    arsenal.reset(key);
    arsenal.index = -1;
    arsenal.equip(slot);
  }

  buyShield(key) {
    const s = SHIELDS[key];
    const a = this.d.actor;
    if ((a.shield ?? 0) >= s.hp || !this.d.wallet.spend(s.price)) return;
    a.shield = s.hp;
    a.shieldMax = s.hp;
  }

  render() {
    if (!this.open) return;
    const { wallet, arsenal, loadout, actor } = this.d;
    const money = wallet.credits;

    const btn = (kind, key, name, price, owned) =>
      `<button data-kind="${kind}" data-key="${key}" class="${owned ? 'have' : ''}"
        ${price > money && !owned ? 'disabled' : ''}>${name}<i>${price || '—'}</i></button>`;

    const guns = ORDER.map((cls) => {
      const items = Object.entries(WEAPONS)
        .filter(([k, w]) => w.class === cls && k !== 'bladestorm')
        .map(([k, w]) => btn('weapon', k, w.name, w.price, arsenal.slots.includes(k)))
        .join('');
      return `<section><h3>${TITLE[cls]}</h3>${items}</section>`;
    }).join('');

    const armour = Object.entries(SHIELDS)
      .map(([k, s]) => btn('shield', k, `${s.name} (+${s.hp})`, s.price, (actor.shield ?? 0) >= s.hp))
      .join('');

    const abilities = loadout.agent.abilities
      .map((a, i) => (a.cost
        ? btn('ability', i, `${label(a.key)} ${a.name} (${loadout.state[i].charges}/${a.charges})`,
              a.cost, loadout.state[i].charges >= a.charges)
        : ''))
      .join('');

    this.el.innerHTML =
      `<header><b>ACHAT</b><span class="t">${Math.ceil(this.seconds)}s</span><span class="cr">${money} cr</span></header>
       <div class="cols">${guns}
         <section><h3>Armure</h3>${armour}</section>
         <section><h3>Capacités</h3>${abilities || '<i style="opacity:.4">aucune payante</i>'}</section>
       </div>
       <button class="ready" data-kind="ready">PRÊT</button>`;
    this.clock = this.el.querySelector('.t');
  }

  // Le compte à rebours ne touche QUE son propre nœud. Reconstruire le menu chaque
  // seconde ferait disparaître le bouton sous le curseur au moment du clic.
  tick(seconds) {
    if (!this.open) return;
    this.seconds = seconds;
    const s = `${Math.max(0, Math.ceil(seconds))}s`;
    if (this.clock && this.clock.textContent !== s) this.clock.textContent = s;
  }
}
