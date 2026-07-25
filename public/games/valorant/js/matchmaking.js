// Matchmaking : écran de recherche (15 s) + répartition joueurs réels / bots.
// assignTeams est pure et testée sous node ; searchMatch ne fait que l'écran.
import { TEAM_SIZE } from './round_manager.js';

// players : [{ id, elo }]. Jamais deux réels dans la même équipe tant qu'il reste
// une place en face ; cas impair à 3 réels : le meilleur ELO joue seul contre les
// deux autres réunis. Les places restantes sont des bots.
//
// `sizes` accepte un nombre (même effectif des deux côtés, le 3v3) ou une paire
// [équipe 0, équipe 1] pour les formats asymétriques comme le 1v3.
export function assignTeams(players, sizes = TEAM_SIZE) {
  const cap = Array.isArray(sizes) ? sizes : [sizes, sizes];
  const teams = [[], []];
  if (players.length === 3) {
    const [best, ...rest] = [...players].sort((a, b) => b.elo - a.elo);
    teams[0].push(best);
    teams[1].push(...rest);
  } else {
    players.forEach((p, i) => teams[i % 2].push(p));
  }
  return teams.map((humans, i) => ({ humans, bots: Math.max(0, cap[i] - humans.length) }));
}

// Miroir d'un lobby : le joueur change de camp, effectifs de bots compris. C'est
// ici qu'on bascule le joueur en équipe 1 plutôt que dans assignTeams, qui doit
// rester pure et déterministe. Le 1v3 reste cohérent : les tailles suivent.
export function mirrorLobby(lobby) {
  return { ...lobby, playerTeam: 1 - lobby.playerTeam, teams: [lobby.teams[1], lobby.teams[0]] };
}

const CSS = `
#search{position:fixed;inset:0;z-index:4;display:grid;place-content:center;gap:10px;text-align:center;
  background:#0d1117;font:13px/1.6 ui-monospace,Consolas,monospace;color:#cfe3ee}
#search h1{margin:0;font-size:18px;letter-spacing:.2em;color:#4ee1e8;font-weight:600}
#search .t{font-size:26px;color:#ffc44d}
#search p{margin:0;opacity:.6}`;

// Résout après le compte à rebours avec l'équipe du joueur et les places de bots.
export function searchMatch({ elo, recent, seconds = 15 }) {
  document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`);
  document.body.insertAdjacentHTML('beforeend', `
    <div id="search"><h1>RECHERCHE D'UNE PARTIE…</h1><div class="t"></div>
    <p>format ${TEAM_SIZE}v${TEAM_SIZE} — niveau global ${Math.round(elo)} · forme récente ${Math.round(recent)}</p>
    <p>les places libres seront comblées par des bots à ton niveau</p></div>`);
  const root = document.getElementById('search');
  const t = root.querySelector('.t');
  let left = seconds;
  t.textContent = `${Math.ceil(left)} s`;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      left -= 0.25;
      t.textContent = `${Math.max(0, Math.ceil(left))} s`;
      if (left > 0) return;
      clearInterval(timer);
      root.remove();
      const teams = assignTeams([{ id: 'you', elo }]);
      resolve({ playerTeam: teams.findIndex((tm) => tm.humans.some((h) => h.id === 'you')), teams });
    }, 250);
  });
}
