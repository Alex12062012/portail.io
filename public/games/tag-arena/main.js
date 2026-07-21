/**
 * main.js — client du jeu Tag Arena.
 * - écrans : menu (modes) → lobby (amis) → jeu → fin
 * - le joueur local est simulé ici (physique partagée) et envoie sa position
 *   ~25 fois/s ; le serveur est autoritaire sur le "it", les timers, les
 *   explosions (mode élimination) et la fin de manche
 * - les autres joueurs (humains + bots) sont interpolés depuis tag:state
 * - la carte de la manche est reçue dans game:start (mapId) parmi MAPS
 */
import { MAPS, PHYS, TAG } from '/shared/tag-map.js';
import { createPhysState, stepPlayer } from '/shared/tag-physics.js';
import { createDebugHud } from '/shared/debug-hud.js';
import { createRenderer } from '/games/tag-arena/render.js';
import { createAudioManager } from '/games/tag-arena/audio.js';

const GAME_TYPE = 'tag-arena';
// Migration lexo.tag.muted → portail.tag.muted (une seule fois, avant que
// createAudioManager() ne lise la clé plus bas)
if (!localStorage.getItem('portail.tag.muted') && localStorage.getItem('lexo.tag.muted')) {
  localStorage.setItem('portail.tag.muted', localStorage.getItem('lexo.tag.muted'));
  localStorage.removeItem('lexo.tag.muted');
}
const name = (localStorage.getItem('portail.name') || '').trim();
if (name.length < 2 || name.length > 16) location.replace('/');

const socket = io();
const hud = createDebugHud(socket);
const $ = id => document.getElementById(id);
const renderer = createRenderer($('game'));
const audio = createAudioManager();
const btnMute = $('btnMute');
function syncMuteBtn() { btnMute.textContent = audio.isMuted() ? '🔇' : '🔊'; }
syncMuteBtn();
btnMute.onclick = () => { audio.setMuted(!audio.isMuted()); syncMuteBtn(); };

// ---------------------------------------------------------------- écrans
const screens = { menu: $('screenMenu'), lobby: $('screenLobby'), game: $('screenGame') };
function show(which) {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== which;
  if (which === 'game') hud.show(); else hud.hide();
}

// --- DEV ONLY : aperçu statique d'une carte pour les captures de comparaison
// (scripts/map-compare.mjs). Activé par ?debugMap=<id> UNIQUEMENT en local
// (localhost / 127.0.0.1), jamais en production. Affiche la carte en vue
// d'ensemble dézoomée, sans réseau ni joueurs, pour comparer l'agencement du
// décor jouable aux captures de référence.
const debugMapId = new URLSearchParams(location.search).get('debugMap');
if (debugMapId && ['localhost', '127.0.0.1'].includes(location.hostname)) {
  const dbgMap = MAPS.find(m => m.id === debugMapId);
  if (dbgMap) {
    renderer.setMap(dbgMap);
    show('game');
    hud.hide(); // captures de comparaison : on masque l'UI (HUD, bouton quitter)
    const quitBtn = $('btnQuitPlaying');
    if (quitBtn) quitBtn.style.display = 'none';
    const view = { players: [], t: 0, mode: 'classic', focus: null, overview: true, noHud: true };
    window.__debugMapReady = false;
    (function drawDebug() {
      renderer.draw(view);
      window.__debugMapReady = true; // signal de "frame dessinée" pour Playwright
      requestAnimationFrame(drawDebug);
    })();
  }
}

let myRoom = null; // dernier room:update reçu
let game = null;   // état de la manche en cours

// ---------------------------------------------------------------- menu
function setMenuError(msg) { $('menuError').textContent = msg || ''; }

$('btnQuick').onclick = () => {
  setMenuError('');
  $('btnQuick').disabled = true; // anti double-clic
  socket.emit('quickplay', { gameType: GAME_TYPE, name }, res => {
    $('btnQuick').disabled = false;
    if (!res?.ok) setMenuError('Impossible de lancer une partie, réessaie.');
  });
};

$('btnCreate').onclick = () => {
  setMenuError('');
  socket.emit('room:create', { gameType: GAME_TYPE, name }, res => {
    if (res?.ok) { myRoom = res.room; renderLobby(); show('lobby'); }
    else setMenuError('Impossible de créer le salon.');
  });
};

$('btnShowJoin').onclick = () => {
  $('joinRow').hidden = false;
  $('codeInput').focus();
};

function joinByCode() {
  const code = $('codeInput').value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) return setMenuError('Le code fait 4 lettres.');
  socket.emit('room:join', { code, name }, res => {
    if (res?.ok) {
      myRoom = res.room;
      renderLobby();
      show('lobby');
      setMenuError('');
    } else {
      setMenuError({
        not_found: 'Salon introuvable. Vérifie le code !',
        full: 'Salon complet (4 joueurs max).',
        in_progress: 'La partie de ce salon a déjà commencé.'
      }[res?.error] || 'Impossible de rejoindre ce salon.');
    }
  });
}
$('btnJoin').onclick = joinByCode;
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinByCode(); });
$('codeInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });

// ---------------------------------------------------------------- lobby
$('btnStart').onclick = () => socket.emit('room:start');
$('btnLeaveLobby').onclick = () => {
  socket.emit('room:leave');
  myRoom = null;
  show('menu');
};

socket.on('room:update', data => {
  myRoom = data;
  renderLobby();
});

function renderLobby() {
  if (!myRoom) return;
  $('lobbyCode').textContent = myRoom.code;
  const ul = $('lobbyPlayers');
  ul.innerHTML = '';
  for (const p of myRoom.players) {
    const li = document.createElement('li');
    li.textContent = `${p.name}${p.isHost ? ' 👑' : ''}${p.id === socket.id ? ' (toi)' : ''}`;
    if (p.id === socket.id) li.classList.add('me');
    ul.appendChild(li);
  }
  const isHost = myRoom.hostId === socket.id;
  const enough = myRoom.players.length >= 2;
  $('btnStart').hidden = !isHost;
  $('btnStart').disabled = !enough;
  $('lobbyHint').textContent = isHost
    ? (enough ? 'Tout le monde est là ? Lance la partie !' : 'En attente de joueurs… (2 minimum)')
    : "En attente du lancement par l'hôte…";
}

// ---------------------------------------------------------------- entrées
const keys = { left: false, right: false, jump: false };
let jumpQueued = false;
const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'jump', KeyW: 'jump', Space: 'jump'
};
addEventListener('keydown', e => {
  if (e.target.matches?.('input, textarea, select')) return; // saisie de code, etc.
  const k = KEYMAP[e.code];
  if (!k) return;
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  if (k === 'jump' && !keys.jump) jumpQueued = true;
  keys[k] = true;
});
addEventListener('keyup', e => {
  if (e.target.matches?.('input, textarea, select')) return;
  const k = KEYMAP[e.code];
  if (k) keys[k] = false;
});

// ---------------------------------------------------------------- partie
socket.on('game:start', payload => {
  const snap = payload.snapshot;
  const map = MAPS.find(m => m.id === payload.mapId) || MAPS[0];
  const meSnap = snap.players.find(p => p.id === socket.id);
  const startDelay = Math.max(0, payload.startDelay || 0);
  game = {
    isPublic: payload.isPublic,
    map,
    mode: payload.mode,            // 'classic' (1v1, 90 s) | 'elimination' (30 s/boom)
    itId: snap.itId,
    t: snap.t,
    over: false,
    meDead: false,
    me: createPhysState(meSnap?.x ?? map.width / 2, meSnap?.y ?? map.ground.y),
    meImm: !!meSnap?.imm,
    meMeta: { name: meSnap?.name ?? name, color: meSnap?.color ?? '#4cc9f0' },
    others: new Map(), // id -> { disp:{x,y}, target:{x,y,vx,vy,f}, meta, imm, dead }
    // temps d'attente : le jeu reste figé, on affiche la carte tirée au sort
    // et le nombre de joueurs (X/4) jusqu'à ce que goAt soit atteint
    waiting: startDelay > 0,
    goAt: performance.now() + startDelay * 1000,
    bombArmed: false // mode élimination : SFX bombe pas encore joué pour ce cycle
  };
  renderer.setMap(map);
  window.__tagDebug = { mapId: map.id, mode: payload.mode }; // pour les tests
  applyState(snap);
  jumpQueued = false; // pas de saut fantôme hérité de l'écran précédent
  keys.left = keys.right = keys.jump = false;
  $('endOverlay').hidden = true;
  $('noticeOverlay').hidden = true;
  $('explodedOverlay').hidden = true;
  show('game');
  audio.startMusic();
  if (game.waiting) {
    updateLobby(); // tirage au sort de la carte + nb de joueurs (X/4)
  } else if (snap.itId === socket.id) {
    renderer.flash('TU ES LE CHAT !');
  }
});

/** Pendant l'attente : bandeau "🗺️ <carte> — X/4" (X = joueurs connus). */
function updateLobby() {
  if (!game || !game.waiting) return;
  const count = Math.min(game.others.size + 1, TAG.maxPlayers);
  // le temps restant ("Début dans Xs") est recalculé chaque frame côté render
  // à partir de goAt, transmis ici (le texte de base ne change qu'à chaque maj)
  renderer.setLobby(`🗺️ ${game.map.name} — ${count}/${TAG.maxPlayers}`, game.goAt);
}

function applyState(s) {
  if (!game) return;
  game.t = s.t;
  game.itId = s.itId;
  // SFX bombe (mode élimination) : démarre quand il reste 5 s réelles avant
  // l'explosion. Réarmé à chaque nouveau cycle : t repasse au-dessus de 5 s
  // quand le serveur recalcule le deadline après un boom (ou un tag).
  if (game.mode === 'elimination' && !game.waiting) {
    if (s.t > 5) game.bombArmed = true;
    else if (game.bombArmed) { game.bombArmed = false; audio.playBomb(); }
  }
  const seen = new Set();
  for (const p of s.players) {
    if (p.id === socket.id) {
      game.meImm = p.imm;
      game.meMeta.color = p.color;
      if (p.dead) game.meDead = true; // filet de sécurité (tag:boom fait foi)
      continue;
    }
    seen.add(p.id);
    let o = game.others.get(p.id);
    if (!o) {
      o = { disp: { x: p.x, y: p.y }, target: {}, meta: {} };
      game.others.set(p.id, o);
    }
    o.target = { x: p.x, y: p.y, vx: p.vx, vy: p.vy, f: p.f };
    o.meta = { name: p.name, color: p.color, bot: p.bot };
    o.imm = p.imm;
    o.dead = p.dead;
  }
  for (const id of [...game.others.keys()]) if (!seen.has(id)) game.others.delete(id);
  if (game.waiting) updateLobby();
}
socket.on('tag:state', applyState);

socket.on('tag:tagged', e => {
  if (!game) return;
  game.itId = e.itId;
  if (!game.waiting && e.itId === socket.id) renderer.flash('TU ES LE CHAT !');
});

socket.on('tag:fx', e => {
  if (game && e.playerId !== socket.id) {
    renderer.fx(e);
    if (e.kind === 'pad') audio.playPad();
    else if (e.kind === 'teleport') audio.playTeleport();
  }
});

// mode élimination : un joueur explose toutes les 30 s
socket.on('tag:boom', e => {
  if (!game) return;
  renderer.boom(e.x, e.y);
  if (e.playerId === socket.id) {
    game.meDead = true;
    $('explodedPlace').textContent = `${e.place}e place — il reste ${e.remaining} joueur${e.remaining > 1 ? 's' : ''}`;
    $('explodedOverlay').hidden = false;
  } else {
    renderer.flash(`${e.name} a explosé 💥`, 38);
  }
});

// EXIT : on referme l'écran d'explosion et on regarde la fin en spectateur
$('btnExit').onclick = () => { $('explodedOverlay').hidden = true; };

// Quitter la partie : on sort du salon et on revient au menu
function quitGame() {
  socket.emit('room:leave');
  myRoom = null;
  game = null;
  audio.stopMusic();
  $('explodedOverlay').hidden = true;
  show('menu');
}
$('btnQuitGame').onclick = quitGame;
$('btnQuitPlaying').onclick = quitGame;

socket.on('tag:end', e => {
  if (!game) return;
  game.over = true;
  audio.stopMusic(); // fin de manche : on coupe la musique de fond
  $('explodedOverlay').hidden = true;
  $('endRanking').hidden = true;
  if (e.aborted) {
    $('endTitle').textContent = 'Manche interrompue';
    $('endDetail').textContent = e.reason || '';
    $('btnReplay').hidden = true;
  } else if (e.mode === 'elimination') {
    const mine = e.ranking.find(r => r.id === socket.id);
    const won = e.winnerId === socket.id;
    $('endTitle').textContent = won ? '🏆 Gagné !' : `💥 ${mine ? mine.rank + 'e place' : 'Éliminé'}`;
    $('endDetail').textContent = `${e.winnerName} est le dernier survivant !`;
    const ol = $('endRanking');
    ol.innerHTML = '';
    for (const r of e.ranking) {
      const li = document.createElement('li');
      li.textContent = `${r.rank === 1 ? '🏆' : r.rank + 'ᵉ'}  ${r.bot ? '🤖 ' : ''}${r.name}${r.id === socket.id ? ' (toi)' : ''}`;
      if (r.id === socket.id) li.classList.add('me');
      ol.appendChild(li);
    }
    ol.hidden = false;
    $('btnReplay').hidden = false;
  } else {
    const lost = e.loserId === socket.id;
    $('endTitle').textContent = lost ? '💀 Perdu !' : '🏆 Gagné !';
    $('endDetail').textContent = lost
      ? "Tu étais le chat quand le temps s'est arrêté…"
      : `${e.loserName} était le chat à la fin. Bien esquivé ${game.meMeta.name} !`;
    $('btnReplay').hidden = false;
  }
  $('endOverlay').hidden = false;
});

$('btnReplay').onclick = () => {
  if (game?.isPublic) {
    // partie publique : on relance un matchmaking immédiat
    $('btnReplay').disabled = true;
    socket.emit('quickplay', { gameType: GAME_TYPE, name }, res => {
      $('btnReplay').disabled = false;
      if (!res?.ok) { game = null; show('menu'); }
    });
  } else if (myRoom && myRoom.hostId === socket.id) {
    // l'hôte relance ; si refus (plus assez de joueurs…), retour au salon
    socket.emit('room:start', res => {
      if (!res?.ok) {
        $('endOverlay').hidden = true;
        renderLobby();
        show('lobby');
      }
    });
  } else {
    show('lobby'); // les autres attendent l'hôte dans le salon
  }
};

$('btnMenu').onclick = () => {
  socket.emit('room:leave');
  myRoom = null;
  game = null;
  audio.stopMusic();
  show('menu');
};

$('btnNoticeMenu').onclick = () => {
  myRoom = null;
  game = null;
  audio.stopMusic();
  show('menu');
};

socket.on('room:closed', () => {
  if (game?.over) {
    myRoom = null;
    game = null;
    show('menu');
  }
});

socket.on('disconnect', () => {
  audio.stopMusic(); // plus de manche en cours : on coupe la musique de fond
  if (game && !game.over) {
    game.over = true;
    $('noticeTitle').textContent = '😵 Connexion au serveur perdue';
    $('noticeOverlay').hidden = false;
  } else if (myRoom) {
    // coupure dans le lobby (ou écran de fin) : le serveur nous a retirés du
    // salon — un lobby figé serait trompeur, retour au menu avec un message
    myRoom = null;
    game = null;
    show('menu');
    setMenuError('Connexion au serveur perdue — le salon a été quitté.');
  }
});

// ---------------------------------------------------------------- boucle
let lastTs = performance.now();
function frame(ts) {
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;

  if (game) {
    const work0 = performance.now();

    // fin de l'attente (tirage de carte + arrivée des autres joueurs) :
    // on dégèle la partie et on affiche le rôle ("GO !" / "TU ES LE CHAT !")
    if (game.waiting && performance.now() >= game.goAt) {
      game.waiting = false;
      renderer.setLobby(null);
      renderer.flash(game.itId === socket.id ? 'TU ES LE CHAT !' : 'GO !');
    }

    if (!game.over && !game.meDead && !game.waiting) {
      const input = {
        left: keys.left,
        right: keys.right,
        jumpPressed: jumpQueued,
        jumpHeld: keys.jump
      };
      jumpQueued = false;
      const isIt = game.itId === socket.id;
      const events = stepPlayer(game.me, input, dt, {
        map: game.map,
        speedMul: isIt ? PHYS.itSpeedMul : 1
      });
      for (const ev of events) {
        if (ev.kind === 'pad') {
          socket.emit('tag:fx', { kind: 'pad', id: ev.id });
          renderer.fx({ kind: 'pad', id: ev.id });
          audio.playPad();
        } else if (ev.kind === 'teleport') {
          socket.emit('tag:fx', { kind: 'teleport', from: ev.from, to: ev.to });
          renderer.fx({ kind: 'teleport', from: ev.from, to: ev.to });
          audio.playTeleport();
        }
      }
    }

    // interpolation douce des autres joueurs vers leur dernière position connue
    // (k élevé : suit de près la position serveur pour limiter le décalage
    // visuel qui peut donner l'impression qu'un tag "passe à travers")
    const k = 1 - Math.exp(-22 * dt);
    for (const o of game.others.values()) {
      const t = o.target;
      if (Math.abs(t.x - o.disp.x) > 260 || Math.abs(t.y - o.disp.y) > 260) {
        o.disp.x = t.x; o.disp.y = t.y; // trop loin (téléportation) : on snap
      } else {
        o.disp.x += (t.x - o.disp.x) * k;
        o.disp.y += (t.y - o.disp.y) * k;
      }
    }

    renderer.draw(buildView());
    hud.markFrame(performance.now() - work0); // → FPS moteur (non plafonné)
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// envoi de la position locale ~50 fois/seconde (réduit le décalage avec le
// serveur, qui est autoritaire sur la détection des tags)
setInterval(() => {
  if (game && !game.over && !game.meDead && !game.waiting && socket.connected) {
    socket.emit('tag:move', {
      x: game.me.x, y: game.me.y,
      vx: game.me.vx, vy: game.me.vy,
      f: game.me.f
    });
  }
}, 20);

function buildView() {
  const players = [];
  if (!game.meDead) {
    players.push({
      id: socket.id,
      x: game.me.x, y: game.me.y, f: game.me.f,
      name: game.meMeta.name, color: game.meMeta.color,
      it: game.itId === socket.id, imm: game.meImm, me: true
    });
  }
  for (const [id, o] of game.others) {
    if (o.dead) continue; // les explosés ne sont plus affichés
    players.push({
      id,
      x: o.disp.x, y: o.disp.y, f: o.target.f,
      name: o.meta.name, color: o.meta.color, bot: o.meta.bot,
      it: game.itId === id, imm: o.imm
    });
  }
  return {
    players,
    t: game.t,
    mode: game.mode,
    focus: { x: game.me.x, y: game.me.y },
    // spectateur (explosé) et fin de manche : vue d'ensemble dézoomée
    overview: game.meDead || game.over
  };
}
