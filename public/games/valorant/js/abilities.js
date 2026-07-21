// Agents et capacités.
//
// Même schéma que weapons.js : une table de données + une classe qui la fait tourner.
// Aucun import Three — les 16 capacités passent par les callbacks de `ctx`, donc ce
// fichier tourne sous node (voir selftest.js).
//
// Cycle identique pour les 16, comme dans Valorant :
//   C/Q/E/X -> équipée · clic gauche -> lancée · clic droit -> variante · 1/2/3 -> rangée
//
// cast(ctx, alt) renvoie `false` pour rester équipée (rotation du mur, placement
// suivant d'une fumée) ; sinon la charge est consommée et la capacité rangée.
//
// charges : utilisations par round (rechargées au début du round)
// cd      : secondes pour régénérer une charge (capacités signature, gratuites)
// cost    : crédits à l'achat (buy menu, prompt 4) — 0 = fournie
// free    : charges offertes chaque round même si la capacité est payante (Sky Smoke)
// shots   : plusieurs lancers pour une seule charge (Hunter's Fury)

export const AGENTS = {
  jett: {
    name: 'Jett', role: 'Duelist', color: 0x7fe3f0, ultCost: 7,
    abilities: [
      { key: 'KeyC', name: 'Cloudburst', charges: 2, cost: 0,
        cast: (c) => c.lob({ kind: 'smoke', radius: 2.6, life: 4.5, speed: 26, gravity: 9 }) },
      { key: 'KeyQ', name: 'Updraft', charges: 1, cost: 150,
        cast: (c) => c.impulse(9.5) },
      { key: 'KeyE', name: 'Tailwind', charges: 1, cost: 0, cd: 12,
        cast: (c) => c.dash(13) },
      // Les couteaux sont une arme, pas un effet : Arsenal sait déjà tout faire
      // (cadence, chargeur, raycast). Voir WEAPONS.bladestorm.
      { key: 'KeyX', name: 'Blade Storm', ult: true, weapon: 'bladestorm' },
    ],
  },

  sova: {
    name: 'Sova', role: 'Initiator', color: 0x2a4a9e, ultCost: 7,
    abilities: [
      { key: 'KeyC', name: 'Owl Drone', charges: 1, cost: 400,
        cast: (c) => c.drone({ hp: 100, life: 9 }) },
      // Clic droit : tir en cloche qui rebondit, comme la visée alternative de Sova.
      { key: 'KeyQ', name: 'Shock Bolt', charges: 2, cost: 150,
        cast: (c, alt) => c.lob({ kind: 'shock', radius: 4.5, damage: 75,
                                  speed: alt ? 30 : 42, gravity: 10, bounces: alt ? 2 : 0 }) },
      { key: 'KeyE', name: 'Recon Bolt', charges: 1, cost: 0, cd: 40,
        cast: (c, alt) => c.lob({ kind: 'recon', radius: 20, life: 6, hp: 40, pulses: 3,
                                  speed: alt ? 32 : 46, gravity: 7, bounces: alt ? 2 : 0 }) },
      { key: 'KeyX', name: "Hunter's Fury", ult: true, shots: 3,
        cast: (c) => c.beam({ damage: 80, width: 1.3 }) },
    ],
  },

  brimstone: {
    name: 'Brimstone', role: 'Controller', color: 0xe2762c, ultCost: 7,
    abilities: [
      { key: 'KeyC', name: 'Stim Beacon', charges: 1, cost: 200,
        cast: (c) => c.lob({ kind: 'stim', radius: 5, life: 12, speed: 18, gravity: 12 }) },
      { key: 'KeyQ', name: 'Incendiary', charges: 1, cost: 250,
        cast: (c) => c.lob({ kind: 'fire', radius: 3.4, life: 7, dps: 60, speed: 22, gravity: 12 }) },
      // Sky Smoke et Orbital Strike se posent à la mini-carte dans Valorant. Elle
      // arrive au prompt 5 : en attendant on vise le sol, la fumée tombe du ciel.
      // 1 charge offerte par round, 2 de plus achetables — jusqu'à 3 fumées en l'air.
      { key: 'KeyE', name: 'Sky Smoke', charges: 3, free: 1, cost: 100,
        cast: (c) => c.sky({ kind: 'smoke', radius: 4.2, life: 19 }) },
      { key: 'KeyX', name: 'Orbital Strike', ult: true,
        cast: (c) => c.sky({ kind: 'laser', radius: 5.5, life: 3, dps: 170 }) },
    ],
  },

  sage: {
    name: 'Sage', role: 'Sentinel', color: 0xcfeedc, ultCost: 8,
    abilities: [
      { key: 'KeyC', name: 'Barrier Orb', charges: 1, cost: 400, ghost: 'wall',
        cast: (c, alt) => (alt ? c.rotate() : c.barrier({ hp: 400, fortified: 600, life: 40 })) },
      { key: 'KeyQ', name: 'Slow Orb', charges: 2, cost: 200,
        cast: (c) => c.lob({ kind: 'slow', radius: 4, life: 7, slow: 0.5, speed: 20, gravity: 10 }) },
      { key: 'KeyE', name: 'Healing Orb', charges: 1, cost: 0, cd: 45,
        cast: (c, alt) => c.heal(alt ? { self: true, amount: 50, over: 5 }
                                     : { amount: 100, over: 5 }) },
      { key: 'KeyX', name: 'Resurrection', ult: true,
        cast: (c) => c.revive({ channel: 3.3 }) },
    ],
  },
};

export const AGENT_KEYS = Object.keys(AGENTS);

// Étiquette de touche pour le HUD : 'KeyC' -> 'C'.
export const label = (code) => code.replace('Key', '');

// --- Barre de capacités ----------------------------------------------------------

export class Loadout {
  // startingUltPoints : le mode rapide (prompt 4) démarre avec une jauge entamée.
  constructor(agentKey, startingUltPoints = 0) {
    this.key = agentKey;
    this.agent = AGENTS[agentKey];
    this.ult = Math.min(startingUltPoints, this.agent.ultCost);
    this.state = this.agent.abilities.map((a) => ({ charges: a.charges ?? 0, cd: 0, shots: 0 }));
    this.equipped = -1;
    this.ultWeapon = false; // Blade Storm en main : X la rééquipe sans repayer
  }

  get current() { return this.equipped < 0 ? null : this.agent.abilities[this.equipped]; }
  get ultReady() { return this.ult >= this.agent.ultCost; }

  // Kills, morts, orbes, pose/désamorçage du spike : +1 point (prompt 4).
  addUlt(n = 1) { this.ult = Math.min(this.ult + n, this.agent.ultCost); }

  // Début de round : les capacités signature (cost 0) sont rendues, les payantes
  // repartent à leurs charges offertes (`free`, 0 par défaut) et se rachètent au
  // buy menu. Les points d'ultime restent.
  resetRound() {
    this.agent.abilities.forEach((a, i) => {
      this.state[i] = { charges: a.free ?? (a.cost ? 0 : (a.charges ?? 0)), cd: 0, shots: 0 };
    });
    this.equipped = -1;
    this.ultWeapon = false;
  }

  // Achat d'une charge au buy menu. Renvoie false si déjà au max ou trop cher.
  buyCharge(i, wallet) {
    const a = this.agent.abilities[i];
    if (!a.cost || this.state[i].charges >= a.charges) return false;
    if (!wallet.spend(a.cost)) return false;
    this.state[i].charges++;
    return true;
  }

  available(i) {
    const a = this.agent.abilities[i];
    if (a.ult) return this.ultReady || (a.weapon && this.ultWeapon);
    return this.state[i].charges > 0;
  }

  update(dt, input, ctx) {
    this.agent.abilities.forEach((a, i) => {
      const s = this.state[i];
      if (s.cd > 0) {
        s.cd -= dt;
        if (s.cd <= 0) s.charges = Math.min(s.charges + 1, a.charges);
      }
      if (input.consumePress(a.key)) this.toggle(i, ctx);
    });

    // Sortir une arme range la capacité (sauf les couteaux, qui SONT l'arme).
    for (let i = 1; i <= 3; i++) if (input.consumePress(`Digit${i}`)) this.equipped = -1;

    if (this.equipped < 0) return;
    const alt = input.consumeClick(2);
    if (alt || input.consumeClick(0)) this.fire(ctx, alt);
  }

  toggle(i, ctx) {
    if (this.equipped === i) { this.equipped = -1; return; }
    if (!this.available(i)) return;
    const a = this.agent.abilities[i];

    // Ultime-arme : pas de visée, on la prend en main directement.
    if (a.weapon) {
      if (!this.ultWeapon) { this.ult = 0; this.ultWeapon = true; }
      ctx.equipWeapon(a.weapon);
      return;
    }
    this.equipped = i;
    this.state[i].shots = a.shots ?? 1;
  }

  fire(ctx, alt) {
    const i = this.equipped;
    const s = this.state[i];
    if (this.agent.abilities[i].cast(ctx, alt) === false) return; // reste équipée
    if (--s.shots > 0) return;
    this.spend(i);
  }

  spend(i) {
    const a = this.agent.abilities[i];
    const s = this.state[i];
    if (a.ult) this.ult = 0;
    else {
      s.charges--;
      if (a.cd) s.cd = a.cd;
    }
    s.shots = 0;
    this.equipped = -1;
  }

}
