// Environnement d'entraînement headless : joue un match bot-vs-bot SANS réseau,
// en réutilisant EXACTEMENT le simulateur du jeu (server/games/valorant.js). C'est
// crucial : les bots entraînés se comporteront en jeu comme à l'entraînement.
//
// runMatch(profileA, profileB) met le profil A sur l'équipe 0 et le profil B (ou
// des bots ELO par défaut si null) sur l'équipe 1, puis renvoie les métriques.
import { createValorantGame } from '../server/games/valorant.js';

const DT = 0.1;          // pas de simulation (= plafond du tick serveur), rapide
const MAX_TICKS = 6000;  // garde-fou (~600 s simulés) contre un round qui ne finit pas
const NULL_IO = { to: () => ({ emit: () => {} }) }; // aucune diffusion réseau

// profileA/profileB : objets gène (bot_profile.js) ou null (= bots ELO par défaut).
export function runMatch(profileA, profileB = null, { mapId } = {}) {
  const room = { code: 'TRAIN', status: 'lobby', isPublic: true };
  const game = createValorantGame(NULL_IO, room, {
    waitSeconds: 0, silent: true, mapId,
    assignProfile: (team) => (team === 0 ? profileA : profileB),
  });

  game.start();
  let ticks = 0;
  while (game.isRunning() && ticks++ < MAX_TICKS) game.tick(DT);

  const actors = game._actors;
  const rm = game._rm();
  const team = (t) => actors.filter((a) => a.team === t);
  const sum = (arr, f) => arr.reduce((s, a) => s + (f(a) || 0), 0);
  return {
    winner: rm?.winner ?? null,
    rounds: rm?.round ?? 0,
    finished: !game.isRunning(),
    teams: [0, 1].map((t) => ({
      points: sum(team(t), (a) => a.points),
      kills: sum(team(t), (a) => a.matchKills),
    })),
  };
}

// Fitness d'un profil : moyenne sur `matches` parties contre la baseline (team 1).
// Score = points/round de l'équipe du profil + bonus de victoire — borné, stable.
export function evaluate(profile, { matches = 3, baseline = null } = {}) {
  let points = 0, wins = 0, rounds = 0, kills = 0;
  for (let m = 0; m < matches; m++) {
    const r = runMatch(profile, baseline);
    const t = r.teams[0];
    const rd = Math.max(1, r.rounds);
    points += t.points / rd;      // points par round (comparable entre matchs)
    kills += t.kills / rd;
    rounds += r.rounds;
    if (r.winner === 0) wins++;
  }
  return {
    fitness: points / matches + (wins / matches) * 200, // bonus de victoire modéré
    winRate: wins / matches,
    pointsPerRound: points / matches,
    killsPerRound: kills / matches,
    avgRounds: rounds / matches,
  };
}
