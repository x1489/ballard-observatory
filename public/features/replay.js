// Replay: play back the last 24 hours of Ballard on the map. A "▶ Replay" button in the map header opens a transport
// bar (play/pause, speed, 24 h scrubber). Located activity items (911 calls, bridge openings, wildlife, incidents,
// low aircraft, …) appear on the map at their real times and fade with age, while a readout shows conditions at
// that moment from the metric history (temperature, wind, AQI, bridge state, lockages, scooters, bus delay, drive).
// Deep link: /?panel=replay. Emit 'replay:open' to open it from elsewhere.
import { icon, kindIcon } from '../icons.js';

const H = 3600e3;
const KEYS = ['weather.tempF', 'weather.windMph', 'purpleair.aqi', 'bridges.ballardUp', 'lockages.today', 'lime.near', 'transit.delay.D', 'traffic.downtown1991', 'aircraft.airborne', 'fire911.count24h'];
const SEV_COLOR = { info: '#64748b', notice: '#0d9488', warn: '#ea580c', alert: '#dc2626' };

export default function init(api) {
  const u = api.util;
  const { esc, isNum, r0, time, dayLabel, reducedMotion } = u;
  const head = document.querySelector('#map-section .section-head');
  const wrap = document.querySelector('#map-section .map-wrap');
  if (!head || !wrap) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'rp-open';
  btn.innerHTML = `${icon('replay', { size: 16 })} Replay last 24 h`;
  head.appendChild(btn);

  let bar = null, group = null, series = {}, items = [], t0 = 0, t1 = 0, cur = 0, playing = false, speed = 1, raf = 0, lastTs = 0;

  const valueAt = (key, t) => {
    const s = series[key];
    if (!s || !s.length) return null;
    let lo = 0, hi = s.length - 1;
    if (t < s[0][0] - 20 * 60e3) return null;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid][0] <= t) lo = mid; else hi = mid - 1; }
    return t - s[lo][0] < 3 * H ? s[lo][1] : null;
  };

  function readout(t) {
    const v = (k) => valueAt(k, t);
    const bits = [];
    if (isNum(v('weather.tempF'))) bits.push(`${icon('thermo', { size: 14 })} ${r0(v('weather.tempF'))}°`);
    if (isNum(v('weather.windMph'))) bits.push(`${icon('wind', { size: 14 })} ${r0(v('weather.windMph'))} mph`);
    if (isNum(v('purpleair.aqi'))) bits.push(`${icon('air', { size: 14 })} AQI ${r0(v('purpleair.aqi'))}`);
    if (isNum(v('bridges.ballardUp'))) bits.push(`${icon('bridge', { size: 14 })} ${v('bridges.ballardUp') >= 1 ? '<b class="rp-up">bridge UP</b>' : 'bridge down'}`);
    if (isNum(v('lockages.today'))) bits.push(`${icon('locks', { size: 14 })} ${r0(v('lockages.today'))} lockages`);
    if (isNum(v('transit.delay.D'))) { const d = v('transit.delay.D'); bits.push(`${icon('transit', { size: 14 })} D ${Math.abs(d) < 1 ? 'on time' : d > 0 ? `${r0(d)} min late` : `${r0(-d)} min early`}`); }
    if (isNum(v('traffic.downtown1991'))) bits.push(`${icon('traffic', { size: 14 })} ${r0(v('traffic.downtown1991'))} min downtown`);
    if (isNum(v('lime.near'))) bits.push(`${icon('pin', { size: 14 })} ${r0(v('lime.near'))} scooters`);
    if (isNum(v('aircraft.airborne'))) bits.push(`${icon('aircraft', { size: 14 })} ${r0(v('aircraft.airborne'))} aircraft`);
    return bits.map((b) => `<span>${b}</span>`).join('') || '<span class="rp-muted">No history recorded for this time yet.</span>';
  }

  function drawAt(t) {
    if (!group) return;
    group.clearLayers();
    const win = 90 * 60e3; // show the last 90 minutes of events at time t, fading
    for (const it of items) {
      if (it.t > t || t - it.t > win) continue;
      const age = (t - it.t) / win;
      const fresh = t - it.t < 8 * 60e3;
      const m = L.marker([it.lat, it.lon], {
        icon: L.divIcon({ className: 'rp-marker', html: `<div class="rp-dot${fresh ? ' fresh' : ''}" style="--c:${SEV_COLOR[it.severity] || '#64748b'}">${kindIcon(it.kind, { size: 13 })}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
        opacity: Math.max(0.25, 1 - age * 0.85), interactive: true, keyboard: false,
      }).bindTooltip(`<b>${esc(it.title)}</b><br>${time(it.t)}`, { direction: 'top', offset: [0, -10] });
      group.addLayer(m);
    }
    const cl = bar.querySelector('.rp-clock');
    cl.textContent = `${dayLabel(t)} ${time(t)}`;
    api.setHTML(bar.querySelector('.rp-read'), readout(t));
    const r = bar.querySelector('input[type=range]');
    const pos = Math.round(((t - t0) / (t1 - t0)) * 1000);
    if (+r.value !== pos) r.value = String(pos);
    const n = items.filter((it) => it.t <= t && t - it.t <= win).length;
    bar.querySelector('.rp-count').textContent = n ? `${n} event${n === 1 ? '' : 's'} on the map` : '';
  }

  function loop(ts) {
    raf = 0;
    if (!playing || !bar) return;
    const dt = lastTs ? Math.min(100, ts - lastTs) : 16;
    lastTs = ts;
    cur += dt * speed * (H / 2000); // 1 hour per 2 s at 1x
    if (cur >= t1) { cur = t1; setPlaying(false); }
    drawAt(cur);
    if (playing) raf = requestAnimationFrame(loop);
  }
  function setPlaying(p) {
    playing = p;
    if (!bar) return;
    const b = bar.querySelector('.rp-play');
    b.innerHTML = icon(p ? 'pause' : 'play', { size: 18 });
    b.setAttribute('aria-label', p ? 'Pause replay' : 'Play replay');
    lastTs = 0;
    if (p && !raf) { if (cur >= t1) cur = t0; raf = requestAnimationFrame(loop); }
  }

  async function open() {
    const map = api.map.getMap && api.map.getMap();
    if (!map || bar) return;
    t1 = Date.now(); t0 = t1 - 24 * H;
    items = api.activity.items().filter((it) => isNum(it.lat) && isNum(it.lon) && it.t >= t0 && it.t <= t1).sort((a, b) => a.t - b.t);
    series = await api.history(KEYS, 24).catch(() => ({})) || {};
    // Start where the record starts (a dashboard that has only been running a few hours has less than 24 h).
    const first = Math.min(...Object.values(series).map((s) => (s && s.length ? s[0][0] : Infinity)), items.length ? items[0].t : Infinity);
    if (isFinite(first)) t0 = Math.max(t0, Math.floor((first - 10 * 60e3) / 60e3) * 60e3);
    cur = t0;
    bar = document.createElement('div');
    bar.className = 'rp-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Replay the last 24 hours');
    const ticks = items.map((it) => `<i style="left:${(((it.t - t0) / (t1 - t0)) * 100).toFixed(2)}%;background:${SEV_COLOR[it.severity] || '#64748b'}" title="${esc(time(it.t))} · ${esc(it.title)}"></i>`).join('');
    bar.innerHTML = `<div class="rp-top"><button type="button" class="rp-play" aria-label="Play replay">${icon('play', { size: 18 })}</button>
        <span class="rp-clock"></span><span class="rp-count"></span><span class="rp-hint"></span>
        <span class="rp-speed" role="group" aria-label="Speed">${[1, 3, 10].map((s) => `<button type="button" data-speed="${s}" class="${s === 1 ? 'on' : ''}" aria-pressed="${s === 1}">${s}×</button>`).join('')}</span>
        <button type="button" class="rp-x" aria-label="Close replay">${icon('close', { size: 16 })}</button></div>
      <div class="rp-track"><div class="rp-ticks">${ticks}</div><input type="range" min="0" max="1000" value="0" aria-label="Replay time"></div>
      <div class="rp-read"></div>`;
    wrap.appendChild(bar);
    wrap.classList.add('replaying');
    group = L.layerGroup().addTo(map);
    bar.querySelector('.rp-play').addEventListener('click', () => setPlaying(!playing));
    bar.querySelector('.rp-x').addEventListener('click', close);
    bar.querySelector('input[type=range]').addEventListener('input', (e) => { setPlaying(false); cur = t0 + (+e.target.value / 1000) * (t1 - t0); drawAt(cur); });
    bar.querySelector('.rp-speed').addEventListener('click', (e) => {
      const b = e.target.closest('[data-speed]');
      if (!b) return;
      speed = +b.dataset.speed;
      for (const x of bar.querySelectorAll('[data-speed]')) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); }
    });
    bar.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); if (e.key === ' ' && e.target.tagName !== 'BUTTON') { e.preventDefault(); setPlaying(!playing); } });
    btn.setAttribute('aria-expanded', 'true');
    const span = t1 - t0;
    bar.querySelector('.rp-hint').textContent = span < 23 * H ? `recorded since ${dayLabel(t0)} ${time(t0)}` : '';
    drawAt(cur);
    if (!reducedMotion()) setPlaying(true);
    bar.querySelector('.rp-play').focus({ preventScroll: true });
  }
  function close() {
    setPlaying(false);
    cancelAnimationFrame(raf); raf = 0;
    if (group) { group.remove(); group = null; }
    if (bar) { bar.remove(); bar = null; }
    wrap.classList.remove('replaying');
    btn.setAttribute('aria-expanded', 'false');
    btn.focus({ preventScroll: true });
  }
  btn.addEventListener('click', () => (bar ? close() : open()));
  api.on('replay:open', open);
  if (new URLSearchParams(location.search).get('panel') === 'replay') api.on('features', () => setTimeout(() => { document.getElementById('map-section')?.scrollIntoView({ block: 'start' }); open(); }, 1500));
}
