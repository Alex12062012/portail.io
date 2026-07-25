/**
 * smoke-valorant.mjs — smoke navigateur du jeu Valorant-like.
 * Charge la page via le vrai serveur du portail, joue les 4 capacités des 4
 * agents, vérifie l'achat, le cycle du spike et la fin de round. Échoue à la
 * moindre erreur console. C'est le seul filet sur la partie Three
 * (effects.js, main.js) — js/selftest.js ne couvre que la logique pure.
 *
 *   node tests/smoke-valorant.mjs            vérifie
 *   node tests/smoke-valorant.mjs shot.png   vérifie + capture une image
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3214;
const BASE = `http://localhost:${PORT}`;
// team=0 : le camp du joueur est tiré au sort à chaque partie depuis le prompt 16.
// Ce parcours suppose un camp fixe — poser le spike au round 1 suppose d'attaquer,
// et les vérifications d'ELO nomment l'équipe perdante. Le tirage lui-même et le
// jeu depuis l'équipe rouge sont couverts plus bas et par smoke-valorant-1v3.
const url = `${BASE}/games/valorant/?test&team=0`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = spawn(process.execPath, ['server/server.js', '--no-tunnel'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore'
});
const cleanup = () => { try { server.kill(); } catch {} };
process.on('exit', cleanup);

for (let i = 0; ; i++) {
  try { if ((await fetch(BASE + '/')).ok) break; } catch {}
  if (i >= 50) throw new Error('serveur injoignable');
  await sleep(200);
}

// Les clics de menu passent par le DOM. L'input synthétique de Playwright n'atteint
// pas cette page une fois la boucle rAF/WebGL lancée (l'élément est pourtant visible,
// activé, stable, et elementFromPoint le renvoie bien) — vérifié, ce n'est pas un
// défaut du menu : el.click() déclenche le bon handler et débite les crédits.
const domClick = (page, sel) => page.evaluate((s) => document.querySelector(s).click(), sel);

const browser = await chromium.launch();
const errors = [];
let n = 0;
const ok = (cond, msg) => { n++; if (!cond) errors.push('ÉCHEC — ' + msg); };

// Une map différente par agent : les 3 maps du prompt 5 sont couvertes.
const MAP_FOR = { jett: 'nexus', sova: 'vault', brimstone: 'ridge', sage: 'nexus' };

for (const agent of ['jett', 'sova', 'brimstone', 'sage']) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`${agent} : ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${agent} console : ${m.text()}`); });
  // DIAGNOSTIC (prompt 11) — retiré une fois la cause connue.
  if (process.env.VAL_DEBUG) {
    page.on('crash', () => console.error(`[${agent}] PAGE CRASHED`));
    page.on('console', (m) => console.log(`[${agent}] console(${m.type()}):`, m.text()));
    page.on('pageerror', (e) => console.error(`[${agent}] pageerror:`, e.message, e.stack));
  }

  await page.goto(url);
  await page.click(`#mappick button[data-map="${MAP_FOR[agent]}"]`);
  await page.click(`#pick button[data-key="${agent}"]`);

  // Matchmaking : l'écran de recherche s'affiche (raccourci à ~1 s en mode test).
  await page.waitForSelector('#search');
  ok((await page.evaluate(() => document.getElementById('search').textContent)).includes('RECHERCHE'),
     `${agent} : écran « Recherche d'une partie » affiché`);

  await page.waitForSelector('canvas');

  // Pas de pointer lock en headless : on l'annonce à la main, sinon les clics sont ignorés.
  await page.evaluate(() => { window.input.locked = true; window.loadout.addUlt(10); });

  // --- Buy phase ---
  await page.waitForSelector('#buy.on');
  const before = await page.evaluate(() => window.playerActor.wallet.credits);
  ok(before === 2400, `${agent} : ${before} crédits au round 1`);
  await domClick(page, '#buy button[data-key="spectre"]');
  await domClick(page, '#buy button[data-key="light"]');
  const after = await page.evaluate(() => ({
    cr: window.playerActor.wallet.credits,
    gun: window.arsenal.slots[0],
    shield: window.playerActor.shield,
  }));
  ok(after.cr === 2400 - 1600 - 400, `${agent} : crédits débités (${after.cr})`);
  ok(after.gun === 'spectre', `${agent} : Spectre équipée en principale`);
  ok(after.shield === 25, `${agent} : Light Shield porté`);
  await domClick(page, '#buy button[data-kind="ready"]');
  ok(!(await page.evaluate(() => window.buy.open)), `${agent} : PRÊT ferme le buy menu`);

  // Bug 9.1 : PRÊT ne doit PAS démarrer le round tant que les bots achètent —
  // sinon on tire sur des bots immobiles (leur IA n'est appelée que `rm.live`).
  await page.waitForTimeout(80);
  const early = await page.evaluate(() => ({
    ready: window.playerActor.ready,
    phase: window.rm.phase,
    locked: window.arsenal.locked,
    botsReady: window.actors.filter((a) => a.ready).length,
  }));
  ok(early.ready === true, `${agent} : PRÊT marque le joueur prêt`);
  ok(early.phase === 'buy', `${agent} : le round attend les bots (phase ${early.phase})`);
  ok(early.locked === true, `${agent} : arme verrouillée avant le début du round`);
  ok(early.botsReady === 1, `${agent} : seul le joueur est prêt pour l'instant`);

  // Fin de la buy phase : le round passe en live. Personne n'est tuable pendant le
  // test — les bots se descendent entre eux en quelques secondes et termineraient le
  // round au milieu des vérifications. Le combat, c'est le sujet du prompt 6.
  await page.evaluate(() => {
    window.rm.timer = 0.001;
    window.actors.forEach((a) => { a.hp = 1e4; a.maxHp = 1e4; });
  });
  await page.waitForTimeout(120);
  ok(await page.evaluate(() => window.rm.live), `${agent} : le round est lancé`);

  for (const key of ['KeyC', 'KeyQ', 'KeyE', 'KeyX']) {
    await page.evaluate((code) => {
      const fire = (t, init) => dispatchEvent(new (t === 'k' ? KeyboardEvent : MouseEvent)(init.type, init));
      fire('k', { type: 'keydown', code });
      fire('k', { type: 'keyup', code });
    }, key);
    // Une frame pour que Loadout consomme l'appui, puis le clic qui lance l'effet.
    await page.waitForTimeout(60);
    await page.evaluate(() => {
      dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
      dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    });
    await page.waitForTimeout(120);
  }

  await page.waitForTimeout(400);
  const state = await page.evaluate(() => ({
    badge: document.body.textContent.includes('selftest'),
    abil: document.getElementById('abil').textContent,
    used: window.loadout.state.some((s, i) => s.charges < (window.loadout.agent.abilities[i].charges ?? 0))
          || window.loadout.ultWeapon || window.loadout.ult === 0,
    frames: window.effects.time,
  }));

  ok(state.badge, `${agent} : selftest de logique passé dans le navigateur`);
  ok(state.frames > 0.3, `${agent} : la boucle de rendu tourne (${state.frames.toFixed(2)}s)`);
  ok(state.abil.includes('ULT') || state.abil.length > 10, `${agent} : barre de capacités affichée`);
  ok(state.used, `${agent} : au moins une capacité a réellement été consommée`);

  // Vault : traverser un pad téléporte vers la sortie liée, à l'autre bout.
  if (agent === 'sova') {
    const exit = await page.evaluate(() => {
      const t = window.map.teleports[0];
      Object.assign(window.player.pos, {
        x: (t.zone.min.x + t.zone.max.x) / 2, y: 0, z: (t.zone.min.z + t.zone.max.z) / 2,
      });
      return t.exit;
    });
    await page.waitForTimeout(150);
    const pos = await page.evaluate(() => ({ ...window.player.pos }));
    ok(Math.hypot(pos.x - exit.x, pos.z - exit.z) < 2,
       `vault : téléporteur emprunté (arrivée ${pos.x.toFixed(1)},${pos.z.toFixed(1)})`);
  }

  // Prompt 10 : rôles distincts, tracers, indicateur de dégâts, bannière de round.
  const roles = await page.evaluate(() => {
    const by = {};
    for (const b of window.bots) (by[b.a.team] ??= []).push(b.role);
    return by;
  });
  for (const [team, list] of Object.entries(roles)) {
    ok(new Set(list).size === list.length, `équipe ${team} : rôles distincts (${list.join(', ')})`);
  }

  ok((await page.evaluate(() => document.getElementById('roundflash').textContent)).match(/ATTAQUE|DÉFENSE/),
     `${agent} : bannière de camp affichée en début de round`);

  // L'annonce doit être énorme (20-25 % de la hauteur), centrée, blanche sur ombre
  // noire, et durer exactement 2 s. `animation-fill-mode: both` garantit qu'elle
  // reste à opacity 0 ensuite — la disparition est vérifiée plus bas (agent jett).
  const flash = await page.evaluate(() => {
    const el = document.getElementById('roundflash');
    const cs = getComputedStyle(el);
    const rg = document.createRange();
    rg.selectNodeContents(el);
    const r = rg.getBoundingClientRect(); // emprise réelle du texte, pas du calque
    return {
      ratio: parseFloat(cs.fontSize) / innerHeight,
      color: cs.color, shadow: cs.textShadow,
      duration: cs.animationDuration, fill: cs.animationFillMode,
      dx: Math.abs((r.left + r.right) / 2 - innerWidth / 2),
      dy: Math.abs((r.top + r.bottom) / 2 - innerHeight / 2),
      overflow: r.width > innerWidth,
    };
  });
  ok(flash.ratio >= 0.18 && flash.ratio <= 0.26,
     `${agent} : annonce de camp à ${(flash.ratio * 100).toFixed(0)} % de la hauteur d'écran`);
  ok(flash.color === 'rgb(255, 255, 255)', `${agent} : annonce de camp en blanc (${flash.color})`);
  ok(/rgb\(0, 0, 0\)/.test(flash.shadow), `${agent} : annonce de camp avec ombre portée noire`);
  ok(flash.duration === '2s' && flash.fill === 'both',
     `${agent} : annonce de camp affichée 2 s puis effacée (${flash.duration}/${flash.fill})`);
  ok(flash.dx < 3 && flash.dy < 3,
     `${agent} : annonce de camp centrée (${flash.dx.toFixed(0)},${flash.dy.toFixed(0)} px du centre)`);
  ok(!flash.overflow, `${agent} : annonce de camp contenue dans la largeur d'écran`);

  // Remise à plat avant les tests de tir : une capacité en main ou un drone en vol
  // laissent `arsenal.locked` à true, et l'Orbital Strike de Brimstone blesse encore.
  await page.evaluate(() => {
    window.loadout.equipped = -1;
    window.loadout.ultWeapon = false;
    if (window.effects.drone) window.effects.killDrone();
    window.effects.zones.forEach((z) => { z.life = 0; });
    window.arsenal.index = -1;
    window.arsenal.reset('classic');
    window.arsenal.equip(1);
  });
  await page.waitForTimeout(120);
  ok(!(await page.evaluate(() => window.arsenal.locked)), `${agent} : arme déverrouillée en jeu`);

  // Tracer : on COMPTE les créations au lieu d'observer l'état instantané. Le fade
  // ne dure que 60 ms et `dt` plafonne à 50 ms en headless : échantillonner frame
  // par frame rate la fenêtre une fois sur trois (constaté).
  const tracers = await page.evaluate(async () => {
    const lines = () => window.effects.pending.filter((f) => f.mesh.isLine).length;
    let made = 0;
    const fade = window.effects.fade.bind(window.effects);
    window.effects.fade = (mesh, s, onEnd) => { if (mesh.isLine) made++; return fade(mesh, s, onEnd); };

    // État de départ garanti : un clic resté en file depuis la boucle des capacités
    // retombe sur l'arme dès que `loadout.equipped` repasse à -1 et tire une balle,
    // ce qui laisse le pistolet en cooldown (0.148 s) pile au moment du test.
    window.input.consumeClick(0);
    window.arsenal.cooldown = 0;
    window.arsenal.reloading = 0;
    const mag0 = window.arsenal.clip.mag;

    dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    await new Promise((r) => setTimeout(r, 300));
    window.effects.fade = fade;
    return { made, after: lines(), spent: mag0 - window.arsenal.clip.mag };
  });
  ok(tracers.spent === 1, `${agent} : le clic a bien tiré une balle (${tracers.spent})`);
  ok(tracers.made > 0, `${agent} : tracer dessiné au tir`);
  ok(tracers.after === 0, `${agent} : tracer nettoyé après le fade`);

  // Indicateur de dégâts : uniquement sur des dégâts réels subis par le joueur.
  const dmg = await page.evaluate(async () => {
    document.querySelectorAll('#dmgring .hitdir').forEach((e) => e.remove());
    const foe = window.actors.find((a) => a.team !== window.playerActor.team && a.alive);
    window.effects.hurt(window.playerActor, 5, foe, 'test');
    await new Promise((r) => setTimeout(r, 80));
    const shown = document.querySelectorAll('#dmgring .hitdir').length;
    await new Promise((r) => setTimeout(r, 1800));
    return { shown, gone: document.querySelectorAll('#dmgring .hitdir').length };
  });
  ok(dmg.shown === 1, `${agent} : indicateur directionnel affiché aux dégâts reçus`);
  ok(dmg.gone === 0, `${agent} : indicateur retiré du DOM après son délai`);

  // La minimap suit la position du joueur.
  const mini = await page.evaluate(() => ({
    marker: { ...window.minimap.marker.position },
    player: { ...window.player.pos },
    ortho: window.minimap.cam.isOrthographicCamera,
  }));
  ok(mini.ortho, `${agent} : caméra minimap orthographique`);
  ok(Math.hypot(mini.marker.x - mini.player.x, mini.marker.z - mini.player.z) < 0.5,
     `${agent} : le marqueur minimap suit le joueur`);

  // Un seul agent joue le cycle spike complet : 4 s de pose, c'est du temps réel.
  if (agent === 'jett') {
    await page.evaluate(() => {
      const s = window.map.sites[0]; // centre du site A de la map active
      Object.assign(window.player.pos, { x: (s.min.x + s.max.x) / 2, y: 0, z: (s.min.z + s.max.z) / 2 });
      dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF' }));
    });
    await page.waitForTimeout(4600);
    ok(await page.evaluate(() => window.spike.planted), 'spike posé après 4 s sur le site');
    ok(await page.evaluate(() => window.indicators.spikeDot.visible), 'triangle du spike sur la minimap');

    // Bien au-delà des 2 s : l'annonce de camp ne doit plus rien afficher.
    ok(await page.evaluate(() => +getComputedStyle(document.getElementById('roundflash')).opacity) === 0,
       'annonce de camp effacée une fois ses 2 s écoulées');

    // Scoreboard : visible tant que Tab est maintenu, 6 lignes de joueurs.
    await page.evaluate(() => dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab' })));
    await page.waitForTimeout(300); // le scoreboard ne se reconstruit que 4 fois/s
    const board = await page.evaluate(() => ({
      on: document.getElementById('board').classList.contains('on'),
      rows: document.querySelectorAll('#board tr:not(.gap)').length,
      // Le pseudo porte la couleur de SON équipe, quel que soit le camp du joueur.
      names: [...document.querySelectorAll('#board td.nm')].map((td) => ({
        team: td.classList.contains('b0') ? 0 : 1, color: getComputedStyle(td).color,
      })),
    }));
    ok(board.on && board.rows === 7, `scoreboard au Tab : 6 joueurs + entête (${board.rows} lignes)`);
    ok(board.names.length === 6, `scoreboard : 6 pseudos rendus (${board.names.length})`);
    ok(board.names.filter((x) => x.team === 0).length === 3
       && board.names.every((x) => x.color === (x.team === 0 ? 'rgb(74, 163, 255)' : 'rgb(255, 77, 77)')),
       `scoreboard : pseudos bleus pour l'équipe 0, rouges pour l'équipe 1 (${board.names.map((x) => x.color).join(' ')})`);
    await page.evaluate(() => dispatchEvent(new KeyboardEvent('keyup', { code: 'Tab' })));
    await page.waitForTimeout(60);
    ok(!(await page.evaluate(() => document.getElementById('board').classList.contains('on'))),
       'scoreboard caché quand Tab est relâché');

    // HUD structuré : vie, munitions, étiquette d'allié projetée à l'écran.
    const hudBits = await page.evaluate(() => ({
      hp: document.querySelector('#hpbox .hp').textContent,
      mag: document.querySelector('#ammo .mag').textContent,
      clock: document.querySelector('#topbar .clock').className,
      allyTags: [...document.querySelectorAll('#labels .tag:not(.enemy)')].length,
    }));
    ok(+hudBits.hp > 0, `barre de vie affichée (${hudBits.hp} pv)`);
    ok(hudBits.mag !== '—', `munitions affichées (${hudBits.mag})`);
    ok(hudBits.clock.includes('spike'), 'timer en mode mèche après la pose');
    ok(hudBits.allyTags === 2, 'étiquettes nom+vie pour les 2 alliés');

    if (process.argv[2]) await page.screenshot({ path: process.argv[2] });

    // Mèche accélérée : on veut vérifier la fin de round, pas attendre 45 s.
    await page.evaluate(() => { window.spike.fuse = 0.05; });
    await page.waitForTimeout(400);
    const end = await page.evaluate(() => ({
      phase: window.rm.phase, score: window.rm.score.slice(),
      reason: window.rm.reason, banner: document.getElementById('banner').textContent,
      credits: window.playerActor.wallet.credits,
    }));
    ok(end.phase === 'end', `explosion : le round se termine (${end.reason})`);
    ok(end.score[0] === 1, 'le round va aux attaquants');
    ok(end.banner.includes('ROUND GAGNÉ'), `bannière de fin affichée : « ${end.banner} »`);
    ok(await page.evaluate(() => document.querySelectorAll('#feed .row').length > 0),
       'killfeed : les morts de l’explosion sont listées');
    // 400 restants + 3000 de victoire + 300 de pose.
    ok(end.credits === 3700, `gains de fin de round corrects (${end.credits} cr)`);

    // Round suivant : nouvelle buy phase et camps inversés.
    await page.evaluate(() => { window.rm.timer = 0.001; });
    await page.waitForTimeout(200);
    const next = await page.evaluate(() => ({ round: window.rm.round, atk: window.rm.attackers, buy: window.buy.open }));
    ok(next.round === 2 && next.atk === 1, 'round 2 : les camps ont tourné');
    ok(next.buy, 'round 2 : le buy menu se rouvre');

    // Matchmaking + ELO adaptatif : 3v3, et les bots perdants du round 1 sont montés.
    const mm = await page.evaluate(() => ({
      n: window.actors.length,
      t0: window.actors.filter((a) => a.team === 0).length,
      elos: window.bots.map((b) => ({ team: b.a.team, elo: b.elo })),
      armed: window.bots.every((b) => !!b.weapon),
    }));
    ok(mm.n === 6 && mm.t0 === 3, `3v3 : ${mm.t0} contre ${mm.n - mm.t0}`);
    ok(mm.armed, 'tous les bots ont acheté une arme');
    ok(mm.elos.filter((b) => b.team === 1).every((b) => b.elo > 1000 && b.elo < 1100),
       'bots perdants montés en ELO après le round perdu');
    ok(mm.elos.filter((b) => b.team === 0).every((b) => b.elo === 1000),
       'bots gagnants restés au niveau moyen global');

    // Prompt 13 : le joueur occupe le premier siège de son équipe.
    await page.evaluate(() => { window.rm.timer = 0.001; });
    await page.waitForTimeout(150);
    const seats = await page.evaluate(() => ({
      me: window.playerActor.role,
      atk: window.playerActor.team === window.rm.attackers,
      mates: window.bots.filter((b) => b.a.team === window.playerActor.team).map((b) => b.role),
    }));
    ok(seats.me === (seats.atk ? 'entry' : 'anchor'), `le joueur tient le 1er rôle (${seats.me})`);
    ok(!seats.mates.includes(seats.me), `aucun bot allié ne double son rôle (${seats.mates.join(', ')})`);

    // Bug 9.3 + prompt 13 : la mort passe par le circuit de dégâts, donc par kill()
    // — c'est lui qui déclenche la succession. Puis on observe un allié vivant.
    await page.evaluate(() => {
      window.actors.forEach((a) => { a.hp = 1e4; a.maxHp = 1e4; });
      const me = window.playerActor;
      me.hp = 50; me.shield = 0;
      const foe = window.actors.find((a) => a.team !== me.team && a.alive);
      window.effects.hurt(me, 999, foe, 'test');
    });
    await page.waitForTimeout(200);
    const heir = await page.evaluate(() => ({
      dead: !window.playerActor.alive,
      mates: window.bots.filter((b) => b.a.team === window.playerActor.team && b.a.alive).map((b) => b.role),
    }));
    ok(heir.dead, 'le joueur meurt bien par le point d’entrée des dégâts');
    ok(heir.mates.includes(seats.me),
       `un bot allié reprend le rôle vacant (${heir.mates.join(', ')})`);
    const spec = await page.evaluate(() => {
      const txt = document.querySelector('#dead em').textContent;
      const tgt = window.actors.find((a) => txt.includes(a.name.toUpperCase()));
      const c = window.camera.position;
      return {
        txt,
        cam: { x: c.x, y: c.y, z: c.z },
        tgt: tgt && { name: tgt.name, x: tgt.pos.x, y: tgt.pos.y, z: tgt.pos.z },
        allies: window.actors
          .filter((a) => a.team === window.playerActor.team && a.alive && a !== window.playerActor).length,
        gun: window.arsenal.locked,
      };
    });
    ok(spec.allies >= 2, `${spec.allies} alliés vivants à observer`);
    ok(spec.txt.includes('VOUS OBSERVEZ'), `nom de l’observé affiché : « ${spec.txt} »`);
    ok(spec.tgt, 'la cible observée est identifiable dans le HUD');
    // Vue 3e personne : la caméra est derrière l'observé ET nettement au-dessus de
    // lui. Comparer à la position du joueur mort ne prouverait rien — au spawn les
    // alliés sont à 1,8 m de lui.
    const dTgt = Math.hypot(spec.cam.x - spec.tgt.x, spec.cam.z - spec.tgt.z);
    ok(dTgt < 4, `caméra placée derrière ${spec.tgt.name} (${dTgt.toFixed(1)} m)`);
    ok(spec.cam.y > spec.tgt.y + 1.9,
       `caméra en surplomb, pas à hauteur d’yeux (y +${(spec.cam.y - spec.tgt.y).toFixed(2)})`);
    ok(spec.gun === true, 'tir verrouillé pendant l’observation');

    await page.evaluate(() => {
      dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight' }));
      dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowRight' }));
    });
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => document.querySelector('#dead em').textContent);
    ok(after !== spec.txt, `→ change de cible observée (« ${after} »)`);

    // Bug 9.2 : l'écran de fin de match ne doit pas reprendre la souris.
    await page.evaluate(() => {
      const t = window.playerActor.team;
      window.rm.score[t] = window.ROUNDS_TO_WIN - 1;
      window.rm.end(t, 'test');
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.body.click());
    await page.waitForTimeout(150);
    const fin = await page.evaluate(() => ({
      on: document.getElementById('endscreen').classList.contains('on'),
      menu: window.input.menu,
      locked: document.pointerLockElement !== null,
    }));
    ok(fin.on, 'écran de fin de match affiché');
    ok(fin.menu === true, 'input.menu posé : plus de recapture auto du pointer lock');
    ok(!fin.locked, 'un clic sur l’écran de fin ne rend pas la souris à la caméra');

    // Le classement de fin mélange les deux équipes : le pseudo doit y porter la
    // couleur de son équipe, comme dans le scoreboard. La surcharge verte de la
    // ligne du joueur (tr.me) est héritée, elle ne doit pas gagner sur la cellule.
    const endNames = await page.evaluate(() => [...document.querySelectorAll('#endscreen td.nm')]
      .map((td) => ({ team: td.classList.contains('b0') ? 0 : 1, color: getComputedStyle(td).color })));
    ok(endNames.length === 6, `écran de fin : 6 pseudos rendus (${endNames.length})`);
    ok(endNames.filter((x) => x.team === 0).length === 3, 'écran de fin : 3 pseudos par équipe');
    ok(endNames.every((x) => x.color === (x.team === 0 ? 'rgb(74, 163, 255)' : 'rgb(255, 77, 77)')),
       `écran de fin : pseudos bleus (t0) et rouges (t1) (${endNames.map((x) => x.color).join(' ')})`);
  }
  await page.close();
}

// --- Le joueur peut démarrer dans l'équipe rouge (prompt 16) ---------------------
// Camp forcé à 1 : rien dans le jeu ne doit supposer que le joueur est en équipe 0,
// et les pseudos doivent suivre l'équipe RÉELLE et non le camp relatif au joueur —
// c'est ici que la distinction se voit, les 3 alliés étant en t1 et non en t0.
{
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`team=1 : ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`team=1 console : ${m.text()}`); });

  await page.goto(`${BASE}/games/valorant/?test&team=1`);
  await page.click('#mappick button[data-map="nexus"]');
  await page.click('#pick button[data-key="jett"]');
  await page.waitForSelector('canvas');
  await page.evaluate(() => { window.input.locked = true; });
  await page.waitForSelector('#buy.on');
  // Round lancé, personne de tuable : mêmes précautions que la boucle principale.
  await page.evaluate(() => {
    window.rm.timer = 0.001;
    window.actors.forEach((a) => { a.hp = 1e4; a.maxHp = 1e4; });
  });
  await page.waitForTimeout(200);

  const red = await page.evaluate(async () => {
    dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab' }));
    await new Promise((r) => setTimeout(r, 400)); // le scoreboard se reconstruit 4x/s
    const cells = [...document.querySelectorAll('#board td.nm')].map((td) => ({
      team: td.classList.contains('b0') ? 0 : 1, color: getComputedStyle(td).color,
    }));
    dispatchEvent(new KeyboardEvent('keyup', { code: 'Tab' }));
    return {
      myTeam: window.playerActor.team,
      mates: window.actors.filter((a) => a.team === window.playerActor.team).length,
      foes: window.actors.filter((a) => a.team !== window.playerActor.team).length,
      live: window.rm.live,
      roles: window.bots.filter((b) => b.a.team === window.playerActor.team).map((b) => b.role),
      cells,
    };
  });
  ok(red.myTeam === 1, `?team=1 : le joueur démarre en équipe rouge (${red.myTeam})`);
  ok(red.mates === 3 && red.foes === 3, `?team=1 : 3v3 conservé (${red.mates} contre ${red.foes})`);
  ok(red.live, '?team=1 : le round se lance normalement depuis l’équipe rouge');
  ok(new Set(red.roles).size === 2, `?team=1 : rôles distincts chez les 2 bots alliés (${red.roles.join(', ')})`);
  ok(red.cells.filter((c) => c.team === 0).length === 3,
     `?team=1 : 3 pseudos marqués équipe 0 (${red.cells.filter((c) => c.team === 0).length})`);
  ok(red.cells.every((c) => c.color === (c.team === 0 ? 'rgb(74, 163, 255)' : 'rgb(255, 77, 77)')),
     `?team=1 : couleur par équipe réelle et non relative au joueur (${red.cells.map((c) => c.color).join(' ')})`);
  await page.close();
}

await browser.close();
cleanup(); // sinon le serveur enfant garde la boucle d'événements vivante et rien ne rend la main

if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`smoke-valorant : ${n} vérifications OK sur les 4 agents`);
process.exit(0);
