// Ballard Live: the neighborhood as it is right now, in 3D. Aerial photography on real terrain under the real sun;
// every aircraft, bus and train as a 3D model moving smoothly in real time; drawbridges that open when they open;
// 911 calls as beacons; the sky above. Tap anything for a live tracking card; follow it and it rides along in the
// island. Director mode films it all hands-free; vision modes and a HUD give the god's-eye view.
import { createScene } from './scene.js';
import { createStore } from './store.js';
import { loadTransit } from './transit-data.js';
import { createAircraft } from './layers/aircraft.js';
import { createBuses } from './layers/buses.js';
import { createTrains } from './layers/trains.js';
import { createBridges } from './layers/bridges.js';
import { createIncidents } from './layers/incidents.js';
import { createTrees } from './layers/trees.js';
import { createStops } from './layers/stops.js';
import { createSky } from './sky.js';
import { nextSunCrossing } from './sun.js';
import { esc, num, time, inMin, isNum, compass, WX, dur, ago } from './fmt.js';
import { icon } from './ui/icons.js';
import { aircraftCard, busCard, stopCard, trainCard, bridgeCard, incidentCard, satCard, weatherCard } from './ui/cards.js';
import { createFollows, createIsland, notify } from './ui/island.js';
import { createVision, MODES } from './ui/vision.js';
import { createDirector } from './ui/director.js';
import { createSkyView } from './ui/skyview.js';
import { createBriefing } from './ui/briefing.js';
import { createSearch } from './ui/search.js';
import { createAlerts } from './ui/alerts.js';

const $ = (s, r = document) => r.querySelector(s);
const q = new URLSearchParams(location.search);

// ------------------------------------------------------------------ shell
document.body.insertAdjacentHTML('beforeend', `
  <div id="scene"></div>
  <div class="brand glass"><div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round"><path d="M3 18h18M5 18v-5m14 5v-5M5 13l6-5m8 5-6-5M3 13h2m14 0h2"/></svg></div>
    <div><div class="name">Ballard</div><div class="sub"><span class="live-dot" id="live"><i></i>LIVE</span><span id="clock" class="num">--:--</span></div></div>
    <div class="wx-chip" id="wx" title="Weather"></div></div>
  <div class="island" id="island" role="button" aria-label="Live activity"></div>
  <div class="rail">
    <div class="grp glass keep"><button data-rail="director" aria-label="Director mode">${icon('film')}<span class="tip">Director: live tour (D)</span></button></div>
    <div class="grp glass">
      <button data-rail="search" aria-label="Search">${icon('search')}<span class="tip">Search (⌘K)</span></button>
      <button data-rail="layers" aria-label="Layers">${icon('layers')}<span class="tip">Layers (L)</span></button>
      <button data-rail="vision" aria-label="Vision modes">${icon('eye')}<span class="tip">Vision &amp; HUD (V)</span></button>
      <button data-rail="sky" aria-label="Sky view">${icon('sky')}<span class="tip">The sky overhead (S)</span></button>
      <button data-rail="briefing" aria-label="Briefing">${icon('news')}<span class="tip">Briefing: what's unusual (B)</span></button>
      <button data-rail="alerts" aria-label="Alerts">${icon('bell')}<span class="tip">Alerts on your phone</span></button>
    </div>
    <div class="grp glass"><button data-rail="north" class="compass" aria-label="Reset view">${icon('compass')}<span class="tip">Reset view</span></button></div>
  </div>
  <div class="dock" id="dock"></div>
  <aside class="sheet glass" id="sheet" aria-live="polite"><div class="grab" id="grab"></div><button class="x" id="sheet-x" aria-label="Close">${icon('x')}</button><div class="body" id="sheet-body"></div></aside>
  <div class="pop glass" id="pop-layers"></div><div class="pop glass" id="pop-vision"></div>
  <div class="boot" id="boot"><div class="b"><div class="t">Ballard</div><div class="s">Bringing the neighborhood online…</div><div class="bar"><i></i></div></div></div>`);

const store = createStore();
const scene = createScene($('#scene'), {
  sunTime: q.get('t') ? Date.parse(q.get('t')) : null,
  camera: q.get('cam') ? (() => { const [lon, lat, z, p, b] = q.get('cam').split(',').map(Number); return { center: [lon, lat], zoom: z, pitch: p, bearing: b }; })() : {},
  onPick: (info) => onPick(info),
});
const sky = createSky();
const follows = createFollows();
const air = createAircraft();

const app = {
  store, scene, sky, follows, layers: { air }, transit: null,
  flightCache: new Map(),
  async lookupFlight(rec) {
    const k = rec.hex;
    if (this.flightCache.has(k)) return this.flightCache.get(k);
    const p = fetch(`/api/flight?callsign=${encodeURIComponent(rec.callsign || '')}&hex=${encodeURIComponent(rec.hex)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    this.flightCache.set(k, p);
    p.then((j) => { this.flightInfos.set(k, j); });
    return p;
  },
  flightInfos: new Map(),
  flightInfo(hex) { return this.flightInfos.get(hex) || null; },
  compass,
  sunTimes() { const t = Date.now(); return { rise: nextSunCrossing(t, -0.833, true), set: nextSunCrossing(t, -0.833, false) }; },
  nextPass(sat) {
    const k = `pass:${sat.id}`, c = this._passCache || (this._passCache = new Map()), hit = c.get(k);
    if (hit && Date.now() - hit.at < 10 * 60e3) return hit.v;
    const v = sky.passes(sat, Date.now(), 48, 10).find((p) => p.visible && p.set > Date.now()) || null;
    c.set(k, { at: Date.now(), v });
    return v;
  },
  radarOn: () => radarOn,
  contacts() {
    const out = [];
    for (const a of air.list()) { const s = air.now(a.hex); if (s) out.push({ kind: 'aircraft', lon: s.lon, lat: s.lat, alt: s.alt, label: a.rec.callsign || a.rec.reg || a.hex.toUpperCase(), sub: `${num(Math.round((a.rec.altFt || 0) / 100) * 100)} ft ${num(a.rec.gsKt)} kt`, selected: air.selected === a.hex }); }
    for (const b of app.layers.bus ? app.layers.bus.list() : []) { const s = app.layers.bus.now(b.id); if (s) out.push({ kind: 'bus', lon: s.lon, lat: s.lat, alt: s.alt + 3, label: b.route ? b.route.short : 'BUS', sub: `#${b.id}`, selected: app.layers.bus.selected === b.id }); }
    return out;
  },
  counts() {
    return { air: air.count(), bus: app.layers.bus ? app.layers.bus.count() : 0, train: app.layers.train ? app.layers.train.count() : 0, calls: app.layers.incidents ? app.layers.incidents.count() : 0 };
  },
  summaryText() { const c = app.counts(); return `${c.air} aircraft · ${c.bus} buses · ${c.train} trains · ${c.calls} active 911 calls`; },
  open: (kind, id) => open(kind, id),
  openList: (k) => openList(k),
  closeSheet: () => closeSheet(),
  select: (kind, id, o) => select(kind, id, o),
  onDirector(on) { $('[data-rail="director"]').classList.toggle('on', on); },
};
app.briefing = createBriefing(app);
const vision = createVision(app);
const director = createDirector(app);
const skyview = createSkyView(app);
const search = createSearch(app);
const alerts = createAlerts(app);
let island = null, radarOn = false;

// ------------------------------------------------------------------ sheet + cards
const sheet = $('#sheet'), sheetBody = $('#sheet-body');
let card = null, cardTimer = 0, sheetKind = null;
function openSheet(kind) {
  sheetKind = kind;
  sheet.classList.add('open'); document.body.classList.add('sheet-open');
  sheetBody.scrollTop = 0;
}
function closeSheet() {
  sheet.classList.remove('open', 'full'); document.body.classList.remove('sheet-open');
  clearInterval(cardTimer); card = null; sheetKind = null;
  select(null);
  scene.follow(null);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}
$('#sheet-x').onclick = closeSheet;
$('#grab').onclick = () => sheet.classList.toggle('full');

function select(kind, id, { focus = true, card: showCard = true } = {}) {
  air.select(kind === 'aircraft' ? id : null);
  app.layers.bus && app.layers.bus.select(kind === 'bus' ? id : null);
  app.layers.train && app.layers.train.select(kind === 'train' ? id : null);
  app.layers.stops && app.layers.stops.select(kind === 'stop' ? id : null);
  if (!kind) return;
  if (focus) {
    const m = scene.map;
    if (kind === 'aircraft') { scene.follow(() => air.now(id), 'track'); if (m.getZoom() < 12.5) m.easeTo({ zoom: 13.8, duration: 1200 }); }
    else if (kind === 'bus') { scene.follow(() => app.layers.bus.now(id), 'track'); if (m.getZoom() < 16) m.easeTo({ zoom: 17.2, pitch: 64, duration: 1200 }); }
    else if (kind === 'train') { scene.follow(() => app.layers.train.now(id), 'track'); if (m.getZoom() < 15) m.easeTo({ zoom: 16, pitch: 62, duration: 1200 }); }
  }
}

function mountCard(c, hash) {
  clearInterval(cardTimer);
  card = c;
  if (!c) return;
  openSheet(c.kind);
  sheetBody.innerHTML = '<div></div>';
  c.mount(sheetBody.firstChild);
  cardTimer = setInterval(() => { try { c.tick(); } catch (e) { console.error(e); } }, 1000);
  if (hash && location.hash !== hash) history.replaceState(null, '', hash);
}
function open(kind, id) {
  $('.pop.open') && $('.pop.open').classList.remove('open');
  if (skyview.open && kind !== 'sat') skyview.hide();
  let c = null;
  if (kind === 'aircraft') c = air.record(id) ? aircraftCard(app, id) : null;
  else if (kind === 'bus') c = app.layers.bus && app.layers.bus.get(id) ? busCard(app, id) : null;
  else if (kind === 'train') c = trainCard(app, id);
  else if (kind === 'stop') c = app.transit.stop(id) ? stopCard(app, id) : null;
  else if (kind === 'bridge') c = bridgeCard(app, id);
  else if (kind === 'incident') c = incidentCard(app, id);
  else if (kind === 'sat') c = satCard(app, id);
  else if (kind === 'weather') c = weatherCard(app);
  else if (kind === 'insight' || kind === 'place') { openBriefingPage(kind, id); return; }
  else if (kind === 'list') { openList(id); return; }
  if (!c) { toast('That one is no longer in range.'); return; }
  select(kind, id);
  mountCard(c, `#/${kind}/${encodeURIComponent(id)}`);
  if (kind === 'bridge') { const b = app.layers.bridge.get(id); if (b) scene.flyTo({ center: b.center, zoom: 17.3, pitch: 64, bearing: scene.map.getBearing() }); }
  if (kind === 'incident') { const x = app.layers.incidents.get(id); if (x) scene.flyTo({ center: [x.lon, x.lat], zoom: 16.8, pitch: 60 }); }
  if (kind === 'stop') {
    const st = app.transit.stop(id), c = scene.map.getCenter();
    app.layers.stops && app.layers.stops.select(id);
    const far = st && Math.hypot((st.lon - c.lng) * 75000, (st.lat - c.lat) * 111000) > 300;
    if (st && (far || scene.map.getZoom() < 16.5)) scene.flyTo({ center: [st.lon, st.lat], zoom: Math.max(17.2, scene.map.getZoom()), pitch: 60 });
  }
}
async function openBriefingPage(kind, id) {
  clearInterval(cardTimer); card = null;
  openSheet(kind);
  sheetBody.innerHTML = `<div style="padding:14px 14px 0"><button class="btn" id="bk">${icon('back')} Briefing</button></div><div></div>`;
  $('#bk', sheetBody).onclick = () => openList('briefing');
  const root = sheetBody.lastChild;
  const at = kind === 'insight' ? await app.briefing.insight(root, id) : await app.briefing.place(root, id);
  if (at) scene.flyTo({ center: [at.lon, at.lat], zoom: kind === 'place' ? 17.6 : 16.2, pitch: 60 });
  history.replaceState(null, '', `#/${kind}/${encodeURIComponent(id)}`);
}

// sheet actions (follow, track, chase, cockpit, radar, sky, list rows, briefing links)
sheetBody.addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  if (a && card) {
    const act = a.dataset.act;
    if (act === 'follow') {
      const on = follows.toggle(card.kind, card.id, card.label());
      a.outerHTML = `<button class="btn ${on ? 'on' : 'primary'}" data-act="follow">${icon('bell')} ${on ? 'Following' : 'Follow'}</button>`;
      toast(on ? `Following ${card.label()} in the island` : 'Stopped following');
    } else if (act === 'track') {
      const tg = card.target && card.target();
      if (card.kind === 'bridge' || card.kind === 'incident') { const t = tg; if (t) scene.flyTo({ center: [t.lon, t.lat], zoom: 17.2, pitch: 62 }); }
      else if (tg) scene.follow(card.target, 'track');
    } else if (act === 'chase') scene.follow(card.target, 'chase', { zoom: card.kind === 'aircraft' ? ((air.spec(card.id) || {}).len > 30 ? 16.4 : 17.6) : card.kind === 'train' ? 16.6 : 18.4 });
    else if (act === 'cockpit') scene.follow(card.target, 'cockpit');
    else if (act === 'radar') { setRadar(!radarOn); a.classList.toggle('on', radarOn); }
    else if (act === 'sky') skyview.show();
    else if (act === 'watch-stop' && card.kind === 'stop') {
      const st = app.transit.stop(card.id);
      const w = { stop: card.id, name: st ? st.name : card.id, route: a.dataset.route || null, label: a.dataset.label || '' };
      alerts.toggleStop(w).then((on) => {
        app.stopWatch = on ? [...(app.stopWatch || []), w] : (app.stopWatch || []).filter((x) => !(x.stop === w.stop && x.route === w.route));
        toast(on ? `You'll get an alert when a ${w.label} is ~5 min from ${w.name}` : 'Stop alert removed');
        card.tick();
      }).catch((err) => toast(err.message));
      e.stopPropagation();
    }
    else if (act === 'watch' && card.kind === 'bus') {
      const o = app.layers.bus.get(card.id);
      const w = { stop: a.dataset.stop, name: a.dataset.name, route: o && o.rec ? o.rec.route : null, label: o && o.route ? o.route.short : '' };
      alerts.toggleStop(w).then((on) => {
        app.stopWatch = on ? [...(app.stopWatch || []), w] : (app.stopWatch || []).filter((x) => !(x.stop === w.stop && x.route === w.route));
        toast(on ? `You'll get an alert when a ${w.label} is ~5 min from ${w.name}` : 'Stop alert removed');
        card.tick();
      }).catch((err) => toast(err.message));
    }
    return;
  }
  const go = e.target.closest('[data-go]');
  if (go) { const [k, ...rest] = go.dataset.go.split(':'); const id = rest.join(':'); if (k === 'addr') open('place', normAddrLocal(id)); else open(k, id); return; }
  const o = e.target.closest('[data-open]');
  if (o) { const [k, ...rest] = o.dataset.open.split(':'); open(k, rest.join(':')); }
});
const normAddrLocal = (a) => String(a || '').toUpperCase().replace(/\s+(#|UNIT|STE|SUITE|APT|BLDG|FL|SPC|RM)\s*[A-Z0-9-]*\s*$/, '').replace(/\bNORTHWEST\b/g, 'NW').replace(/\bAVENUE\b/g, 'AVE').replace(/\bSTREET\b/g, 'ST').replace(/\bPLACE\b/g, 'PL').replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ lists
function openList(kind) {
  clearInterval(cardTimer); card = null;
  select(null);
  if (kind === 'briefing') { openSheet('briefing'); sheetBody.innerHTML = '<div></div>'; app.briefing.home(sheetBody.firstChild); history.replaceState(null, '', '#/briefing'); return; }
  if (kind === 'alerts') { openSheet('alerts'); sheetBody.innerHTML = '<div></div>'; alerts.render(sheetBody.firstChild); history.replaceState(null, '', '#/alerts'); return; }
  openSheet(`list:${kind}`);
  const render = () => { sheetBody.innerHTML = listHTML(kind); };
  render();
  cardTimer = setInterval(render, 3000);
  history.replaceState(null, '', `#/list/${kind}`);
}
function listHTML(kind) {
  const B = (bg, fg, inner) => `<div class="b" style="background:${bg};color:${fg}">${inner}</div>`;
  if (kind === 'flights' || kind === 'overview') {
    const rows = air.list().filter((a) => a.rec).sort((a, b) => (a.rec.distKm ?? 99) - (b.rec.distKm ?? 99));
    const note = airStale() ? '<div class="fine" style="margin:0 18px 8px;color:var(--warn)">Live aircraft positions are paused: the ADS-B feed hasn\'t updated in a few minutes. Everything else is live.</div>' : '';
    return `<div class="list-h"><h2>In the air</h2><p>${rows.length} aircraft within 20 nm of Ballard, from ADS-B · nearest first</p></div>${note}<div class="rows">${rows.map((a) => {
      const r = a.rec, info = app.flightInfo(a.hex), rt = info && info.route;
      return `<button class="row" data-open="aircraft:${a.hex}">${B('rgba(90,200,250,.14)', 'var(--air)', icon(r.kind === 'helicopter' ? 'plane' : 'plane'))}<div><div class="t">${esc(r.callsign || r.reg || a.hex.toUpperCase())}${rt && rt.origin ? ` <span style="color:var(--muted);font-weight:500">${esc(rt.origin.iata || '')} → ${esc(rt.destination.iata || '')}</span>` : ''}</div>
        <div class="s">${esc(a.spec ? a.spec.desc : r.type || 'Aircraft')}${r.operator ? ` · ${esc(r.operator)}` : ''}</div></div><div class="r">${r.onGround ? 'GND' : `${num(Math.round((r.altFt || 0) / 100) * 100)}`}<small>${r.onGround ? '' : 'ft · '}${num((r.distKm || 0) * 0.621, 1)} mi</small></div></button>`;
    }).join('') || '<div class="empty">No aircraft in range right now.</div>'}</div>`;
  }
  if (kind === 'buses') {
    const rows = (app.layers.bus ? app.layers.bus.list() : []).filter((b) => b.route).sort((a, b) => a.route.short.localeCompare(b.route.short, 'en', { numeric: true }));
    return `<div class="list-h"><h2>Buses</h2><p>${rows.length} King County Metro buses around Ballard, live</p></div><div class="rows">${rows.map((b) => {
      const d = b.rec.delay, nx = (b.rec.next || []).find((x) => x[2] > Date.now()), st = nx ? app.transit.stop(nx[0]) : null;
      return `<button class="row" data-open="bus:${esc(b.id)}"><div class="b" style="background:${esc(b.spec.color)};color:#fff">${esc(b.route.short.replace(' Line', ''))}</div><div><div class="t">${esc(b.info && b.info.headsign ? `to ${b.info.headsign}` : b.route.name)}</div>
        <div class="s">${st ? `next: ${esc(st.name)} · ${esc(inMin(nx[2]))}` : `bus ${esc(b.id)}`}</div></div><div class="r ${isNum(d) && d >= 90 ? 'late' : 'ontime'}">${isNum(d) ? (Math.abs(d) < 90 ? 'on time' : d > 0 ? `+${Math.round(d / 60)} min` : `−${Math.round(-d / 60)} min`) : ''}<small>#${esc(b.id)}</small></div></button>`;
    }).join('') || '<div class="empty">No buses reporting nearby right now.</div>'}</div>`;
  }
  if (kind === 'trains') {
    const d = store.get('trains') || {};
    return `<div class="list-h"><h2>Trains</h2><p>Amtrak on the BNSF line along Ballard's shore (Cascades to Vancouver BC, Empire Builder)</p></div><div class="rows">
      ${(d.trains || []).map((t) => `<button class="row" data-open="train:${esc(t.id)}">${B('rgba(52,211,153,.14)', 'var(--train)', icon('train'))}<div><div class="t">${esc(t.route)} ${esc(t.num)}</div><div class="s">${esc(t.origin.name)} → ${esc(t.dest.name)}</div></div><div class="r">${isNum(t.speedMph) ? Math.round(t.speedMph) : '–'}<small>mph</small></div></button>`).join('')}
      <div class="sec" style="padding:0 8px"><h3>Next through Ballard</h3>${(d.upcoming || []).map((t) => `<button class="row" data-open="train:${esc(t.id)}">${B('rgba(255,255,255,.06)', 'var(--muted)', icon('train'))}<div><div class="t">${esc(t.route)} ${esc(t.num)}</div><div class="s">${esc(t.origin.name)} → ${esc(t.dest.name)} · ${t.pass.northbound ? 'northbound' : 'southbound'}</div></div><div class="r">≈ ${esc(time(t.pass.t))}<small>${esc(inMin(t.pass.t))}</small></div></button>`).join('') || '<div class="fine" style="padding:0 10px">No passenger trains scheduled through Ballard in the next eight hours.</div>'}</div></div>`;
  }
  if (kind === 'calls') {
    const rows = (app.layers.incidents ? app.layers.incidents.list() : []).slice().sort((a, b) => b.t - a.t);
    return `<div class="list-h"><h2>911 calls</h2><p>Seattle Fire dispatches in and around Ballard, last two hours, and SDOT traffic incidents</p></div><div class="rows">${rows.map((x) => `<button class="row" data-open="incident:${esc(x.id)}">${B(x.active ? 'rgba(255,90,79,.18)' : 'rgba(255,255,255,.06)', x.active ? 'var(--alert)' : 'var(--muted)', icon('siren'))}
      <div><div class="t">${esc(x.label)}</div><div class="s">${esc(x.rec.address || '')}</div></div><div class="r">${esc(time(x.t))}<small>${x.active ? 'active' : esc(ago(x.t))}</small></div></button>`).join('') || '<div class="empty">No calls in the last two hours.</div>'}</div>`;
  }
  if (kind === 'locks') {
    const L = store.get('lockages');
    return `<div class="list-h"><h2>Ballard Locks</h2><p>Hiram M. Chittenden Locks: vessels between Salmon Bay and Puget Sound (US Army Corps of Engineers)</p></div>
      ${L ? `<div style="padding:0 18px"><div class="grid2"><div><div class="k">Lockages today</div><div class="v">${num(L.today && L.today.total)}</div><div class="d">${num(L.today && L.today.up)} up · ${num(L.today && L.today.down)} down</div></div><div><div class="k">Waiting now</div><div class="v">${num(L.queued)}</div><div class="d">${isNum(L.avgWaitMin) ? `average wait ${Math.round(L.avgWaitMin)} min` : ''}</div></div></div></div>
      <div class="rows">${(L.recent || []).slice(0, 25).map((v) => `<div class="row">${B('rgba(90,200,250,.12)', 'var(--air)', icon('anchor'))}<div><div class="t">${esc(v.name)}</div><div class="s">${v.direction === 'up' ? 'Up to the lake' : 'Down to the Sound'} · ${v.commercial ? 'commercial' : 'recreational'}${isNum(v.waitMin) ? ` · waited ${v.waitMin} min` : ''}</div></div><div class="r">${esc(time(v.start || v.arrival))}</div></div>`).join('')}</div>` : '<div class="empty">No data.</div>'}`;
  }
  return '';
}

// ------------------------------------------------------------------ picking on the scene
function onPick(info) {
  if (director.on) return;
  const o = info && info.object;
  if (!o) return;
  if (o.kind === 'aircraft' && o.id) open('aircraft', o.id);
  else if (o.kind === 'bus' && o.id) open('bus', o.id);
  else if (o.kind === 'train' && o.id) open('train', o.id);
  else if (o.kind === 'bridge') open('bridge', o.b ? o.b.name : o.id);
  else if (o.kind === 'incident') open('incident', o.id);
  else if (o.kind === 'stop') open('stop', o.id);
}

// Aircraft positions older than 3 minutes: the feed (or the relay behind it) is down. Say so rather than show nothing.
function airStale() {
  const m = store.meta.aircraft;
  const d = store.get('aircraft');
  const t = (d && d.t) || (m && m.fetchedAt) || 0;
  return !!m && Date.now() - t > 3 * 60e3;
}

// ------------------------------------------------------------------ dock (live tracker chips)
function chips() {
  const L = store.data;
  const c = app.counts();
  const br = ((L.bridges || {}).bridges || []).find((b) => b.name === 'Ballard'), fr = ((L.bridges || {}).bridges || []).find((b) => b.name === 'Fremont');
  const trains = (L.trains || {}).trains || [], upcoming = (L.trains || {}).upcoming || [];
  const iss = sky.iss(), pass = iss ? app.nextPass(iss) : null;
  const nearest = air.list().filter((a) => a.rec && !a.rec.onGround).sort((a, b) => a.rec.distKm - b.rec.distKm)[0];
  const locks = L.lockages;
  const chip = (id, ic, color, k, v, cls = '') => `<button class="chip glass ${cls}" data-chip="${id}"><span class="ico" style="background:color-mix(in srgb, ${color} 18%, transparent);color:${color}">${icon(ic)}</span><span><div class="k">${esc(k)}</div><div class="v">${v}</div></span></button>`;
  const up = [br, fr].filter((b) => b && b.up);
  $('#dock').innerHTML = [
    airStale()
      ? chip('flights', 'plane', 'var(--faint)', 'In the air', '<small>live aircraft paused</small>')
      : chip('flights', 'plane', 'var(--air)', 'In the air', `${c.air}${nearest ? ` <small>nearest ${esc(nearest.rec.callsign || nearest.rec.reg || '')}</small>` : ''}`),
    chip('buses', 'bus', 'var(--bus)', 'Buses', `${c.bus} <small>on the road</small>`),
    chip('bridge', 'bridge', 'var(--bridge)', 'Drawbridges', up.length ? `${up.map((b) => `${b.name} up ${dur((Date.now() - (b.since || Date.now())) / 1000)}`).join(' · ')}` : `Down <small>open to traffic</small>`, up.length ? 'alert' : ''),
    chip('trains', 'train', 'var(--train)', 'Trains', trains.length ? `${trains.length} <small>on the line</small>` : upcoming[0] ? `${esc(time(upcoming[0].pass.t))} <small>${esc(upcoming[0].route.replace('Amtrak ', ''))}</small>` : '<small>none soon</small>'),
    chip('calls', 'siren', 'var(--alert)', '911 · last 2 h', `${(app.layers.incidents ? app.layers.incidents.list() : []).length} <small>${c.calls} active</small>`, c.calls ? 'alert' : ''),
    chip('sky', 'sat', 'var(--sky)', 'ISS', pass ? `${esc(time(pass.rise))} <small>${pass.rise - Date.now() < 86400e3 && new Date(pass.rise).getDate() !== new Date().getDate() ? 'tomorrow' : 'tonight'}</small>` : '<small>overhead view</small>'),
    locks ? chip('locks', 'anchor', 'var(--weather)', 'Locks', `${num(locks.today && locks.today.total)} <small>today${locks.queued ? ` · ${locks.queued} waiting` : ''}</small>`) : '',
  ].join('');
}
$('#dock').addEventListener('click', (e) => {
  const c = e.target.closest('[data-chip]');
  if (!c) return;
  const id = c.dataset.chip;
  if (id === 'bridge') open('bridge', 'Ballard');
  else if (id === 'sky') skyview.show();
  else openList(id);
});

// ------------------------------------------------------------------ top-left: clock + weather
function clock() { $('#clock').textContent = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', second: '2-digit' }).toLowerCase(); }
setInterval(clock, 1000); clock();
function weatherChip() {
  const w = store.get('weather');
  if (!w || !w.current) return;
  const c = w.current;
  $('#wx').innerHTML = `${icon(c.precipIn > 0 ? 'rain' : c.cloud > 70 ? 'cloud' : c.isDay ? 'sun' : 'moon')}<span class="t">${Math.round(c.tempF)}°</span><span class="d">${esc(WX(c.code))}<br>wind ${Math.round(c.windMph)} ${esc(compass(c.windDir))}</span>`;
}
$('#wx').onclick = () => open('weather', 'now');

// ------------------------------------------------------------------ rail: popovers and modes
function popover(id, html) {
  const p = $(id);
  const was = p.classList.contains('open');
  document.querySelectorAll('.pop.open').forEach((x) => x.classList.remove('open'));
  if (!was) { p.innerHTML = html(); p.classList.add('open'); }
}
const VIS = { aircraft: true, buses: true, trains: true, bridges: true, incidents: true, trees: true, labels: true, trails: true, buildings: true };
function layersHTML() {
  const L = [['aircraft', 'Aircraft (3D)', 'var(--air)'], ['buses', 'Buses (3D)', 'var(--bus)'], ['trains', 'Trains (3D)', 'var(--train)'], ['bridges', 'Drawbridges', 'var(--bridge)'], ['incidents', '911 calls', 'var(--alert)'],
    ['trees', 'Trees (3D, city LiDAR survey)', '#4f8a4a'], ['trails', 'Flight trails', 'var(--air)'], ['labels', 'Labels', '#fff'], ['buildings', '3D buildings', '#cbd5e1']];
  return `<h4>Show</h4>${L.map(([k, l, c]) => `<label><input type="checkbox" data-l="${k}" ${VIS[k] ? 'checked' : ''}><span class="sw" style="background:${c}"></span>${esc(l)}</label>`).join('')}
    <label><input type="checkbox" data-l="radar" ${radarOn ? 'checked' : ''}><span class="sw" style="background:#38bdf8"></span>Rain radar (last hour)</label>
    <h4 style="margin-top:10px">Aerial photos</h4><select id="year">${[2025, 2023, 2021, 2019, 2017, 2015, 2013, 2009, 2002, 1936].map((y) => `<option value="${y}">${y}${y === 2025 ? ' (latest)' : ''}</option>`).join('')}</select>`;
}
$('#pop-layers').addEventListener('change', (e) => {
  const k = e.target.dataset.l;
  if (e.target.id === 'year') { scene.setYear(e.target.value); return; }
  if (!k) return;
  const on = e.target.checked;
  if (k === 'radar') { setRadar(on); return; }
  VIS[k] = on;
  if (k === 'aircraft') air.set({ visible: on });
  if (k === 'buses' && app.layers.bus) app.layers.bus.set({ visible: on });
  if (k === 'trains' && app.layers.train) app.layers.train.set({ visible: on });
  if (k === 'bridges' && app.layers.bridge) app.layers.bridge.set({ visible: on });
  if (k === 'incidents' && app.layers.incidents) app.layers.incidents.set({ visible: on });
  if (k === 'labels') { air.set({ labels: on }); app.layers.bus && app.layers.bus.set({ labels: on }); }
  if (k === 'trails') air.set({ trails: on });
  if (k === 'trees' && app.layers.trees) app.layers.trees.set({ visible: on });
  if (k === 'buildings') scene.setBuildings(on);
});
function visionHTML() {
  return `<h4>Vision</h4>${MODES.map((m) => `<div class="opt ${vision.mode === m.id ? 'on' : ''}" data-v="${m.id}"><div><div style="font-weight:650">${esc(m.label)}</div><div style="color:var(--muted);font-size:12px">${esc(m.desc)}</div></div></div>`).join('')}
    <h4 style="margin-top:10px">Overlay</h4><label><input type="checkbox" id="hud" ${vision.hudOn ? 'checked' : ''}> Targeting HUD</label>`;
}
$('#pop-vision').addEventListener('click', (e) => { const o = e.target.closest('[data-v]'); if (o) { vision.set(o.dataset.v); $('#pop-vision').innerHTML = visionHTML(); $('[data-rail="vision"]').classList.toggle('on', vision.mode !== 'natural' || vision.hudOn); } });
$('#pop-vision').addEventListener('change', (e) => { if (e.target.id === 'hud') { vision.hud(e.target.checked); $('[data-rail="vision"]').classList.toggle('on', vision.mode !== 'natural' || vision.hudOn); } });

document.querySelector('.rail').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rail]');
  if (!b) return;
  const r = b.dataset.rail;
  if (r === 'search') search.open();
  else if (r === 'layers') popover('#pop-layers', layersHTML);
  else if (r === 'vision') popover('#pop-vision', visionHTML);
  else if (r === 'sky') { if (skyview.open) skyview.hide(); else { closeSheet(); skyview.show(); } b.classList.toggle('on', skyview.open); }
  else if (r === 'briefing') openList('briefing');
  else if (r === 'alerts') openList('alerts');
  else if (r === 'director') { if (director.on) director.stop(); else director.start(); }
  else if (r === 'north') { scene.follow(null); scene.map.easeTo({ center: [-122.3905, 47.6665], zoom: 15.3, pitch: 62, bearing: 28, duration: 1600 }); }
});
function setRadar(on) {
  radarOn = !!on;
  scene.setRadar((store.get('radar') || {}).frames || [], radarOn);
}

// keyboard
addEventListener('keydown', (e) => {
  if (e.target.matches && e.target.matches('input, textarea, select')) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); search.open(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') { if (skyview.open) { skyview.hide(); $('[data-rail="sky"]').classList.remove('on'); } else closeSheet(); document.querySelectorAll('.pop.open').forEach((x) => x.classList.remove('open')); }
  else if (k === 'd') { if (director.on) director.stop(); else director.start(); }
  else if (k === 's') { if (skyview.open) skyview.hide(); else skyview.show(); $('[data-rail="sky"]').classList.toggle('on', skyview.open); }
  else if (k === 'b') openList('briefing');
  else if (k === 'l') popover('#pop-layers', layersHTML);
  else if (k === 'v') { const i = MODES.findIndex((m) => m.id === vision.mode); vision.set(MODES[(i + 1) % MODES.length].id); toast(`Vision: ${MODES[(i + 1) % MODES.length].label}`); }
  else if (k === '/') { e.preventDefault(); search.open(); }
});

// ------------------------------------------------------------------ toasts
let toastT = 0;
function toast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast glass'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
}

// ------------------------------------------------------------------ live data -> layers, events
const prev = { bridges: new Map(), emerg: new Set(), fires: new Set(), issVisible: false };
function onData(ids) {
  const L = store.data;
  $('#live').classList.toggle('off', !store.online());
  if (ids.includes('aircraft')) {
    air.ingest(L.aircraft);
    for (const a of (L.aircraft && L.aircraft.aircraft) || []) {
      if (a.emergency && !prev.emerg.has(`${a.hex}:${a.squawk}`)) {
        prev.emerg.add(`${a.hex}:${a.squawk}`);
        island && island.flash('aircraft', `<b>${esc(a.callsign || a.reg || a.hex)}</b> <span class="m">squawking ${esc(a.squawk)}: ${esc(a.emergency)}</span>`, `${num(Math.round((a.altFt || 0) / 100) * 100)} ft`, { alert: true, item: { kind: 'aircraft', id: a.hex } });
        if (follows.has('aircraft', a.hex)) notify(`${a.callsign || a.hex}: emergency`, `Squawk ${a.squawk} (${a.emergency})`, `em-${a.hex}`);
      }
    }
  }
  if (ids.includes('buses') && app.layers.bus) app.layers.bus.ingest(L.buses);
  if (ids.includes('trains') && app.layers.train) app.layers.train.ingest(L.trains);
  if (ids.includes('bridges') && app.layers.bridge) {
    app.layers.bridge.ingest(L.bridges);
    for (const b of (L.bridges && L.bridges.bridges) || []) {
      if (!['Ballard', 'Fremont'].includes(b.name)) continue;
      const was = prev.bridges.get(b.name);
      prev.bridges.set(b.name, b.up);
      if (was !== undefined && was !== b.up) {
        island && island.flash('bridge', `<b>${esc(b.name)} Bridge</b> <span class="m">${b.up ? 'is going up for a vessel' : 'is back down: open to traffic'}</span>`, b.up ? 'UP' : 'DOWN', { alert: b.up, item: { kind: 'bridge', id: b.name } });
        if (follows.has('bridge', b.name)) notify(`${b.name} Bridge ${b.up ? 'is up' : 'is down'}`, b.up ? 'Raised for a vessel. Expect a short wait.' : 'Open to traffic again.', `br-${b.name}`);
      }
    }
  }
  if ((ids.includes('fire911') || ids.includes('incidents')) && app.layers.incidents) {
    app.layers.incidents.ingest(L.fire911, L.incidents);
    const firstLoad = !prev.firesSeeded;
    for (const x of (L.fire911 && L.fire911.incidents) || []) {
      if (!x.active || prev.fires.has(x.id)) continue;
      prev.fires.add(x.id);
      if (!firstLoad && /fire|smoke|rescue|explosion/i.test(x.type || '') && !/alarm/i.test(x.type || '') && (x.distKm ?? 9) < 2.5)
        island && island.flash('incident', `<b>${esc(x.type)}</b> <span class="m">${esc(x.address || '')}</span>`, 'now', { alert: true, item: { kind: 'incident', id: `sfd-${x.id}` } });
    }
    prev.firesSeeded = true;
  }
  if (ids.includes('weather')) {
    const w = L.weather;
    weatherChip();
    if (w && w.current) {
      scene.setCloud((w.current.cloud || 0) / 100);
      air.setQnh(w.current.pressureHpa);
      if (w.current.precipIn > 0 && !prev.autoRadar) { prev.autoRadar = true; setRadar(true); }
    }
  }
  if (ids.includes('radar') && radarOn) scene.setRadar((L.radar || {}).frames || [], true);
  chips();
  if (card && card.repaint && ids.includes('weather')) card.repaint();
}

// ------------------------------------------------------------------ boot
(async () => {
  const [transit, rail, bridges] = await Promise.all([
    loadTransit().catch((e) => { console.error(e); return null; }),
    fetch('/data/rail.json').then((r) => r.json()).catch(() => null),
    fetch('/data/bridges.json').then((r) => r.json()).catch(() => ({ bridges: [] })),
  ]);
  app.transit = transit || { stop: () => null, tripInfo: () => null, stopAlong: () => null, route: () => null };
  const bridgeLayer = createBridges(bridges, (lon, lat) => scene.ground(lon, lat));
  app.layers.bridge = bridgeLayer;
  app.layers.bus = transit ? createBuses(transit, { deckZ: bridgeLayer.deckZ }) : createBuses({ tripInfo: () => null, stopAlong: () => null }, {});
  app.layers.train = rail ? createTrains(rail) : { ingest() {}, produce: () => [], list: () => [], count: () => 0, now: () => null, set() {}, select() {} };
  app.layers.incidents = createIncidents();
  app.layers.trees = createTrees();
  scene.add('trees', (ctx) => app.layers.trees.produce(ctx));
  if (transit) { app.layers.stops = createStops(transit); scene.add('stops', (ctx) => app.layers.stops.produce(ctx)); }
  scene.add('bridges', (ctx) => bridgeLayer.produce(ctx));
  scene.add('incidents', (ctx) => app.layers.incidents.produce(ctx));
  scene.add('trains', (ctx) => app.layers.train.produce(ctx));
  scene.add('buses', (ctx) => app.layers.bus.produce(ctx));
  scene.add('aircraft', (ctx) => air.produce(ctx));
  store.subscribe(onData);
  // Phones drop WebGL contexts when the app is backgrounded for a while; come back to a fresh page, not a black one.
  const canvas = scene.map.getCanvas();
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); }, false);
  canvas.addEventListener('webglcontextrestored', () => { location.reload(); }, false);
  island = createIsland(app, $('#island'));
  await Promise.race([scene.ready, new Promise((r) => setTimeout(r, 6000))]);
  await store.start();
  sky.load().then(chips).catch(() => {});
  $('#boot').classList.add('done');
  // deep links (also used when a notification is tapped while the app is open)
  app.route = () => {
    const [, kind, id] = (location.hash.match(/^#\/([^/]+)\/?(.*)$/) || []);
    if (kind === 'list') openList(decodeURIComponent(id));
    else if (kind === 'briefing' || kind === 'alerts') openList(kind);
    else if (kind === 'sky') skyview.show();
    else if (kind) setTimeout(() => open(kind, decodeURIComponent(id)), 400);
  };
  app.route();
  alerts.current().then((c) => { app.stopWatch = c.watch || []; }).catch(() => {});
  if (q.get('director') === '1') director.start();
  if (q.get('vision')) vision.set(q.get('vision'));
  setInterval(chips, 2000);
  window.__live = app; // for QA
})();
