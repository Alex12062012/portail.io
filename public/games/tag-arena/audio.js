/**
 * audio.js — gestion audio de Tag Arena : musique de fond (boucle) + SFX courts.
 *
 * Fichiers dans /games/tag-arena/assets/audio/ :
 *  - music-bg.mp3  (REQUIS — phonk énergique, ~94 s, joué en boucle)
 *  - bump.mp3      (SFX bounce pad)
 *  - teleport.mp3  (SFX téléporteur)
 *  - bomb.m4a      (SFX décompte d'explosion, ~8 s, joué 5 s avant le boom)
 *
 * Politique autoplay : si la lecture est refusée tant que l'utilisateur n'a pas
 * interagi, la musique démarre au tout premier geste (clic / touche / toucher).
 * Les SFX, eux, sont toujours déclenchés en cours de partie (donc après une
 * interaction) : pas besoin de logique de déblocage.
 */

const BASE = '/games/tag-arena/assets/audio/';
const MUTE_KEY = 'portail.tag.muted';

const MUSIC_VOL = 0.35; // volume musique
const SFX_VOL = 0.5;    // volume des effets courts (pad, téléporteur, bombe)

export function createAudioManager() {
  let muted = localStorage.getItem(MUTE_KEY) === '1';
  let musicShouldPlay = false; // la manche en cours veut-elle de la musique ?

  // --- musique de fond, jouée en boucle ---
  const music = new Audio(BASE + 'music-bg.mp3');
  music.loop = true;
  music.preload = 'auto';
  music.volume = MUSIC_VOL;
  music.addEventListener('error', () => {}); // ne jamais throw si le fichier manque

  // --- effets courts (SFX) : un Audio par effet, rejoué depuis le début ---
  function makeSfx(file) {
    const a = new Audio(BASE + file);
    a.preload = 'auto';
    a.volume = SFX_VOL;
    a.addEventListener('error', () => {}); // ne jamais throw si le fichier manque
    return a;
  }
  const sfxPad = makeSfx('bump.mp3');
  const sfxTeleport = makeSfx('teleport.mp3');
  const sfxBomb = makeSfx('bomb.m4a');

  function playSfx(a) {
    if (muted) return;
    try { a.currentTime = 0; } catch {}
    a.play().catch(() => {});
  }
  function playPad() { playSfx(sfxPad); }
  function playTeleport() { playSfx(sfxTeleport); }
  function playBomb() { playSfx(sfxBomb); }

  // --- déblocage autoplay : au premier geste utilisateur ---
  let unlocked = false;
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    if (musicShouldPlay && !muted) music.play().catch(() => {});
    removeEventListener('pointerdown', unlock);
    removeEventListener('keydown', unlock);
    removeEventListener('touchstart', unlock);
  }
  addEventListener('pointerdown', unlock);
  addEventListener('keydown', unlock);
  addEventListener('touchstart', unlock);

  /** Démarre (ou redémarre) la musique de fond — appelé au début du temps d'attente. */
  function startMusic() {
    musicShouldPlay = true;
    if (muted) return;
    try { music.currentTime = 0; } catch {}
    // si l'autoplay est bloqué, la lecture démarrera via unlock() au 1er geste
    music.play().catch(() => {});
  }

  /** Coupe la musique de fond — appelé à la fin de la manche / en quittant. */
  function stopMusic() {
    musicShouldPlay = false;
    music.pause();
  }

  /** Coupe / rétablit TOUT l'audio. Le choix est persisté en localStorage. */
  function setMuted(m) {
    muted = !!m;
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    if (muted) music.pause();
    else if (musicShouldPlay) music.play().catch(() => {});
    return muted;
  }
  function toggleMuted() { return setMuted(!muted); }
  function isMuted() { return muted; }

  return { startMusic, stopMusic, playPad, playTeleport, playBomb, setMuted, toggleMuted, isMuted };
}
