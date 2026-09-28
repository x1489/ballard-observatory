// Formatting and small rendering helpers shared by the dashboard.
export const TZ = 'America/Los_Angeles';
export const CENTER = [47.6687, -122.3847];

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
export const r0 = (n) => (isNum(n) ? Math.round(n) : '–');
export const r1 = (n) => (isNum(n) ? (Math.round(n * 10) / 10).toFixed(1) : '–');

/** Safe external link: only http(s). */
export const href = (u) => (/^https?:\/\//i.test(u || '') ? esc(u) : '#');
/** Camera images go through the local server's /img proxy (SDOT's CDN rejects some browsers). */
export const camSrc = (u, v) => esc(`/img?u=${encodeURIComponent(u || '')}&v=${v || Math.floor(Date.now() / 60000)}`);

const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const fmtHour = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric' });
const fmtWd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
const fmtMD = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' });
const fmtFull = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtLong = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric' });
const partsF = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });

export const time = (t) => (isNum(t) ? fmtTime.format(t).replace(' AM', ' am').replace(' PM', ' pm') : '–');
export const hour = (t) => (isNum(t) ? fmtHour.format(t).replace(' AM', 'a').replace(' PM', 'p') : '');
export const wd = (t) => (isNum(t) ? fmtWd.format(t) : '');
export const md = (t) => (isNum(t) ? fmtMD.format(t) : '');
export const full = (t) => (isNum(t) ? fmtFull.format(t) : '–');
export const longDate = (t) => fmtLong.format(t);

export function pparts(t = Date.now()) {
  const o = {};
  for (const p of partsF.formatToParts(t)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour % 24, mm: +o.minute, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) };
}
export const dayKey = (t) => { const p = pparts(t); return p.y * 10000 + p.m * 100 + p.d; };

/** Human day label relative to today: 'Today', 'Tomorrow', 'Sat Sep 26'. */
export function dayLabel(t) {
  const k = dayKey(t), p = pparts(Date.now()), today = p.y * 10000 + p.m * 100 + p.d;
  // Next calendar day by date arithmetic, not now + 24h (wrong in the first hour of a 25-hour DST day).
  const n = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  const tom = n.getUTCFullYear() * 10000 + (n.getUTCMonth() + 1) * 100 + n.getUTCDate();
  if (k === today) return 'Today';
  if (k === tom) return 'Tomorrow';
  return `${wd(t)} ${md(t)}`;
}

/** '5m ago', 'in 12m', 'just now'. */
export function rel(t, now = Date.now()) {
  if (!isNum(t)) return '–';
  const s = Math.round((t - now) / 1000), a = Math.abs(s);
  let v;
  if (a < 45) return s < 0 ? 'just now' : 'now';
  if (a < 3600) v = Math.round(a / 60) >= 60 ? '1h' : `${Math.round(a / 60)}m`;
  else if (a < 86400 * 2) {
    let h = Math.floor(a / 3600), m = Math.round((a % 3600) / 60);
    if (m === 60) { h++; m = 0; }
    v = `${h}h${h < 10 && m ? ` ${m}m` : ''}`;
  }
  else v = `${Math.round(a / 86400)}d`;
  return s < 0 ? `${v} ago` : `in ${v}`;
}
/** Live-updating relative time element. */
export const relEl = (t) => `<time data-rel="${isNum(t) ? t : ''}" title="${esc(full(t))}">${rel(t)}</time>`;

export function duration(ms) {
  if (!isNum(ms)) return '–';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg) => (isNum(deg) ? COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16] : '');
/** Arrow pointing where the wind blows TO (deg is where it comes FROM). */
export const windArrow = (deg) => (isNum(deg) ? `<span class="warrow" style="display:inline-block;transform:rotate(${deg + 180}deg)" aria-hidden="true">↑</span>` : '');

const WMO = {
  0: ['Clear', '☀️', '🌙'], 1: ['Mostly clear', '🌤️', '🌙'], 2: ['Partly cloudy', '⛅', '☁️'], 3: ['Overcast', '☁️', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Freezing fog', '🌫️'], 51: ['Light drizzle', '🌦️', '🌧️'], 53: ['Drizzle', '🌦️', '🌧️'], 55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'], 61: ['Light rain', '🌦️', '🌧️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'], 71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
  80: ['Showers', '🌦️', '🌧️'], 81: ['Showers', '🌧️'], 82: ['Heavy showers', '🌧️'], 85: ['Snow showers', '🌨️'], 86: ['Snow showers', '🌨️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm, hail', '⛈️'], 99: ['Thunderstorm, hail', '⛈️'],
};
export const wxText = (code) => (WMO[code] ? WMO[code][0] : '—');
export const wxIcon = (code, isDay = true) => { const w = WMO[code]; if (!w) return '·'; return (!isDay && w[2]) || w[1]; };

export function aqiInfo(aqi) {
  if (!isNum(aqi)) return { label: '—', color: '#9ca3af' };
  if (aqi <= 50) return { label: 'Good', color: '#4ade80' };
  if (aqi <= 100) return { label: 'Moderate', color: '#facc15' };
  if (aqi <= 150) return { label: 'Unhealthy for sensitive groups', short: 'USG', color: '#fb923c' };
  if (aqi <= 200) return { label: 'Unhealthy', color: '#ef4444' };
  if (aqi <= 300) return { label: 'Very unhealthy', color: '#a855f7' };
  return { label: 'Hazardous', color: '#9f1239', ink: '#fff' }; // ink: text color on the swatch (default #111)
}

/** Minimal SVG sparkline. points: [{x, y}] (numbers). */
export function sparkline(values, { w = 280, h = 44, stroke = 'var(--accent)', fill = true, min, max, dots = false } = {}) {
  const v = values.filter((p) => isNum(p.x) && isNum(p.y));
  if (v.length < 2) return '';
  const xs = v.map((p) => p.x), ys = v.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = min ?? Math.min(...ys), y1 = max ?? Math.max(...ys);
  const sx = (x) => ((x - x0) / (x1 - x0 || 1)) * (w - 4) + 2;
  const sy = (y) => h - 3 - ((y - y0) / (y1 - y0 || 1)) * (h - 6);
  const d = v.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
  const area = fill ? `<path d="${d}L${sx(x1).toFixed(1)},${h}L${sx(x0).toFixed(1)},${h}Z" fill="${stroke}" opacity=".12"/>` : '';
  const dd = dots ? v.map((p) => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="1.6" fill="${stroke}"/>`).join('') : '';
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="height:${h}px" aria-hidden="true">${area}<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linejoin="round"/>${dd}</svg>`;
}

export function distLabel(km) {
  if (!isNum(km)) return '';
  const mi = km * 0.621371;
  return mi < 0.2 ? `${Math.round(mi * 5280 / 10) * 10} ft` : `${mi.toFixed(mi < 10 ? 1 : 0)} mi`;
}

export const plural = (n, s, p = s + 's') => `${n} ${n === 1 ? s : p}`;

// ---------------------------------------------------------------- live values: flash, tween, countdowns

/** True when the viewer asked the OS for reduced motion (flash and tween then do nothing visible). */
export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** True when the page is in dark mode (explicit data-theme wins over the OS setting). */
export function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Brief highlight on an element whose value just changed (class .bl-flash from core.css, ~1.2 s).
 * Calling it again while it is flashing restarts the highlight. No-op with prefers-reduced-motion.
 */
export function flash(el) {
  if (!el || !el.classList || reducedMotion()) return;
  el.classList.remove('bl-flash');
  void el.offsetWidth; // restart the CSS animation
  el.classList.add('bl-flash');
  clearTimeout(el._blFlashT);
  el._blFlashT = setTimeout(() => el.classList.remove('bl-flash'), 1500);
}

/**
 * Animate el.textContent from one number to another over `ms` (ease-out), formatting each frame with fmt(v).
 * Cancels any tween already running on el. With reduced motion (or non-numbers) it sets the final text at once.
 * Returns a function that stops the tween and shows the final value.
 */
export function tween(el, from, to, fmt = (v) => String(Math.round(v)), ms = 700) {
  if (!el) return () => {};
  if (el._blTween) el._blTween();
  if (!isNum(from) || !isNum(to) || from === to || ms <= 0 || reducedMotion() || typeof requestAnimationFrame !== 'function') {
    el.textContent = fmt(to);
    return () => {};
  }
  let raf = 0;
  const t0 = performance.now();
  const stop = () => { cancelAnimationFrame(raf); el.textContent = fmt(to); if (el._blTween === stop) el._blTween = null; };
  const step = (t) => {
    const p = Math.min(1, Math.max(0, (t - t0) / ms));
    el.textContent = fmt(from + (to - from) * (1 - (1 - p) ** 3));
    if (p < 1) raf = requestAnimationFrame(step); else if (el._blTween === stop) el._blTween = null;
  };
  el._blTween = stop;
  el.textContent = fmt(from);
  raf = requestAnimationFrame(step);
  return stop;
}

/**
 * Mark a value for core's auto-flash: when a card (or glance tile) re-renders and the text of the element with
 * the same key changed, core flashes it. Keys only need to be unique within one card.
 *   `${live('temp', r0(c.tempF) + '°')}`  ->  <span data-live-key="temp">54°</span>
 */
export const live = (key, html, tag = 'span') => `<${tag} data-live-key="${esc(key)}">${html}</${tag}>`;
/** The attribute alone, for an element you already write: `<b ${liveAttr('gust')}>…</b>`. */
export const liveAttr = (key) => `data-live-key="${esc(key)}"`;
/**
 * A number that core tweens from its previous value (and flashes) when it changes between renders.
 * dp = decimal places. null/undefined render as '–' and never tween.
 */
export const liveNum = (key, n, dp = 0, tag = 'span') =>
  `<${tag} data-live-key="${esc(key)}" data-live-num="${isNum(n) ? n : ''}" data-live-dp="${dp}">${isNum(n) ? n.toFixed(dp) : '–'}</${tag}>`;

/** Snapshot of the [data-live-key] values under root: Map key -> { text, num }. Take it before re-rendering. */
export function liveSnapshot(root) {
  const m = new Map();
  if (root && root.querySelectorAll) for (const el of root.querySelectorAll('[data-live-key]')) m.set(el.dataset.liveKey, { text: el.textContent, num: el.dataset.liveNum });
  return m;
}
/**
 * After re-rendering root, flash every [data-live-key] whose text differs from the snapshot (and tween the
 * [data-live-num] ones from their old number). Keys that are new or gone are ignored. Returns the count flashed.
 */
export function liveFlash(root, before) {
  if (!root || !before || !before.size) return 0;
  let n = 0;
  for (const el of root.querySelectorAll('[data-live-key]')) {
    const old = before.get(el.dataset.liveKey);
    if (!old || old.text === el.textContent) continue;
    const a = parseFloat(old.num), b = parseFloat(el.dataset.liveNum);
    if (isNum(a) && isNum(b) && a !== b) {
      const dp = Math.max(0, Math.min(6, +el.dataset.liveDp || 0));
      tween(el, a, b, (v) => v.toFixed(dp));
    }
    flash(el);
    n++;
  }
  return n;
}

/** Countdown text to t: '4:05' under an hour, '2h 05m' beyond, 'now' once reached. */
export function countdownText(t, now = Date.now()) {
  if (!isNum(t)) return '–';
  const s = Math.ceil((t - now) / 1000);
  if (s <= 0) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
/** A countdown that core re-renders every second: <time data-countdown="t">4:05</time>. */
export const countdownEl = (t) => `<time data-countdown="${isNum(t) ? t : ''}" title="${esc(full(t))}">${countdownText(t)}</time>`;
/** A small "new" badge (styled by core.css): `${title} ${newBadge()}`. */
export const newBadge = (label = 'new') => `<span class="bl-new">${esc(label)}</span>`;

/**
 * Open an accessible modal dialog: focus trap, Esc / backdrop click to close, focus returned on close.
 * html is trusted markup for the body. Returns { el (the dialog), body, close() }. Re-opening the same id closes it.
 */
export function openDialog({ id, title, html = '', onClose = null, wide = false } = {}) {
  const prev = id && document.getElementById(id);
  if (prev) { prev._blClose && prev._blClose(); return null; }
  const back = document.createElement('div');
  back.className = 'bl-dialog-back';
  const labelId = `${id || 'dlg'}-title`;
  back.innerHTML = `<div class="bl-dialog${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="${esc(labelId)}"${id ? ` id="${esc(id)}"` : ''}>
    <header><h3 id="${esc(labelId)}">${esc(title || '')}</h3><button type="button" class="icon-btn bl-dialog-x" aria-label="Close"><svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></header>
    <div class="bd">${html}</div></div>`;
  const dlg = back.firstElementChild;
  const opener = document.activeElement;
  const focusables = () => [...dlg.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])')].filter((x) => !x.hidden && x.offsetParent !== null);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  };
  function close() {
    document.removeEventListener('keydown', onKey, true);
    back.remove();
    document.documentElement.classList.remove('bl-modal-open');
    if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus({ preventScroll: true });
    if (onClose) { try { onClose(); } catch (err) { console.error('dialog onClose', err); } }
  }
  dlg._blClose = close;
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  dlg.querySelector('.bl-dialog-x').addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(back);
  document.documentElement.classList.add('bl-modal-open');
  const first = focusables().find((x) => !x.classList.contains('bl-dialog-x')) || dlg.querySelector('.bl-dialog-x');
  first.focus({ preventScroll: true });
  return { el: dlg, body: dlg.querySelector('.bd'), close };
}
