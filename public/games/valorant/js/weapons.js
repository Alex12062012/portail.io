// Arsenal, tir, recul, dégâts.
//
// Zéro dépendance Three.js : le raycast passe par le callback `api.trace(spreadDeg)`.
// Tout ce fichier tourne donc tel quel dans node (voir selftest.js).
//
// Angles en degrés, distances en mètres, temps en secondes.

// Tranches de dégâts : on prend la première dont `r` couvre la distance.
const D = (h, b, l) => [{ r: Infinity, h, b, l }];

// --- Familles de maniement -----------------------------------------------------
// `cat` pilote le recul et la précision ; `class` (dans WEAPONS) ne sert qu'au
// classement dans le buy menu du prompt 4. Le Shorty est un pistolet qui se
// comporte en shotgun : les deux champs divergent volontairement.
export const CATS = {
  pistol:  { climb: 0.75, climbShots: 3,  drift: 0.25, recover: 10, err: 0.25, moveErr: 2.2, bloom: 0.08, moveMult: 1,    reload: 1.5 },
  smg:     { climb: 0.45, climbShots: 6,  drift: 0.45, recover: 12, err: 0.30, moveErr: 0.9, bloom: 0.05, moveMult: 1,    reload: 1.8 },
  rifle:   { climb: 1.00, climbShots: 6,  drift: 0.90, recover: 8,  err: 0.10, moveErr: 3.2, bloom: 0.04, moveMult: 1,    reload: 2.5 },
  heavy:   { climb: 0.70, climbShots: 10, drift: 0.70, recover: 6,  err: 0.35, moveErr: 3.5, bloom: 0.03, moveMult: 0.55, reload: 5.0 },
  // Pas de pattern : un gros coup de caméra, puis un temps mort avant de pouvoir réviser.
  sniper:  { climb: 0, flinch: 3.2, recover: 2.2, err: 0.05, moveErr: 5.0, settle: 0.55, moveMult: 0.85, reload: 3.7 },
  // Pas de recul à proprement parler : des pellets dispersés autour du point visé.
  shotgun: { climb: 0, flinch: 1.6, recover: 6, err: 0, moveErr: 1.5, spread: 3.2, moveMult: 1, reload: 2.5 },
  melee:   { climb: 0, recover: 8, err: 0, moveErr: 0, moveMult: 1, reload: 0 },
  // Couteaux de Jett : err et moveErr à 0 = précision 100 % même en course ou en l'air.
  knives:  { climb: 0, recover: 10, err: 0, moveErr: 0, bloom: 0, moveMult: 1, reload: 0 },
};

// Multiplicateur de dégâts après avoir traversé un mur. Faible = ne traverse pas.
export const PEN = { low: 0, med: 0.5, high: 0.8 };

// --- Arsenal -------------------------------------------------------------------
// d      : tranches de dégâts tête/corps/jambe (par pellet pour les shotguns)
// fps    : tirs par seconde ; auto : maintien de la gâchette
// drift  : sens de la dérive latérale du spray (+1 droite, -1 gauche)
export const WEAPONS = {
  // --- Pistolets ---
  classic:  { name: 'Classic',  class: 'pistol',  cat: 'pistol',  price: 0,    d: D(78, 26, 22),   fps: 6.75, mag: 12,  pen: 'low',  drift: 1 },
  shorty:   { name: 'Shorty',   class: 'pistol',  cat: 'shotgun', price: 300,  pellets: 15, spread: 5.5,
              d: [{ r: 7, h: 36, b: 12, l: 10 }, { r: 15, h: 24, b: 8, l: 7 }, { r: Infinity, h: 9, b: 3, l: 3 }],
              fps: 3.3,  mag: 2,   pen: 'low' },
  frenzy:   { name: 'Frenzy',   class: 'pistol',  cat: 'pistol',  price: 450,  d: D(78, 26, 22),   fps: 10,   mag: 13,  pen: 'low',  drift: -1, auto: true },
  ghost:    { name: 'Ghost',    class: 'pistol',  cat: 'pistol',  price: 500,  d: D(105, 30, 25),  fps: 6.75, mag: 15,  pen: 'med',  drift: 1 },
  sheriff:  { name: 'Sheriff',  class: 'pistol',  cat: 'pistol',  price: 800,  d: D(159, 55, 47),  fps: 4,    mag: 6,   pen: 'med',  drift: -1 },

  // --- SMG ---
  stinger:  { name: 'Stinger',  class: 'smg',     cat: 'smg',     price: 1100, d: [{ r: 20, h: 67, b: 27, l: 23 }, { r: Infinity, h: 62, b: 25, l: 21 }], fps: 16,   mag: 20, pen: 'low', drift: -1, auto: true },
  spectre:  { name: 'Spectre',  class: 'smg',     cat: 'smg',     price: 1600, d: [{ r: 20, h: 78, b: 26, l: 22 }, { r: Infinity, h: 66, b: 22, l: 18 }], fps: 13.3, mag: 30, pen: 'low', drift: 1,  auto: true },

  // --- Shotguns (dégâts PAR pellet) ---
  bucky:    { name: 'Bucky',    class: 'shotgun', cat: 'shotgun', price: 850,  pellets: 15, spread: 4.5,
              d: [{ r: 8, h: 60, b: 20, l: 17 }, { r: 12, h: 27, b: 9, l: 8 }, { r: Infinity, h: 15, b: 5, l: 4 }],
              fps: 1.1, mag: 5, pen: 'low' },
  judge:    { name: 'Judge',    class: 'shotgun', cat: 'shotgun', price: 1850, pellets: 12, spread: 4.0,
              d: [{ r: 10, h: 34, b: 17, l: 14 }, { r: 15, h: 26, b: 13, l: 11 }, { r: Infinity, h: 20, b: 10, l: 8 }],
              fps: 3.5, mag: 7, pen: 'low', auto: true },

  // --- Rifles ---
  bulldog:  { name: 'Bulldog',  class: 'rifle',   cat: 'rifle',   price: 2050, d: D(115, 35, 30),  fps: 9.15, mag: 24, pen: 'med', drift: 1, auto: true, zoom: 1.25, burstAds: 3 },
  guardian: { name: 'Guardian', class: 'rifle',   cat: 'rifle',   price: 2250, d: D(195, 65, 49),  fps: 6.5,  mag: 12, pen: 'med', drift: -1, zoom: 1.25 },
  phantom:  { name: 'Phantom',  class: 'rifle',   cat: 'rifle',   price: 2900, silenced: true, drift: -1, auto: true, fps: 11, mag: 30, pen: 'med',
              d: [{ r: 20, h: 156, b: 39, l: 33 }, { r: 50, h: 140, b: 35, l: 30 }, { r: Infinity, h: 124, b: 31, l: 26 }] },
  vandal:   { name: 'Vandal',   class: 'rifle',   cat: 'rifle',   price: 2900, d: D(160, 40, 34),  fps: 9.75, mag: 25, pen: 'med', drift: 1, auto: true },

  // --- Snipers ---
  // `reload` sur l'arme : durée propre, sinon celle de la famille (CATS).
  marshal:  { name: 'Marshal',  class: 'sniper',  cat: 'sniper',  price: 950,  d: D(202, 101, 85),  fps: 1.5,  mag: 5, pen: 'high', zoom: 2.5, reload: 2.5 },
  outlaw:   { name: 'Outlaw',   class: 'sniper',  cat: 'sniper',  price: 2400, d: D(238, 140, 119), fps: 2.75, mag: 2, pen: 'high', zoom: 2.5 },
  operator: { name: 'Operator', class: 'sniper',  cat: 'sniper',  price: 4700, d: D(255, 150, 120), fps: 0.75, mag: 5, pen: 'high', zoom: 4, settle: 1.1 },

  // --- Lourdes ---
  // `warmup` : l'Ares gagne en précision tant qu'on garde la gâchette enfoncée.
  ares:     { name: 'Ares',     class: 'heavy',   cat: 'heavy',   price: 1600, d: D(72, 30, 25), fps: 10,   mag: 50,  pen: 'high', drift: 1,  auto: true, warmup: true },
  odin:     { name: 'Odin',     class: 'heavy',   cat: 'heavy',   price: 3500, d: D(78, 35, 30), fps: 12.5, mag: 100, pen: 'high', drift: -1, auto: true },

  // Slot 3. Hors tableau des 18, mais il faut bien quelque chose sous la touche.
  knife:    { name: 'Couteau',  class: 'melee',   cat: 'melee',   price: 0, d: D(50, 50, 50), fps: 2, mag: Infinity, pen: 'low', range: 1.6 },

  // Ultime de Jett (prompt 3) : une arme, pas un effet. `throwAll` = le clic droit
  // lance tout le reste d'un coup, et ces couteaux-là ne se rechargent pas sur kill.
  bladestorm: { name: 'Blade Storm', class: 'melee', cat: 'knives', price: 0,
                d: D(150, 50, 50), fps: 2.2, mag: 5, pen: 'low', range: 60, throwAll: true },
};

// --- Calculs purs --------------------------------------------------------------

// Dégâts d'un impact. `part` vaut 'h' (tête), 'b' (corps) ou 'l' (jambes).
export function damage(w, part, dist) {
  const t = w.d.find((s) => dist <= s.r) ?? w.d[w.d.length - 1];
  return t[part];
}

// Recul du n-ième tir d'un spray (n commence à 0). Déterministe : le pattern
// s'apprend. La montée s'installe sur les premières balles, puis la dérive
// latérale démarre, dans le sens propre à l'arme.
export function recoilAt(w, n) {
  const c = CATS[w.cat];
  if (!c.climb) return { x: 0, y: c.flinch ?? 0 };
  const ramp = Math.min(n / c.climbShots, 1);
  const y = c.climb * (0.4 + 0.6 * ramp);
  const x = n < c.climbShots ? 0 : c.drift * Math.sin((n - c.climbShots) * 0.6) * (w.drift ?? 1);
  return { x, y };
}

// Demi-angle du cône de tir, en degrés. 0 = laser.
export function spreadOf(w, n, playerSpread, opts = {}) {
  const c = CATS[w.cat];
  let s = c.err + playerSpread * c.moveErr + n * (c.bloom ?? 0);
  if (w.warmup) s *= Math.max(0.3, 1 - n * 0.07);   // Ares : se stabilise en tirant
  if (opts.settling > 0) s += 4;                     // sniper pas encore réarmé
  if (opts.ads) s *= 0.35;
  return s;
}

// --- Arme équipée --------------------------------------------------------------

export class Arsenal {
  // slots : [principale, secondaire, mêlée]
  constructor(slots = ['vandal', 'classic', 'knife']) {
    this.slots = slots;
    this.ammo = {};
    this.locked = false; // une capacité est en main : la gâchette ne tire pas
    for (const k of slots) if (k) this.reset(k);
    // Un slot à null = pas d'arme principale (début de match, ou principale perdue
    // en mourant). On démarre alors sur le pistolet.
    this.equip(slots[0] ? 0 : 1);
  }

  reset(key, reserve) {
    const w = WEAPONS[key];
    this.ammo[key] = { mag: w.mag, reserve: reserve ?? (w.mag === Infinity ? Infinity : w.mag * 3) };
  }

  // Arme d'ultime (Blade Storm) : slot 4, sans réserve — épuisée, elle rend la main.
  equipAbilityWeapon(key) {
    this.slots[3] = key;
    if (!this.ammo[key]) this.reset(key, 0);
    this.index = -1;
    this.equip(3);
  }

  get abilityWeapon() { return this.index === 3; }

  equip(i) {
    if (i === this.index || !this.slots[i]) return;
    this.index = i;
    this.key = this.slots[i];
    this.w = WEAPONS[this.key];
    this.shots = 0;        // compteur de spray, remis à zéro entre deux rafales
    this.cooldown = 0;
    this.reloading = 0;
    this.reloadTotal = 0;
    this.settling = 0;     // sniper : temps restant avant de pouvoir réviser
    this.burst = 0;
    this.ads = false;
    this.recoil = { x: 0, y: 0 };
    this.idle = 0;
    this.kick = 0;         // impulsion visuelle du viewmodel
  }

  get clip() { return this.ammo[this.key]; }
  get spread() { return spreadOf(this.w, this.shots, this._playerSpread ?? 0, this); }

  startReload() {
    const a = this.clip;
    if (this.reloading || a.mag >= this.w.mag || a.reserve <= 0) return;
    this.reloading = this.reloadTotal = this.w.reload ?? CATS[this.w.cat].reload;
    this.burst = 0; // une rafale entamée ne doit pas repartir seule après le rechargement
  }

  // api : { trace(spreadDeg, pellets) -> [hit], onHit(hit, dmg), onShot(w) }
  update(dt, input, player, api) {
    const w = this.w;
    const c = CATS[w.cat];
    this._playerSpread = player.spread;

    for (let i = 0; i < 3; i++) if (input.consumePress(`Digit${i + 1}`)) this.equip(i);
    if (input.consumePress('KeyR')) this.startReload();

    this.ads = !this.locked && !!w.zoom && input.mouse(2);

    if (this.reloading > 0) {
      this.reloading -= dt * (player.buff ?? 1); // Stim Beacon : rechargement plus rapide
      if (this.reloading <= 0) {
        this.reloading = 0; // pas de reliquat négatif : truthy, il bloquerait startReload
        const a = this.clip, need = w.mag - a.mag;
        const take = Math.min(need, a.reserve);
        a.mag += take;
        a.reserve -= take;
        this.shots = 0;
      }
    }

    this.cooldown = Math.max(0, this.cooldown - dt);
    this.settling = Math.max(0, this.settling - dt);
    this.kick = Math.max(0, this.kick - dt * 6);

    // Blade Storm : le clic droit lance tout le reste d'un seul geste.
    const dump = !this.locked && w.throwAll && input.consumeClick(2);
    if (dump) while (this.clip.mag > 0) this.fire(player, api, true);

    const firing = w.auto || this.burst > 0 ? input.mouse(0) || this.burst > 0 : input.consumeClick(0);
    if (!dump && firing && !this.locked && this.canFire()) this.fire(player, api);
    else if (!input.mouse(0)) {
      // Fin de rafale : le compteur de spray retombe après un court délai.
      this.idle += dt;
      if (this.idle > 0.35) this.shots = 0;
    }
    if (input.mouse(0)) this.idle = 0;

    // Retour de caméra : le recul se résorbe exponentiellement.
    const k = Math.min(c.recover * dt, 1);
    this.recoil.x -= this.recoil.x * k;
    this.recoil.y -= this.recoil.y * k;
    player.recoilYaw = -this.recoil.x * Math.PI / 180;
    player.recoilPitch = this.recoil.y * Math.PI / 180;
    player.speedMult = input.mouse(0) && this.clip.mag > 0 ? c.moveMult : 1;
  }

  canFire() {
    if (this.cooldown > 0 || this.reloading > 0) return false;
    if (this.clip.mag <= 0) { this.startReload(); return false; }
    return true;
  }

  // `grouped` : lancer groupé du Blade Storm — ces couteaux-là ne se rechargent pas sur kill.
  fire(player, api, grouped = false) {
    const w = this.w, c = CATS[w.cat];
    this.cooldown = 1 / w.fps / (player.buff ?? 1); // Stim Beacon : cadence accélérée
    if (w.mag !== Infinity) this.clip.mag--;

    // Rafale du Bulldog en visée : les 2 coups suivants partent tout seuls, plus vite.
    if (w.burstAds && this.ads) {
      if (this.burst > 0) { this.burst--; this.cooldown = 0.07; }
      else this.burst = w.burstAds - 1;
    }

    const deg = spreadOf(w, this.shots, player.spread, this);
    const hits = api.trace(w, deg);
    for (const h of hits) api.onHit(h, Math.round(damage(w, h.part, h.dist) * (h.penMult ?? 1)), grouped);

    const r = recoilAt(w, this.shots);
    this.recoil.x += r.x;
    this.recoil.y += r.y;
    this.shots++;
    this.settling = w.settle ?? c.settle ?? 0;
    this.kick = 1;
    api.onShot?.(w);
  }
}
