// Ballard Live — entry point. Wires the built-in cards (cards.js), glance tiles (glance.js), heads-up items
// (headsup.js), feed health (health.js) and map layers (map.js) into the core (core.js), sets up the page chrome
// (clock, theme, camera lightbox), starts the transport and loads the optional feature modules (features/index.js).
// The API handed to features is documented in FRONTEND.md.
import * as util from './util.js';
import * as core from './core.js';
import * as cards from './cards.js';
import * as mapMod from './map.js';
import { etaHtml } from './glance.js';
import './headsup.js';
import './health.js';
import { loadFeatures } from './features/index.js';

const { $, $$, rel, time } = util;

for (const [name, def] of Object.entries(cards.CARDS)) core.registerCard(name, def);

// ------------------------------------------------------------ clock and live-updating times

const DATE_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long', month: 'short', day: 'numeric' });
core.on('tick', (now) => {
  $('#clock').textContent = time(now);
  $('#clock-date').textContent = `${DATE_FMT.format(now)} · Seattle`;
  if (now % 5000 < 1000) {
    for (const el of $$('[data-rel]')) { const t = +el.dataset.rel; if (t) el.textContent = rel(t, now); }
    for (const el of $$('[data-eta]')) {
      if (el.dataset.etaMin) { el.innerHTML = etaHtml(+el.dataset.eta, now); continue; }
      const v = cards.etaText(+el.dataset.eta, now); el.textContent = el.dataset.etaUnit && v !== 'now' ? v + el.dataset.etaUnit : v;
    }
  }
});

// ------------------------------------------------------------ theme

function initTheme() {
  $('#theme-btn').addEventListener('click', () => {
    const next = util.isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('bl-theme', next); } catch { /* private mode */ }
    core.emit('theme', next);
  });
}

// ------------------------------------------------------------ camera lightbox

let lbReturn = null; // element focused before the lightbox opened; focus goes back there on close
function initLightbox() {
  const lb = $('#lightbox');
  const close = () => {
    if (lb.hidden) return;
    lb.hidden = true;
    let r = lbReturn;
    lbReturn = null;
    // The cameras card may have re-rendered meanwhile: fall back to the same camera's new figure.
    if (r && !r.isConnected && r.dataset && r.dataset.cam) r = $(`[data-cam="${CSS.escape(r.dataset.cam)}"]`);
    if (r && r.isConnected && r.focus) r.focus({ preventScroll: true });
  };
  lb.addEventListener('click', (e) => { if (e.target === lb || e.target.closest('.lb-close')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.addEventListener('click', (ev) => {
    const cam = ev.target.closest && !ev.target.closest('[data-set]') && ev.target.closest('[data-cam]');
    if (cam) openLightbox(cam.querySelector('img').src, cam.dataset.label);
  });
  // Camera figures are role="button": Enter or Space opens the enlarged image.
  document.addEventListener('keydown', (ev) => {
    if ((ev.key !== 'Enter' && ev.key !== ' ') || !ev.target.matches || !ev.target.matches('[data-cam]')) return;
    ev.preventDefault();
    openLightbox(ev.target.querySelector('img').src, ev.target.dataset.label);
  });
}
function openLightbox(src, label) {
  const lb = $('#lightbox');
  if (lb.hidden) lbReturn = document.activeElement;
  lb.querySelector('img').src = src;
  lb.querySelector('.lb-cap').textContent = label || '';
  lb.hidden = false;
  lb.querySelector('.lb-close').focus({ preventScroll: true });
}

// ------------------------------------------------------------ boot

initTheme();
initLightbox();
mapMod.initMap();

/** The API every feature module receives (export default function init(api)). See FRONTEND.md. */
const api = Object.freeze({
  version: 2,
  // store and events
  store: core.store, D: core.D, env: core.env, meta: core.meta,
  on: core.on, off: core.off, emit: core.emit,
  connection: core.connection, transport: core.transport,
  // registries
  registerCard: core.registerCard, getCard: core.getCard, cardNames: core.cardNames,
  registerTile: core.registerTile, registerHeadsup: core.registerHeadsup, registerLayer: mapMod.registerLayer,
  // rendering
  invalidate: core.invalidate, notify: core.notify, renderCard: core.renderCard, renderAll: core.renderAll,
  setHTML: core.setHTML, tile: core.tile, hu: core.hu, asOf: core.asOf, observeCard: core.observeCard,
  // data
  history: core.history, activity: core.activity,
  // prefs and page chrome
  ui: core.ui, saveUI: core.saveUI, setUI: core.setUI, addHeaderButton: core.addHeaderButton, openLightbox,
  // modules
  util,
  cards,
  map: Object.freeze({
    get instance() { return mapMod.map; },
    getMap: mapMod.getMap, registerLayer: mapMod.registerLayer, layer: mapMod.layer, layers: mapMod.layerList,
    setLayerOn: mapMod.setLayerOn, drawLayer: mapMod.drawLayer, redrawLayer: mapMod.redrawLayer,
    dotIcon: mapMod.dotIcon, labelIcon: mapMod.labelIcon, setBasemap: mapMod.setBasemap,
  }),
});
window.ballard = api; // for the console and for debugging

const features = loadFeatures(api); // runs alongside the first data load; feature cards render as soon as they register
core.start();
features.then((loaded) => core.emit('features', loaded));
