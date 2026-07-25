// Scoreboard (Tab maintenu) : les 6 joueurs, agent, K/D/A, crédits (équipe du
// joueur uniquement), statut vivant/mort. Reconstruit 4 fois par seconde quand
// il est visible — jamais quand il est caché.
export class Scoreboard {
  // deps : { actors, playerActor, input, rm }
  constructor(root, deps) {
    this.d = deps;
    root.insertAdjacentHTML('beforeend', '<div id="board"></div>');
    this.el = document.getElementById('board');
    this.last = -1;
  }

  update(time) {
    const on = this.d.input.down('Tab');
    this.el.classList.toggle('on', on);
    if (!on || time - this.last < 0.25) return;
    this.last = time;

    const { actors, playerActor, rm } = this.d;
    const my = playerActor.team;
    const row = (a) => `
      <tr class="t${a.team === my ? 0 : 1}${a === playerActor ? ' me' : ''}${a.alive ? '' : ' dead'}">
        <td class="nm b${a.team}">${a.name}</td><td>${a.agentName ?? a.name}</td>
        <td>${a.matchKills ?? 0}</td><td>${a.matchDeaths ?? 0}</td><td>${a.assists ?? 0}</td>
        <td>${a.team === my ? `${a.wallet.credits} cr` : '—'}</td>
        <td>${a.alive ? 'vivant' : 'mort'}</td>
      </tr>`;
    const side = (t) => actors.filter((a) => a.team === t).map(row).join('');
    this.el.innerHTML = `
      <table><caption>ROUND ${rm.round} — ${rm.score[my]} · ${rm.score[1 - my]}</caption>
        <tr><th>JOUEUR</th><th>AGENT</th><th>K</th><th>M</th><th>A</th><th>CRÉDITS</th><th></th></tr>
        ${side(my)}<tr class="gap"><td colspan="7"></td></tr>${side(1 - my)}
      </table>`;
  }
}
