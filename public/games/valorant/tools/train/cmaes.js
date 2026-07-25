// CMA-ES (Covariance Matrix Adaptation Evolution Strategy) — écrit à la main,
// zéro dépendance. Décalque de purecmaes.m (Hansen, "The CMA Evolution Strategy:
// A Tutorial") à un détail près : ici on MAXIMISE la fitness, donc le tri des
// individus est DÉCROISSANT.
//
// L'optimisation vit dans un espace normalisé [0,1]^N ; c'est l'appelant qui
// clampe et remappe vers les bornes réelles des gènes (contrainte de boîte par
// troncature — suffisant pour 7 gènes déjà bornés).

const eye = (n) => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
const mulVec = (M, v) => M.map((row) => row.reduce((s, m, j) => s + m * v[j], 0));

// Décomposition propre d'une matrice symétrique (Jacobi cyclique). Renvoie les
// valeurs propres et B, dont la COLONNE j est le vecteur propre j.
// N = 7 ici : le coût est négligeable devant une seule simulation de match.
export function jacobiEigen(input, sweeps = 60) {
  const n = input.length;
  const A = input.map((r) => [...r]);
  const V = eye(n);
  for (let s = 0; s < sweeps; s++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
    if (off < 1e-24) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-18) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
      for (let k = 0; k < n; k++) { const a = A[k][p], b = A[k][q]; A[k][p] = c * a - sn * b; A[k][q] = sn * a + c * b; }
      for (let k = 0; k < n; k++) { const a = A[p][k], b = A[q][k]; A[p][k] = c * a - sn * b; A[q][k] = sn * a + c * b; }
      for (let k = 0; k < n; k++) { const a = V[k][p], b = V[k][q]; V[k][p] = c * a - sn * b; V[k][q] = sn * a + c * b; }
    }
  }
  return { values: A.map((r, i) => r[i]), vectors: V };
}

export const SIGMA_MIN = 1e-3;
// Plafond du pas. L'espace de recherche est le cube unité [0,1]^N : à sigma = 1 on
// échantillonne tout le domaine à chaque tirage, la covariance ne veut plus rien
// dire et CMA-ES dégénère en recherche aléatoire. 0.4 laisse de quoi explorer sans
// perdre la localité.
export const SIGMA_MAX = 0.4;

export class CMAES {
  // x0 : moyenne initiale. sigma : pas global initial. lambda : taille de population.
  // rand : source aléatoire injectable (les tests s'en servent pour être déterministes).
  constructor(x0, sigma = 0.3, { lambda, rand = Math.random } = {}) {
    const N = x0.length;
    this.N = N;
    this.rand = rand;
    this.lambda = lambda ?? 4 + Math.floor(3 * Math.log(N));
    this.mu = Math.max(1, Math.floor(this.lambda / 2));
    this.xmean = x0.slice();
    this.sigma = sigma;

    // Poids de recombinaison (log-décroissants) et masse effective associée.
    const raw = Array.from({ length: this.mu }, (_, i) => Math.log(this.mu + 0.5) - Math.log(i + 1));
    const sum = raw.reduce((a, b) => a + b, 0);
    this.w = raw.map((v) => v / sum);
    this.mueff = 1 / this.w.reduce((a, b) => a + b * b, 0);

    // Constantes d'adaptation (formules standard du tutoriel).
    this.cc = (4 + this.mueff / N) / (N + 4 + 2 * this.mueff / N);
    this.cs = (this.mueff + 2) / (N + this.mueff + 5);
    this.c1 = 2 / ((N + 1.3) ** 2 + this.mueff);
    this.cmu = Math.min(1 - this.c1, 2 * (this.mueff - 2 + 1 / this.mueff) / ((N + 2) ** 2 + this.mueff));
    this.damps = 1 + 2 * Math.max(0, Math.sqrt((this.mueff - 1) / (N + 1)) - 1) + this.cs;

    this.pc = new Array(N).fill(0);
    this.ps = new Array(N).fill(0);
    this.B = eye(N);
    this.D = new Array(N).fill(1);
    this.C = eye(N);
    this.invsqrtC = eye(N);
    this.chiN = Math.sqrt(N) * (1 - 1 / (4 * N) + 1 / (21 * N * N));

    this.gen = 0;
    this.counteval = 0;
    this.eigeneval = 0;
    this.best = { x: x0.slice(), fitness: -Infinity };
  }

  // N(0,1) par Box-Muller.
  gauss() {
    let u = 0;
    while (u === 0) u = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rand());
  }

  // Une génération de candidats : x = xmean + sigma * B * (D .* z).
  ask() {
    return Array.from({ length: this.lambda }, () => {
      const z = Array.from({ length: this.N }, () => this.gauss());
      return this.xmean.map((m, i) => m + this.sigma * this.B[i].reduce((s, b, j) => s + b * this.D[j] * z[j], 0));
    });
  }

  // xs : ce qu'a renvoyé ask(). fits : fitness de chacun (plus haut = meilleur).
  tell(xs, fits) {
    const N = this.N;
    const idx = fits.map((_, i) => i).sort((a, b) => fits[b] - fits[a]); // décroissant : on maximise
    this.counteval += xs.length;
    this.gen++;
    if (fits[idx[0]] > this.best.fitness) this.best = { x: xs[idx[0]].slice(), fitness: fits[idx[0]] };

    const xold = this.xmean;
    const xmean = new Array(N).fill(0);
    for (let k = 0; k < this.mu; k++) for (let i = 0; i < N; i++) xmean[i] += this.w[k] * xs[idx[k]][i];
    this.xmean = xmean;

    // Chemins d'évolution : ps pilote sigma, pc pilote la mise à jour rang-1 de C.
    const dm = xmean.map((v, i) => (v - xold[i]) / this.sigma);
    const cdm = mulVec(this.invsqrtC, dm);
    const csFac = Math.sqrt(this.cs * (2 - this.cs) * this.mueff);
    this.ps = this.ps.map((p, i) => (1 - this.cs) * p + csFac * cdm[i]);
    const psNorm = Math.hypot(...this.ps);
    const hsig = psNorm / Math.sqrt(1 - (1 - this.cs) ** (2 * this.counteval / this.lambda)) / this.chiN
      < 1.4 + 2 / (N + 1) ? 1 : 0;
    const ccFac = Math.sqrt(this.cc * (2 - this.cc) * this.mueff);
    this.pc = this.pc.map((p, i) => (1 - this.cc) * p + hsig * ccFac * dm[i]);

    // C <- (1-c1-cmu)C + c1(pc pc' + correction hsig) + cmu * somme des rangs mu.
    for (let i = 0; i < N; i++) for (let j = 0; j <= i; j++) {
      let rankMu = 0;
      for (let k = 0; k < this.mu; k++) {
        const yi = (xs[idx[k]][i] - xold[i]) / this.sigma;
        const yj = (xs[idx[k]][j] - xold[j]) / this.sigma;
        rankMu += this.w[k] * yi * yj;
      }
      const v = (1 - this.c1 - this.cmu) * this.C[i][j]
        + this.c1 * (this.pc[i] * this.pc[j] + (1 - hsig) * this.cc * (2 - this.cc) * this.C[i][j])
        + this.cmu * rankMu;
      this.C[i][j] = v;
      this.C[j][i] = v;
    }

    // Adaptation du pas. Bornée : sur 10 h, un sigma qui diverge ou s'annule
    // transformerait la recherche en bruit pur ou en point fixe.
    this.sigma = Math.min(SIGMA_MAX, Math.max(SIGMA_MIN,
      this.sigma * Math.exp((this.cs / this.damps) * (psNorm / this.chiN - 1))));

    // Décomposition propre amortie (coûteuse en O(N^3), inutile à chaque génération).
    if (this.counteval - this.eigeneval > this.lambda / (this.c1 + this.cmu) / N / 10) {
      this.eigeneval = this.counteval;
      const { values, vectors } = jacobiEigen(this.C);
      this.B = vectors;
      this.D = values.map((v) => Math.sqrt(Math.max(1e-20, v)));
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        this.invsqrtC[i][j] = this.B[i].reduce((s, _, k) => s + this.B[i][k] * (1 / this.D[k]) * this.B[j][k], 0);
      }
    }
    return this.best;
  }

  // Reprise : seuls la moyenne et le pas sont utiles (un redémarrage repart
  // volontairement d'une covariance neutre — pratique standard des restarts).
  toJSON() { return { xmean: this.xmean, sigma: this.sigma, gen: this.gen, best: this.best }; }
}
