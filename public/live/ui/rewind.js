// Rewind: play back the last day of Ballard (every recorded aircraft, bus and train moving as it did, the bridges
// opening when they opened, 911 calls appearing when they came in) under the sun as it was at that moment.
import { createReplay, statesAt } from '../replay.js';
import { esc } from '../fmt.js';
import { icon } from './icons.js';

const TZ = 'America/Los_Angeles';
const fmtT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const SPEEDS = [1, 10, 60, 300];

export function createRewind(app, { toast }) {
  const R = createReplay();
  const bar = document.createElement('div');
  bar.className = 'rewind glass';
  bar.hidden = true;
  bar.innerHTML = `<button class="rw-play" data-rw="play" aria-label="Play or pause">${icon('play')}</button>
    <button class="rw-speed" data-rw="speed" aria-label="Playback speed">1×</button>
    <input class="rw-slider" type="range" min="0" max="1000" value="1000" aria-label="Time">
    <div class="rw-time num"><b data-rw="time">–</b><small data-rw="note">Rewind</small></div>
    <button class="btn primary" data-rw="live">Back to live</button>`;
  document.body.appendChild(bar);
  const slider = bar.querySelector('.rw-slider');
  const S = { on: false, t: 0, t0: 0, t1: 0, playing: false, speed: 10, raf: 0, last: 0, rec: null, recKey: '', lastSun: 0, lastInc: 0, missing: false };

  const setPlayIcon = () => { bar.querySelector('[data-rw="play"]').innerHTML = icon(S.playing ? 'pause' : 'play'); };
  function applyState() {
    const L = app.layers;
    if (S.rec) {
      const st = statesAt(S.rec, S.t);
      L.air.setReplay(st.aircraft); L.bus.setReplay(st.buses); L.train.setReplay(st.trains);
    } else { L.air.setReplay([]); L.bus.setReplay([]); L.train.setReplay([]); }
    L.bridge.setReplayTime(S.t);
    if (Math.abs(S.t - S.lastInc) > 20e3) { L.incidents.setReplayTime(S.t); S.lastInc = S.t; }
    if (Math.abs(S.t - S.lastSun) > 60e3) { app.scene.setSunTime(S.t); S.lastSun = S.t; }
    bar.querySelector('[data-rw="time"]').textContent = fmtT.format(S.t).replace(' AM', ' am').replace(' PM', ' pm');
    bar.querySelector('[data-rw="note"]').textContent = S.missing ? 'nothing recorded for this hour' : `Rewind · ${S.speed}×`;
    slider.value = String(Math.round(((S.t - S.t0) / Math.max(1, S.t1 - S.t0)) * 1000));
  }
  async function loadAt(t) {
    const key = new Date(t).toISOString().slice(0, 13);
    if (key === S.recKey) return;
    S.recKey = key;
    const rec = await R.recordAt(t);
    if (S.recKey !== key) return;
    S.rec = rec; S.missing = !rec;
  }
  function frame(ts) {
    if (!S.on) return;
    S.raf = requestAnimationFrame(frame);
    const dt = S.last ? ts - S.last : 0;
    S.last = ts;
    if (S.playing) {
      S.t = Math.min(S.t1, S.t + dt * S.speed);
      if (S.t >= S.t1) { S.playing = false; setPlayIcon(); }
    }
    loadAt(S.t);
    applyState();
  }
  async function open() {
    if (S.on) return;
    const idx = await R.index(true);
    const hours = (idx.hours || []).map(([d, h]) => Date.parse(`${d}T${String(h).padStart(2, '0')}:00:00${offsetFor(d)}`)).filter(Number.isFinite).sort((a, b) => a - b);
    if (!hours.length) { toast('Rewind is recording; the first hour becomes available soon.'); return; }
    S.t1 = Math.min(Date.now() - 60e3, idx.last || idx.updated || Date.now());
    S.t0 = Math.max(idx.from || hours[0], S.t1 - 24 * 3600e3);
    S.t = Math.max(S.t0, S.t1 - 20 * 60e3);
    S.on = true; S.playing = true; S.speed = 10; S.last = 0; S.recKey = ''; S.lastSun = 0; S.lastInc = 0;
    bar.querySelector('[data-rw="speed"]').textContent = `${S.speed}×`;
    setPlayIcon();
    app.scene.setClock(() => S.t);
    document.body.classList.add('rewinding');
    bar.hidden = false;
    app.closeSheet();
    S.raf = requestAnimationFrame(frame);
  }
  function close() {
    if (!S.on) return;
    S.on = false; cancelAnimationFrame(S.raf);
    const L = app.layers;
    L.air.setReplay(null); L.bus.setReplay(null); L.train.setReplay(null);
    L.bridge.setReplayTime(null); L.incidents.setReplayTime(null);
    app.scene.setClock(null); app.scene.setSunTime(null);
    document.body.classList.remove('rewinding');
    bar.hidden = true;
  }
  // Pacific UTC offset for a date (PDT -07:00 / PST -08:00)
  function offsetFor(d) {
    const t = Date.parse(`${d}T12:00:00Z`);
    const h = +new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit' }).format(t);
    return h === 5 ? '-07:00' : '-08:00';
  }
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rw]');
    if (!b) return;
    if (b.dataset.rw === 'play') { if (S.t >= S.t1) S.t = S.t0; S.playing = !S.playing; setPlayIcon(); }
    else if (b.dataset.rw === 'speed') { S.speed = SPEEDS[(SPEEDS.indexOf(S.speed) + 1) % SPEEDS.length]; b.textContent = `${S.speed}×`; }
    else if (b.dataset.rw === 'live') close();
  });
  slider.addEventListener('input', () => { S.t = S.t0 + (+slider.value / 1000) * (S.t1 - S.t0); S.lastSun = 0; S.lastInc = 0; });
  return { open, close, get on() { return S.on; }, get time() { return S.t; }, toggle() { if (S.on) close(); else open(); } };
}
