// IA des bots — remplace le DummyBot du prompt 4.
// Navigation par waypoints (champ `nav` des maps), combat probabiliste, achats,
// fumée avant de pousser un site, soin sous 55 pv. Toute la traduction ELO ->
// comportement vient de bot_difficulty.js : ici on ne lit que `this.p`.
// Aucun import Three : la vision et les effets passent par les callbacks de ctx.
import { blocked, groundHeight } from '../player.js';
import { WEAPONS, damage } from '../weapons.js';
import { SHIELDS } from '../economy.js';
import { botParams, LOSS_BOOST } from './bot_difficulty.js';
import { paramsOf, behavior } from './bot_profile.js';

const SPEED = 4.6;   // un peu sous le joueur (5.5) : il reste rattrapable
const HEIGHT = 1.8;
const SIGHT = 45;
const WP_REACH = 1.1;

// Rôles (prompt 10). Le rôle décide du QUOI FAIRE, l'ELO (bot_difficulty.js) du
// À QUEL POINT C'EST BIEN EXÉCUTÉ — les deux axes restent séparés.
// Assignés par index dans l'équipe : déterministe, donc testable.
export const ATK_ROLES = ['entry', 'support', 'lurker'];
export const DEF_ROLES = ['anchor', 'roamer', 'rotator'];
const SUPPORT_DELAY = 2.2; // s : le support laisse l'entry ouvrir le site
const PATROL_EVERY = 9;    // s : le roamer change de site
const ROTATE_AFTER = 14;   // s sans avoir vu d'ennemi : le rotator bascule
const ESCORT_GAP = 5;      // m : au-delà, le support recolle à son entry

// Succession des rôles (prompt 13). Les survivants sont triés par la priorité de
// leur rôle actuel puis reçoivent les rôles de `order` dans cet ordre — la liste
// se « tasse » : entry mort => support devient entry, lurker devient support.
// Fonction pure : `team` est une liste { actor, role }, morts inclus.
export function reassignRoles(team, order) {
  const rank = (r) => { const i = order.indexOf(r); return i < 0 ? Infinity : i; };
  const next = new Map();
  team.filter((t) => t.actor.alive)
    .sort((a, b) => rank(a.role) - rank(b.role))
    // Au-delà de order.length, plus rien à distribuer ; en dessous, les rôles
    // de queue restent simplement vacants.
    .forEach((t, i) => { if (i < order.length) next.set(t.actor, order[i]); });
  return next;
}

// Achats par palier, du plus cher au moins cher. smartBuy prend le meilleur
// abordable ; à bas ELO on part d'un palier au hasard (et on descend si trop cher).
const TIERS = [
  { gun: 'vandal', shield: 'heavy' },
  { gun: 'spectre', shield: 'light' },
  { gun: 'sheriff', shield: 'light' },
  { gun: 'classic', shield: null },
];
const tierCost = (t) => WEAPONS[t.gun].price + (t.shield ? SHIELDS[t.shield].price : 0);

const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export class BotController {
  // a : l'acteur (pos, hp, team, wallet…) ; elo : niveau de départ (moyen global) ;
  // nav : routes de la map active.
  // profile (optionnel) : un gène de style/compétence (bot_profile.js) issu de
  // l'entraînement. Absent → comportement historique piloté par l'ELO, inchangé.
  constructor(a, elo, nav, profile = null) {
    this.a = a;
    this.nav = nav;
    this.rotBA = [...nav.rotAB].reverse(); // calculée une fois, pas à chaque frame
    this.weapon = WEAPONS.classic;
    this.elo = elo;
    this.profile = profile;
    if (profile) {
      this.p = paramsOf(profile);
      const b = behavior(profile);
      this.supportDelay = b.supportDelay; this.escortGap = b.escortGap;
      this.patrolEvery = b.patrolEvery; this.rotateAfter = b.rotateAfter;
    } else {
      this.p = botParams(elo);
      this.supportDelay = SUPPORT_DELAY; this.escortGap = ESCORT_GAP;
      this.patrolEvery = PATROL_EVERY; this.rotateAfter = ROTATE_AFTER;
    }
    this.newRound(0, 0);
  }

  // Le rôle vit sur l'ACTEUR : c'est le seul endroit où joueur et bots se lisent
  // de la même façon (roleHolder, reassignRoles). `this.role` reste l'écriture
  // naturelle dans tout le contrôleur.
  get role() { return this.a.role; }

  set role(v) { this.a.role = v; }

  // Promotion en cours de round : l'état interne doit suivre, sinon un support
  // promu entry continuerait d'attendre et un roamer promu anchor de patrouiller.
  promote(role) {
    this.role = role;
    if (role === 'entry') this.wait = 0;
    if (role === 'anchor') { this.patrol = Infinity; this.rotateIn = Infinity; }
  }

  // Round perdu par son équipe : montée progressive (spec : +2 à +5 %). Le niveau
  // de départ est un PLANCHER, y compris pour un bot à profil : son STYLE reste
  // figé, mais sa compétence grimpe au même rythme que l'ELO.
  boost() {
    this.elo *= LOSS_BOOST;
    if (this.profile) {
      this.p = {
        ...this.p,
        reaction: Math.max(0.15, this.p.reaction / LOSS_BOOST),
        fireInterval: Math.max(0.3, this.p.fireInterval / LOSS_BOOST),
        aimError: Math.max(0.4, this.p.aimError / LOSS_BOOST),
        headshotChance: Math.min(0.6, this.p.headshotChance * LOSS_BOOST),
        abilityChance: Math.min(0.98, this.p.abilityChance * LOSS_BOOST),
      };
      return;
    }
    this.p = botParams(this.elo);
  }

  // i : index du bot DANS SON ÉQUIPE. attackers : équipe qui attaque ce round.
  newRound(i, attackers) {
    // Délai d'achat, échelonné par index : déterministe (donc testable) et ça évite
    // que les 3 bots se déclarent prêts sur la même frame.
    this.a.ready = false;
    this.buyIn = 2 + i * 0.6;
    this.role = (this.a.team === attackers ? ATK_ROLES : DEF_ROLES)[i % 3];
    this.holdSite = i % 2 ? 'B' : 'A'; // les défenseurs se répartissent les sites
    this.wait = this.role === 'support' ? this.supportDelay : 0;
    this.patrol = this.patrolEvery;
    this.rotateIn = this.rotateAfter;
    this.sawEnemy = false;
    this.deployed = false; // a rejoint son poste : il rote ensuite par la route inter-sites
    this.routeKey = null;
    this.path = null;
    this.wp = 0;
    this.cool = 0;
    this.seen = 0;
    this.smokeTried = false;
    this.healTried = false;
  }

  buyRound() {
    const w = this.a.wallet;
    let i = this.p.smartBuy ? 0 : Math.floor(Math.random() * TIERS.length);
    while (tierCost(TIERS[i]) > w.credits) i++; // le classic à 0 termine toujours
    const t = TIERS[i];
    w.spend(WEAPONS[t.gun].price);
    this.weapon = WEAPONS[t.gun];
    if (t.shield) {
      w.spend(SHIELDS[t.shield].price);
      this.a.shield = SHIELDS[t.shield].hp;
      this.a.shieldMax = this.a.shield;
    }
  }

  // Phase d'achat : le bot « réfléchit » puis se déclare prêt.
  tickBuy(dt) {
    if (this.a.ready) return;
    this.buyIn -= dt;
    if (this.buyIn <= 0) this.a.ready = true;
  }

  update(dt, ctx) {
    const me = this.a;
    if (!me.alive) return;
    // Soin (exemple ELO de la spec) : tenté une fois, la première fois sous 55 pv.
    if (!this.healTried && me.hp < 55) {
      this.healTried = true;
      if (Math.random() < this.p.abilityChance) ctx.healOver(me);
    }
    if (this.combat(dt, ctx)) return; // cible en vue : on s'arrête et on tire
    this.decide(dt, ctx);
  }

  // --- Combat -----------------------------------------------------------------

  combat(dt, ctx) {
    const me = this.a;
    let foe = null, fd = SIGHT;
    for (const e of ctx.actors) {
      if (e.team === me.team || !e.alive) continue;
      const d = dist2(me.pos, e.pos);
      if (d < fd && ctx.canSee(me.pos, e.pos)) { foe = e; fd = d; }
    }
    if (!foe) { this.seen = 0; return false; }
    this.sawEnemy = true; // le rotator ne bascule que s'il n'a rien vu de son côté

    if (me.model) me.model.rotation.y = Math.atan2(me.pos.x - foe.pos.x, me.pos.z - foe.pos.z);
    this.seen += dt;
    if (this.seen < this.p.reaction) return true; // vu, mais pas encore réagi

    this.cool -= dt;
    if (this.cool <= 0) {
      this.cool = this.p.fireInterval;
      ctx.tracer?.(me.pos, foe.pos); // la balle se voit, qu'elle touche ou non
      // Probabilité de toucher : erreur de visée + distance. Les dégâts viennent
      // de l'arme réellement achetée — l'économie du bot pèse sur sa puissance.
      const hit = Math.min(0.95, Math.max(0.06, 0.92 - this.p.aimError * 0.06 - fd * 0.007));
      if (Math.random() < hit) {
        const head = Math.random() < this.p.headshotChance;
        ctx.hurt(foe, damage(this.weapon, head ? 'h' : 'b', fd), me, this.weapon.name);
      }
    }
    return true;
  }

  // --- Décisions --------------------------------------------------------------

  decide(dt, ctx) {
    const me = this.a, s = ctx.spike;

    if (me.team === ctx.attackers) {
      if (s.planted) { // garder le spike posé
        if (dist2(me.pos, s.pos) > 7) this.walk(dt, s.pos, ctx.solids);
        return;
      }
      if (s.state !== 'carried') return; // désamorcé / explosé : plus d'objectif

      // Le lurker ignore le plan d'équipe et part sur l'autre site chercher les
      // isolés — sauf s'il porte le spike, auquel cas l'objectif prime.
      const site = this.role === 'lurker' && ctx.carrier !== this.a
        ? (ctx.plan.site === 'A' ? 'B' : 'A')
        : ctx.plan.site;
      // Le support n'entre pas en même temps que l'entry : il part avec du retard,
      // ce qui suffit à décaler les deux trajectoires dans le temps.
      if (this.wait > 0 && ctx.carrier !== this.a) { this.wait -= dt; return; }

      const target = ctx.siteCenter(ctx.sites[site === 'A' ? 0 : 1]);
      // Fumigène avant de pousser le site (exemple ELO de la spec) : tenté une fois.
      if (!this.smokeTried && dist2(me.pos, target) < 15) {
        this.smokeTried = true;
        if (Math.random() < this.p.abilityChance) {
          const e = this.nav['atk' + site].at(-2); // l'entrée du site
          ctx.dropSmoke({ x: e[0], y: me.pos.y, z: e[1] });
        }
      }
      if (ctx.carrier === me) {
        if (ctx.siteAt(me.pos)) { s.tickPlant(dt, true, true, me.pos); return; } // immobile : il pose
        this.followRoute(dt, 'atk' + site, ctx.solids);
        return;
      }
      if (ctx.carrier?.player) { // escorte du joueur porteur
        if (dist2(me.pos, ctx.carrier.pos) > this.escortGap) this.walk(dt, ctx.carrier.pos, ctx.solids);
        return;
      }
      // Le support colle au titulaire d'`entry` — joueur ou bot, selon qui a
      // survécu — et pas seulement au porteur du spike. Assez près : il pousse.
      if (this.role === 'support') {
        const lead = ctx.roleHolder(me.team, 'entry');
        if (lead && lead !== me) {
          if (dist2(me.pos, lead.pos) > this.escortGap) this.walk(dt, lead.pos, ctx.solids);
          else this.followRoute(dt, 'atk' + site, ctx.solids);
          return;
        }
      }
      this.followRoute(dt, 'atk' + site, ctx.solids); // même route que le porteur bot
      return;
    }

    // --- Défense ---
    if (s.planted) {
      // Le spike posé prime sur le rôle : tout le monde converge.
      const there = ctx.siteAt(s.pos)?.name ?? this.holdSite;
      if (!this.goSite(dt, there, ctx.solids)) return;
      if (dist2(me.pos, s.pos) > 1.8) { this.walk(dt, s.pos, ctx.solids); return; }
      // Un seul défuseur : le bot le plus proche s'y colle, les autres couvrent.
      // ponytail : si le joueur défenseur tient F en même temps, ça défuse double —
      // rare, et le vrai partage arrive avec le HUD d'équipe du prompt 7.
      const team = ctx.actors.filter((a) => a.team === me.team && a.alive && !a.player);
      const nearest = team.reduce((m, a) => (dist2(a.pos, s.pos) < dist2(m.pos, s.pos) ? a : m));
      if (nearest === me) s.tickDefuse(dt, true);
      return;
    }
    this.patrolTick(dt);
    this.goSite(dt, this.holdSite, ctx.solids);
  }

  // roamer : va-et-vient entre les sites. rotator : bascule une fois s'il n'a rien
  // vu venir de son côté. anchor : ne bouge pas, c'est le point d'ancrage du site.
  patrolTick(dt) {
    const flip = () => { this.holdSite = this.holdSite === 'A' ? 'B' : 'A'; };
    if (this.role === 'roamer') {
      this.patrol -= dt;
      if (this.patrol <= 0) { this.patrol = this.patrolEvery; flip(); }
    } else if (this.role === 'rotator' && !this.sawEnemy) {
      this.rotateIn -= dt;
      if (this.rotateIn <= 0) { this.rotateIn = Infinity; flip(); } // une seule fois
    }
  }

  // Rejoint un site : route depuis le spawn au premier déploiement, route
  // inter-sites ensuite (rotAB, ou son inverse pour aller vers A).
  goSite(dt, site, solids) {
    if (!this.deployed) {
      // High ground du site quand la map en a un et que l'ELO le justifie.
      const high = this.p.holdsHigh && this.nav[`def${site}High`];
      if (!this.followRoute(dt, high ? `def${site}High` : `def${site}`, solids)) return false;
      this.deployed = true;
      return true;
    }
    return this.followPath(dt, `rot${site}`, site === 'B' ? this.nav.rotAB : this.rotBA, solids);
  }

  // --- Navigation ---------------------------------------------------------------

  followRoute(dt, key, solids) { return this.followPath(dt, key, this.nav[key], solids); }

  // Suit une polyligne, en reprenant au point le plus proche quand la route change
  // (une rotation peut partir de n'importe où). Renvoie true une fois au bout.
  followPath(dt, key, points, solids) {
    if (this.routeKey !== key) {
      this.routeKey = key;
      this.path = points;
      let best = 0, bd = Infinity;
      points.forEach(([x, z], i) => {
        const d = Math.hypot(x - this.a.pos.x, z - this.a.pos.z);
        if (d < bd) { bd = d; best = i; }
      });
      this.wp = best;
    }
    if (!this.path || this.wp >= this.path.length) return true;
    const [x, z] = this.path[this.wp];
    this.walk(dt, { x, z }, solids);
    if (Math.hypot(x - this.a.pos.x, z - this.a.pos.z) < WP_REACH) this.wp++;
    return this.wp >= this.path.length;
  }

  walk(dt, tgt, solids) {
    const p = this.a.pos;
    const dx = tgt.x - p.x, dz = tgt.z - p.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) return;
    // Glissement axe par axe, comme le joueur : suffit pour longer murs et chicanes.
    for (const [ax, v] of [['x', dx / len], ['z', dz / len]]) {
      const probe = { x: p.x, y: p.y, z: p.z };
      probe[ax] += v * SPEED * dt;
      if (!blocked(probe, solids, HEIGHT)) p[ax] = probe[ax];
    }
    const g = groundHeight(p, solids); // suit rampes et plateformes
    if (g > -Infinity) p.y = g;
    if (this.a.model) this.a.model.rotation.y = Math.atan2(-dx, -dz);
  }
}
