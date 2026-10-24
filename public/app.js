'use strict';

const COVER_STATES = {
  open: { label: 'Ouvert', cls: 'ok' },
  closed: { label: 'Fermé', cls: 'ok' },
  opening: { label: 'Ouverture…', cls: 'moving' },
  closing: { label: 'Fermeture…', cls: 'moving' },
  stopped: { label: 'Arrêté', cls: 'ok' },
  calibrating: { label: 'Calibration…', cls: 'moving' },
};
const FAST_POLL = 1000;

const roomsEl = document.getElementById('rooms');
const summaryEl = document.getElementById('summary');
const refreshBtn = document.getElementById('refresh');
const toastEl = document.getElementById('toast');

const cards = new Map(); // id -> { el, data }
const rooms = new Map(); // nom -> élément <section>
let pollInterval = 3000;
let pollTimer = null;

// ---- Accès API ---------------------------------------------------------------

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Erreur HTTP ${res.status}`);
  return body;
}

function sendAction(id, action, position) {
  return api(`/api/devices/${encodeURIComponent(id)}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, position }),
  });
}

// ---- Rendu -------------------------------------------------------------------

function clone(id) {
  return document.getElementById(id).content.firstElementChild.cloneNode(true);
}

function formatPower(watts) {
  if (typeof watts !== 'number') return '';
  return `${watts.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} W`;
}

function getRoom(name) {
  if (rooms.has(name)) return rooms.get(name);
  const section = clone('tpl-room');
  section.querySelector('.room-name').textContent = name;
  section.querySelectorAll('[data-room-action]').forEach((btn) => {
    btn.addEventListener('click', () => roomAction(name, btn.dataset.roomAction, btn));
  });
  roomsEl.append(section);
  rooms.set(name, section);
  return section;
}

function createCard(device) {
  const el = clone(device.type === 'cover' ? 'tpl-cover' : 'tpl-switch');
  el.querySelector('.name').textContent = device.name;
  const link = el.querySelector('.web-link');
  link.href = device.webUrl;

  if (device.type === 'cover') {
    const slider = el.querySelector('.slider');
    const wrap = el.querySelector('.slider-wrap');
    const value = el.querySelector('.position-value');
    const show = () => (value.textContent = `${slider.value} %`);
    const commit = async () => {
      await runAction(device.id, 'position', Number(slider.value));
      delete el.dataset.dragging;
    };

    // Clavier : comportement natif du curseur.
    slider.addEventListener('input', () => {
      el.dataset.dragging = '1';
      show();
    });
    slider.addEventListener('change', commit);

    // Souris et toucher : le curseur ne réagit qu'à un glissement horizontal, pour qu'un
    // défilement de la page commencé sur le curseur ne déplace pas le volet.
    let start = null;
    let dragging = false;
    const moveTo = (clientX) => {
      const r = slider.getBoundingClientRect();
      slider.value = Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * 100);
      show();
    };
    const begin = (e) => {
      dragging = true;
      el.dataset.dragging = '1';
      wrap.setPointerCapture(e.pointerId);
      moveTo(e.clientX);
    };
    const reset = () => {
      start = null;
      dragging = false;
    };
    wrap.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY };
      if (e.pointerType === 'mouse') begin(e);
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!start) return;
      if (dragging) return moveTo(e.clientX);
      const dx = Math.abs(e.clientX - start.x);
      const dy = Math.abs(e.clientY - start.y);
      if (dx > 8 && dx > dy) begin(e);
      else if (dy > 8) reset(); // défilement vertical : on laisse faire la page
    });
    wrap.addEventListener('pointerup', () => {
      const wasDragging = dragging;
      reset();
      if (wasDragging) commit();
    });
    wrap.addEventListener('pointercancel', () => {
      if (dragging) {
        delete el.dataset.dragging;
        updateCard(cards.get(device.id).data); // rétablit la position réelle
      }
      reset();
    });
  }

  el.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => runAction(device.id, btn.dataset.action));
  });

  getRoom(device.room).querySelector('.grid').append(el);
  return el;
}

function updateCard(device) {
  let entry = cards.get(device.id);
  if (!entry) {
    entry = { el: createCard(device) };
    cards.set(device.id, entry);
  }
  entry.data = device;
  const { el } = entry;
  const badge = el.querySelector('.badge');
  const meta = el.querySelector('.meta');

  el.classList.toggle('offline', !device.online);
  meta.classList.toggle('err', !device.online);

  if (!device.online) {
    badge.className = 'badge err';
    badge.textContent = 'Hors ligne';
    meta.textContent = `${device.host} — ${device.error}`;
    return;
  }

  const s = device.status;
  if (device.type === 'cover') {
    const state = COVER_STATES[s.state] || { label: s.state, cls: '' };
    badge.className = `badge ${state.cls}`;
    badge.textContent = state.label;

    const slider = el.querySelector('.slider');
    const hint = el.querySelector('.hint');
    const calibrated = s.positionControl && s.position !== null;
    el.querySelector('.slider-wrap').hidden = !calibrated;
    hint.hidden = calibrated;

    if (!el.dataset.dragging) {
      // Sans calibration, on déduit un état visuel approximatif.
      const pos = calibrated ? s.position : s.state === 'closed' ? 0 : s.state === 'open' ? 100 : null;
      el.querySelector('.position-value').textContent = pos === null ? '–' : `${pos} %`;
      el.querySelector('.shutter').style.height = `${pos === null ? 50 : 100 - pos}%`;
      if (calibrated) slider.value = s.position;
    }

    el.querySelector('[data-action="open"]').classList.toggle('active', s.state === 'opening');
    el.querySelector('[data-action="close"]').classList.toggle('active', s.state === 'closing');

    const parts = [];
    if (s.power) parts.push(formatPower(s.power));
    if (s.targetPosition !== null && s.state !== 'stopped' && COVER_STATES[s.state]?.cls === 'moving') {
      parts.push(`vers ${s.targetPosition} %`);
    }
    meta.textContent = parts.join(' · ');
  } else {
    badge.className = `badge ${s.on ? 'on' : ''}`;
    badge.textContent = s.on ? 'Allumé' : 'Éteint';
    const btn = el.querySelector('.power');
    btn.setAttribute('aria-pressed', String(s.on));
    btn.querySelector('.power-label').textContent = s.on ? 'Éteindre' : 'Allumer';
    meta.textContent = s.on && s.power !== null ? `Consommation : ${formatPower(s.power)}` : '';
  }
}

function updateRoomActions() {
  for (const [name, section] of rooms) {
    const covers = [...cards.values()].filter((c) => c.data.room === name && c.data.type === 'cover');
    section.querySelector('.room-actions').hidden = covers.length < 2;
  }
  document.getElementById('house-actions').hidden = ![...cards.values()].some((c) => c.data.type === 'cover');
}

function updateSummary(devices) {
  const online = devices.filter((d) => d.online);
  const covers = online.filter((d) => d.type === 'cover');
  const openCovers = covers.filter((d) => d.status.state !== 'closed' && d.status.position !== 0);
  const lightsOn = online.filter((d) => d.type === 'switch' && d.status.on);
  const parts = [];
  if (covers.length) parts.push(`${openCovers.length}/${covers.length} volet(s) ouvert(s)`);
  parts.push(`${lightsOn.length} lumière(s) allumée(s)`);
  if (online.length < devices.length) parts.push(`${devices.length - online.length} hors ligne`);
  summaryEl.textContent = parts.join(' · ');
}

function render(devices) {
  if (devices.length === 0) {
    roomsEl.innerHTML = '<p class="empty">Aucun module configuré.</p>';
    return;
  }
  devices.forEach(updateCard);
  updateRoomActions();
  updateSummary(devices);
}

// ---- Actions -----------------------------------------------------------------

let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 4000);
}

async function runAction(id, action, position) {
  const entry = cards.get(id);
  entry.el.classList.add('busy');
  try {
    const device = await sendAction(id, action, position);
    updateCard(device);
    schedulePoll(FAST_POLL);
  } catch (err) {
    toast(`${entry.data.name} : ${err.message}`);
  } finally {
    entry.el.classList.remove('busy');
  }
}

// room === null : tous les volets de l'appartement.
async function roomAction(room, action, btn) {
  const covers = [...cards.values()].filter(
    (c) => (room === null || c.data.room === room) && c.data.type === 'cover' && c.data.online
  );
  btn.disabled = true;
  await Promise.all(covers.map((c) => runAction(c.data.id, action)));
  btn.disabled = false;
}

for (const [id, action] of [['open-all', 'open'], ['close-all', 'close']]) {
  const btn = document.getElementById(id);
  btn.addEventListener('click', () => roomAction(null, action, btn));
}

// ---- Actualisation périodique --------------------------------------------------

function isMoving() {
  return [...cards.values()].some((c) => c.data.online && COVER_STATES[c.data.status.state]?.cls === 'moving');
}

function schedulePoll(delay) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, delay);
}

async function poll() {
  clearTimeout(pollTimer);
  refreshBtn.classList.add('spin');
  try {
    const data = await api('/api/devices');
    pollInterval = data.pollInterval || pollInterval;
    render(data.devices);
  } catch (err) {
    summaryEl.textContent = `Serveur injoignable : ${err.message}`;
  } finally {
    refreshBtn.classList.remove('spin');
  }
  if (!document.hidden) schedulePoll(isMoving() ? FAST_POLL : pollInterval);
}

refreshBtn.addEventListener('click', poll);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(pollTimer);
  else poll();
});

poll();
