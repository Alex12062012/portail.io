// Assemblage du HUD (prompt 7) : timer/score, vie/armure/crédits, munitions,
// capacités, action en cours, bannières, écran de fin de match, killfeed,
// scoreboard. Le style vit dans css/hud.css. Remplace le HUD texte des prompts 1-6.
import { Killfeed } from './killfeed.js';
import { Scoreboard } from './scoreboard.js';
import { DamageIndicator } from './damage_indicator.js';
import { label } from '../abilities.js';

export class Hud {
  // deps : { actors, playerActor, loadout, arsenal, rm, spike, input }
  constructor(deps) {
    this.d = deps;
    document.body.insertAdjacentHTML('beforeend', `
      <div id="hudRoot">
        <div id="topbar" class="panel">
          <div class="score s0">0</div>
          <div class="mid"><div class="clock">—</div><div class="round">ROUND 1</div></div>
          <div class="score s1">0</div>
        </div>
        <div id="hpbox" class="panel">
          <span class="agent"></span>
          <div class="bar"><div></div></div>
          <div class="row"><span class="hp">100</span><span class="sh"></span><span class="cr"></span></div>
        </div>
        <div id="ammo" class="panel">
          <div class="wn"></div>
          <div><span class="mag">—</span> <span class="res"></span></div>
          <em class="rl">RECHARGEMENT</em>
        </div>
        <div id="abil"></div>
        <div id="action"><span></span><div class="ring"></div></div>
        <div id="roundflash"></div>
        <div id="banner"></div>
        <div id="dead"><span>MORT</span><em></em></div>
        <div id="endscreen"></div>
      </div>`);
    const q = (s) => document.querySelector(s);
    this.el = {
      s0: q('#topbar .s0'), s1: q('#topbar .s1'), clock: q('#topbar .clock'), round: q('#topbar .round'),
      agent: q('#hpbox .agent'), hpFill: q('#hpbox .bar div'), hp: q('#hpbox .hp'),
      sh: q('#hpbox .sh'), cr: q('#hpbox .cr'),
      ammo: q('#ammo'), wn: q('#ammo .wn'), mag: q('#ammo .mag'), res: q('#ammo .res'),
      abil: q('#abil'), action: q('#action'), actionLbl: q('#action span'), actionRing: q('#action .ring'),
      banner: q('#banner'), flash: q('#roundflash'),
      dead: q('#dead'), spec: q('#dead em'), end: q('#endscreen'),
    };
    const root = document.getElementById('hudRoot');
    this.feed = new Killfeed(root, deps.playerActor.team);
    this.board = new Scoreboard(root, deps);
    this.dmg = new DamageIndicator(root);
    this.el.agent.textContent = deps.loadout.agent.name.toUpperCase();
    this.matchShown = false;
    this.flashFor = -1;
  }

  // s : { time, action: { label, pct } | null }
  update(s) {
    const { rm, spike, playerActor, arsenal, loadout } = this.d;
    const my = playerActor.team;

    // timer + score (spike posé : la mèche remplace le timer de round)
    const el = this.el;
    if (spike.planted) {
      el.clock.textContent = spike.fuse.toFixed(1);
      el.clock.className = 'clock spike';
    } else {
      const t = Math.max(0, Math.ceil(rm.timer));
      el.clock.textContent = rm.phase === 'live' || rm.phase === 'buy' ? `${t}` : '—';
      el.clock.className = `clock${rm.phase === 'live' && t <= 10 ? ' low' : ''}`;
    }
    el.round.textContent = `ROUND ${rm.round} · ${rm.phase === 'buy' ? 'ACHAT' : my === rm.attackers ? 'ATTAQUE' : 'DÉFENSE'}`;
    el.s0.textContent = rm.score[my];
    el.s1.textContent = rm.score[1 - my];

    // vie / armure / crédits
    el.hpFill.style.width = `${Math.max(0, (playerActor.hp / playerActor.maxHp) * 100)}%`;
    el.hp.textContent = Math.round(playerActor.hp);
    el.sh.textContent = playerActor.shield
      ? `${playerActor.shieldMax === 50 ? 'LOURD' : 'LÉGER'} +${Math.round(playerActor.shield)}` : '';
    el.cr.textContent = `${playerActor.wallet.credits} cr`;

    // munitions
    const clip = arsenal.clip;
    el.wn.textContent = arsenal.w.name.toUpperCase();
    el.mag.textContent = clip.mag === Infinity ? '∞' : clip.mag;
    el.res.textContent = `/ ${clip.reserve === Infinity ? '∞' : clip.reserve}`;
    el.ammo.classList.toggle('reloading', arsenal.reloading > 0);

    // capacités : touche, nom, charges / cooldown / jauge d'ultime
    el.abil.innerHTML = loadout.agent.abilities.map((a, i) => {
      const st = loadout.state[i];
      const on = i === loadout.equipped || (a.weapon && loadout.ultWeapon);
      let cls = on ? ' on' : '', count;
      if (a.ult) {
        count = `${loadout.ult}/${loadout.agent.ultCost}`;
        if (loadout.ultReady) cls += ' ready'; else if (!on) cls += ' off';
      } else {
        count = st.cd > 0 && st.charges === 0 ? `${Math.ceil(st.cd)}s` : `x${st.charges}`;
        if (!st.charges && !on) cls += ' off';
      }
      return `<div class="slot panel${cls}"><b>${label(a.key)}</b><i>${count}</i><span class="nm">${a.name}</span></div>`;
    }).join('');

    // action en cours (pose / désamorçage), ou attente des autres joueurs
    const act = s.action
      ?? (rm.phase === 'buy' && playerActor.ready
        ? { label: 'EN ATTENTE DES AUTRES JOUEURS', pct: 0 } : null);
    el.action.classList.toggle('on', !!act);
    if (act) {
      el.actionLbl.textContent = act.label;
      // Anneau : conic-gradient piloté par --p, pas de canvas ni de SVG.
      el.actionRing.style.setProperty('--p', act.pct ?? 0);
      el.actionRing.style.visibility = act.pct ? '' : 'hidden';
    }

    // Bannière ATTAQUE / DÉFENSE : une seule fois par round.
    if (rm.round !== this.flashFor && rm.phase === 'buy') {
      this.flashFor = rm.round;
      const atk = my === rm.attackers;
      el.flash.textContent = atk ? 'ATTAQUE' : 'DÉFENSE';
      el.flash.className = atk ? 'atk' : 'def';
      el.flash.style.animation = 'none';
      void el.flash.offsetWidth; // force le redémarrage de l'animation
      el.flash.style.animation = '';
    }

    // bannières de fin de round / de match
    if (rm.phase === 'match') {
      el.banner.textContent = '';
      this.showEnd();
    } else if (rm.phase === 'end') {
      el.banner.textContent = `${rm.roundWinner === my ? 'ROUND GAGNÉ' : 'ROUND PERDU'} — ${rm.reason}`;
    } else el.banner.textContent = '';

    el.dead.classList.toggle('on', !playerActor.alive && rm.phase === 'live');
    el.spec.textContent = s.spectating ? `VOUS OBSERVEZ ${s.spectating.name.toUpperCase()}  ·  ← → CHANGER` : '';

    this.dmg.update(s.dt, s.dir, playerActor.pos, spike);
    this.board.update(s.time);
  }

  // Écran de fin : score, MVP (meilleur au score), relance d'une recherche.
  showEnd() {
    if (this.matchShown) return;
    this.matchShown = true;
    const { rm, actors, playerActor } = this.d;
    const my = playerActor.team;
    const mvp = actors.reduce((m, a) => ((a.matchKills ?? 0) > (m.matchKills ?? 0) ? a : m));
    this.el.end.classList.add('on');
    this.el.end.innerHTML = `
      <h1>${rm.winner === my ? 'VICTOIRE' : 'DÉFAITE'}</h1>
      <div class="sc">${rm.score[my]} — ${rm.score[1 - my]}</div>
      <div class="mvp">MVP · ${mvp.name} (${mvp.matchKills ?? 0} kills)</div>
      <button>RELANCER UNE RECHERCHE</button>`;
    this.el.end.querySelector('button').addEventListener('click', () => location.reload());
    // Même règle que BuyMenu#show : toute UI qui prend le curseur pose `input.menu`,
    // sinon le listener de clic global d'input.js redemande le pointer lock à chaque
    // clic — y compris sur le bouton de cet écran, et la caméra reprend la souris.
    this.d.input.menu = true;
    if (document.pointerLockElement) document.exitPointerLock();
  }
}
