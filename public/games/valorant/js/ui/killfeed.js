// Killfeed : « Tueur [ARME] Victime » en haut à droite, chaque ligne s'efface
// après quelques secondes. Alimenté par kill() dans main.js.
export class Killfeed {
  // myTeam : colore tueur/victime selon leur camp par rapport au joueur.
  constructor(root, myTeam) {
    root.insertAdjacentHTML('beforeend', '<div id="feed"></div>');
    this.el = document.getElementById('feed');
    this.myTeam = myTeam;
  }

  add(killer, victim, via = '') {
    const cls = (a) => (a && a.team === this.myTeam ? 'a' : 'e');
    const row = document.createElement('div');
    row.className = 'row panel';
    row.innerHTML =
      `<span class="${killer ? cls(killer) : 'e'}">${killer?.name ?? 'SPIKE'}</span>` +
      `<span class="w">[${(via || '?').toUpperCase()}]</span>` +
      `<span class="${cls(victim)}">${victim.name}</span>`;
    this.el.appendChild(row);
    setTimeout(() => row.remove(), 6000);
  }
}
