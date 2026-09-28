// Live Activities for the web: follow anything (a flight, a bus, a train, a bridge, the ISS) and its live status
// rides along in the island at the top, rotating between followed items; events (a bridge going up, an emergency
// squawk, a fire call nearby, the ISS rising) flash in the island, and followed ones can raise a system notification.
import { esc, num, time, inMin, isNum, dur } from '../fmt.js';
import { icon } from './icons.js';
import { routeFit } from './cards.js';

const KEY = 'ballard-follows';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
const save = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode */ } };

export function createFollows() {
  let items = load().filter((x) => x && x.kind && x.id);
  const subs = new Set();
  const changed = () => { save(items); for (const f of subs) f(items); };
  return {
    list: () => items,
    has: (kind, id) => items.some((x) => x.kind === kind && x.id === String(id)),
    toggle(kind, id, label) {
      id = String(id);
      if (items.some((x) => x.kind === kind && x.id === id)) items = items.filter((x) => !(x.kind === kind && x.id === id));
      else { items = [{ kind, id, label, since: Date.now() }, ...items].slice(0, 8); askPermission(); }
      changed();
      return this.has(kind, id);
    },
    remove(kind, id) { items = items.filter((x) => !(x.kind === kind && x.id === String(id))); changed(); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}
function askPermission() {
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); } catch { /* unsupported */ }
}
export function notify(title, body, tag) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
    new Notification(title, { body, tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png' });
  } catch { /* unsupported */ }
}

const DOT = { aircraft: ['plane', 'var(--air)'], bus: ['bus', 'var(--bus)'], train: ['train', 'var(--train)'], bridge: ['bridge', 'var(--bridge)'], sat: ['sat', 'var(--sky)'], incident: ['siren', 'var(--alert)'], summary: ['wave', 'var(--air)'] };

export function createIsland(app, el) {
  let idx = 0, rotAt = 0, flash = null, current = null;
  const dot = (kind) => { const [ic, c] = DOT[kind] || DOT.summary; return `<span class="dot" style="background:color-mix(in srgb, ${c} 22%, transparent);color:${c}">${icon(ic, 'ic', 'style="width:15px;height:15px"')}</span>`; };

  function describe(f) {
    const now = Date.now();
    if (f.kind === 'aircraft') {
      const rec = app.layers.air.record(f.id), s = app.layers.air.now(f.id);
      if (!rec || !s) return { text: `<b>${esc(f.label)}</b> <span class="m">out of range</span>`, val: '–' };
      const info = app.flightInfo(f.id), fit = info ? routeFit(info.route, s) : null;
      const ft = rec.onGround ? 'GND' : `${num(Math.round(s.alt / 0.3048 / 100) * 100)} ft ${rec.vrFpm > 300 ? '▲' : rec.vrFpm < -300 ? '▼' : ''}`;
      const rt = fit && fit.ok ? ` <span class="m">${esc(info.route.origin.iata || '')} → ${esc(info.route.destination.iata || '')}</span>` : '';
      return { text: `<b>${esc(f.label)}</b>${rt}`, val: ft, prog: fit && fit.ok ? fit.frac : null };
    }
    if (f.kind === 'bus') {
      const o = app.layers.bus.get(f.id);
      if (!o) return { text: `<b>${esc(f.label)}</b> <span class="m">not reporting</span>`, val: '–' };
      const nx = (o.rec.next || []).find((x) => x[2] > now);
      const st = nx ? app.transit.stop(nx[0]) : null;
      return { text: `<b>${esc(o.route ? o.route.short : f.label)}</b> <span class="m">→ ${esc((o.info && o.info.headsign) || '')}${st ? ` · ${esc(st.name)}` : ''}</span>`, val: nx ? inMin(nx[2]) : '–' };
    }
    if (f.kind === 'train') {
      const d = app.store.get('trains') || {}, t = [...(d.trains || []), ...(d.upcoming || [])].find((x) => x.id === f.id);
      if (!t) return { text: `<b>${esc(f.label)}</b> <span class="m">not on the line</span>`, val: '–' };
      return { text: `<b>${esc(`${t.route} ${t.num}`)}</b> <span class="m">${t.pass ? `${t.pass.t < now ? 'passed' : 'passes'} Ballard` : ''}</span>`, val: t.pass ? `≈ ${time(t.pass.t)}` : isNum(t.speedMph) ? `${Math.round(t.speedMph)} mph` : '–' };
    }
    if (f.kind === 'bridge') {
      const b = ((app.store.get('bridges') || {}).bridges || []).find((x) => x.name === f.id);
      if (!b) return { text: `<b>${esc(f.id)} Bridge</b>`, val: '–' };
      return { text: `<b>${esc(f.id)} Bridge</b> <span class="m">${b.up ? 'open to boats' : 'open to traffic'}</span>`, val: b.up ? `UP ${dur((now - (b.since || now)) / 1000)}` : 'DOWN', alert: b.up };
    }
    if (f.kind === 'sat') {
      const s = app.sky.find(f.id);
      if (!s) return { text: `<b>${esc(f.label)}</b>`, val: '–' };
      const p = app.sky.at(s, now), dark = app.sky.sun().elevation < -6;
      if (p && p.el > 10 && p.sunlit && dark) return { text: `<b>${esc(f.label)}</b> <span class="m">visible now · look ${esc(app.compass(p.az))}</span>`, val: `${Math.round(p.el)}° up`, alert: true };
      const nx = app.nextPass(s);
      return { text: `<b>${esc(f.label)}</b> <span class="m">next visible pass</span>`, val: nx ? `${time(nx.rise)}` : '–' };
    }
    return { text: esc(f.label), val: '' };
  }
  function summary() {
    const a = app.layers.air.count(), b = app.layers.bus.count();
    const br = ((app.store.get('bridges') || {}).bridges || []).filter((x) => ['Ballard', 'Fremont'].includes(x.name));
    const up = br.filter((x) => x.up);
    const trains = (app.store.get('trains') || {}).trains || [];
    const parts = [`${a} ${a === 1 ? 'aircraft' : 'aircraft'}`, `${b} ${b === 1 ? 'bus' : 'buses'}`];
    if (trains.length) parts.push(`${trains.length} train${trains.length > 1 ? 's' : ''}`);
    return { kind: 'summary', text: `<b>Ballard now</b> <span class="m">${esc(parts.join(' · '))}</span>`, val: up.length ? `${up.map((x) => x.name).join(' & ')} UP` : 'Bridges down', alert: up.length > 0 };
  }
  function render() {
    const now = Date.now();
    let d, kind, item = null;
    if (flash && now < flash.until) { d = flash; kind = flash.kind; item = flash.item || null; }
    else {
      flash = null;
      const fl = app.follows.list();
      if (fl.length) {
        if (now - rotAt > 6000) { idx = (idx + 1) % fl.length; rotAt = now; }
        item = fl[idx % fl.length]; kind = item.kind; d = describe(item);
      } else { d = summary(); kind = 'summary'; }
    }
    current = item;
    const html = `${dot(kind)}<div class="txt">${d.text}</div>${d.val ? `<span class="val num">${esc(d.val)}</span>` : ''}${isNum(d.prog) ? `<div class="prog"><i style="width:${Math.round(d.prog * 100)}%"></i></div>` : ''}`;
    if (el.innerHTML !== html) el.innerHTML = html;
    el.classList.toggle('alert', !!d.alert);
  }
  el.addEventListener('click', () => {
    const it = current;
    if (it) app.open(it.kind, it.id);
    else app.openList('overview');
  });
  setInterval(render, 1000);
  render();
  return {
    render,
    flash(kind, text, val, { alert = false, item = null, ms = 9000 } = {}) {
      flash = { kind, text, val, alert, item, until: Date.now() + ms };
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
      render();
    },
  };
}
