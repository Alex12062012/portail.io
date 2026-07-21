// Rounds, conditions de victoire, alternance des camps, score du match.
// Contient aussi la config du mode rapide : un fichier game_mode_quick.js séparé
// n'aurait fait que ré-exporter ces constantes et celles d'economy.js / spike.js.
// Aucun import Three ni DOM — tourne sous node (voir selftest.js).
import { roundReward } from './economy.js';

// --- Mode rapide 3v3 ---------------------------------------------------------------
export const ROUNDS_TO_WIN = 3;         // Bo5 : premier à 3 rounds gagnés
export const ROUND_TIMER_SECONDS = 65;  // vs 100 s en compétitif
export const BUY_SECONDS = 15;
export const END_SECONDS = 5;           // bannière de fin de round
export const TEAM_SIZE = 3;             // les places vides sont comblées par des bots (prompt 6)
export const STARTING_ULT_POINTS = 2;   // jauge entamée : un match court doit permettre l'ultime

export class RoundManager {
  // game : { spike, players[], aliveCount(team), resetRound(attackers), allReady?, onRoundEnd? }
  // Un `player` : { team, wallet, kills, alive, ready }
  constructor(game) {
    this.g = game;
    this.round = 0;
    this.score = [0, 0];
    this.lossStreak = [0, 0];
    this.attackers = 0;
    this.winner = null;
    this.reason = '';
    this.startRound();
  }

  get defenders() { return 1 - this.attackers; }
  get live() { return this.phase === 'live'; }

  startRound() {
    this.round++;
    // Switch de camp à CHAQUE round, pas seulement à la mi-match.
    if (this.round > 1) this.attackers = 1 - this.attackers;
    this.phase = 'buy';
    this.timer = BUY_SECONDS;
    this.reason = '';
    this.g.spike.reset();
    for (const p of this.g.players) p.kills = 0;
    this.g.resetRound(this.attackers);
  }

  update(dt) {
    if (this.phase === 'match') return;
    this.timer -= dt;

    // Le round démarre au premier des deux : tout le monde prêt, ou timer écoulé.
    // Avant ça, main.js garde l'arsenal et les capacités verrouillés — sans quoi
    // on peut tirer sur des bots encore immobiles (leur IA n'est appelée que `live`).
    if (this.phase === 'buy') {
      if (this.timer <= 0 || this.g.allReady?.()) { this.phase = 'live'; this.timer = ROUND_TIMER_SECONDS; }
      return;
    }
    if (this.phase === 'end') {
      if (this.timer <= 0) this.startRound();
      return;
    }

    const s = this.g.spike;
    s.tick(dt);

    // Ordre volontaire : le spike tranche avant les éliminations. Une équipe
    // attaquante entièrement morte gagne quand même si la mèche va au bout.
    if (s.state === 'exploded') return this.end(this.attackers, 'spike explosé');
    if (s.state === 'defused') return this.end(this.defenders, 'spike désamorcé');
    if (this.g.aliveCount(this.defenders) === 0) return this.end(this.attackers, 'défenseurs éliminés');
    // Après la pose, tuer tous les attaquants ne suffit plus : il faut désamorcer.
    if (!s.planted && this.g.aliveCount(this.attackers) === 0) return this.end(this.defenders, 'attaquants éliminés');
    if (!s.planted && this.timer <= 0) return this.end(this.defenders, 'temps écoulé');
  }

  end(team, reason) {
    // Paiement avant mise à jour du streak : roundReward veut les défaites d'AVANT.
    for (const p of this.g.players) {
      p.wallet.add(roundReward({
        won: p.team === team,
        lossStreak: this.lossStreak[p.team],
        kills: p.kills,
        planted: p.team === this.attackers && this.g.spike.everPlanted,
        survived: p.alive,
      }));
    }

    this.score[team]++;
    this.lossStreak[team] = 0;
    this.lossStreak[1 - team]++;
    this.reason = reason;
    this.roundWinner = team;
    this.phase = 'end';
    this.timer = END_SECONDS;
    if (this.score[team] >= ROUNDS_TO_WIN) { this.phase = 'match'; this.winner = team; }
    this.g.onRoundEnd?.(team, reason);
  }
}
