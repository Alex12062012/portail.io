/**
 * portal.js — page d'accueil : gestion du pseudo (localStorage) + cartes de jeu.
 * Le pseudo est lu par les pages de jeu via localStorage('portail.name').
 */
const NAME_KEY = 'portail.name';

// Migration lexo.name → portail.name (une seule fois, silencieuse)
if (!localStorage.getItem('portail.name') && localStorage.getItem('lexo.name')) {
  localStorage.setItem('portail.name', localStorage.getItem('lexo.name'));
  localStorage.removeItem('lexo.name');
}

const $ = id => document.getElementById(id);
const modal = $('nameModal');
const input = $('nameInput');
const errEl = $('nameError');

function storedName() {
  const n = (localStorage.getItem(NAME_KEY) || '').trim();
  return n.length >= 2 && n.length <= 16 ? n : null;
}

function openModal() {
  input.value = storedName() || '';
  errEl.textContent = '';
  modal.hidden = false;
  setTimeout(() => input.focus(), 50);
}

function submitName() {
  const n = input.value.trim();
  if (n.length < 2 || n.length > 16) {
    errEl.textContent = 'Le pseudo doit faire entre 2 et 16 caractères.';
    return;
  }
  localStorage.setItem(NAME_KEY, n);
  $('userName').textContent = n;
  modal.hidden = true;
}

$('nameOk').addEventListener('click', submitName);
input.addEventListener('keydown', e => { if (e.key === 'Enter') submitName(); });
$('editName').addEventListener('click', openModal);

// garde-fou : pas de pseudo valide → on bloque l'accès au jeu
function guardCard(id) {
  const el = $(id);
  if (!el) return;
  el.addEventListener('click', e => {
    if (!storedName()) {
      e.preventDefault();
      openModal();
    }
  });
}
guardCard('cardTag');
guardCard('cardMine');

const name = storedName();
if (name) $('userName').textContent = name;
else openModal();
