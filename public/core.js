// Ballard Live core: the data store, event bus, transport (SSE with a polling fallback), render scheduling,
// the card / glance-tile / heads-up registries, metric history, the activity list, UI prefs and header controls.
// This is the API feature modules build on; FRONTEND.md documents it.
import { $, $$, esc, isNum, time, full, relEl, pparts, dayKey, liveSnapshot, liveFlash, countdownText } from './util.js';

// Core styles (value flash, LIVE indicator, chip counts, "new" badge) live in core.css, injected here.
if (typeof document !== 'undefined' && !document.getElementById('bl-core-css')) {
  const link = document.createElement('link');
  link.id = 'bl-core-css';
  link.rel = 'stylesheet';
  link.href = new URL('./core.css', import.meta.url).href;
  document.head.appendChild(link);
}

const STREAM_URL = '/api/stream';
// ?transport=polling skips the stream (debugging, and headless captures: --virtual-time-budget never advances
// while an EventSource is open).
const FORCE_POLL = typeof location !== 'undefined' && new URLSearchParams(location.search).get('transport') === 'polling';
const HELLO_TIMEOUT = 4000;   // no 'hello' this long after opening the stream: treat it as failed
const SILENT_MS = 90000;      // the server pings every 25 s; nothing for this long means a dead connection
const HIST_MAX_MS = 48 * 3600e3;
const ACTIVITY_MAX = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================================================================== store

const state = {};   // id -> envelope { id, title, ttl, fetchedAt, expiresAt, stale, error, data }
const rows = {};    // id -> /api/sources row { id, title, group, ttl, daily, fetchedAt, expiresAt, error, ms, ok, fail }
const sigs = {};    // id -> JSON of the last data seen, to tell a real change from a re-send
let order = [];     // source ids in server order
const server = { now: null, loadErrors: [] };

/** A source's data, or null. */
export const D = (id) => (state[id] && state[id].data) || null;
/** A source's whole envelope { id, title, ttl, fetchedAt, expiresAt, stale, error, data }, or null. */
export const env = (id) => state[id] || null;
/** A source's /api/sources row { id, title, group, ttl, daily, fetchedAt, expiresAt, error, ms, ... }, or null. */
export const meta = (id) => rows[id] || null;
const ttlOf = (id) => (rows[id] && rows[id].ttl) || (state[id] && state[id].ttl) || 60;

export const store = {
  D, env, meta,
  /** Source ids in server order. */
  ids: () => order.slice(),
  /** /api/sources rows in server order (kept current by the stream and by polls). */
  sources: () => order.map((id) => rows[id]).filter(Boolean),
  /** { now, loadErrors } from the last /api/sources (or hello). */
  server: () => ({ ...server }),
  ttl: ttlOf,
  /** True when a source's data is older than 3 refresh cycles, or is daily data from an earlier Pacific day. */
  isStale(id, now = Date.now()) {
    const e = state[id];
    if (!e || !e.fetchedAt) return false;
    if (e.stale) return true;
    if (now - e.fetchedAt > 3 * ttlOf(id) * 1000) return true;
    return !!(rows[id] && rows[id].daily && dayKey(e.fetchedAt) !== dayKey(now));
  },
};

/**
 * ' · as of 7:05 pm' when a source's data is older than two refresh cycles (upstream failing, or this
 * page can't reach the server). Glance tiles and heads-up items otherwise present old data as current.
 */
export function asOf(...ids) {
  const now = Date.now();
  let oldest = Infinity;
  for (const id of ids) {
    const e = env(id);
    if (!e || !e.data || !e.fetchedAt) continue;
    const ttl = (rows[id] && rows[id].ttl) || e.ttl || 60;
    if (now - e.fetchedAt > Math.max(2 * ttl * 1000, 120000)) oldest = Math.min(oldest, e.fetchedAt);
  }
  return oldest < Infinity ? ` · <span style="color:var(--warn)" title="The latest refresh failed">as of ${time(oldest)}</span>` : '';
}

// ================================================================== event bus

const handlers = new Map();
/** Subscribe to an event. Returns an unsubscribe function. A throwing handler is logged and never breaks others. */
export function on(event, fn) {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event).add(fn);
  return () => off(event, fn);
}
export function off(event, fn) {
  const s = handlers.get(event);
  if (s) s.delete(fn);
}
export function emit(event, ...args) {
  const s = handlers.get(event);
  if (!s) return;
  for (const fn of [...s]) {
    try { fn(...args); } catch (err) { console.error(`[core] '${event}' handler failed`, err); }
  }
}

// ================================================================== UI prefs

/** Persisted UI prefs (localStorage 'bl-ui'). Mutate, then saveUI(); or use setUI(). */
export const ui = loadUI();
function loadUI() {
  try { const o = JSON.parse(localStorage.getItem('bl-ui') || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}
export function saveUI() {
  try { localStorage.setItem('bl-ui', JSON.stringify(ui)); } catch { /* private mode */ }
}
/** Set (or with null/undefined, delete) a pref, save, emit 'ui' (key, value) and re-render everything. */
export function setUI(key, value, { render = true } = {}) {
  if (value == null) delete ui[key]; else ui[key] = value;
  saveUI();
  emit('ui', key, ui[key]);
  if (render) renderAll();
}

// ================================================================== setHTML

const FOCUSABLE = 'a[href],button,[tabindex]';
/**
 * el.innerHTML = html, except that identical writes are skipped (no image reloads, no lost hover or focus)
 * and keyboard focus inside el moves to the same-index focusable in the new markup. Returns true if written.
 */
export function setHTML(el, html) {
  if (!el || el._html === html) return false;
  const a = document.activeElement;
  const idx = a && a !== el && el.contains(a) ? $$(FOCUSABLE, el).indexOf(a) : -1;
  el.innerHTML = html;
  el._html = html;
  if (idx >= 0) { const n = $$(FOCUSABLE, el)[idx]; if (n) n.focus({ preventScroll: true }); }
  return true;
}

// ================================================================== registries

const cards = new Map();   // name -> normalized def (+ el)
const tiles = [];          // { id, order, render, _seq }
const heads = [];          // { id, order, render, _seq }
let seq = 0;
let booted = false;

const SECTION_TITLES = { live: 'Live', weather: 'Weather & sky', water: 'Water & the Locks', move: 'Getting around', safety: 'Safety', community: 'Community' };

/**
 * Register (or replace) a card. def = { deps: [sourceIds], render(D, ctx) -> html | null, clock?, section?, title?,
 * wide?, order?, after?(el, ctx) }. Uses the existing [data-card=name] element, or creates one in `section`.
 * Returns the card element (null if it has no container).
 */
export function registerCard(name, def) {
  if (!name || !def || typeof def.render !== 'function') throw new TypeError(`registerCard('${name}'): def.render must be a function`);
  const c = { ...def, deps: Array.isArray(def.deps) ? def.deps.slice() : [] };
  const prev = cards.get(name);
  c.el = prev && prev.el && prev.el.isConnected ? prev.el : ensureCardEl(name, c);
  cards.set(name, c);
  if (booted) invalidate(name);
  return c.el || null;
}
/** The current def of a card (to wrap or extend a built-in), or null. */
export const getCard = (name) => cards.get(name) || null;
/** Registered card names, in registration order. */
export const cardNames = () => [...cards.keys()];

function ensureCardEl(name, def) {
  const found = document.querySelector(`[data-card="${CSS.escape(name)}"]`);
  if (found) return found;
  const grid = ensureSection(def.section || 'live', def.sectionTitle);
  if (!grid) return null;
  const el = document.createElement('article');
  el.className = `card${def.wide ? ' wide' : ''}`;
  el.dataset.card = name;
  el.innerHTML = `<header><h3>${esc(def.title || name)}</h3><span class="meta"></span></header><div class="body"></div>`;
  const ord = isNum(def.order) ? def.order : Infinity;
  if (isNum(def.order)) el.dataset.order = def.order;
  const before = [...grid.children].find((x) => orderOf(x) > ord);
  grid.insertBefore(el, before || null);
  if (!isNum(def.order)) el.dataset.order = String(Math.max(0, ...[...grid.children].filter((x) => x !== el).map(orderOf).filter(isNum)) + 10);
  observeCard(el);
  return el;
}
const orderOf = (el) => (el.dataset.order != null && el.dataset.order !== '' ? +el.dataset.order : Infinity);

/** The .cards grid of section `id`, creating the section if needed ('live' goes between the glance tiles and the map). */
function ensureSection(id, title) {
  let sec = document.getElementById(id);
  if (!sec) {
    const main = $('main');
    if (!main) return null;
    sec = document.createElement('section');
    sec.id = id;
    sec.className = 'section';
    const label = title || SECTION_TITLES[id] || id.charAt(0).toUpperCase() + id.slice(1);
    sec.innerHTML = `<div class="section-head"><h2>${esc(label)}</h2></div><div class="cards"></div>`;
    const anchor = id === 'live' ? $('#map-section') : $('#health');
    main.insertBefore(sec, anchor && anchor.parentNode === main ? anchor : null);
    // A jump-nav link, placed like the section itself.
    const nav = $('.jump');
    if (nav && !nav.querySelector(`a[href="#${CSS.escape(id)}"]`)) {
      const a = document.createElement('a');
      a.href = `#${id}`;
      a.textContent = label;
      nav.insertBefore(a, nav.querySelector(id === 'live' ? 'a[href="#map-section"]' : 'a[href="#health"]'));
    }
  }
  let grid = sec.querySelector('.cards');
  if (!grid) { grid = document.createElement('div'); grid.className = 'cards'; sec.appendChild(grid); }
  if (!grid.dataset.ordered) {
    // Existing cards get orders 0, 10, 20, ... so new cards can be placed between them.
    [...grid.children].forEach((x, i) => { if (x.dataset.order == null) x.dataset.order = String(i * 10); });
    grid.dataset.ordered = '1';
  }
  if (ro) grid.classList.add('masonry');
  return grid;
}

/**
 * Register (or replace, by id) a glance tile. def = { id, order?, render(D, ctx) -> html | html[] | null }.
 * Built-in orders are 100 (weather) … 800 (911). Build the markup with tile().
 */
export function registerTile(def) {
  return addTo(tiles, def, 'registerTile');
}
/**
 * Register (or replace, by id) a heads-up strip item. def = { id, order?, render(D, ctx) -> html | html[] | null }.
 * Built-in orders: 0 server down, 100 NWS alerts … 1000 air quality. Build the markup with hu().
 */
export function registerHeadsup(def) {
  return addTo(heads, def, 'registerHeadsup');
}
function addTo(list, def, fn) {
  if (!def || !def.id || typeof def.render !== 'function') throw new TypeError(`${fn}: { id, render } required`);
  const i = list.findIndex((x) => x.id === def.id);
  const d = { ...def, order: isNum(def.order) ? def.order : 10000, _seq: i >= 0 ? list[i]._seq : seq++ };
  if (i >= 0) list[i] = d; else list.push(d);
  list.sort((a, b) => a.order - b.order || a._seq - b._seq);
  if (booted) schedule();
  return () => { const j = list.indexOf(d); if (j >= 0) { list.splice(j, 1); if (booted) schedule(); } };
}

/** Glance tile markup. key (optional) marks the value for the auto-flash. v, s and k are HTML (escape data yourself). */
export const tile = ({ href = '#', k = '', v = '', s = '', cls = '', key = null }) =>
  `<a class="tile ${cls}" href="${href}"><div class="k">${k}</div><div class="v"${key ? ` data-live-key="${esc(key)}"` : ''}>${v}</div><div class="s">${s}</div></a>`;
/** Heads-up item markup: a link when href is given, else a plain box. cls: 'info' | 'warn' | 'danger'. b, small are HTML. */
export const hu = ({ cls = 'info', href = null, title = null, b = '', small = '' }) => {
  const tag = href != null ? 'a' : 'div';
  return `<${tag} class="hu ${cls}"${href != null ? ` href="${href}"` : ''}${title != null ? ` title="${esc(title)}"` : ''}><span class="dot"></span><b>${b}</b><span class="small">${small}</span></${tag}>`;
};

// ================================================================== render scheduling

let pendingIds = new Set(), pendingChanged = new Set(), pendingTargets = new Set(), rafQueued = false;

/** Mark a source as updated: its cards (and glance, heads-up, health, map) re-render in the next frame. */
export function notify(id, changed = true) {
  pendingIds.add(id);
  if (changed) pendingChanged.add(id);
  schedule();
}
/** Schedule a re-render: card names, or 'cards' | 'all' | 'clock' (cards with clock: true) | 'glance' | 'headsup' | 'health'. */
export function invalidate(...targets) {
  for (const t of targets.flat()) if (t) pendingTargets.add(t);
  schedule();
}
function schedule() {
  if (rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(flush);
}
function flush() {
  rafQueued = false;
  const ids = pendingIds, changed = pendingChanged, targets = pendingTargets;
  pendingIds = new Set(); pendingChanged = new Set(); pendingTargets = new Set();
  const all = targets.has('all') || targets.has('cards'), clock = targets.has('clock');
  for (const [name, c] of cards) {
    if (all || targets.has(name) || (clock && c.clock) || c.deps.some((d) => ids.has(d))) renderCard(name);
  }
  renderGlance();
  renderHeadsup();
  emit('render', { ids, changed, targets });
}

/** Render every card, the glance tiles and the heads-up strip now (synchronously). */
export function renderAll() {
  for (const name of cards.keys()) renderCard(name);
  renderGlance();
  renderHeadsup();
  emit('render', { ids: new Set(), changed: new Set(), targets: new Set(['all']) });
}

function makeCtx(target, now) {
  return { ui, now, env, meta, D, card: target, series: (key, hours = 24) => seriesFor(target, key, hours) };
}

/** Render one card now. Normally you want invalidate(name) instead (batched into the next frame). */
export function renderCard(name) {
  const c = cards.get(name);
  if (!c) return;
  const el = c.el && c.el.isConnected ? c.el : document.querySelector(`[data-card="${CSS.escape(name)}"]`);
  if (!el) return;
  c.el = el;
  const body = el.querySelector('.body');
  if (!body) return;
  const metaEl = el.querySelector('.meta');
  const now = Date.now();
  const envs = c.deps.map(env).filter(Boolean);
  const errs = envs.filter((e) => e.error);
  // The OLDEST source that has data, so a stale primary feed isn't masked by a fresh secondary one.
  const ages = envs.filter((e) => e.data != null && e.fetchedAt).map((e) => e.fetchedAt);
  const fetched = ages.length ? Math.min(...ages) : 0;
  const stale = envs.some((e) => store.isStale(e.id, now));
  if (metaEl && c.deps.length) {
    const cls = errs.length && errs.some((e) => e.data == null) ? 'err' : errs.length || stale ? 'stale' : fetched ? 'ok' : '';
    const title = errs.map((e) => `${e.id}: ${e.error}`).join('\n') || (fetched ? `Fetched ${full(fetched)}` : 'Loading');
    setHTML(metaEl, `${fetched ? relEl(fetched) : 'loading'}<span class="sd ${cls}" title="${esc(title)}"></span>`);
    if (metaEl.title !== title) metaEl.title = title;
  }
  const ctx = makeCtx(name, now);
  let html = null;
  try {
    html = c.render(D, ctx);
  } catch (err) {
    console.error(`card ${name}`, err);
    html = `<div class="err-note">This card hit a display error: ${esc(err.message)}</div>`;
  }
  if (html == null) {
    if (errs.length) html = `<div class="empty">Couldn't load this right now.</div><div class="err-note">${errs.map((e) => esc(e.error)).join('<br>')}</div><div class="tiny faint">Retrying automatically.</div>`;
    else html = '<div class="skeleton"></div>';
  } else if (errs.length && fetched) {
    html += `<div class="err-note" title="${esc(errs.map((e) => e.error).join('\n'))}">Showing last good data. The latest refresh failed.</div>`;
  }
  // Preserve scroll position of inner scrollers across re-renders; flash values that changed.
  const scrollers = $$('.scroll', body).map((s) => s.scrollTop);
  const before = liveSnapshot(body);
  const wrote = setHTML(body, html);
  if (wrote) {
    $$('.scroll', body).forEach((s, i) => { if (scrollers[i]) s.scrollTop = scrollers[i]; });
    liveFlash(body, before);
  }
  if (typeof c.after === 'function') {
    try { c.after(el, { ...ctx, changed: wrote }); } catch (err) { console.error(`card ${name} after()`, err); }
  }
}

function renderList(list, target) {
  const now = Date.now();
  const ctx = makeCtx(target, now);
  const out = [];
  for (const d of list) {
    try {
      const h = d.render(D, ctx);
      if (Array.isArray(h)) out.push(...h.filter(Boolean)); else if (h) out.push(h);
    } catch (err) {
      console.error(`${target} ${d.id}`, err);
    }
  }
  return out;
}
function renderGlance() {
  const el = $('#glance');
  if (!el) return;
  const html = renderList(tiles, 'glance').join('');
  const before = liveSnapshot(el);
  if (setHTML(el, html)) liveFlash(el, before);
}
function renderHeadsup() {
  const el = $('#headsup');
  if (!el) return;
  const items = renderList(heads, 'headsup');
  setHTML(el, items.join(''));
  el.hidden = !items.length;
}

// Interactions inside cards: [data-set="key=value"] toggles UI state and re-renders.
function onSetClick(ev) {
  const t = ev.target.closest && ev.target.closest('[data-set]');
  if (!t) return;
  ev.preventDefault();
  const [k, v] = t.dataset.set.split('=');
  const card = t.closest('[data-card]');
  ui[k] = v || '';
  saveUI();
  emit('ui', k, ui[k]);
  renderAll();
  // The clicked control was replaced: focus its successor (same value, e.g. a seg button, or same key,
  // e.g. 'Show all' -> 'Show less') so keyboard users aren't dropped back to the top of the page.
  const next = card && (card.querySelector(`[data-set="${CSS.escape(t.dataset.set)}"]`) || card.querySelector(`[data-set^="${CSS.escape(k)}="]`));
  if (next && next !== document.activeElement) next.focus({ preventScroll: true });
}

// ================================================================== masonry card packing

/**
 * .cards.masonry uses 4px grid rows with a 12px row gap, so a span of n rows is 16n - 12 px tall.
 * Each card spans just enough rows for its current height, which removes the empty space a plain grid
 * leaves under short cards in a row with a tall one. Cards are align-self:start, so setting the span
 * never changes a card's own height.
 * Spans are packed synchronously once (before the first paint), then updated in the next animation frame
 * after a card's height changes. Writing them inside the ResizeObserver callback reflows cards into other
 * columns, whose fractional widths differ by 1/64 px, and Chrome then reports "ResizeObserver loop completed
 * with undelivered notifications" (an error event on window). Width-only changes never write anything.
 */
let ro = null, spanPending = new Map(), spanRaf = 0;
const spanOf = (h) => `span ${Math.ceil((h + 12) / 16)}`;
function setSpan(el, h) {
  const v = spanOf(h);
  if (el.style.gridRowEnd !== v) el.style.gridRowEnd = v;
}
function initMasonry() {
  if (!window.ResizeObserver || ro) return; // plain grid
  ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const h = (e.borderBoxSize && e.borderBoxSize[0]) ? e.borderBoxSize[0].blockSize : e.target.getBoundingClientRect().height;
      if (e.target.style.gridRowEnd !== spanOf(h)) spanPending.set(e.target, h);
    }
    if (spanPending.size && !spanRaf) {
      spanRaf = requestAnimationFrame(() => {
        spanRaf = 0;
        const p = spanPending;
        spanPending = new Map();
        for (const [el, h] of p) setSpan(el, h);
      });
    }
  });
  for (const grid of $$('.cards')) grid.classList.add('masonry');
  const all = $$('.cards > .card');
  const heights = all.map((c) => c.getBoundingClientRect().height); // one layout for all reads, then all writes
  all.forEach((c, i) => setSpan(c, heights[i]));
  for (const card of all) ro.observe(card, { box: 'border-box' });
}
/** Keep a card element you added to a .cards grid packed (core does this for cards it creates). */
export function observeCard(el) {
  if (!ro || !el) return;
  if (el.parentElement && el.parentElement.classList.contains('cards')) el.parentElement.classList.add('masonry');
  setSpan(el, el.getBoundingClientRect().height);
  ro.observe(el, { box: 'border-box' });
}

// ================================================================== metric history

const hist = {
  cache: new Map(),     // key -> { s: [[t, v], ...] oldest first, hours: window loaded from the server (0 = live points only) }
  inflight: new Map(),  // key -> { hours, p }
  failedAt: new Map(),  // key -> time of the last failed fetch (no retry for 60 s)
  deps: new Map(),      // key -> Set of render targets that read it via ctx.series()
  supported: null,      // false after a 404 (a server without /api/history): history() then resolves {} without asking
  keys: [],
};
const since = (s, hours) => { const t0 = Date.now() - hours * 3600e3; return s.filter((p) => p[0] >= t0); };

/**
 * Metric time series from /api/history: Promise of { key: [[t, v], ...] } (oldest first; keys without data are
 * omitted; {} on servers without history). Cached, and kept live by 'metric' events. hours: 1-48 (default 24).
 */
export function history(keys, hours = 24) {
  const list = [...new Set([].concat(keys || []).filter((k) => typeof k === 'string' && k))];
  hours = Math.max(1, Math.min(48, +hours || 24));
  const pick = () => {
    const out = {};
    if (hist.supported === false) return out;
    for (const k of list) { const c = hist.cache.get(k); if (c && c.s.length) out[k] = since(c.s, hours); }
    return out;
  };
  if (!list.length || hist.supported === false) return Promise.resolve(pick());
  const waits = [], need = [];
  for (const k of list) {
    const c = hist.cache.get(k);
    if (c && c.hours >= hours) continue;
    const f = hist.inflight.get(k);
    if (f && f.hours >= hours) waits.push(f.p); else need.push(k);
  }
  if (need.length) waits.push(fetchHistory(need, hours));
  return Promise.all(waits).then(pick);
}
/** The cached series for key (possibly only live points), or null. Synchronous. */
history.cached = (key, hours = 24) => { const c = hist.cache.get(key); return c ? since(c.s, hours) : null; };
/** Every metric key the server has reported (from /api/history) or streamed. */
history.keys = () => hist.keys.slice();
/** true / false (server has no /api/history) / null (not known yet). */
history.supported = () => hist.supported;

function fetchHistory(keys, hours) {
  const now = Date.now();
  const todo = keys.filter((k) => !(hist.failedAt.get(k) > now - 60000));
  if (!todo.length) return Promise.resolve();
  const entry = { hours, p: null };
  entry.p = (async () => {
    try {
      const res = await fetch(`/api/history?keys=${todo.map(encodeURIComponent).join(',')}&hours=${hours}`, { cache: 'no-store' });
      if (res.status === 404) { hist.supported = false; res.text().catch(() => {}); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      hist.supported = true;
      if (j && Array.isArray(j.keys)) hist.keys = [...new Set([...j.keys, ...hist.keys])];
      for (const k of todo) {
        const got = j && j.series && Array.isArray(j.series[k]) ? j.series[k] : [];
        const c = hist.cache.get(k);
        hist.cache.set(k, { s: mergeSeries(got, c ? c.s : []), hours: Math.max(hours, c ? c.hours : 0) });
        hist.failedAt.delete(k);
        touchMetric(k);
      }
    } catch {
      for (const k of todo) hist.failedAt.set(k, Date.now());
    } finally {
      for (const k of todo) if (hist.inflight.get(k) === entry) hist.inflight.delete(k);
    }
  })();
  for (const k of todo) hist.inflight.set(k, entry);
  return entry.p;
}
function mergeSeries(a, b) {
  const m = new Map();
  for (const p of [...a, ...b]) if (Array.isArray(p) && isNum(p[0]) && isNum(p[1])) m.set(p[0], p[1]);
  const t0 = Date.now() - HIST_MAX_MS;
  return [...m].filter((p) => p[0] >= t0).sort((x, y) => x[0] - y[0]);
}
function applyMetric(m) {
  if (!m || typeof m.key !== 'string' || !isNum(m.t) || !isNum(m.v)) return;
  let c = hist.cache.get(m.key);
  if (!c) hist.cache.set(m.key, c = { s: [], hours: 0 });
  const s = c.s, last = s[s.length - 1];
  if (!last || m.t > last[0]) s.push([m.t, m.v]);
  else if (m.t === last[0]) last[1] = m.v;
  else c.s = mergeSeries(s, [[m.t, m.v]]);
  const t0 = Date.now() - HIST_MAX_MS;
  if (c.s.length && c.s[0][0] < t0) c.s = c.s.filter((p) => p[0] >= t0);
  if (!hist.keys.includes(m.key)) hist.keys.push(m.key);
  emit('metric', m);
  touchMetric(m.key);
}
function touchMetric(key) {
  const d = hist.deps.get(key);
  if (d && d.size) invalidate(...d);
}
function seriesFor(target, key, hours) {
  hours = Math.max(1, Math.min(48, +hours || 24));
  if (target) {
    let s = hist.deps.get(key);
    if (!s) hist.deps.set(key, s = new Set());
    s.add(target);
  }
  const c = hist.cache.get(key);
  if (c && c.hours >= hours) return since(c.s, hours);
  if (hist.supported !== false) history([key], hours); // re-renders `target` when it lands
  return null;
}
// After a reconnect, refetch what is cached so gaps from the outage are filled.
function resyncHistory() {
  const byHours = new Map();
  for (const [k, c] of hist.cache) {
    if (c.hours <= 0) continue;
    hist.failedAt.delete(k);
    if (!byHours.has(c.hours)) byHours.set(c.hours, []);
    byHours.get(c.hours).push(k);
  }
  for (const [h, keys] of byHours) fetchHistory(keys, h); // merges into the cache; readers keep the old series meanwhile
}

// ================================================================== activity

const act = { list: [], seen: new Set(), loaded: false, supported: null, inflight: null, resolve: null };
const actReady = new Promise((r) => { act.resolve = r; });
const actIds = (it) => [it.id != null ? `i:${it.id}` : null, it.key != null ? `k:${it.key}` : null].filter(Boolean);

export const activity = {
  /** Activity items, newest first (up to 500). */
  items: () => act.list.slice(),
  /** Resolves with items() once the initial list has loaded ([] on servers without /api/activity). */
  ready: actReady,
  /** true / false (server has no /api/activity) / null (not known yet). */
  supported: () => act.supported,
};

function addActivity(it, announce) {
  if (!it || typeof it !== 'object' || !it.title) return false;
  const ids = actIds(it);
  if (!ids.length || ids.some((k) => act.seen.has(k))) return false;
  for (const k of ids) act.seen.add(k);
  const t = isNum(it.t) ? it.t : Date.now();
  let i = act.list.findIndex((x) => (isNum(x.t) ? x.t : 0) <= t);
  if (i < 0) i = act.list.length;
  act.list.splice(i, 0, it);
  while (act.list.length > ACTIVITY_MAX) for (const k of actIds(act.list.pop())) act.seen.delete(k);
  if (announce) emit('activity', it);
  return true;
}
/** Load /api/activity. announce: emit 'activity' for items not seen yet (catch-up); otherwise it is the initial list. */
function loadActivity(limit, announce) {
  if (act.inflight) return act.inflight;
  act.inflight = (async () => {
    try {
      const res = await fetch(`/api/activity?limit=${limit}`, { cache: 'no-store' });
      if (res.status === 404) { act.supported = false; res.text().catch(() => {}); act.resolve(act.list.slice()); return; }
      if (!res.ok) return;
      const j = await res.json();
      act.supported = true;
      const items = (j && Array.isArray(j.items) ? j.items : []).slice().reverse(); // oldest first, so events arrive in order
      for (const it of items) addActivity(it, announce && act.loaded);
      act.loaded = true;
      act.resolve(act.list.slice());
    } catch { /* offline: retried on the next hello / activity poll */ } finally {
      act.inflight = null;
    }
  })();
  return act.inflight;
}

// ================================================================== transport

let mode = 'init';        // 'sse' while the stream is up, else 'polling'
let conn = null;          // 'live' | 'polling' | 'down' (null until known)
let es = null, esHello = false, everHello = false, sseFails = 0, sseRetryT = 0, helloT = 0, lastMsg = 0, lastFailure = null;
const timers = {};
let polling = false, actPollT = 0, downProbeT = 0;
const UNREACHABLE = 'Dashboard server unreachable';

/** Connection state: 'live' (stream up), 'polling', 'down' (server unreachable), or null before the first answer. */
export const connection = () => conn;
/** Transport details, for debugging and QA: { mode, connection, streamOpen, failures, lastFailure: {why, at}, lastMessageAt }. */
export const transport = () => ({ mode, connection: conn, streamOpen: !!(es && esHello), failures: sseFails, lastFailure, lastMessageAt: lastMsg || null });

function setConnection(c) {
  if (c === conn) return;
  conn = c;
  // While the server is unreachable, check every 5 s so recovery shows up quickly.
  clearInterval(downProbeT);
  downProbeT = c === 'down' ? setInterval(refreshSources, 5000) : 0;
  renderConn();
  emit('connection', c);
  invalidate('headsup', 'health');
}
function reachable(ok) {
  if (!ok) {
    if (!(mode === 'sse' && es && es.readyState === 1)) setConnection('down');
    return;
  }
  if (conn === 'down') {
    // Back from 'down' (e.g. the server restarted): reconnect the stream now rather than after the backoff,
    // and re-poll the feeds whose last poll failed only because the server was unreachable.
    if (!es && everHello && !FORCE_POLL) { sseFails = 0; connectStream(); }
    if (polling) { let i = 0; for (const id of order) if (state[id] && state[id].error === UNREACHABLE) schedulePoll(id, (i++) * 40); }
  }
  if (mode === 'sse') setConnection('live');
  else if (mode === 'polling' || conn === 'down') setConnection('polling');
}

function applyRows(list, info = {}) {
  const ids = [];
  for (const r of list) if (r && r.id) { rows[r.id] = { ...r }; ids.push(r.id); }
  for (const id of Object.keys(rows)) if (!ids.includes(id)) delete rows[id];
  order = ids;
  if (isNum(info.now)) server.now = info.now;
  if (Array.isArray(info.loadErrors)) server.loadErrors = info.loadErrors;
  if (polling) for (const id of ids) if (!(id in timers)) schedulePoll(id, 0);
  emit('sources', store.sources());
  invalidate('health');
}

function applyEnvelope(e, status = 200, idHint = null) {
  if (!e || typeof e !== 'object') return;
  const id = e.id || idHint;
  if (!id) return;
  const cur = state[id];
  let changed = false;
  if (e.data != null) {
    // A slow poll can land after a newer pushed envelope: never go back in time.
    if (cur && cur.data != null && isNum(cur.fetchedAt) && isNum(e.fetchedAt) && e.fetchedAt < cur.fetchedAt) return;
    let sig;
    try { sig = JSON.stringify(e.data); } catch { sig = String(Math.random()); }
    changed = sig !== sigs[id];
    sigs[id] = sig;
    state[id] = e.id ? e : { ...e, id };
  } else if (e.error || status !== 200) {
    state[id] = { ...(cur || { id }), error: e.error || `HTTP ${status}` };
  } else if (!cur) {
    state[id] = { ...e, id }; // pending: no data and no error yet
  } else {
    return;
  }
  // Keep the feed-health rows in step with what the cards show.
  const row = rows[id];
  if (row) {
    if (e.fetchedAt) row.fetchedAt = e.fetchedAt;
    if (e.expiresAt !== undefined && e.data != null) row.expiresAt = e.expiresAt;
    row.error = e.error || (e.data == null && status !== 200 ? `HTTP ${status}` : null);
  }
  emit('source', id, state[id], { changed });
  notify(id, changed);
}

async function refreshSources() {
  try {
    const res = await fetch('/api/sources', { cache: 'no-store' });
    const j = await res.json();
    if (!j || !Array.isArray(j.sources)) throw new Error('bad /api/sources');
    applyRows(j.sources, j);
    reachable(true);
    return true;
  } catch {
    reachable(false);
    return false;
  }
}

// ---------------------------------------------------------------- SSE

function connectStream() {
  clearTimeout(sseRetryT);
  sseRetryT = 0;
  if (es) return;
  if (typeof EventSource !== 'function' || FORCE_POLL) { startPolling(); return; }
  const src = new EventSource(STREAM_URL);
  es = src;
  esHello = false;
  clearTimeout(helloT);
  helloT = setTimeout(() => { if (es === src && !esHello) streamFailed(src, 'timeout'); }, HELLO_TIMEOUT);
  const handle = (fn) => (ev) => {
    if (es !== src) return;
    lastMsg = Date.now();
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    try { fn(d); } catch (err) { console.error(`[core] stream '${ev.type}'`, err); }
  };
  src.addEventListener('hello', handle(onHello));
  src.addEventListener('source', handle((e) => { if (esHello) applyEnvelope(e, 200); }));
  src.addEventListener('activity', handle((it) => addActivity(it, true)));
  src.addEventListener('metric', handle(applyMetric));
  src.addEventListener('ping', handle(() => {}));
  src.onerror = () => { if (es === src) streamFailed(src, src.readyState === 2 ? 'closed' : 'network'); };
}

function onHello(d) {
  clearTimeout(helloT);
  const first = !everHello;
  esHello = true;
  everHello = true;
  sseFails = 0;
  if (d && Array.isArray(d.sources)) applyRows(d.sources, d);
  if (hist.supported === false) hist.supported = null; // a server with a stream has history; ask again
  mode = 'sse';
  stopPolling();
  setConnection('live');
  // Catch up on what happened while disconnected (the source snapshots after hello cover the store).
  if (!act.loaded) { if (act.supported === false) act.supported = null; loadActivity(200, false); }
  else if (!first) loadActivity(100, true);
  if (!first) resyncHistory();
}

function streamFailed(src, why) {
  clearTimeout(helloT);
  try { src.close(); } catch { /* ignore */ }
  if (es === src) es = null;
  esHello = false;
  sseFails++;
  lastFailure = { why, at: Date.now() };
  mode = 'polling';
  startPolling();
  // An HTTP error before this page ever got a hello: most likely a server without /api/stream. Look again rarely.
  const noStream = !everHello && why === 'closed';
  const delay = noStream ? Math.min(600000, 120000 * sseFails) : Math.min(30000, 1000 * 2 ** Math.min(5, sseFails - 1)) + Math.random() * 500;
  sseRetryT = setTimeout(connectStream, delay);
  refreshSources(); // decides between 'polling' (server up) and 'down'
}

// ---------------------------------------------------------------- polling fallback

const dueAt = (id) => { const e = state[id]; return e.expiresAt ?? (e.fetchedAt + ttlOf(id) * 1000); };
function schedulePoll(id, delay) {
  clearTimeout(timers[id]);
  timers[id] = setTimeout(() => poll(id), delay);
}
function startPolling() {
  if (polling) return;
  polling = true;
  mode = 'polling';
  const now = Date.now();
  let i = 0;
  for (const id of order) {
    const e = state[id];
    const due = e && e.data != null && e.fetchedAt ? dueAt(id) : 0;
    schedulePoll(id, due > now ? due - now + 1500 : (i++) * 40);
  }
  clearInterval(actPollT);
  actPollT = setInterval(() => { if (act.supported !== false) loadActivity(act.loaded ? 50 : 200, true); }, 30000);
}
function stopPolling() {
  polling = false;
  for (const id of Object.keys(timers)) { clearTimeout(timers[id]); delete timers[id]; }
  clearInterval(actPollT);
}

/** Fetch one source now (once: don't schedule the next poll). */
async function poll(id, once = false) {
  if (!once) clearTimeout(timers[id]);
  let delay = 30000;
  try {
    // no-cache: revalidate (ETag -> 304 on servers that send one) instead of always downloading the body.
    const res = await fetch(`/api/${encodeURIComponent(id)}`, { cache: 'no-cache' });
    const e = await res.json();
    applyEnvelope(e && typeof e === 'object' ? e : { error: `HTTP ${res.status}` }, res.status, id);
    reachable(true);
    const ttl = ttlOf(id);
    // expiresAt: fetchedAt + ttl, or the next Pacific midnight for daily sources (older servers omit it).
    if (e && e.data != null && e.fetchedAt) delay = Math.max(10000, (e.expiresAt ?? (e.fetchedAt + ttl * 1000)) - Date.now() + 1500);
    else delay = Math.min(60000, ttl * 1000);
  } catch {
    delay = 15000;
    if (!(mode === 'sse' && esHello)) { // with the stream up, it is authoritative: one failed poll changes nothing
      state[id] = { ...(state[id] || { id }), error: UNREACHABLE };
      reachable(false);
      emit('source', id, state[id], { changed: false });
      notify(id, false);
    }
  }
  if (polling && !once) schedulePoll(id, delay);
}

/** Back on the tab (or back online): make sure the stream is healthy and nothing is overdue. */
function checkFreshness() {
  if (document.visibilityState !== 'visible') return;
  if (!es && everHello) { sseFails = 0; connectStream(); }
  else if (es && esHello && Date.now() - lastMsg > 60000) streamFailed(es, 'silent');
  const now = Date.now();
  for (const id of order) {
    const e = state[id];
    const late = !e || !e.fetchedAt || now > dueAt(id) + (mode === 'sse' ? 30000 : 0);
    if (!late) continue;
    if (polling) { clearTimeout(timers[id]); poll(id); } else poll(id, true);
  }
}

// ================================================================== header: connection indicator, feature buttons

function renderConn() {
  let el = document.getElementById('bl-conn');
  if (!el) {
    const clock = document.getElementById('clock');
    if (!clock) return;
    el = document.createElement('span');
    el.id = 'bl-conn';
    el.className = 'bl-conn';
    el.setAttribute('role', 'status');
    el.innerHTML = '<i aria-hidden="true"></i><span class="bl-conn-t"></span>';
    clock.after(el);
  }
  el.hidden = !conn;
  el.dataset.state = conn || '';
  el.querySelector('.bl-conn-t').textContent = { live: 'LIVE', polling: 'polling', down: 'offline' }[conn] || '';
  el.title = {
    live: 'Live: the server pushes updates the moment it sees them',
    polling: 'Polling: each feed is checked on its refresh timer (live stream unavailable)',
    down: "Offline: can't reach the dashboard server. Retrying.",
  }[conn] || '';
}

/**
 * Add (or update, by id) a button in the header, before the theme toggle. Returns the <button>.
 * { id, label (short text or emoji), title, onClick(ev), html? (trusted markup instead of label) }
 */
export function addHeaderButton({ id, label = '', title = '', onClick, html = null } = {}) {
  const right = $('.topbar-right');
  if (!right) return null;
  let b = id ? document.getElementById(id) : null;
  if (!b) {
    b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn';
    if (id) b.id = id;
    const theme = $('#theme-btn', right);
    right.insertBefore(b, theme && theme.parentNode === right ? theme : null);
  }
  if (html != null) b.innerHTML = html; else b.textContent = label;
  if (title) { b.title = title; b.setAttribute('aria-label', title); }
  if (b._blClick) b.removeEventListener('click', b._blClick);
  b._blClick = typeof onClick === 'function' ? onClick : null;
  if (b._blClick) b.addEventListener('click', b._blClick);
  return b;
}

// ================================================================== clock

function startClock() {
  let lastMin = Math.floor(Date.now() / 60000);
  const tick = () => {
    const now = Date.now();
    emit('tick', now);
    for (const el of document.querySelectorAll('[data-countdown]')) {
      const t = +el.dataset.countdown;
      if (!t) continue;
      const s = countdownText(t, now);
      if (el.textContent !== s) el.textContent = s;
    }
    const m = Math.floor(now / 60000);
    if (m !== lastMin) {
      lastMin = m;
      emit('minute', now);
      if (pparts(now).mm === 0) renderAll(); // hourly: hour-based labels ("Now" column, day rollovers)
    }
    if (es && esHello && now - lastMsg > SILENT_MS) streamFailed(es, 'silent');
  };
  tick();
  setInterval(tick, 1000);
  setInterval(() => invalidate('clock'), 30000); // clock cards, glance tiles, heads-up
}

// ================================================================== start

/** Boot: render, load the source list (retrying while the server is down), then open the stream (or poll). */
export async function start() {
  if (booted) return;
  booted = true;
  document.addEventListener('click', onSetClick);
  startClock();
  renderAll();
  initMasonry(); // after the first render, so the synchronous packing measures the skeletons
  loadActivity(200, false);
  for (let attempt = 0; !(await refreshSources()); attempt++) await sleep(Math.min(10000, 1000 * 2 ** attempt));
  setInterval(refreshSources, 20000);
  document.addEventListener('visibilitychange', checkFreshness);
  window.addEventListener('online', () => { refreshSources(); if (!es && everHello) { sseFails = 0; connectStream(); } });
  connectStream();
}
