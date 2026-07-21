// Économie : crédits, gains de fin de round, prix.
// Valeurs officielles Valorant, sauf STARTING_CREDITS — le mode rapide démarre
// haut pour permettre un achat plein dès le round 1 (façon Swiftplay).
// Aucun import : tourne sous node (voir selftest.js).

export const STARTING_CREDITS = 2400;
export const CREDIT_CAP = 9000;

export const REWARD = {
  win: 3000,
  loss: [1900, 2400, 2900], // 1re, 2e, 3e défaite d'affilée — puis plafonné
  kill: 200,
  plant: 300,               // toute l'équipe attaquante, même si le round est perdu ensuite
  survivedLoss: 1000,       // plancher garanti : survivre à un round perdu sans kill
};

export const SHIELDS = {
  light: { name: 'Light Shield', hp: 25, price: 400 },
  heavy: { name: 'Heavy Shield', hp: 50, price: 1000 },
};

// Gains d'un joueur en fin de round. `lossStreak` = défaites consécutives AVANT ce round.
export function roundReward({ won, lossStreak = 0, kills = 0, planted = false, survived = false }) {
  let c = kills * REWARD.kill;
  if (planted) c += REWARD.plant;
  if (won) return c + REWARD.win;

  c += REWARD.loss[Math.min(lossStreak, REWARD.loss.length - 1)];
  // Ce plancher n'est jamais atteint avec les valeurs ci-dessus (1900 > 1000). Il est
  // là parce que la règle le demande, et il tiendra si les gains de défaite changent.
  if (survived && kills === 0) c = Math.max(c, REWARD.survivedLoss);
  return c;
}

export class Wallet {
  constructor(credits = STARTING_CREDITS) { this.credits = credits; }
  add(n) { this.credits = Math.min(this.credits + n, CREDIT_CAP); }
  canAfford(n) { return n <= this.credits; }
  spend(n) {
    if (!this.canAfford(n)) return false;
    this.credits -= n;
    return true;
  }
}
