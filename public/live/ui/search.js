// ⌘K search across everything: flights in the air, bus routes, the bridges, the ISS, addresses (every address with
// public records) and the observatory's findings.
import { esc, num } from '../fmt.js';
import { icon } from './icons.js';
import { normAddr, prettyAddr } from './briefing.js';

export function createSearch(app) {
  const el = document.createElement('div');
  el.className = 'search glass';
  el.innerHTML = `<div class="in">${icon('search')}<input type="search" placeholder="Search flights, bus routes, addresses, findings…" autocomplete="off" spellcheck="false" aria-label="Search"><span class="kbd">esc</span></div><div class="res"></div>`;
  document.body.appendChild(el);
  const input = el.querySelector('input'), res = el.querySelector('.res');
  let index = null, hits = [], sel = 0;
  async function ensure() {
    if (index) return index;
    try { const j = await app.store.obs('place_index.json'); index = j.rows.map((r) => ({ k: r[0], n: r[4], names: r[8] || [] })); } catch { index = []; }
    return index;
  }
  const row = (h, i) => `<button class="row ${i === sel ? 'on' : ''}" data-i="${i}"><div class="b" style="background:${h.bg || 'rgba(255,255,255,.08)'};color:${h.fg || 'var(--text)'}">${h.icon ? icon(h.icon) : esc(h.badge || '')}</div><div><div class="t">${esc(h.t)}</div><div class="s">${esc(h.s || '')}</div></div><div class="r"><small>${esc(h.kind || '')}</small></div></button>`;
  async function run(q) {
    const t = q.trim(), lq = t.toLowerCase();
    const out = [];
    if (t) {
      for (const a of app.layers.air.list()) {
        const r = a.rec || {};
        if ([r.callsign, r.reg, a.hex, r.type, r.operator].some((x) => x && String(x).toLowerCase().includes(lq)))
          out.push({ t: r.callsign || r.reg || a.hex.toUpperCase(), s: `${a.spec ? a.spec.desc : r.type || ''} · ${r.onGround ? 'on the ground' : `${num(Math.round((r.altFt || 0) / 100) * 100)} ft`}`, icon: 'plane', fg: 'var(--air)', bg: 'rgba(90,200,250,.14)', kind: 'Flight', go: ['aircraft', a.hex] });
      }
      const routes = new Map();
      for (const b of app.layers.bus.list()) if (b.route && (b.route.short.toLowerCase() === lq || b.route.short.toLowerCase().startsWith(lq) || (b.route.name || '').toLowerCase().includes(lq))) { if (!routes.has(b.route.short)) routes.set(b.route.short, []); routes.get(b.route.short).push(b); }
      for (const [short, list] of routes) out.push({ t: `${short}`, s: `${list.length} bus${list.length > 1 ? 'es' : ''} on the road · ${list[0].route.name || ''}`, badge: short.replace(' Line', ''), fg: '#fff', bg: list[0].spec ? list[0].spec.color : '#555', kind: 'Route', go: ['bus', list[0].id] });
      if (app.layers.stops && lq.length >= 3) {
        for (const st of app.layers.stops.all().filter((x) => x.name.toLowerCase().includes(lq)).slice(0, 5))
          out.push({ t: st.name, s: `Bus stop #${st.id} · live arrivals`, icon: 'bus', fg: 'var(--bus)', bg: 'rgba(255,176,32,.14)', kind: 'Stop', go: ['stop', st.id] });
      }
      if (app.layers.cameras && lq.length >= 3) {
        for (const c of app.layers.cameras.list().filter((x) => x.label.toLowerCase().includes(lq)).slice(0, 3))
          out.push({ t: c.label, s: 'Traffic camera · live image', icon: 'camera', kind: 'Camera', go: ['camera', c.id] });
      }
      for (const b of ['Ballard', 'Fremont']) if (`${b} bridge`.toLowerCase().includes(lq)) out.push({ t: `${b} Bridge`, s: 'Drawbridge status, openings, camera', icon: 'bridge', fg: 'var(--bridge)', bg: 'rgba(251,146,60,.14)', kind: 'Bridge', go: ['bridge', b] });
      if (/^(iss|space|station|satel)/.test(lq)) { const iss = app.sky.iss(); if (iss) out.push({ t: 'International Space Station', s: 'Where it is and when to see it', icon: 'sat', fg: 'var(--sky)', bg: 'rgba(167,139,250,.14)', kind: 'Sky', go: ['sat', String(iss.id)] }); }
      if (/^(wea|rain|temp|tide|sun)/.test(lq)) out.push({ t: 'Weather now', s: 'Conditions, rain, tide, sunset', icon: 'cloud', fg: 'var(--weather)', bg: 'rgba(125,211,252,.14)', kind: 'Weather', go: ['weather', 'now'] });
      if (/^(lock|chitt)/.test(lq)) out.push({ t: 'Ballard Locks', s: 'Lockages, vessels, queue', icon: 'anchor', fg: 'var(--air)', bg: 'rgba(90,200,250,.14)', kind: 'Locks', go: ['list', 'locks'] });
      await ensure();
      const nq = normAddr(t);
      for (const r of index.filter((r) => r.k.includes(nq) || r.names.some((n) => String(n).toLowerCase().includes(lq))).slice(0, 6))
        out.push({ t: prettyAddr(r.k), s: `${num(r.n)} public records${r.names.length ? ` · ${r.names.slice(0, 2).map(prettyAddr).join(', ')}` : ''}`, icon: 'pin', kind: 'Place', go: ['place', r.k] });
      await app.briefing.load().catch(() => {});
      for (const i of app.briefing.consumer().filter((i) => `${i.plain.headline} ${i.plain.summary}`.toLowerCase().includes(lq)).slice(0, 4))
        out.push({ t: i.plain.headline, s: i.plain.summary, icon: 'chart', kind: 'Finding', go: ['insight', i.id] });
    }
    hits = out.slice(0, 14); sel = 0;
    res.innerHTML = t ? (hits.map(row).join('') || '<div class="empty">Nothing matching in Ballard right now.</div>') : '<div class="empty">Try a flight (ASA), a bus route (40, D Line), an address (5400 Ballard Ave), "bridge" or "ISS".</div>';
  }
  function go(h) { if (!h) return; close(); const [kind, id] = h.go; if (kind === 'list') app.openList(id); else app.open(kind, id); }
  function open() { el.classList.add('open'); input.value = ''; run(''); setTimeout(() => input.focus(), 30); ensure(); }
  function close() { el.classList.remove('open'); input.blur(); }
  input.addEventListener('input', () => run(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % Math.max(1, hits.length); res.innerHTML = hits.map(row).join(''); }
    else if (e.key === 'Enter') go(hits[sel]);
    else if (e.key === 'Escape') close();
  });
  res.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) go(hits[+b.dataset.i]); });
  document.addEventListener('pointerdown', (e) => { if (el.classList.contains('open') && !e.target.closest('.search') && !e.target.closest('[data-rail="search"]')) close(); });
  return { open, close, get isOpen() { return el.classList.contains('open'); } };
}
