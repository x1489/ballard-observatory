// Tracking cards, Flighty-style, for everything that moves (and a few things that don't): each card renders once and
// then refreshes its live fields every second. Cards: aircraft, bus, train, bridge, incident, satellite, weather,
// locks. Lists: flights, buses, trains, 911 calls, the sky.
import { esc, num, time, timeS, ago, inMin, dur, miles, compass, flightNo, titleCase, isNum, WX, day } from '../fmt.js';
import { icon } from './icons.js';
import { distM, bearing, gcInterp, toRad, enu } from '../geo.js';
import { closestApproach } from '../motion.js';
import { incidentCategory, CAT_COLOR } from '../layers/incidents.js';
import { busSpec } from '../fleet.js';

const BALLARD = { lat: 47.6687, lon: -122.3847 };
const FT = 0.3048;
const R = 6371008.8;
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

// ------------------------------------------------------------------ helpers
function status(cls, text) { return `<span class="status ${cls}"><i></i>${esc(text)}</span>`; }
function stat(k, v, d = '') { return `<div><div class="k">${esc(k)}</div><div class="v">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`; }
function spark(values, { color = '#5ac8fa', h = 64 } = {}) {
  const v = values.filter(isNum);
  if (v.length < 2) return '<div class="fine">Collecting…</div>';
  const mn = Math.min(...v), mx = Math.max(...v), span = mx - mn || 1, w = 300;
  const pts = v.map((y, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${(h - 6 - ((y - mn) / span) * (h - 12)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs><linearGradient id="sg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <polygon points="0,${h} ${pts} ${w},${h}" fill="url(#sg)"/><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}
export function followBtn(on) { return `<button class="btn ${on ? 'on' : 'primary'}" data-act="follow">${icon('bell')} ${on ? 'Following' : 'Follow'}</button>`; }

/** Cross-track and along-track position (m) of a point relative to the great circle a -> b. */
function onRoute(a, b, p) {
  const d13 = distM(a.lon, a.lat, p.lon, p.lat) / R, t13 = toRad(bearing(a.lon, a.lat, p.lon, p.lat)), t12 = toRad(bearing(a.lon, a.lat, b.lon, b.lat));
  const xt = Math.asin(Math.sin(d13) * Math.sin(t13 - t12));
  const at = Math.acos(Math.max(-1, Math.min(1, Math.cos(d13) / Math.cos(xt))));
  return { xt: Math.abs(xt * R), at: at * R * Math.sign(Math.cos(t13 - t12)), total: distM(a.lon, a.lat, b.lon, b.lat) };
}
/** Plausible filed route for where the aircraft actually is (adsbdb routes can be stale for reused callsigns). */
export function routeFit(route, pos) {
  if (!route || !route.origin || !route.destination || !isNum(route.origin.lat) || !isNum(route.destination.lat) || !pos) return null;
  const r = onRoute(route.origin, route.destination, pos);
  const ok = r.xt < Math.max(90e3, 0.15 * r.total) && r.at > -60e3 && r.at < r.total + 60e3;
  return { ...r, ok, frac: Math.max(0, Math.min(1, r.at / r.total)), left: Math.max(0, r.total - r.at) };
}

// ------------------------------------------------------------------ aircraft
export function aircraftCard(app, hex) {
  const L = app.layers.air;
  let info = null, lookupDone = false;
  const rec0 = L.record(hex);
  if (!rec0) return null;
  app.lookupFlight(rec0).then((j) => { info = j; lookupDone = true; paintStatic(); }).catch(() => { lookupDone = true; paintStatic(); });
  let root = null;
  function header() {
    const rec = L.record(hex) || rec0, spec = L.spec(hex) || {};
    const rt = info && info.route, pos = L.now(hex);
    const fit = routeFit(rt, pos);
    const title = flightNo(rec.callsign, fit && fit.ok && rt.airline ? rt.airline.iata : null) || rec.reg || hex.toUpperCase();
    const airline = (fit && fit.ok && rt.airline && rt.airline.name) || rec.operator || (rec.kind === 'seaplane' ? 'Floatplane' : rec.kind === 'helicopter' ? 'Helicopter' : rec.kind === 'military' ? 'Military' : 'Private or unscheduled');
    const ac = info && info.aircraft;
    const typeName = (ac && ac.manufacturer && ac.type ? `${ac.manufacturer} ${ac.type}` : null) || spec.desc || rec.desc || rec.type || 'Aircraft';
    return { rec, spec, rt, fit, title, airline, typeName };
  }
  function paintStatic() {
    if (!root) return;
    const h = header();
    const photo = info && info.photo;
    root.innerHTML = `<div class="card">
      <div class="kind" style="color:var(--air)">${icon('plane')} ${h.rec.kind === 'helicopter' ? 'Helicopter' : 'Flight'}</div>
      <h1>${esc(h.title)}</h1><div class="h-sub">${esc(h.airline)} · ${esc(h.typeName)}</div>
      <div data-k="status"></div>
      ${photo ? `<div class="photo" style="background-image:url('${esc(photo.src)}')"><a class="credit" href="${esc(photo.link || 'https://www.planespotters.net')}" target="_blank" rel="noopener">© ${esc(photo.credit || 'planespotters.net')}</a></div>` : ''}
      ${h.fit && h.fit.ok ? `<div class="route"><div class="ap">${esc(h.rt.origin.iata || h.rt.origin.icao)}<small>${esc(h.rt.origin.city || h.rt.origin.name || '')}</small></div>
        <div class="track"><div class="ln"></div><div class="done" data-k="done"></div><div class="pl" data-k="pl">${icon('plane', 'ic', 'style="width:20px;height:20px"')}</div></div>
        <div class="ap r">${esc(h.rt.destination.iata || h.rt.destination.icao)}<small>${esc(h.rt.destination.city || h.rt.destination.name || '')}</small></div></div>
        <div class="route-meta" data-k="rmeta"></div>`
        : `<div class="fine" style="margin-top:14px">${lookupDone ? (h.rt ? 'The filed route for this callsign doesn\'t match where the aircraft is, so it isn\'t shown.' : 'No published route for this flight (common for private, cargo charter, military and local flights).') : 'Looking up the route…'}</div>`}
      <div class="grid2" data-k="grid"></div>
      <div class="sec"><h3>Altitude <span data-k="altnote"></span></h3><div data-k="spark"></div></div>
      <div class="actions">${followBtn(app.follows.has('aircraft', hex))}
        <button class="btn" data-act="track">${icon('target')} Track</button><button class="btn" data-act="chase">${icon('chase')} Chase</button>
        ${h.rec.onGround ? '' : `<button class="btn" data-act="cockpit">${icon('cockpit')} Cockpit</button>`}<button class="btn" data-act="share">${icon('link')} Share</button></div>
      <div class="fine">Position from ADS-B (${esc((app.store.get('aircraft') || {}).provider || 'adsb.lol')}, volunteer receivers), drawn between reports by dead reckoning.
        ${h.rt ? 'Route from adsbdb: callsign-based, can be wrong for charters and repositioning flights.' : ''}
        <br><a href="https://globe.adsb.lol/?icao=${esc(hex)}" target="_blank" rel="noopener">Track history</a> · ${h.rec.callsign ? `<a href="https://flightaware.com/live/flight/${esc(h.rec.callsign)}" target="_blank" rel="noopener">FlightAware</a> · ` : ''}ICAO ${esc(hex.toUpperCase())}${h.rec.reg ? ` · ${esc(h.rec.reg)}` : ''}</div></div>`;
    tick();
  }
  function tick() {
    if (!root) return;
    const rec = L.record(hex);
    const s = L.now(hex);
    const set = (k, html) => { const el = root.querySelector(`[data-k="${k}"]`); if (el && el.innerHTML !== html) el.innerHTML = html; };
    if (!rec || !s) { set('status', status('muted', 'Out of range: no recent position')); return; }
    const h = header();
    const altFt = rec.onGround ? 0 : Math.round(s.alt / FT / 10) * 10;
    const vr = rec.vrFpm || 0;
    let phase = rec.onGround ? 'On the ground' : vr > 400 ? 'Climbing' : vr < -400 ? 'Descending' : 'Level flight';
    const dest = h.fit && h.fit.ok ? h.rt.destination : null, orig = h.fit && h.fit.ok ? h.rt.origin : null;
    if (!rec.onGround && dest && vr < -300 && h.fit.left < 70e3) phase = `On approach to ${dest.iata || dest.icao}`;
    else if (!rec.onGround && orig && vr > 300 && h.fit.at < 50e3) phase = `Departed ${orig.iata || orig.icao}`;
    else if (rec.kind === 'helicopter' && (rec.gsKt || 0) < 25 && !rec.onGround) phase = 'Hovering';
    const cls = rec.emergency ? 'alert' : rec.onGround ? 'muted' : '';
    set('status', status(cls, rec.emergency ? `Emergency: ${rec.emergency} (squawk ${rec.squawk})` : phase));
    if (dest) {
      const pct = Math.round(h.fit.frac * 100);
      const done = root.querySelector('[data-k="done"]'), pl = root.querySelector('[data-k="pl"]');
      if (done) done.style.width = `${pct}%`;
      if (pl) pl.style.left = `${pct}%`;
      const gs = s.gs || 1;
      const eta = Date.now() + (h.fit.left / Math.max(gs, 60)) * 1000 + (h.fit.left > 80e3 ? 6 * 60e3 : 0);
      set('rmeta', `<span>${miles(h.fit.at)} mi flown</span><span>${miles(h.fit.left)} mi to go · lands ≈ ${time(eta)}</span>`);
    }
    const [e, n] = enu(BALLARD.lon, BALLARD.lat, s.lon, s.lat);
    const dNow = Math.hypot(e, n);
    const cpa = closestApproach(e, n, s.heading, s.gs || 0);
    const cpaTxt = cpa.tS > 5 && cpa.tS < 900 && cpa.dM < dNow - 200 ? `closest ${miles(cpa.dM)} mi in ${dur(cpa.tS)}` : dNow < 1500 ? 'overhead now' : 'moving away';
    set('grid', [
      stat('Altitude', rec.onGround ? 'Ground' : `${num(altFt)}<small> ft</small>`, rec.onGround ? '' : `${vr > 150 ? '▲' : vr < -150 ? '▼' : '▶'} ${num(Math.abs(vr))} ft/min`),
      stat('Speed', `${num(rec.gsKt)}<small> kt</small>`, `${num((rec.gsKt || 0) * 1.15078)} mph`),
      stat('Heading', `${num(s.heading)}°<small> ${compass(s.heading)}</small>`, s.bank && Math.abs(s.bank) > 4 ? `banking ${Math.abs(Math.round(s.bank))}° ${s.bank > 0 ? 'right' : 'left'}` : 'wings level'),
      stat('From Ballard', `${miles(dNow)}<small> mi</small>`, cpaTxt),
      stat('Aircraft', esc(rec.type || '–'), esc(rec.reg || '')),
      stat('Squawk', esc(rec.squawk || '–'), rec.squawk === '1200' ? 'VFR' : rec.category ? `category ${esc(rec.category)}` : ''),
    ].join(''));
    const tr = L.trail(hex);
    set('spark', spark(tr.map((p) => p[2] / FT)));
    set('altnote', tr.length > 1 ? `last ${Math.round((tr[tr.length - 1][3] - tr[0][3]) / 60) || 1} min` : '');
  }
  return {
    kind: 'aircraft', id: hex,
    mount(el) { root = el; paintStatic(); },
    tick,
    target: () => { const s = L.now(hex); return s ? { ...s } : null; },
    label() { const h = header(); return h.title; },
  };
}

// ------------------------------------------------------------------ bus
export function busCard(app, id) {
  const L = app.layers.bus;
  let root = null;
  function paint() {
    const o = L.get(id);
    if (!root || !o) return;
    const r = o.route || {};
    const spec = busSpec(id, r.short);
    const color = r.color && r.color !== '#FDB71A' ? r.color : spec.color;
    root.innerHTML = `<div class="card">
      <div class="kind" style="color:var(--bus)">${icon('bus')} ${r.agency === '40' ? 'ST Express · operated by Metro' : 'King County Metro'}</div>
      <h1><span class="badge" style="background:${esc(color)};font-size:22px;height:36px;padding:0 10px;border-radius:9px;vertical-align:4px">${esc(r.short || '?')}</span> ${esc((o.info && o.info.headsign) || r.name || '')}</h1>
      <div class="h-sub">${esc(r.name || '')}</div>
      <div data-k="status"></div>
      <div class="grid2" data-k="grid"></div>
      <div class="sec"><h3>Next stops <span data-k="upd"></span></h3><div class="timeline" data-k="stops" style="--c:${esc(color)}"></div></div>
      <div class="actions">${followBtn(app.follows.has('bus', id))}<button class="btn" data-act="track">${icon('target')} Track</button><button class="btn" data-act="chase">${icon('chase')} Ride along</button><button class="btn" data-act="share">${icon('link')} Share</button></div>
      <div class="fine">King County Metro real-time feed (GTFS-rt): positions arrive about 30 to 60 seconds after the fact, so the bus you see is where it most likely is now, estimated along its route from those reports, its recent pace and Metro's predicted stop times (usually within a block). The small ring marks its last reported position.
        Vehicle ${esc(id)}: ${esc(spec.desc)}${spec.propulsion === 'trolley' ? ' (electric trolleybus)' : spec.propulsion === 'battery' ? ' (battery-electric)' : ''}.</div></div>`;
    tick();
  }
  function tick() {
    const o = L.get(id);
    if (!root) return;
    const set = (k, html) => { const el = root.querySelector(`[data-k="${k}"]`); if (el && el.innerHTML !== html) el.innerHTML = html; };
    if (!o) { set('status', status('muted', 'No longer reporting in this area')); return; }
    const v = o.rec, d = v.delay;
    const late = isNum(d) ? (d >= 90 ? ['warn', `${Math.round(d / 60)} min late`] : d <= -90 ? ['ok', `${Math.round(-d / 60)} min early`] : ['ok', 'On time']) : ['muted', 'No prediction'];
    const now = L.now(id);
    set('status', `${status(late[0], late[1])} ${v.status === 'stopped' ? status('muted', 'At a stop') : now && now.moving ? status('', 'Moving') : ''}`);
    const next = (v.next || []).filter((x) => x[2] > Date.now() - 30e3).slice(0, 7);
    const stopName = (sid) => { const s = app.transit.stop(sid); return s ? s.name : `Stop ${sid}`; };
    const watched = new Set((app.stopWatch || []).filter((w) => !w.route || w.route === v.route).map((w) => w.stop));
    set('stops', next.map(([sid, , t, dl], i) => `<div class="st ${i === 0 ? 'now' : ''}"><div class="n">${esc(stopName(sid))}${i === 0 && v.status === 'stopped' ? '<small>at this stop now</small>' : ''}</div>
      <div class="t" style="display:flex;align-items:center;gap:8px"><span>${esc(inMin(t))}<small class="${isNum(dl) && dl >= 90 ? 'late' : 'ontime'}">${esc(time(t))}</small></span>
      <button class="btn ${watched.has(sid) ? 'on' : ''}" style="padding:6px" title="Alert me ~5 min before a ${esc((o.route && o.route.short) || '')} reaches this stop" data-act="watch" data-stop="${esc(sid)}" data-name="${esc(stopName(sid))}">${icon('bell', 'ic', 'style="width:14px;height:14px"')}</button></div></div>`).join('') || '<div class="fine">No upcoming stops reported.</div>');
    set('upd', `updated ${ago(v.t)}`);
    const next0 = next[0];
    set('grid', [
      stat('Next stop', next0 ? esc(inMin(next0[2])) : '–', next0 ? esc(stopName(next0[0])) : ''),
      stat('Vehicle', `#${esc(id)}`, esc(busSpec(id, o.route && o.route.short).desc)),
    ].join(''));
  }
  return { kind: 'bus', id, mount(el) { root = el; paint(); }, tick, target: () => L.now(id), label: () => { const o = L.get(id); return o && o.route ? `${o.route.short} ${o.info ? `→ ${o.info.headsign}` : ''}` : `Bus ${id}`; } };
}

// ------------------------------------------------------------------ bus stop (live arrivals board)
export function stopCard(app, stopId) {
  let root = null;
  const stop = () => app.transit.stop(stopId);
  function arrivals() {
    const now = Date.now(), out = [];
    for (const b of app.layers.bus.list()) {
      const hit = (b.rec.next || []).find((x) => x[0] === stopId && x[2] > now - 30e3);
      if (hit) out.push({ b, t: hit[2], delay: hit[3] });
    }
    return out.sort((a, c) => a.t - c.t);
  }
  function paint() {
    const s = stop();
    if (!root) return;
    if (!s) { root.innerHTML = '<div class="card"><h1>Bus stop</h1><p class="h-sub">Unknown stop.</p></div>'; return; }
    root.innerHTML = `<div class="card"><div class="kind" style="color:var(--bus)">${icon('bus')} Bus stop · #${esc(stopId)}</div>
      <h1 style="font-size:24px">${esc(s.name)}</h1><div class="h-sub">Live arrivals from King County Metro's real-time feed</div>
      <div class="sec"><h3>Arriving <span data-k="upd"></span></h3><div class="rows" style="padding:0" data-k="list"></div></div>
      <div class="actions"><button class="btn" data-act="track">${icon('target')} Show</button><a class="btn" href="https://kingcounty.gov/en/dept/metro" target="_blank" rel="noopener">${icon('link')} Schedules</a><button class="btn" data-act="share">${icon('link')} Share</button></div>
      <div class="fine">Only buses already on their way (reporting live) are listed; tap the bell to be alerted about 5 minutes before one gets here.</div></div>`;
    tick();
  }
  function tick() {
    if (!root) return;
    const el = root.querySelector('[data-k="list"]');
    if (!el) return;
    const rows = arrivals();
    const watched = (app.stopWatch || []).filter((w) => w.stop === stopId);
    const html = rows.map(({ b, t, delay }) => {
      const r = b.route || {}, on = watched.some((w) => !w.route || w.route === b.rec.route);
      return `<div class="row" data-open="bus:${esc(b.id)}" style="cursor:pointer"><div class="b" style="background:${esc(b.spec.color)};color:#fff">${esc((r.short || '?').replace(' Line', ''))}</div>
        <div><div class="t">${esc(b.info && b.info.headsign ? `to ${b.info.headsign}` : r.name || '')}</div><div class="s">${isNum(delay) ? (Math.abs(delay) < 90 ? 'on time' : delay > 0 ? `${Math.round(delay / 60)} min late` : `${Math.round(-delay / 60)} min early`) : 'live'} · bus ${esc(b.id)}</div></div>
        <div class="r" style="display:flex;align-items:center;gap:8px"><span>${esc(inMin(t))}<small>${esc(time(t))}</small></span>
        <button class="btn ${on ? 'on' : ''}" style="padding:6px" title="Alert me ~5 min before a ${esc(r.short || '')} gets here" data-act="watch-stop" data-route="${esc(b.rec.route || '')}" data-label="${esc(r.short || '')}">${icon('bell', 'ic', 'style="width:14px;height:14px"')}</button></div></div>`;
    }).join('') || '<div class="fine" style="margin:0">No buses reporting on their way here right now.</div>';
    if (el.innerHTML !== html) el.innerHTML = html;
    const u = root.querySelector('[data-k="upd"]');
    if (u) u.textContent = `${rows.length} on the way`;
  }
  return { kind: 'stop', id: stopId, mount(el) { root = el; paint(); }, tick, target: () => { const s = stop(); return s ? { lon: s.lon, lat: s.lat, alt: 0, heading: 0 } : null; }, label: () => (stop() || {}).name || 'Stop' };
}

// ------------------------------------------------------------------ traffic camera
export function cameraCard(app, id) {
  let root = null;
  const cam = () => app.layers.cameras.get(id);
  function paint() {
    const c = cam();
    if (!root) return;
    if (!c) { root.innerHTML = '<div class="card"><h1>Camera</h1><p class="h-sub">This camera is offline right now.</p></div>'; return; }
    root.innerHTML = `<div class="card"><div class="kind" style="color:var(--air)">${icon('camera')} Traffic camera · SDOT</div>
      <h1 style="font-size:24px">${esc(c.label)}</h1><div class="h-sub" data-k="age"></div>
      <div class="cam" style="margin-top:14px"><img alt="Live traffic camera: ${esc(c.label)}" data-k="img" src="/img?u=${encodeURIComponent(c.url)}&t=${c.lastModified}"></div>
      <div class="actions"><button class="btn" data-act="track">${icon('target')} Show</button><button class="btn" data-act="share">${icon('link')} Share</button></div>
      <div class="fine">Seattle Department of Transportation traffic cameras publish a still image about once a minute.</div></div>`;
    tick();
  }
  function tick() {
    const c = cam();
    if (!root || !c) return;
    const age = root.querySelector('[data-k="age"]');
    if (age) age.textContent = `Updated ${ago(c.lastModified)}`;
    const img = root.querySelector('[data-k="img"]');
    const src = `/img?u=${encodeURIComponent(c.url)}&t=${c.lastModified}`;
    if (img && !img.src.endsWith(src.slice(1))) img.src = src;
  }
  return { kind: 'camera', id, mount(el) { root = el; paint(); }, tick, target: () => { const c = cam(); return c ? { lon: c.lon, lat: c.lat, alt: 0, heading: 0 } : null; }, label: () => (cam() || {}).label || 'Camera' };
}

// ------------------------------------------------------------------ train
function trainDelay(st) {
  const sch = st.schDep ?? st.schArr, est = st.dep ?? st.arr;
  return isNum(sch) && isNum(est) ? Math.round((est - sch) / 60000) : null;
}
export function trainCard(app, id) {
  let root = null;
  const find = () => { const d = app.store.get('trains') || {}; return (d.trains || []).find((t) => t.id === id) || (d.upcoming || []).find((t) => t.id === id) || null; };
  function paint() {
    const t = find();
    if (!root) return;
    if (!t) { root.innerHTML = '<div class="card"><h1>Train</h1><p class="h-sub">No longer on the Ballard line.</p></div>'; return; }
    root.innerHTML = `<div class="card"><div class="kind" style="color:var(--train)">${icon('train')} Amtrak</div>
      <h1>${esc(t.route)} ${esc(t.num)}</h1><div class="h-sub">${esc(t.origin.name || t.origin.code)} → ${esc(t.dest.name || t.dest.code)}</div>
      <div data-k="status"></div><div class="grid2" data-k="grid"></div>
      <div class="sec"><h3>Stations</h3><div class="timeline" data-k="stations" style="--c:var(--train)"></div></div>
      <div class="actions">${followBtn(app.follows.has('train', id))}<button class="btn" data-act="track">${icon('target')} Track</button><button class="btn" data-act="chase">${icon('chase')} Chase</button><button class="btn" data-act="share">${icon('link')} Share</button></div>
      <div class="fine">Amtrak's train map via Amtraker; positions every one to a few minutes, motion along the BNSF line in between is estimated from the reported speed. The time a train passes Ballard is estimated from its Seattle and Edmonds times.</div></div>`;
    tick();
  }
  function tick() {
    const t = find();
    if (!root || !t) return;
    const set = (k, html) => { const el = root.querySelector(`[data-k="${k}"]`); if (el && el.innerHTML !== html) el.innerHTML = html; };
    const sts = t.stations || [];
    const nextSt = sts.find((s) => s.status !== 'Departed') || sts[sts.length - 1];
    const dl = nextSt ? trainDelay(nextSt) : null;
    set('status', dl == null ? status('muted', t.state || 'Scheduled') : dl > 4 ? status('warn', `${dl} min late`) : dl < -2 ? status('ok', `${-dl} min early`) : status('ok', 'On time'));
    const pass = t.pass;
    set('grid', [
      stat('Speed', isNum(t.speedMph) ? `${num(t.speedMph)}<small> mph</small>` : '–', t.heading ? `heading ${esc(t.heading)}` : ''),
      stat(pass && pass.t < Date.now() ? 'Passed Ballard' : 'Passes Ballard', pass ? `≈ ${esc(time(pass.t))}` : '–', pass ? (pass.northbound ? 'northbound' : 'southbound') : ''),
    ].join(''));
    set('stations', sts.map((s) => { const d = trainDelay(s); const est = s.dep ?? s.arr, sch = s.schDep ?? s.schArr;
      return `<div class="st ${s.status === 'Departed' ? 'done' : s === nextSt ? 'now' : ''}"><div class="n">${esc(s.name || s.code)}<small>${esc(s.code)}${s.status ? ` · ${esc(s.status)}` : ''}</small></div>
        <div class="t">${esc(time(est ?? sch))}<small class="${d > 4 ? 'late' : 'ontime'}">${d == null ? '' : d > 0 ? `+${d} min` : d < 0 ? `${d} min` : 'on time'}</small></div></div>`; }).join(''));
  }
  return { kind: 'train', id, mount(el) { root = el; paint(); }, tick, target: () => app.layers.train.now(id), label: () => { const t = find(); return t ? `${t.route} ${t.num}` : 'Train'; } };
}

// ------------------------------------------------------------------ bridge
function nearestCam(app, lon, lat, maxM = 450) {
  let best = null;
  for (const c of (app.store.get('cameras') || {}).cameras || []) {
    if (!c.ok || !isNum(c.lat)) continue;
    const d = distM(lon, lat, c.lon, c.lat);
    if (d < maxM && (!best || d < best.d)) best = { ...c, d };
  }
  return best;
}
export function bridgeCard(app, name) {
  let root = null;
  const live = () => ((app.store.get('bridges') || {}).bridges || []).find((b) => b.name === name) || null;
  function paint() {
    const b = app.layers.bridge.get(name);
    if (!root || !b) return;
    const cam = nearestCam(app, b.center[0], b.center[1]);
    root.innerHTML = `<div class="card"><div class="kind" style="color:var(--bridge)">${icon('bridge')} Drawbridge · SDOT</div>
      <h1>${esc(name)} Bridge</h1><div class="h-sub">Bascule bridge over the Lake Washington Ship Canal · ${esc(num(b.clearanceM / FT))} ft clearance when down</div>
      <div data-k="status"></div><div class="grid2" data-k="grid"></div>
      <div class="sec"><h3>Openings today <span data-k="cnt"></span></h3><div class="bars" data-k="bars"></div><div class="route-meta" style="margin-top:4px"><span>12 am</span><span>6 am</span><span>noon</span><span>6 pm</span><span>11 pm</span></div></div>
      <div class="sec"><h3>Recent openings</h3><div data-k="log"></div></div>
      ${cam ? `<div class="sec"><h3>Live camera <span>${esc(cam.label)}</span></h3><div class="cam"><img alt="SDOT traffic camera near the ${esc(name)} Bridge" src="/img?u=${encodeURIComponent(cam.url)}&t=${cam.lastModified}"><span>SDOT · ${esc(ago(cam.lastModified))}</span></div></div>` : ''}
      <div class="actions">${followBtn(app.follows.has('bridge', name))}<button class="btn" data-act="track">${icon('target')} Show</button><button class="btn" data-open="list:alerts">${icon('bell')} Phone alerts</button><button class="btn" data-act="share">${icon('link')} Share</button></div>
      <div class="fine">Status from SDOT's live bridge feed; openings history from Seattle open data. Under federal rules (33 CFR 117.1051) these bridges needn't open for most vessels during weekday rush hours.</div></div>`;
    tick();
  }
  function tick() {
    if (!root) return;
    const set = (k, html) => { const el = root.querySelector(`[data-k="${k}"]`); if (el && el.innerHTML !== html) el.innerHTML = html; };
    const lb = live();
    const log = ((app.store.get('bridges') || {}).log || []).filter((l) => l.bridge === name);
    const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });
    const todays = log.filter((l) => new Date(l.upAt).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' }) === today);
    const durs = log.map((l) => l.minutes).filter(isNum).sort((a, b) => a - b);
    const med = durs.length ? durs[Math.floor(durs.length / 2)] : null;
    if (lb && lb.up) {
      const upFor = (Date.now() - (lb.since || Date.now())) / 1000;
      set('status', `${status('alert', `Up · open to boats · ${dur(upFor)}`)}`);
    } else set('status', status('ok', lb && lb.sinceKnown ? `Down · open to traffic since ${time(lb.since)}` : 'Down · open to traffic'));
    const od = app.store.get('bridge-odds') || {};
    const odds = name === 'Ballard' ? od.now : name === 'Fremont' && od.fremont ? od.fremont.now : null;
    const typical = odds && isNum(odds.typicalMinutes) ? odds.typicalMinutes : med;
    set('grid', [
      stat('Typical opening', typical ? `${num(typical, 0)}<small> min</small>` : '–', odds && isNum(odds.typicalMinutes) ? 'median, last 12 weeks' : durs.length ? `median of the last ${durs.length}` : ''),
      stat(lb && lb.up ? 'Expected down' : 'Next 30 minutes', lb && lb.up ? (typical ? `≈ ${esc(time((lb.since || Date.now()) + typical * 60e3))}` : '–')
        : odds && isNum(odds.chanceNext30Min) ? `${Math.round(odds.chanceNext30Min * 100)}<small>%</small>` : '–',
        lb && lb.up ? 'at the typical duration' : odds ? (odds.restricted ? 'rush-hour restriction in effect' : 'chance it opens (same hour, 12 weeks)') : ''),
    ].join(''));
    const byHour = new Array(24).fill(0);
    for (const l of todays) byHour[+new Date(l.upAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }) % 24]++;
    const mx = Math.max(1, ...byHour), hNow = +new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }) % 24;
    set('bars', byHour.map((v, i) => `<i class="${i === hNow ? 'now' : ''}" style="height:${(v / mx) * 100}%" title="${i}:00 · ${v}"></i>`).join(''));
    set('cnt', `${todays.length} so far`);
    set('log', log.slice(0, 6).map((l) => `<div class="row" style="grid-template-columns:1fr auto;padding:6px 4px"><div><div class="t">${esc(time(l.upAt))}</div><div class="s">${esc(day(l.upAt))}</div></div><div class="r">${num(l.minutes, 1)}<small>minutes</small></div></div>`).join('') || '<div class="fine">No openings logged yet.</div>');
  }
  return { kind: 'bridge', id: name, mount(el) { root = el; paint(); }, tick, target: () => app.layers.bridge.now(name), label: () => `${name} Bridge` };
}

// ------------------------------------------------------------------ incident
const UNIT = { E: 'Engine', L: 'Ladder', M: 'Medic', A: 'Aid unit', B: 'Battalion chief', MSO: 'Medical services officer', DEP: 'Deputy chief', HAZ: 'Hazmat', R: 'Rescue', FB: 'Fireboat', MRN: 'Marine unit', SAFT: 'Safety officer', AIR: 'Air unit', PIO: 'Public information officer' };
const unitName = (u) => { const m = /^([A-Z]+)(\d*)$/.exec(u); return m && UNIT[m[1]] ? `${UNIT[m[1]]} ${m[2]}`.trim() : u; };
export function incidentCard(app, id) {
  let root = null;
  function paint() {
    const x = app.layers.incidents.get(id);
    if (!root) return;
    if (!x) { root.innerHTML = '<div class="card"><h1>Call closed</h1><p class="h-sub">This call is no longer in the last two hours.</p></div>'; return; }
    const r = x.rec, c = CAT_COLOR[x.cat] || CAT_COLOR.other;
    const units = String(r.units || '').split(/\s+/).filter(Boolean);
    root.innerHTML = `<div class="card"><div class="kind" style="color:${rgb(c)}">${icon('siren')} ${x.src === 'fire' ? '911 · Seattle Fire Department' : 'Traffic incident · SDOT'}</div>
      <h1>${esc(x.label)}</h1><div class="h-sub">${esc(titleCase(r.address || r.location || ''))}</div>
      <div data-k="status"></div>
      ${units.length ? `<div class="sec"><h3>Units dispatched <span>${units.length}</span></h3><div class="rows" style="padding:0">${units.map((u) => `<div class="row" style="grid-template-columns:40px 1fr;padding:6px 4px"><div class="b" style="background:${rgb(c)}22;color:${rgb(c)}">${esc(u)}</div><div class="t">${esc(unitName(u))}</div></div>`).join('')}</div></div>` : ''}
      <div class="actions"><button class="btn" data-act="track">${icon('target')} Show</button><button class="btn" data-act="share">${icon('link')} Share</button></div>
      <div class="fine">${x.src === 'fire' ? 'Seattle Fire Department real-time 911 dispatches. Medical calls are included without patient details; an address can be a block location.' : 'SDOT traffic incident feed.'}</div></div>`;
    tick();
  }
  function tick() {
    const x = app.layers.incidents.get(id);
    if (!root || !x) return;
    const el = root.querySelector('[data-k="status"]');
    const html = x.active ? status('alert', `Active · dispatched ${ago(x.t)}`) : status('muted', `Dispatched ${time(x.t)} · ${ago(x.t)}`);
    if (el && el.innerHTML !== html) el.innerHTML = html;
  }
  return { kind: 'incident', id, mount(el) { root = el; paint(); }, tick, target: () => app.layers.incidents.now(id), label: () => (app.layers.incidents.get(id) || {}).label || 'Call' };
}

// ------------------------------------------------------------------ satellite
export function satCard(app, satId) {
  let root = null, passes = null;
  const sat = () => app.sky.find(satId);
  function paint() {
    const s = sat();
    if (!root) return;
    if (!s) { root.innerHTML = '<div class="card"><h1>Satellite</h1><p class="h-sub">Loading orbital elements…</p></div>'; app.sky.load().then(paint); return; }
    if (!passes) passes = app.sky.passes(s.rec ? s : s, Date.now(), 72, 10);
    const name = s.iss ? 'International Space Station' : s.css ? 'Tiangong space station' : titleCase(s.name);
    const vis = passes.filter((p) => p.visible).slice(0, 6);
    root.innerHTML = `<div class="card"><div class="kind" style="color:var(--sky)">${icon('sat')} Satellite · NORAD ${esc(s.id)}</div>
      <h1>${esc(name)}</h1><div class="h-sub">${esc(s.group)} · orbit from CelesTrak, position computed live (SGP4)</div>
      <div data-k="status"></div><div class="grid2" data-k="grid"></div>
      <div class="sec"><h3>Visible passes over Ballard <span>next 3 days</span></h3>${vis.length ? `<div class="rows" style="padding:0">${vis.map((p) => `<div class="row" style="grid-template-columns:1fr auto;padding:8px 4px"><div><div class="t">${esc(day(p.rise))} · ${esc(time(p.rise))}</div>
        <div class="s">rises ${esc(compass(p.riseAz))}, highest ${Math.round(p.maxEl)}° ${esc(compass(p.maxAz))}, sets ${esc(compass(p.setAz))}</div></div><div class="r">${esc(dur((p.set - p.rise) / 1000))}<small>visible</small></div></div>`).join('')}</div>` : '<div class="fine">No visible passes in the next three days (it passes over in daylight or in Earth\'s shadow).</div>'}</div>
      <div class="actions">${followBtn(app.follows.has('sat', String(s.id)))}<button class="btn" data-act="sky">${icon('sky')} Open sky view</button><button class="btn" data-act="share">${icon('link')} Share</button></div>
      <div class="fine">"Visible" means the satellite is sunlit while the sky over Ballard is dark (sun more than 6° below the horizon), and at least 10° above the horizon.</div></div>`;
    tick();
  }
  function tick() {
    const s = sat();
    if (!root || !s) return;
    const p = app.sky.at(s, Date.now());
    if (!p) return;
    const set = (k, html) => { const el = root.querySelector(`[data-k="${k}"]`); if (el && el.innerHTML !== html) el.innerHTML = html; };
    const dark = app.sky.sun().elevation < -6;
    set('status', p.el > 0 ? (p.sunlit && dark ? status('ok', `Visible now: look ${compass(p.az)}, ${Math.round(p.el)}° up`) : status('', `Above the horizon (${p.sunlit ? 'sky too bright' : "in Earth's shadow"})`)) : status('muted', 'Below the horizon'));
    set('grid', [stat('Altitude', `${num(p.altKm)}<small> km</small>`, `${num(p.altKm * 0.6214)} mi`), stat('Speed', `${num(p.speedKmh)}<small> km/h</small>`, `${num(p.speedKmh * 0.6214)} mph`),
      stat('Over', `${num(Math.abs(p.lat), 1)}°${p.lat >= 0 ? 'N' : 'S'} ${num(Math.abs(p.lon), 1)}°${p.lon >= 0 ? 'E' : 'W'}`, ''), stat('Distance', `${num(p.range)}<small> km</small>`, 'from Ballard')].join(''));
  }
  return { kind: 'sat', id: String(satId), mount(el) { root = el; paint(); }, tick, target: () => null, label: () => { const s = sat(); return s ? (s.iss ? 'ISS' : titleCase(s.name)) : 'Satellite'; } };
}

// ------------------------------------------------------------------ weather
export function weatherCard(app) {
  let root = null;
  function paint() {
    const w = app.store.get('weather');
    if (!root) return;
    if (!w || !w.current) { root.innerHTML = '<div class="card"><h1>Weather</h1><p class="h-sub">Loading…</p></div>'; return; }
    const c = w.current, hr = (w.hourly || []).filter((h) => h.t >= Date.now() - 3600e3).slice(0, 12);
    const tide = app.store.get('tides'), aq = app.store.get('purpleair');
    const sun = app.sky.sun(), rs = app.sunTimes();
    root.innerHTML = `<div class="card"><div class="kind" style="color:var(--weather)">${icon('cloud')} Weather in Ballard</div>
      <h1>${Math.round(c.tempF)}° <span style="font-weight:600;font-size:22px;color:var(--muted)">${esc(WX(c.code))}</span></h1>
      <div class="h-sub">Feels like ${Math.round(c.feelsF)}° · wind ${Math.round(c.windMph)} mph ${esc(compass(c.windDir))}${c.gustMph > c.windMph + 5 ? `, gusts ${Math.round(c.gustMph)}` : ''} · humidity ${num(c.humidity)}%</div>
      ${w.rainStartsAt ? status('warn', `Rain starting ≈ ${time(w.rainStartsAt)}`) : w.rainEndsAt ? status('', `Rain ending ≈ ${time(w.rainEndsAt)}`) : status('ok', 'No rain expected in the next hours')}
      <div class="sec"><h3>Next 12 hours</h3><div style="display:grid;grid-template-columns:repeat(${hr.length},1fr);gap:4px;text-align:center">${hr.map((h) => `<div><div class="fine" style="margin:0">${esc(time(h.t).replace(':00', ''))}</div><div style="font-weight:700;font-size:15px">${Math.round(h.tempF)}°</div><div class="fine" style="margin:0;color:${h.pop >= 40 ? 'var(--weather)' : 'var(--faint)'}">${h.pop ? `${h.pop}%` : ''}</div></div>`).join('')}</div></div>
      <div class="grid2">${stat(sun.elevation > 0 ? 'Sunset' : 'Sunrise', esc(time(sun.elevation > 0 ? rs.set : rs.rise)), sun.elevation > 0 ? `sun ${Math.round(sun.elevation)}° up` : `sun ${Math.round(-sun.elevation)}° below`)}
        ${stat('Tide', tide && tide.latest ? `${num(tide.latest.ft, 1)}<small> ft</small>` : '–', tide && tide.next && tide.next[0] ? `${esc(tide.next[0].type === 'H' ? 'high' : 'low')} ${num(tide.next[0].ft, 1)} ft at ${esc(time(tide.next[0].t))}` : 'Shilshole Bay')}
        ${stat('Air quality', aq ? `${num(aq.medianAqi)}<small> AQI</small>` : '–', aq ? `${num(aq.count)} PurpleAir sensors` : '')}
        ${stat('Pressure', `${num(c.pressureHpa)}<small> hPa</small>`, `visibility ${num(c.visMi, 0)} mi`)}</div>
      <div class="actions"><button class="btn ${app.radarOn() ? 'on' : ''}" data-act="radar">${icon('radar')} Rain radar</button></div>
      <div class="fine">Open-Meteo (current and hourly), NOAA tides at Shilshole Bay, PurpleAir sensors; radar from NEXRAD via Iowa Environmental Mesonet.</div></div>`;
  }
  return { kind: 'weather', id: 'now', mount(el) { root = el; paint(); }, tick() { /* re-rendered on data */ }, repaint: paint, target: () => null, label: () => 'Weather' };
}
