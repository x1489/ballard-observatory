// Ballard Live map: the Leaflet map, its basemap, the layer registry, and the animated layers.
//
// A layer is { key, label, color, on, deps, draw(group, ctx), count?(D), persistent?, stop?() } (see FRONTEND.md):
//   - one chip per layer in #layer-chips toggles it; the on/off choice is saved in ui.layers (+ ui.layersSeen);
//   - draw() runs when the layer is turned on and whenever the DATA of one of its deps changes (a re-sent,
//     identical envelope does not redraw), and hourly. For ordinary layers `group` has just been cleared;
//   - persistent: true layers keep their markers between draws (draw updates them in place, for animation);
//     when such a layer is turned off its group is cleared and stop() is called;
//   - features added with ctx.add(layer, id) get a stable popup key, so an open popup survives redraws;
//   - count(D), if given, is shown on the chip (a number, or null to hide it) after every render.
// Animation: addAnimator(fn) runs fn(now) on one shared requestAnimationFrame loop (about 30 fps) while the tab
// is visible and the map is on screen; return false from fn to stop. mapVisible() tells whether the map is shown.
import { $, esc, href, isNum, r0, r1, time, rel, dayLabel, aqiInfo, CENTER, plural, camSrc, isDark, pparts, reducedMotion } from './util.js';
import { D, env, on, ui, saveUI } from './core.js';
import { routeBadge, closureToday, peakGustText } from './cards.js';
import { icon } from './icons.js';

/** The Leaflet map (null until initMap(), and when Leaflet failed to load). ES live binding: read it at use time. */
export let map = null;
export const getMap = () => map;

const layers = []; // registration order = chip order
let inited = false;
let urlLayers = null; // Set of layer keys from ?layers=, or null
let baseLayer = null;
// Layers are rebuilt on refresh (bridges every ~20 s); remember which feature's popup is open so it survives.
let openKey = null, redrawing = false;
// The layer keys of v1, whose saved prefs (ui.layers) predate ui.layersSeen.
const V1_KEYS = ['fire', 'bus', 'bridge', 'traffic', 'power', 'cams', 'air', 'temps', 'radar', 'lime', 'closures', 'cso', 'crime', '311', 'permits'];

// ------------------------------------------------------------ icons (need window.L at call time)

/** Round colored dot marker icon. cls: extra class on the dot (e.g. 'pulse-ring'). */
export const dotIcon = (color, size = 12, cls = '') => L.divIcon({ className: '', html: `<div class="pin ${cls}" style="width:${size}px;height:${size}px;background:${color}"></div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
/** Text label marker icon (centered on the point). html is trusted markup. */
export const labelIcon = (html, cls = 'pin-label', style = '') => L.divIcon({ className: '', html: `<span class="${cls}" style="${style}">${html}</span>`, iconSize: [0, 0] });

// ------------------------------------------------------------ animation loop

const animators = new Set();
let rafId = 0, lastFrame = 0, onScreen = true;
/** Whether the map is on screen and the tab visible (animations only run then). */
export const mapVisible = () => onScreen && document.visibilityState === 'visible';
function frame(ts) {
  rafId = 0;
  if (ts - lastFrame >= 32) { // ~30 fps is plenty for gliding markers and saves battery
    lastFrame = ts;
    const now = Date.now();
    for (const fn of [...animators]) {
      let keep = true;
      try { keep = fn(now) !== false; } catch (err) { console.error('map animator', err); keep = false; }
      if (!keep) animators.delete(fn);
    }
  }
  schedule();
}
function schedule() {
  if (!rafId && animators.size && mapVisible()) rafId = requestAnimationFrame(frame);
}
/** Run fn(now) every animation frame while the map is visible. Returns a stop function. */
export function addAnimator(fn) {
  animators.add(fn);
  schedule();
  return () => animators.delete(fn);
}
document.addEventListener('visibilitychange', schedule);

// ------------------------------------------------------------ registry

/**
 * Register (or replace, by key) a map layer.
 * def = { key, label, color, on (default visibility), deps: [sourceIds], draw(group, ctx), count?(D), persistent?, stop?() }
 * ctx = { D, env, ui, now, map, L, key, add(leafletLayer, featureId) }.
 * Returns the layer record ({ ...def, on, group }).
 */
export function registerLayer(def) {
  if (!def || !def.key || typeof def.draw !== 'function') throw new TypeError('registerLayer: { key, draw } required');
  const l = { label: def.key, color: '#64748b', ...def, deps: Array.isArray(def.deps) ? def.deps.slice() : [], defaultOn: !!def.on, on: !!def.on, group: null };
  const i = layers.findIndex((x) => x.key === l.key);
  if (i >= 0) {
    const old = layers[i];
    l.on = old.on;
    l.group = old.group;
    if (old.persistent && typeof old.stop === 'function') { try { old.stop(); } catch { /* ignore */ } }
    if (old.group) old.group.clearLayers();
    layers[i] = l;
    if (inited) { const chip = chipEl(l.key); if (chip) chip.outerHTML = chipHTML(l); drawLayer(l); updateCounts(); }
    return l;
  }
  layers.push(l);
  if (inited) {
    l.on = urlLayers ? urlLayers.has(l.key) : savedOn(l);
    const chips = $('#layer-chips');
    if (chips) chips.insertAdjacentHTML('beforeend', chipHTML(l));
    if (map) { l.group = L.layerGroup(); if (l.on) l.group.addTo(map); }
    drawLayer(l);
    updateCounts();
  }
  return l;
}
/** A registered layer record by key, or null. */
export const layer = (key) => layers.find((x) => x.key === key) || null;
/** All layer records, in chip order. */
export const layerList = () => layers.slice();

/** Turn a layer on or off (like clicking its chip; saved). on omitted = toggle. */
export function setLayerOn(key, on) {
  const l = layer(key);
  if (!l) return;
  const v = on == null ? !l.on : !!on;
  if (v === l.on) return;
  l.on = v;
  const btn = chipEl(key);
  if (btn) { btn.classList.toggle('on', l.on); btn.setAttribute('aria-pressed', l.on); }
  saveLayers();
  if (map && l.group) { if (l.on) l.group.addTo(map); else l.group.remove(); }
  drawLayer(l);
}

function savedOn(l) {
  if (typeof ui.layers !== 'string') return l.defaultOn; // never customized
  const seen = typeof ui.layersSeen === 'string' ? ui.layersSeen.split(',') : V1_KEYS;
  if (!seen.includes(l.key)) return l.defaultOn;        // a layer this browser has not offered before
  return ui.layers.split(',').includes(l.key);           // '' = user turned every layer off
}
function saveLayers() {
  const reg = new Set(layers.map((x) => x.key));
  const prevOn = typeof ui.layers === 'string' ? ui.layers.split(',').filter(Boolean) : [];
  const prevSeen = typeof ui.layersSeen === 'string' ? ui.layersSeen.split(',').filter(Boolean) : typeof ui.layers === 'string' ? V1_KEYS : [];
  // Keep the saved state of layers whose module is not loaded this time.
  ui.layers = [...layers.filter((x) => x.on).map((x) => x.key), ...prevOn.filter((k) => !reg.has(k))].join(',');
  ui.layersSeen = [...new Set([...prevSeen, ...reg])].join(',');
  saveUI();
}

const chipEl = (key) => { const c = $('#layer-chips'); return c && c.querySelector(`[data-layer="${CSS.escape(key)}"]`); };
const chipHTML = (l) => `<button type="button" class="chip ${l.on ? 'on' : ''}" data-layer="${esc(l.key)}" aria-pressed="${l.on}"><i style="background:${esc(l.color)}"></i>${esc(l.label)}${typeof l.count === 'function' ? '<span class="n"></span>' : ''}</button>`;

function updateCounts() {
  for (const l of layers) {
    if (typeof l.count !== 'function') continue;
    const n = chipEl(l.key) && chipEl(l.key).querySelector('.n');
    if (!n) continue;
    let v = null;
    try { v = l.count(D); } catch (err) { console.error('layer count', l.key, err); }
    const txt = isNum(v) ? String(v) : '';
    if (n.textContent !== txt) n.textContent = txt;
  }
}

// ------------------------------------------------------------ map

/** Create the chips and the Leaflet map (once). Called by app.js before core.start(). */
export function initMap() {
  if (inited) return;
  inited = true;
  const chips = $('#layer-chips');
  for (const l of layers) l.on = savedOn(l);
  // Deep link: ?layers=radar,aircraft,bus shows exactly those layers for this visit (saved prefs are untouched
  // until a chip is clicked).
  const want = new URLSearchParams(location.search).get('layers');
  if (want != null) { const set = new Set(want.split(',').map((x) => x.trim()).filter(Boolean)); for (const l of layers) l.on = set.has(l.key); urlLayers = set; }
  if (chips) {
    chips.innerHTML = layers.map(chipHTML).join('');
    chips.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-layer]');
      if (btn) setLayerOn(btn.dataset.layer);
    });
  }
  on('render', ({ changed }) => {
    for (const l of layers) if (l.deps.some((d) => changed.has(d))) drawLayer(l);
    updateCounts();
  });
  on('minute', (now) => { if (pparts(now).mm === 0) for (const l of layers) drawLayer(l); }); // time-of-day styling
  on('theme', setBasemap);
  if (!window.L) {
    const el = $('#map');
    if (el) el.innerHTML = '<div class="empty" style="padding:20px">The map library (Leaflet) could not load. Check your internet connection.</div>';
    return;
  }
  map = L.map('map', { zoomControl: true, scrollWheelZoom: false, attributionControl: true }).setView(CENTER, 14);
  map.on('focus click', () => map.scrollWheelZoom.enable());
  map.on('blur mouseout', () => map.scrollWheelZoom.disable());
  map.on('popupopen', (e) => { const src = e.popup && e.popup._source; openKey = (src && src.options && src.options.pkey) || null; });
  map.on('popupclose', () => { if (!redrawing) openKey = null; });
  map.createPane('labels');
  map.getPane('labels').style.zIndex = 390;
  map.getPane('labels').style.pointerEvents = 'none';
  setBasemap();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', setBasemap);
  for (const l of layers) {
    l.group = L.layerGroup();
    if (l.on) l.group.addTo(map);
  }
  L.circle(CENTER, { radius: 2000, color: '#0f766e', weight: 1, opacity: 0.35, fill: false, dashArray: '4 6', interactive: false }).addTo(map);
  $('#map-note').textContent = 'Dashed circle: 2 km around NW Market St & Ballard Ave. Click the map to enable scroll zoom.';
  // Pause animations while the map is scrolled out of view.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      for (const e of entries) onScreen = e.isIntersecting;
      schedule();
    }, { rootMargin: '100px' }).observe($('#map'));
  }
}

/** Light or dark Esri basemap to match the page theme (core emits 'theme' on toggle). */
export function setBasemap() {
  if (!map) return;
  const shade = isDark() ? 'Dark' : 'Light';
  if (baseLayer) baseLayer.remove();
  const esri = (name) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${shade}_Gray_${name}/MapServer/tile/{z}/{y}/{x}`;
  const opts = { maxZoom: 19, maxNativeZoom: 16 };
  baseLayer = L.layerGroup([
    L.tileLayer(esri('Base'), { ...opts, attribution: 'Basemap &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors' }),
    L.tileLayer(esri('Reference'), { ...opts, pane: 'labels' }),
  ]).addTo(map);
}

/** Rebuild one layer now (record or key). Normally automatic; call it when a layer depends on something else. */
export function drawLayer(l) {
  if (typeof l === 'string') l = layer(l);
  if (!l || !map || !l.group) return;
  const g = l.group;
  const add = (lyr, id) => { if (id != null && lyr.options) lyr.options.pkey = `${l.key}:${id}`; g.addLayer(lyr); return lyr; };
  const ctx = { D, env, ui, now: Date.now(), map, L: window.L, key: l.key, add };
  if (l.persistent) {
    if (!l.on) {
      try { if (typeof l.stop === 'function') l.stop(); } catch (err) { console.error('layer stop', l.key, err); }
      g.clearLayers();
      return;
    }
    try { l.draw(g, ctx); } catch (err) { console.error('layer', l.key, err); }
    return;
  }
  redrawing = true;
  g.clearLayers(); // closes any popup open on this layer; reopened below for the same feature
  redrawing = false;
  if (!l.on) return;
  try {
    l.draw(g, ctx);
  } catch (err) {
    console.error('layer', l.key, err);
  }
  if (openKey && openKey.startsWith(l.key + ':')) {
    let found = null;
    g.eachLayer((x) => { if (x.options.pkey === openKey && x.getPopup && x.getPopup()) found = x; });
    if (found) found.openPopup(); else openKey = null; // the feature is gone
  }
}
export const redrawLayer = drawLayer;

// ------------------------------------------------------------ helpers for animated layers

const M_PER_DEG = 111320;
function distM(a, b) {
  const dLat = (b[0] - a[0]) * M_PER_DEG;
  const dLon = (b[1] - a[1]) * M_PER_DEG * Math.cos(a[0] * Math.PI / 180);
  return Math.hypot(dLat, dLon);
}
function setPopup(marker, html) {
  if (marker._blHtml === html) return;
  marker._blHtml = html;
  if (marker.getPopup()) marker.setPopupContent(html); else marker.bindPopup(html, { maxWidth: 320 });
}
function rotateEl(marker, sel, deg) {
  const el = marker.getElement && marker.getElement();
  const r = el && el.querySelector(sel);
  if (r && isNum(deg)) r.style.transform = `rotate(${deg}deg)`;
}
function fadeOut(marker, extra = []) {
  const el = marker.getElement && marker.getElement();
  if (el) el.classList.add('mk-fade');
  setTimeout(() => { marker.remove(); for (const x of extra) x.remove(); }, reducedMotion() ? 0 : 900);
}

// ------------------------------------------------------------ built-in layers

// 911: ids first seen during this page session pulse for a while (the first draw only seeds).
const fireSeen = new Map();
let fireSeeded = false;
registerLayer({
  key: 'fire', label: '911 calls', color: '#dc2626', on: true, deps: ['fire911'],
  draw(g, { D, now, add }) {
    const f = D('fire911');
    const list = (f && f.incidents) || [];
    for (const x of list) if (!fireSeen.has(x.id)) fireSeen.set(x.id, fireSeeded ? now : 0);
    if (list.length) fireSeeded = true;
    for (const x of list.filter((x) => isNum(x.lat) && isNum(x.lon))) {
      const age = (now - x.t) / 3600e3;
      const fresh = fireSeen.get(x.id) && now - fireSeen.get(x.id) < 5 * 60e3;
      const cls = [x.active ? 'pulse-ring' : '', fresh ? 'pulse-new' : ''].join(' ');
      const m = L.marker([x.lat, x.lon], { icon: dotIcon(x.active ? '#dc2626' : '#f87171', x.active || fresh ? 16 : 11, cls), opacity: x.active || fresh ? 1 : Math.max(0.35, 1 - age / 30), zIndexOffset: x.active || fresh ? 1000 : 0 });
      m.bindPopup(`<b>${esc(x.type)}</b><br>${esc(x.address)}<br><span class="muted">${time(x.t)} · ${rel(x.t)}</span>${x.units ? `<br><span class="mono small">${esc(x.units)}</span>` : ''}${x.active ? '<br><span class="tag danger">active</span>' : ''}${fresh ? ' <span class="bl-new">new</span>' : ''}`);
      add(m, x.id);
    }
  },
  count: (D) => { const f = D('fire911'); return f ? (f.incidents || []).filter((x) => isNum(x.lat)).length : null; },
});

// Buses glide from fix to fix at constant speed over the observed update interval, so they appear to drive.
const buses = new Map(); // vehicleId -> { marker, from, to, t0, dur }
let busStop = null, busLast = 0, busGap = 5000;
const busColor = (route) => (route === 'D Line' ? '#c8102e' : '#0e7c86');
const busIcon = (x) => L.divIcon({
  className: '', iconSize: [30, 30], iconAnchor: [15, 15],
  html: `<div class="bus-mk" style="--c:${busColor(x.route)}"><span class="bus-arrow" style="transform:rotate(${isNum(x.heading) ? x.heading : 0}deg)"${isNum(x.heading) ? '' : ' hidden'}></span><span class="bus-num">${esc(x.route === 'D Line' ? 'D' : x.route)}</span></div>`,
});
function busPopup(x) {
  const dev = x.deviationSec;
  const lateness = isNum(dev) ? (dev > 60 ? `${Math.round(dev / 60)} min late` : dev < -60 ? `${Math.round(-dev / 60)} min early` : 'on time') : '';
  return `${routeBadge(x.route, true)} <b>${esc(x.headsign || '')}</b><br>${esc(lateness)}${lateness ? ' · ' : ''}GPS fix ${rel(x.t)}`;
}
function stepBuses(now) {
  if (!buses.size) { busStop = null; return false; }
  for (const b of buses.values()) {
    if (b.done) continue;
    const k = Math.min(1, (now - b.t0) / b.dur);
    b.marker.setLatLng([b.from[0] + (b.to[0] - b.from[0]) * k, b.from[1] + (b.to[1] - b.from[1]) * k]);
    if (k >= 1) b.done = true;
  }
  return true;
}
registerLayer({
  key: 'bus', label: 'Buses', color: '#2563eb', on: true, deps: ['vehicles'], persistent: true,
  draw(g, { D, env: envOf, now }) {
    const v = D('vehicles');
    const list = ((v && v.vehicles) || []).filter((x) => isNum(x.lat) && isNum(x.lon) && x.vehicleId);
    // Re-target only on new data (not on the hourly redraw), and glide over the real gap between fetches.
    const fa = (envOf('vehicles') || {}).fetchedAt || now;
    if (fa === busLast && buses.size) return;
    if (busLast) busGap = Math.min(120000, Math.max(5000, fa - busLast));
    busLast = fa;
    const seen = new Set();
    for (const x of list) {
      seen.add(x.vehicleId);
      const to = [x.lat, x.lon];
      let b = buses.get(x.vehicleId);
      if (!b) {
        const marker = L.marker(to, { icon: busIcon(x), keyboard: false, zIndexOffset: 300 });
        marker.options.pkey = `bus:${x.vehicleId}`;
        g.addLayer(marker);
        b = { marker, from: to, to, t0: now, dur: 1, done: true, route: x.route };
        buses.set(x.vehicleId, b);
      } else {
        const cur = b.marker.getLatLng();
        const from = [cur.lat, cur.lng];
        const jump = distM(from, to) > 1500; // a new trip or a GPS glitch: don't draw a bus across town
        b.from = jump || reducedMotion() ? to : from;
        b.to = to;
        b.t0 = now;
        b.dur = jump ? 1 : busGap;
        b.done = false;
        if (b.route !== x.route) { b.marker.setIcon(busIcon(x)); b.route = x.route; }
      }
      rotateEl(b.marker, '.bus-arrow', x.heading);
      setPopup(b.marker, busPopup(x));
    }
    for (const [id, b] of buses) if (!seen.has(id)) { buses.delete(id); fadeOut(b.marker); }
    if (!busStop && buses.size) busStop = addAnimator(stepBuses);
  },
  stop() { buses.clear(); if (busStop) busStop(); busStop = null; busLast = 0; },
  count: (D) => { const v = D('vehicles'); return v ? (v.vehicles || []).length : null; },
});

registerLayer({
  key: 'bridge', label: 'Bridges', color: '#f59e0b', on: true, deps: ['bridges'],
  draw(g, { D, add }) {
    const b = D('bridges');
    for (const x of (b && b.bridges) || []) {
      if (!isNum(x.lat)) continue;
      add(L.marker([x.lat, x.lon], { icon: labelIcon(`${esc(x.name)} ${x.up ? 'UP' : 'down'}`, `pin-bridge${x.up ? ' up' : ''}`, `background:${x.up ? '#c2410c' : '#15803d'}`), zIndexOffset: 500 })
        .bindPopup(`<b>${esc(x.name)} Bridge</b><br>${x.up ? 'Raised: closed to traffic' : 'Down: open to traffic'}${x.sinceKnown && isNum(x.since) ? `<br>since ${time(x.since)}` : ''}`), x.id);
    }
  },
});

// Aircraft: dead-reckoned from ground speed and track between the ~15 s updates, with a short trail.
const planes = new Map(); // hex -> { marker, trail, pts, base, vel, corr, corrT0 }
let planeStop = null, planeLast = 0;
const AC_COLORS = { airliner: '#7c3aed', seaplane: '#0891b2', helicopter: '#db2777', military: '#4b5563', light: '#a855f7', unknown: '#8b5cf6' };
const acColor = (x) => (x.emergency ? '#dc2626' : AC_COLORS[x.kind] || AC_COLORS.unknown);
const PLANE_SVG = (c) => `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M12 1.8c.9 0 1.5.8 1.5 1.7v5.8l8 4.6v2.2l-8-2.4v4.8l2.3 1.8v1.7L12 21l-3.8 1v-1.7l2.3-1.8v-4.8l-8 2.4v-2.2l8-4.6V3.5c0-.9.6-1.7 1.5-1.7z" fill="${c}" stroke="#fff" stroke-width="1.1" stroke-linejoin="round"/></svg>`;
const HELI_SVG = (c) => `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M2 5.5h20" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/><path d="M12 5.5v3" stroke="${c}" stroke-width="2"/><ellipse cx="12" cy="12.5" rx="4" ry="5" fill="${c}" stroke="#fff" stroke-width="1.1"/><path d="M12 17.5V22M9.5 22h5" stroke="${c}" stroke-width="2" stroke-linecap="round"/></svg>`;
const acLabel = (x) => `${esc(x.callsign || x.reg || x.hex.toUpperCase())}${isNum(x.altFt) ? ` · ${Math.round(x.altFt / 100)}` : ''}`;
const acIcon = (x) => L.divIcon({
  className: '', iconSize: [24, 24], iconAnchor: [12, 12],
  html: `<div class="ac-mk${x.emergency ? ' emerg' : ''}"><span class="ac-rot" style="transform:rotate(${isNum(x.track) ? x.track : 0}deg)">${x.kind === 'helicopter' ? HELI_SVG(acColor(x)) : PLANE_SVG(acColor(x))}</span><span class="ac-label">${acLabel(x)}</span></div>`,
});
function acPopup(x) {
  const name = esc(x.callsign || x.reg || x.hex.toUpperCase());
  const rows = [
    x.operator && esc(x.operator), x.desc ? esc(x.desc) : x.type ? esc(x.type) : null,
    isNum(x.altFt) ? `${Math.round(x.altFt).toLocaleString()} ft` : null, isNum(x.gsKt) ? `${Math.round(x.gsKt)} kt` : null,
    isNum(x.vrFpm) && Math.abs(x.vrFpm) >= 200 ? `${x.vrFpm > 0 ? '▲' : '▼'} ${Math.abs(Math.round(x.vrFpm / 100) * 100)} fpm` : null,
    isNum(x.distKm) ? `${(x.distKm * 0.621).toFixed(1)} mi away` : null,
  ].filter(Boolean);
  return `<b>${name}</b>${x.reg && x.callsign ? ` <span class="muted small">${esc(x.reg)}</span>` : ''}${x.emergency ? ` <span class="tag danger">${esc(x.emergency)}</span>` : ''}<br>${rows.join(' · ')}<br><a href="${href(`https://globe.adsb.lol/?icao=${x.hex}`)}" target="_blank" rel="noopener">Track on ADS-B Exchange (adsb.lol)</a>`;
}
function velocity(x) {
  if (!isNum(x.gsKt) || !isNum(x.track) || x.gsKt < 30) return [0, 0];
  const mps = x.gsKt * 0.514444;
  const rad = x.track * Math.PI / 180;
  return [(Math.cos(rad) * mps) / M_PER_DEG / 1000, (Math.sin(rad) * mps) / (M_PER_DEG * Math.cos(x.lat * Math.PI / 180)) / 1000]; // deg per ms
}
function predicted(p, now) {
  const dt = Math.max(0, Math.min(20000, now - p.base.t));
  return [p.base.lat + p.vel[0] * dt, p.base.lon + p.vel[1] * dt];
}
function stepPlanes(now) {
  if (!planes.size) { planeStop = null; return false; }
  for (const p of planes.values()) {
    const [lat, lon] = predicted(p, now);
    const k = p.corr ? Math.min(1, (now - p.corrT0) / 1500) : 1;
    const c = p.corr && k < 1 ? [p.corr[0] * (1 - k), p.corr[1] * (1 - k)] : [0, 0];
    if (k >= 1) p.corr = null;
    p.marker.setLatLng([lat + c[0], lon + c[1]]);
  }
  return true;
}
registerLayer({
  key: 'aircraft', label: 'Aircraft', color: '#7c3aed', on: true, deps: ['aircraft'], persistent: true,
  draw(g, { D, env: envOf, now }) {
    const a = D('aircraft');
    const fa = (envOf('aircraft') || {}).fetchedAt || now;
    if (fa === planeLast && planes.size) return; // hourly redraw with the same data: keep gliding
    planeLast = fa;
    const list = ((a && a.aircraft) || []).filter((x) => !x.onGround && isNum(x.lat) && isNum(x.lon) && x.hex);
    const seen = new Set();
    for (const x of list) {
      seen.add(x.hex);
      const base = { lat: x.lat, lon: x.lon, t: isNum(x.t) ? Math.min(x.t, now) : now };
      let p = planes.get(x.hex);
      if (!p) {
        const marker = L.marker([x.lat, x.lon], { icon: acIcon(x), keyboard: false, zIndexOffset: 800 });
        marker.options.pkey = `aircraft:${x.hex}`;
        const trail = L.polyline([[x.lat, x.lon]], { color: acColor(x), weight: 2, opacity: 0.35, interactive: false, dashArray: '2 5' });
        g.addLayer(trail);
        g.addLayer(marker);
        p = { marker, trail, pts: [[x.lat, x.lon]], base, vel: velocity(x), corr: null, sig: '' };
        planes.set(x.hex, p);
      } else {
        const cur = p.marker.getLatLng();
        p.base = base;
        p.vel = velocity(x);
        const target = predicted(p, now);
        const off = [cur.lat - target[0], cur.lng - target[1]];
        // Glide the correction away over 1.5 s instead of snapping (unless it's a big jump).
        p.corr = !reducedMotion() && distM([cur.lat, cur.lng], target) < 3000 ? off : null;
        p.corrT0 = now;
        p.pts.push([x.lat, x.lon]);
        if (p.pts.length > 10) p.pts.shift();
        p.trail.setLatLngs(p.pts);
      }
      const sig = `${x.kind}|${x.emergency}|${acLabel(x)}`;
      if (p.sig !== sig) { p.marker.setIcon(acIcon(x)); p.trail.setStyle({ color: acColor(x) }); p.sig = sig; }
      rotateEl(p.marker, '.ac-rot', x.track);
      setPopup(p.marker, acPopup(x));
    }
    for (const [hex, p] of planes) if (!seen.has(hex)) { planes.delete(hex); fadeOut(p.marker, [p.trail]); }
    if (!planeStop && planes.size) planeStop = addAnimator(stepPlanes);
  },
  stop() { planes.clear(); if (planeStop) planeStop(); planeStop = null; planeLast = 0; },
  count: (D) => { const a = D('aircraft'); return a && isNum(a.airborne) ? a.airborne : null; },
});

registerLayer({
  key: 'traffic', label: 'Traffic incidents', color: '#ea580c', on: true, deps: ['incidents'],
  draw(g, { D, add }) {
    const i = D('incidents');
    for (const x of (i && i.incidents) || []) add(L.marker([x.lat, x.lon], { icon: dotIcon('#ea580c', 14) }).bindPopup(`<b>${esc(x.type)}</b><br>${esc(x.description)}`), x.id);
  },
  count: (D) => { const i = D('incidents'); return i ? (i.incidents || []).length : null; },
});
registerLayer({
  key: 'power', label: 'Outages', color: '#eab308', on: true, deps: ['outages'],
  draw(g, { D, add }) {
    const o = D('outages');
    for (const x of (o && o.ballard) || []) {
      if (x.ring && x.ring.length > 2) g.addLayer(L.polygon(x.ring, { color: '#eab308', weight: 2, fillOpacity: 0.25 }));
      add(L.marker([x.lat, x.lon], { icon: dotIcon('#eab308', 14) }).bindPopup(`<b>Power outage</b><br>${plural(x.customers, 'customer')} · ${esc(x.status)}<br>Started ${time(x.start)}${isNum(x.etr) ? ` · ETR ${time(x.etr)}` : ''}`), x.id);
    }
  },
  count: (D) => { const o = D('outages'); return o ? (o.ballard || []).length : null; },
});

// Radar: all frames are loaded as tile layers and cycled (about 0.5 s a frame, holding on "now").
const radar = { layers: [], times: [], i: 0, playing: true, last: 0, key: '', ctrl: null, stopAnim: null, userTouched: false };
function radarShow(i) {
  radar.i = i;
  radar.layers.forEach((l, j) => l.setOpacity(j === i ? 0.62 : 0));
  const c = radar.ctrl && radar.ctrl.getContainer();
  if (!c) return;
  const t = radar.times[i];
  const lbl = c.querySelector('.radar-time');
  if (lbl) lbl.textContent = i === radar.layers.length - 1 ? `now · ${time(t)}` : time(t);
  const rng = c.querySelector('input');
  if (rng && +rng.value !== i) rng.value = String(i);
}
function radarStep(now) {
  if (!radar.layers.length) { radar.stopAnim = null; return false; }
  if (!radar.playing) return true;
  const hold = radar.i === radar.layers.length - 1 ? 1600 : 520;
  if (now - radar.last >= hold) { radar.last = now; radarShow((radar.i + 1) % radar.layers.length); }
  return true;
}
function radarControl() {
  const C = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const div = L.DomUtil.create('div', 'radar-ctl leaflet-bar');
      div.innerHTML = `<button type="button" class="radar-play" aria-label="Pause radar loop" title="Play/pause radar loop">${icon('pause', { size: 14 })}</button>
        <input type="range" min="0" max="${Math.max(0, radar.layers.length - 1)}" step="1" value="${radar.i}" aria-label="Radar frame">
        <span class="radar-time" aria-live="off"></span>`;
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      const btn = div.querySelector('button');
      const setBtn = () => { btn.innerHTML = icon(radar.playing ? 'pause' : 'play', { size: 14 }); btn.setAttribute('aria-label', radar.playing ? 'Pause radar loop' : 'Play radar loop'); };
      btn.addEventListener('click', () => { radar.playing = !radar.playing; radar.userTouched = true; setBtn(); });
      div.querySelector('input').addEventListener('input', (e) => { radar.playing = false; radar.userTouched = true; setBtn(); radarShow(+e.target.value); });
      setBtn();
      return div;
    },
  });
  return new C();
}
registerLayer({
  key: 'radar', label: 'Radar', color: '#06b6d4', on: false, deps: ['radar'], persistent: true,
  draw(g, { D, now, map: m }) {
    const r = D('radar');
    if (!r) return;
    const frames = Array.isArray(r.frames) && r.frames.length ? r.frames : r.tileUrl ? [{ label: 'now', tileUrl: r.tileUrl }] : [];
    const key = `${r.valid}|${frames.map((f) => f.tileUrl).join()}`;
    if (key !== radar.key) {
      radar.key = key;
      g.clearLayers();
      const v = Math.floor((r.valid || now) / 60000);
      radar.layers = frames.map((f) => L.tileLayer(`${f.tileUrl}?v=${v}`, { opacity: 0, maxNativeZoom: 10, maxZoom: 19, attribution: 'Radar: Iowa Environmental Mesonet' }));
      radar.times = frames.map((f) => { const m2 = /^-(\d+)m$/.exec(f.label || ''); return (r.valid || now) - (m2 ? +m2[1] * 60000 : 0); });
      radar.layers.forEach((l) => g.addLayer(l));
      if (!radar.userTouched) radar.playing = !reducedMotion();
      radarShow(radar.layers.length - 1);
      if (radar.ctrl) { radar.ctrl.remove(); radar.ctrl = null; }
    }
    if (!radar.ctrl && m && radar.layers.length > 1) { radar.ctrl = radarControl(); radar.ctrl.addTo(m); radarShow(radar.i); }
    if (!radar.stopAnim && radar.layers.length > 1) radar.stopAnim = addAnimator(radarStep);
  },
  stop() {
    if (radar.stopAnim) radar.stopAnim();
    if (radar.ctrl) radar.ctrl.remove();
    Object.assign(radar, { layers: [], times: [], key: '', ctrl: null, stopAnim: null });
  },
});

registerLayer({
  key: 'cams', label: 'Cameras', color: '#64748b', on: false, deps: ['cameras'],
  draw(g, { D, add }) {
    const c = D('cameras');
    for (const x of (c && c.cameras) || []) add(L.marker([x.lat, x.lon], { icon: labelIcon(icon('camera', { size: 14 }), 'pin-label cam-pin') }).bindPopup(`<b>${esc(x.label)}</b>${x.ok ? `<img src="${camSrc(x.url, x.lastModified)}" alt="">` : '<br>offline'}`, { maxWidth: 360 }), x.id);
  },
  count: (D) => { const c = D('cameras'); return c ? (c.cameras || []).filter((x) => x.ok).length : null; },
});
registerLayer({
  key: 'air', label: 'Air sensors', color: '#22c55e', on: false, deps: ['purpleair'],
  draw(g, { D, add }) {
    const pa = D('purpleair');
    for (const x of (pa && pa.sensors) || []) {
      const i = aqiInfo(x.aqi);
      add(L.marker([x.lat, x.lon], { icon: labelIcon(`<span style="color:${i.color}">●</span> ${r0(x.aqi)}`) }).bindPopup(`<b>PurpleAir ${esc(x.id)}</b><br>AQI ${r0(x.aqi)} (${esc(i.label)})<br>PM2.5 ${r1(x.pm25)} µg/m³ · ${rel(x.t)}`), x.id);
    }
  },
  count: (D) => { const pa = D('purpleair'); return pa ? (pa.sensors || []).length : null; },
});
registerLayer({
  key: 'temps', label: 'Temperatures', color: '#0ea5e9', on: false, deps: ['stations', 'westpoint'],
  draw(g, { D, add }) {
    const st = D('stations');
    for (const x of ((st && st.stations) || []).filter((s) => !s.stale && isNum(s.tempF))) add(L.marker([x.lat, x.lon], { icon: labelIcon(`${r0(x.tempF)}°`) }).bindPopup(`<b>${esc(x.id)}</b><br>${r0(x.tempF)}°F · ${r0(x.humidity)}% RH<br>${rel(x.t)}`), x.id);
    const wp = D('westpoint');
    if (wp && isNum(wp.windKt)) add(L.marker([wp.lat, wp.lon], { icon: labelIcon(`<span style="display:inline-block;transform:rotate(${(wp.windDir || 0) + 180}deg)">↑</span> ${r0(wp.windKt)} kt`) }).bindPopup(`<b>West Point</b><br>Wind ${r0(wp.windKt)} kt${isNum(wp.gustKt) ? `, gust ${r0(wp.gustKt)}` : peakGustText(wp) ? `, ${peakGustText(wp)}` : ''}<br>Air ${r0(wp.airTempF)}°F`), 'westpoint');
  },
});

const ICONIC_EMOJI = { Aves: '🐦', Mammalia: '🦭', Plantae: '🌿', Insecta: '🐝', Fungi: '🍄', Arachnida: '🕷️', Mollusca: '🐌', Actinopterygii: '🐟', Amphibia: '🐸', Reptilia: '🦎' };
registerLayer({
  key: 'wildlife', label: 'Wildlife', color: '#65a30d', on: false, deps: ['wildlife'],
  draw(g, { D, add }) {
    const w = D('wildlife');
    for (const o of ((w && w.observations) || []).filter((o) => isNum(o.lat) && isNum(o.lon))) {
      const name = (o.taxon && (o.taxon.common || o.taxon.name)) || 'Observation';
      // Only plain https image paths: the URL goes inside a CSS url() below.
      const photo = o.photo && /^https:\/\/[\w.-]+\/[\w/.%~-]+$/.test(o.photo) ? o.photo : null;
      const emoji = ICONIC_EMOJI[o.taxon && o.taxon.iconic] || '🔎';
      const pin = L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15],
        html: `<span class="wl-pin" title="${esc(name)}"${photo ? ` style="background-image:url('${esc(photo)}')"` : ''}>${photo ? '' : emoji}</span>` });
      add(L.marker([o.lat, o.lon], { icon: pin, keyboard: false }).bindPopup(`${photo ? `<img src="${esc(photo)}" alt="${esc(name)}" loading="lazy" style="width:220px;max-width:60vw">` : ''}
        <b>${esc(name)}</b>${o.taxon && o.taxon.common ? ` <i class="muted small">${esc(o.taxon.name)}</i>` : ''}<br>
        <span class="small muted">${o.t ? `${esc(dayLabel(o.t))}${o.timeKnown ? ` ${time(o.t)}` : ''}` : ''}${o.user ? ` · by ${esc(o.user)}` : ''}${o.obscured ? ' · location obscured' : ''}</span><br>
        <a href="${href(o.url)}" target="_blank" rel="noopener">View on iNaturalist</a>`, { maxWidth: 260 }), o.id);
    }
  },
  count: (D) => { const w = D('wildlife'); return w ? (w.observations || []).filter((o) => isNum(o.lat)).length : null; },
});

let limeRenderer = null;
registerLayer({
  key: 'lime', label: 'Scooters', color: '#84cc16', on: false, deps: ['lime'],
  draw(g, { D }) {
    const li = D('lime');
    const col = { s: '#84cc16', e: '#16a34a', b: '#65a30d' };
    // One shared canvas renderer: up to 1000 dots without hundreds of SVG nodes (and no renderer per redraw).
    const renderer = limeRenderer || (limeRenderer = L.canvas({ padding: 0.2 }));
    for (const [lat, lon, k] of (li && li.points) || []) g.addLayer(L.circleMarker([lat, lon], { radius: 3, color: col[k] || '#84cc16', weight: 0, fillOpacity: 0.8, interactive: false, renderer }));
  },
  count: (D) => { const li = D('lime'); return li && isNum(li.inBbox) ? li.inBbox : null; },
});
registerLayer({
  key: 'closures', label: 'Street closures', color: '#f97316', on: false, deps: ['closures'],
  draw(g, { D, now, add }) {
    const c = D('closures');
    for (const x of (c && c.closures) || []) {
      const hrs = closureToday(x, now);
      for (const seg of Array.isArray(x.segments) ? x.segments : []) {
        if (!seg.line || seg.line.length < 2) continue;
        add(L.polyline(seg.line, { color: hrs ? '#f97316' : '#fdba74', weight: hrs ? 6 : 4, opacity: 0.85, dashArray: hrs ? null : '4 6' })
          .bindPopup(`<b>${esc(x.type)}</b>: ${esc(x.street)}<br>${esc(x.name || '')}<br>${hrs ? `Closed today ${esc(hrs)}` : 'Not closed today'}`), x.permit);
      }
    }
  },
  count: (D) => { const c = D('closures'); return c ? (c.closures || []).length : null; },
});
registerLayer({
  key: 'cso', label: 'Sewer outfalls', color: '#0d9488', on: false, deps: ['cso'],
  draw(g, { D, add }) {
    const c = D('cso');
    const col = { overflowing: '#dc2626', recent: '#f59e0b', none: '#14b8a6', nodata: '#9ca3af' };
    for (const x of (c && c.sites) || []) add(L.circleMarker([x.lat, x.lon], { radius: 6, color: '#fff', weight: 1.5, fillColor: col[x.status] || '#9ca3af', fillOpacity: 0.9 }).bindPopup(`<b>${esc(x.name)}</b> <span class="mono small">${esc(x.tag)}</span><br>${esc({ overflowing: 'Overflowing now', recent: 'Overflowed in last 48h', none: 'No recent overflow', nodata: 'No data' }[x.status] || x.status)}`), x.tag);
  },
});
registerLayer({
  key: 'crime', label: 'Police reports', color: '#7c3aed', on: false, deps: ['crime'],
  draw(g, { D, add }) {
    const c = D('crime');
    for (const x of ((c && c.reports) || []).filter((x) => isNum(x.lat))) add(L.circleMarker([x.lat, x.lon], { radius: 5, color: '#fff', weight: 1, fillColor: '#7c3aed', fillOpacity: 0.75 }).bindPopup(`<b>${esc((x.offenses || []).join(', '))}</b><br>${esc(x.block || '')}<br>${esc(dayLabel(x.t))} ${time(x.t)}`), x.id);
  },
  count: (D) => { const c = D('crime'); return c ? (c.reports || []).filter((x) => isNum(x.lat)).length : null; },
});
registerLayer({
  key: '311', label: '311', color: '#a16207', on: false, deps: ['requests311'],
  draw(g, { D, add }) {
    const r = D('requests311');
    for (const x of ((r && r.requests) || []).filter((x) => isNum(x.lat))) add(L.circleMarker([x.lat, x.lon], { radius: 5, color: '#fff', weight: 1, fillColor: '#a16207', fillOpacity: 0.75 }).bindPopup(`<b>${esc(x.type)}</b><br>${esc(x.address || '')}<br>${esc(x.status)} · ${rel(x.t)}`), x.id);
  },
});
registerLayer({
  key: 'permits', label: 'Permits', color: '#0891b2', on: false, deps: ['permits'],
  draw(g, { D, add }) {
    const p = D('permits');
    for (const x of ((p && p.permits) || []).filter((x) => isNum(x.lat))) add(L.circleMarker([x.lat, x.lon], { radius: 5, color: '#fff', weight: 1, fillColor: '#0891b2', fillOpacity: 0.75 }).bindPopup(`<b>${esc(x.type)}</b><br>${esc(x.address)}<br><span class="small">${esc((x.description || '').slice(0, 160))}</span>`), x.id);
  },
});
