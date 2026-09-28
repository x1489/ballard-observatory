// Ballard Stories: an Instagram-style ring bar under the hero and a full-screen story viewer, generated from live
// data: Today (with a snapshot of the living scene), Bridges (the day's openings, each Ballard Bridge opening paired
// with the camera frame nearest to it), Cameras (3-hour time-lapses recorded by the server), Wildlife, Weather (radar loop),
// the Locks, Tonight, and 911. Tap/click right or left, arrow keys, swipe; hold to pause; Esc closes.
// Seen state per story is kept in localStorage ('bl-stories-seen'). Emits/listens 'stories:open' ({ id, at }).
import { icon } from '../icons.js';
import { usualOf } from '../baseline.js';
import { moments, SUMMARY } from '../insight.js';

const SEEN_KEY = 'bl-stories-seen';
const BRIDGE_CAM = 'CMR-0390'; // 15th Ave W & W Nickerson St, looking north at the Ballard Bridge
const FRAME_MS = 5500;

export default function init(api) {
  const u = api.util;
  const { esc, isNum, r0, r1, time, rel, dayLabel, reducedMotion } = u;
  let cams = { cameras: [] }, camsAt = 0;
  const seen = () => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {}; } catch { return {}; } };
  const markSeen = (id, sig) => { try { const s = seen(); s[id] = sig; localStorage.setItem(SEEN_KEY, JSON.stringify(s)); } catch { /* ignore */ } };
  async function loadCams(force) {
    if (!force && Date.now() - camsAt < 60000) return cams;
    try { const r = await fetch('/api/cams', { cache: 'no-cache' }); if (r.ok) { cams = await r.json(); camsAt = Date.now(); } } catch { /* offline */ }
    return cams;
  }
  const frameUrl = (id, t) => `/cam/${encodeURIComponent(id)}/${t}.jpg`;
  const nearestFrame = (id, t) => {
    const c = (cams.cameras || []).find((x) => x.id === id);
    if (!c || !c.frames.length) return null;
    let best = null;
    for (const f of c.frames) if (!best || Math.abs(f - t) < Math.abs(best - t)) best = f;
    return best != null && Math.abs(best - t) < 6 * 60e3 ? frameUrl(id, best) : null;
  };
  // The living scene as a story image: rendered on demand (when its frame is shown) in portrait, via the hero's
  // 'hero:render' hook, so it is crisp at story size; frames just carry the HERO placeholder until then.
  const HERO = 'hero:scene';
  const heroSnapshot = () => {
    try {
      const cv = document.createElement('canvas');
      cv.width = 720; cv.height = 1280;
      const req = { canvas: cv, w: 720, h: 1280 };
      api.emit('hero:render', req);
      if (req.done) return cv.toDataURL('image/jpeg', 0.86);
      const c = document.querySelector('#hero canvas');
      return c && c.width ? c.toDataURL('image/jpeg', 0.82) : null;
    } catch { return null; }
  };

  // ------------------------------------------------ story builders: each returns { id, title, icon, frames: [...] } or null
  // frame: { kicker, title, body, image?, images? (time-lapse), bg? (css), cta?: { label, href } }
  function buildStories(now) {
    const D = api.D;
    const out = [];
    // Today
    {
      const frames = [];
      const w = SUMMARY.weather(D, now), sun = SUMMARY.sun(D, now), tide = SUMMARY.tide(D, now), br = SUMMARY.bridge(D, now), bus = SUMMARY.bus(D, now);
      if (w) frames.push({ kicker: new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long', month: 'long', day: 'numeric' }).format(now), title: `${w.value} and ${w.sub.split(' · ')[0].toLowerCase()}`, body: w.sub.split(' · ').slice(1).join(' · '), image: HERO });
      const mo = moments(D, now, { baseline: usualOf }).slice(0, 3);
      for (const m of mo) frames.push({ kicker: m.kicker, title: m.title, body: m.body, image: m.image || null, bg: m.tone === 'warn' ? 'warn' : 'accent', ic: m.icon, cta: m.link ? { label: 'Open', href: m.link } : { label: 'Details', href: m.href } });
      const facts = [br && `${br.label}: ${br.value}`, bus && `${bus.label}: ${bus.value}`, tide && `Tide: ${tide.value}, ${tide.sub.toLowerCase()}`, sun && `${sun.label} ${sun.value} (${sun.sub})`].filter(Boolean);
      if (facts.length) frames.push({ kicker: 'At a glance', title: 'Ballard right now', list: facts, bg: 'night', ic: 'sparkle' });
      if (frames.length) out.push({ id: 'today', title: 'Today', icon: 'sparkle', frames });
    }
    // Bridges: the last 24 hours at a glance (the bridges source's opening log), then each Ballard Bridge opening
    // paired with the camera frame nearest to it, then the odds for the next half hour.
    {
      const br = D('bridges');
      const log = ((br && br.log) || []).filter((l) => isNum(l.upAt) && now - l.upAt < 24 * 3600e3).sort((a, b) => b.upAt - a.upAt);
      const frames = [];
      if (log.length) {
        const by = new Map();
        for (const l of log) { const x = by.get(l.bridge) || { n: 0, mins: 0 }; x.n += 1; x.mins += isNum(l.minutes) ? l.minutes : 0; by.set(l.bridge, x); }
        const upNow = ((br && br.bridges) || []).filter((b) => b.up).map((b) => b.name);
        frames.push({ kicker: 'Last 24 hours', title: u.plural(log.length, 'bridge opening'), list: [...by.entries()].sort((a, b) => b[1].n - a[1].n).map(([name, x]) => `${name} · ${x.n}×${x.mins ? ` · ${r0(x.mins)} min in all` : ''}`), body: upNow.length ? `Up right now: ${upNow.join(', ')}.` : 'All bridges are down right now.', bg: 'accent', ic: 'bridge', cta: { label: 'Bridge details', href: '#water' } });
      }
      for (const l of log.filter((x) => /ballard/i.test(x.bridge)).slice(0, 5)) {
        frames.push({ kicker: `${dayLabel(l.upAt)} · ${time(l.upAt)}`, title: 'The Ballard Bridge opened', body: isNum(l.minutes) ? `Up for ${Math.max(1, r0(l.minutes))} min while boats passed${isNum(l.downAt) ? `, back down at ${time(l.downAt)}` : ''}.` : 'Raised for boats; road traffic stopped.', image: nearestFrame(BRIDGE_CAM, l.upAt + 90e3), bg: 'warn', ic: 'bridge', cta: { label: 'Bridge details', href: '#water' } });
      }
      const odds = D('bridge-odds');
      if (odds && odds.now) frames.push({ kicker: 'Next 30 minutes', title: odds.now.restricted ? 'Rush-hour rule in effect' : `${r0(odds.now.chanceNext30Min * 100)}% chance of an opening`, body: odds.now.restricted ? `No openings for most boats until ${time(odds.next)}.` : `Ballard usually sees ~${r1(odds.now.expectedPerHour)} openings an hour now, about ${r0(odds.now.typicalMinutes || 4)} minutes each.`, image: nearestFrame(BRIDGE_CAM, now), bg: 'accent', ic: 'bridge' });
      if (frames.length) out.push({ id: 'bridges', title: 'Bridges', icon: 'bridge', frames });
    }
    // Cameras: 3-hour time-lapses
    {
      const labels = Object.fromEntries(((D('cameras') || {}).cameras || []).map((c) => [c.id, c.label]));
      const frames = (cams.cameras || []).filter((c) => c.frames.length >= 3).map((c) => ({
        kicker: `Time-lapse · ${time(c.frames[0])}–${time(c.frames[c.frames.length - 1])}`, title: labels[c.id] || c.label || c.id,
        body: `${c.frames.length} frames, one every ~2 minutes, recorded by this dashboard.`, images: c.frames.map((t) => frameUrl(c.id, t)), camId: c.id, ic: 'camera',
      }));
      if (frames.length) out.push({ id: 'cams', title: 'Cameras', icon: 'camera', frames });
    }
    // Wildlife
    {
      const w = D('wildlife');
      const obs = ((w && w.observations) || []).filter((o) => o.photo && /^https:\/\/[\w.-]+\/[\w/.%~-]+$/.test(o.photo)).slice(0, 10);
      if (obs.length) out.push({ id: 'wildlife', title: 'Wildlife', icon: 'wildlife', frames: obs.map((o) => ({ kicker: `${o.t ? dayLabel(o.t) : ''} · iNaturalist`, title: o.taxon.common || o.taxon.name, body: [o.taxon.common ? o.taxon.name : null, o.place ? o.place.replace(/, Seattle, WA, US$|, WA, US$|, US$/, '') : null, o.user ? `by ${o.user}` : null].filter(Boolean).join(' · '), image: o.photo, ic: 'wildlife', cta: { label: 'View on iNaturalist', href: o.url, ext: true } })) });
    }
    // Weather
    {
      const w = D('weather'), r = D('radar'), nws = D('nws-forecast');
      const frames = [];
      if (w && w.current) {
        const c = w.current, d0 = (w.daily || [])[0] || {};
        frames.push({ kicker: 'Now', title: `${r0(c.tempF)}°, ${u.wxText(c.code).toLowerCase()}`, body: `Feels ${r0(c.feelsF)}° · wind ${r0(c.windMph)} mph · high ${r0(d0.hiF)}°, low ${r0(d0.loF)}°`, image: HERO, ic: 'weather' });
      }
      if (r && r.loopGif) frames.push({ kicker: `Radar · ${time(r.valid)}`, title: 'Rain over western Washington', body: 'The last hour of NEXRAD from Camano Island.', image: r.loopGif, contain: true, ic: 'weather' });
      for (const p of ((nws && nws.periods) || []).slice(0, 2)) frames.push({ kicker: 'NWS forecast', title: p.name, body: p.detail || p.short, bg: 'night', ic: 'weather' });
      if (frames.length) out.push({ id: 'weather', title: 'Weather', icon: 'weather', frames });
    }
    // The Locks
    {
      const frames = [];
      const l = D('lockages'), s = D('salmon'), lake = D('lake');
      if (l && l.today) frames.push({ kicker: 'Ballard Locks today', title: `${l.today.total} lockages`, body: `${l.today.up} into the lake, ${l.today.down} out to the Sound${l.queued ? ` · ${l.queued} waiting now` : ''}.`, list: (l.recent || []).slice(0, 5).map((v) => `${v.direction === 'up' ? '↑' : '↓'} ${v.name.trim().toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase())}${isNum(v.end) ? ` · ${time(v.end)}` : ''}`), bg: 'accent', ic: 'locks' });
      for (const sp of ((s && s.species) || []).filter((x) => (x.latestCount || 0) > 0)) frames.push({ kicker: `Fish ladder · ${sp.latestDate}`, title: `${sp.latestCount.toLocaleString()} ${sp.name.toLowerCase()}`, body: `Season total ${isNum(sp.total) ? sp.total.toLocaleString() : '—'} (WDFW, preliminary).`, bg: 'water', ic: 'wildlife' });
      if (lake && isNum(lake.ft)) frames.push({ kicker: 'Lake Washington Ship Canal', title: `${lake.ft.toFixed(2)} ft above the Locks`, body: isNum(lake.outflowCfs) ? `${r0(lake.outflowCfs)} cubic feet per second flowing out to the Sound.` : '', bg: 'water', ic: 'water' });
      if (frames.length) out.push({ id: 'locks', title: 'Locks', icon: 'locks', frames });
    }
    // Tonight
    {
      const ev = D('events');
      const p = u.pparts(now);
      const endOfDay = now + ((24 - p.hh) * 60 - p.mm) * 60e3 + 2 * 3600e3;
      const list = ((ev && ev.events) || []).filter((e) => !e.allDay && !e.canceled && e.start > now - 30 * 60e3 && e.start < endOfDay).sort((a, b) => a.start - b.start).slice(0, 8);
      if (list.length) out.push({ id: 'tonight', title: p.hh >= 15 ? 'Tonight' : 'Events', icon: 'event', frames: list.map((e) => ({ kicker: `${time(e.start)}${e.venue ? ` · ${e.venue}` : ''}`, title: e.title, body: [e.cost, e.source].filter(Boolean).join(' · '), bg: 'event', ic: 'event', cta: { label: 'Event page', href: e.url, ext: true } })) });
    }
    // 911
    {
      const f = D('fire911');
      const inc = ((f && f.incidents) || []).filter((x) => now - x.t < 12 * 3600e3).slice(0, 6);
      if (inc.length) out.push({ id: 'fire', title: '911', icon: 'fire', frames: inc.map((x) => ({ kicker: `${time(x.t)} · ${rel(x.t, now)}`, title: x.type, body: `${x.address || ''}${x.units ? ` · ${x.units}` : ''}${x.active ? ' · still active' : ''}`, bg: x.active ? 'warn' : 'night', ic: 'fire', cta: { label: 'On the map', href: '#map-section' } })) });
    }
    return out;
  }
  const sigOf = (s) => `${s.frames.length}|${s.frames.map((f) => f.title).join('|')}`.slice(0, 400);

  // ------------------------------------------------ the ring bar
  const bar = document.createElement('section');
  bar.className = 'st-bar';
  bar.setAttribute('aria-label', 'Stories');
  const hero = document.getElementById('hero');
  const main = document.querySelector('main');
  (hero && hero.parentNode === main) ? hero.after(bar) : main.insertBefore(bar, document.getElementById('glance'));
  let stories = [];
  function renderBar() {
    stories = buildStories(Date.now());
    const s = seen();
    api.setHTML(bar, stories.map((st) => `<button type="button" class="st-ring ${s[st.id] === sigOf(st) ? 'seen' : ''}" data-story="${esc(st.id)}" aria-label="${esc(st.title)} story, ${st.frames.length} ${st.frames.length === 1 ? 'card' : 'cards'}">
      <span class="st-av">${icon(st.icon, { size: 22 })}</span><span class="st-name">${esc(st.title)}</span></button>`).join(''));
  }
  bar.addEventListener('click', (e) => { const b = e.target.closest('[data-story]'); if (b) open(b.dataset.story); });

  // ------------------------------------------------ the viewer
  let v = null; // { root, si, fi, timer, start, elapsed, paused, lapse }
  function open(id, at = 0) {
    renderBar();
    const si = Math.max(0, stories.findIndex((s) => s.id === id));
    if (!stories.length) return;
    if (!v) {
      const root = document.createElement('div');
      root.className = 'st-view';
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-label', 'Stories');
      root.innerHTML = `<div class="st-stage"><div class="st-prog"></div>
        <div class="st-top"><span class="st-av sm"></span><span class="st-ttl"></span><span class="st-when"></span>
          <button type="button" class="st-pp" aria-label="Pause">${icon('pause', { size: 18 })}</button><button type="button" class="st-x" aria-label="Close stories">${icon('close', { size: 20 })}</button></div>
        <div class="st-frame"></div>
        <button type="button" class="st-nav prev" aria-label="Previous">${icon('left', { size: 26 })}</button><button type="button" class="st-nav next" aria-label="Next">${icon('right', { size: 26 })}</button></div>`;
      document.body.appendChild(root);
      document.documentElement.classList.add('bl-modal-open');
      v = { root, si, fi: at, timer: 0, start: 0, elapsed: 0, paused: false, lapse: 0, opener: document.activeElement };
      wire(root);
    }
    v.si = si; v.fi = Math.min(at, stories[si].frames.length - 1);
    show();
    v.root.querySelector('.st-x').focus({ preventScroll: true });
  }
  function close() {
    if (!v) return;
    clearTimeout(v.timer); clearInterval(v.lapse); cancelAnimationFrame(v.raf);
    v.root.remove();
    document.documentElement.classList.remove('bl-modal-open');
    if (v.opener && document.contains(v.opener)) v.opener.focus({ preventScroll: true });
    v = null;
    renderBar();
  }
  function frameHTML(f) {
    const src = f.image === HERO ? heroSnapshot() : f.image;
    const img = src ? `<img class="st-img ${f.contain ? 'contain' : ''}" src="${esc(src)}" alt="">` : '';
    const lapse = f.images ? `<img class="st-img lapse" src="${esc(f.images[0])}" alt=""><div class="st-lapse-bar"><span></span></div>` : '';
    const list = f.list ? `<ul class="st-list">${f.list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
    const cta = f.cta && f.cta.href ? `<a class="st-cta" href="${f.cta.ext ? u.href(f.cta.href) : esc(f.cta.href)}" ${f.cta.ext ? 'target="_blank" rel="noopener"' : 'data-close'}>${esc(f.cta.label)} ${icon('right', { size: 15 })}</a>` : '';
    return `<div class="st-card bg-${esc(f.bg || 'night')}${f.image || f.images ? ' has-img' : ''}">${img}${lapse}
      ${!f.image && !f.images ? `<div class="st-big-ico">${icon(f.ic || 'sparkle', { size: 64 })}</div>` : ''}
      <div class="st-text"><div class="st-kick">${esc(f.kicker || '')}</div><div class="st-title">${esc(f.title || '')}</div>${f.body ? `<div class="st-body">${esc(f.body)}</div>` : ''}${list}${cta}</div></div>`;
  }
  function show() {
    const st = stories[v.si];
    const f = st.frames[v.fi];
    const root = v.root;
    root.querySelector('.st-av.sm').innerHTML = icon(st.icon, { size: 16 });
    root.querySelector('.st-ttl').textContent = st.title;
    root.querySelector('.st-when').textContent = `${v.fi + 1}/${st.frames.length}`;
    root.querySelector('.st-prog').innerHTML = st.frames.map((_, i) => `<span class="${i < v.fi ? 'done' : ''}"><i></i></span>`).join('');
    root.querySelector('.st-frame').innerHTML = frameHTML(f);
    clearInterval(v.lapse);
    const dur = f.images ? Math.min(12000, Math.max(FRAME_MS, f.images.length * 110)) : FRAME_MS;
    if (f.images) {
      const img = root.querySelector('.st-img.lapse');
      const barEl = root.querySelector('.st-lapse-bar span');
      f.images.forEach((src) => { const im = new Image(); im.src = src; });
      let k = 0;
      v.lapse = setInterval(() => { if (v.paused) return; k = (k + 1) % f.images.length; img.src = f.images[k]; barEl.style.width = `${((k + 1) / f.images.length) * 100}%`; }, Math.max(80, dur / f.images.length));
    }
    if (st.id) markSeen(st.id, v.fi === st.frames.length - 1 ? sigOf(st) : (seen()[st.id] || ''));
    v.dur = dur; v.elapsed = 0; v.start = performance.now();
    tick();
  }
  function tick() {
    cancelAnimationFrame(v.raf);
    const step = () => {
      if (!v) return;
      const now = performance.now();
      if (!v.paused) v.elapsed += now - v.start;
      v.start = now;
      const cur = v.root.querySelector('.st-prog span:nth-child(' + (v.fi + 1) + ') i');
      if (cur) cur.style.width = `${Math.min(100, (v.elapsed / v.dur) * 100)}%`;
      if (v.elapsed >= v.dur) { next(); return; }
      v.raf = requestAnimationFrame(step);
    };
    v.raf = requestAnimationFrame(step);
  }
  function next() {
    const st = stories[v.si];
    if (v.fi < st.frames.length - 1) { v.fi++; show(); return; }
    markSeen(st.id, sigOf(st));
    if (v.si < stories.length - 1) { v.si++; v.fi = 0; show(); return; }
    close();
  }
  function prev() {
    if (v.fi > 0) { v.fi--; show(); return; }
    if (v.si > 0) { v.si--; v.fi = stories[v.si].frames.length - 1; show(); return; }
    show();
  }
  function setPaused(p) {
    if (!v) return;
    v.paused = p;
    v.root.classList.toggle('paused', p);
    const b = v.root.querySelector('.st-pp');
    b.innerHTML = icon(p ? 'play' : 'pause', { size: 18 });
    b.setAttribute('aria-label', p ? 'Play' : 'Pause');
  }
  function wire(root) {
    root.querySelector('.st-x').addEventListener('click', close);
    root.querySelector('.st-pp').addEventListener('click', () => setPaused(!v.paused));
    root.querySelector('.st-nav.next').addEventListener('click', next);
    root.querySelector('.st-nav.prev').addEventListener('click', prev);
    root.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
    const frame = root.querySelector('.st-frame');
    let downAt = 0, downX = 0, held = false, holdTimer = 0;
    frame.addEventListener('pointerdown', (e) => { downAt = Date.now(); downX = e.clientX; held = false; holdTimer = setTimeout(() => { held = true; setPaused(true); }, 250); });
    frame.addEventListener('pointerup', (e) => {
      clearTimeout(holdTimer);
      if (held) { setPaused(false); return; }
      if (e.target.closest('a,button')) return;
      const dx = e.clientX - downX;
      if (Math.abs(dx) > 50) { if (dx < 0) next(); else prev(); return; }
      if (Date.now() - downAt < 400) { const r = frame.getBoundingClientRect(); if (e.clientX - r.left < r.width * 0.33) prev(); else next(); }
    });
    frame.addEventListener('pointerleave', () => { clearTimeout(holdTimer); if (held) { held = false; setPaused(false); } });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
      else if (e.key === ' ') { e.preventDefault(); setPaused(!v.paused); }
      else if (e.key === 'Tab') {
        const f = [...root.querySelectorAll('button,a[href]')].filter((x) => x.offsetParent !== null);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
    if (reducedMotion()) setPaused(true);
  }
  document.addEventListener('visibilitychange', () => { if (v && document.visibilityState !== 'visible') setPaused(true); }); // once, not per open

  // Camera cards get a "▶ Time-lapse" button.
  const camCard = api.getCard('cameras');
  if (camCard) {
    api.registerCard('cameras', { ...camCard, render(D, ctx) {
      const h = camCard.render(D, ctx);
      const n = (cams.cameras || []).filter((c) => c.frames.length >= 3).length;
      return h == null ? h : `${n ? `<div class="st-camrow"><button type="button" class="bl-btn" data-story-open="cams">${icon('play', { size: 14 })} Play 3-hour time-lapses (${n})</button></div>` : ''}${h}`;
    } });
  }
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-story-open]'); if (b) { e.preventDefault(); open(b.dataset.storyOpen); } });
  api.on('stories:open', (x) => open((x && x.id) || 'today', (x && x.at) || 0));

  // refresh the bar when data changes (cheaply: at most every 20 s)
  let lastBar = 0;
  const maybe = () => { if (Date.now() - lastBar > 20000 && !v) { lastBar = Date.now(); renderBar(); } };
  api.on('render', maybe);
  api.on('activity', () => { lastBar = 0; maybe(); });
  api.on('minute', () => { loadCams().then(() => { api.invalidate('cameras'); lastBar = 0; maybe(); }); });
  loadCams(true).then(() => { renderBar(); api.invalidate('cameras'); });
  renderBar();
  const qs = new URLSearchParams(location.search).get('story');
  if (qs) api.on('features', () => setTimeout(() => open(qs), 600));
}
