// Ballard Live insight engine: pure functions over the live store (D(id) -> data) that turn raw feeds into
// meaning. Used by the hero scene, the Dynamic Island pill, Moments, Ask Ballard, Stories, For You and Share.
//   sunPosition / moonPosition   real astronomy for the living scene
//   summaries                    one-line status per topic
//   liveActivities               ranked "what's live right now" items (the header pill)
//   moments                      smart spotlight suggestions (clear sunset, minus tide, salmon run, ...)
//   answer / suggestions         natural-language Q&A over live data (Ask Ballard)
//   brief                        a spoken narrative of right now
// Everything here is synchronous and side-effect free; callers pass `now` and, optionally, history series.
import { esc, href, isNum, r0, r1, time, hour, wd, md, dayLabel, dayKey, pparts, wxText, aqiInfo, compass, duration, plural, camSrc, rel } from './util.js';
import { liveGroups, etaText, tideAt, nextTides, rainTimes, closureToday } from './cards.js';
import { icon } from './icons.js';

const MIN = 60e3, H = 60 * MIN, DAY = 24 * H;
export const CENTER = { lat: 47.6687, lon: -122.3847 };
const RAD = Math.PI / 180;
const arr = (v) => (Array.isArray(v) ? v : []);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const listJoin = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// ======================================================================= astronomy

/** Solar elevation and azimuth (degrees; azimuth clockwise from north) at time t. Accurate to ~0.5°. */
export function sunPosition(t, lat = CENTER.lat, lon = CENTER.lon) {
  const d = t / DAY + 2440587.5 - 2451545.0;
  const g = ((357.529 + 0.98560028 * d) % 360) * RAD;
  const q = (280.459 + 0.98564736 * d) % 360;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = ((gmst + lon / 15) * 15) * RAD - ra;
  const la = lat * RAD;
  const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
  let az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha)) / RAD;
  az = (az + 360) % 360;
  return { elevation: el / RAD, azimuth: az };
}

/** Moon for the scene: elevation arc between rise and set (from USNO times), illumination and waxing flag. */
export function moonPosition(sky, t) {
  const m = sky && sky.moon;
  if (!m) return null;
  const illum = isNum(m.illum) ? m.illum / 100 : 0.5;
  const waxing = /waxing|first|new/i.test(m.phase || '');
  let rise = m.rise, set = m.set;
  if (!isNum(rise) && !isNum(set)) return { up: false, illum, waxing };
  if (isNum(rise) && isNum(set) && set < rise) {
    // set belongs to this morning; the moon that rises today sets tomorrow (approx. +24h50m)
    if (t < set) rise = set - 12.4 * H; else set = set + 24.8 * H;
  }
  if (!isNum(rise)) rise = set - 12.4 * H;
  if (!isNum(set)) set = rise + 12.4 * H;
  const up = t >= rise && t <= set;
  const f = up ? (t - rise) / (set - rise) : 0;
  return { up, illum, waxing, frac: f, elevation: up ? Math.sin(f * Math.PI) * 42 : -10, azimuth: 100 + f * 160 };
}

export const sunIsUp = (t) => sunPosition(t).elevation > -0.8;

// ======================================================================= places (regular hours)

export const PLACES = [
  { id: 'market', name: 'Ballard Farmers Market', short: 'Farmers market', where: 'Ballard Ave NW', hours: { 0: [9, 14] } },
  { id: 'library', name: 'Ballard Library', short: 'Library', where: '5614 22nd Ave NW', hours: { 0: [10, 18], 1: [10, 18], 2: [10, 20], 3: [10, 20], 4: [10, 20], 5: [10, 18], 6: [10, 18] } },
  { id: 'nordic', name: 'National Nordic Museum', short: 'Nordic Museum', where: '2655 NW Market St', hours: { 0: [10, 17], 2: [10, 17], 3: [10, 17], 4: [10, 20], 5: [10, 17], 6: [10, 17] } },
];
const hh12 = (h) => (h === 0 ? '12 am' : h < 12 ? `${h} am` : h === 12 ? 'noon' : `${h - 12} pm`);
export function placeStatus(pl, now) {
  const p = pparts(now);
  const hr = p.hh + p.mm / 60;
  const today = pl.hours[p.wd];
  if (today && hr >= today[0] && hr < today[1]) return { open: true, text: `open until ${hh12(today[1])}`, closesAt: now + (today[1] - hr) * H };
  for (let i = today && hr < today[0] ? 0 : 1; i <= 7; i++) {
    const d = (p.wd + i) % 7;
    if (pl.hours[d]) return { open: false, text: `opens ${i === 0 ? 'today' : i === 1 ? 'tomorrow' : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]} ${hh12(pl.hours[d][0])}` };
  }
  return { open: false, text: 'closed' };
}

// ======================================================================= shared lookups

const ballardBridge = (D) => arr((D('bridges') || {}).bridges).find((x) => /ballard/i.test(x.name)) || null;
const fremontBridge = (D) => arr((D('bridges') || {}).bridges).find((x) => /fremont/i.test(x.name)) || null;
function dLineDowntown(D, now) {
  const tr = D('transit');
  if (!tr) return null;
  return liveGroups(tr, now).find((g) => g.route === 'D Line' && /downtown/i.test(`${g.headsign} ${g.dir}`)) || null;
}
const minsText = (t, now) => { const v = etaText(t, now); return v === 'now' ? 'now' : `${v} min`; };
function currentTide(D, now) {
  const td = D('tides');
  if (!td) return null;
  const cur = tideAt(td, now);
  return { ...cur, next: nextTides(td, now) };
}
function aqiNow(D) {
  const pa = D('purpleair');
  if (pa && isNum(pa.medianAqi)) return { aqi: pa.medianAqi, src: 'Ballard PurpleAir sensors' };
  const an = D('airnow');
  const o = an && arr(an.observed).find((x) => x.primary);
  return o ? { aqi: o.aqi, src: 'AirNow' } : null;
}
function nextSun(D, now) {
  const s = D('sky');
  if (!s || !s.sun) return null;
  const { rise, set } = s.sun;
  if (isNum(rise) && now < rise) return { kind: 'sunrise', t: rise };
  if (isNum(set) && now < set) return { kind: 'sunset', t: set };
  if (s.tomorrowSun && isNum(s.tomorrowSun.rise)) return { kind: 'sunrise', t: s.tomorrowSun.rise };
  return null;
}
const marineAdvisory = (D) => arr((D('alerts') || {}).alerts).find((a) => a.marine || /small craft|gale|marine/i.test(a.event || '')) || null;

// ======================================================================= summaries

/** One-line status per topic: { icon, label, value, sub, href, tone }. value/sub are plain text. */
export const SUMMARY = {
  weather(D) {
    const w = D('weather');
    if (!w || !w.current) return null;
    const c = w.current, d0 = arr(w.daily)[0] || {};
    return { icon: 'weather', label: 'Weather', value: `${r0(c.tempF)}°`, sub: `${wxText(c.code)}${isNum(d0.hiF) ? ` · H${r0(d0.hiF)} L${r0(d0.loF)}` : ''}`, href: '#weather' };
  },
  bridge(D, now) {
    const b = ballardBridge(D);
    if (!b) return null;
    const since = b.sinceKnown && isNum(b.since) ? b.since : null;
    return { icon: 'bridge', label: 'Ballard Bridge', value: b.up ? 'UP' : 'Down', tone: b.up ? 'warn' : 'ok', sub: b.up ? `raised${since ? ` ${Math.max(1, r0((now - since) / MIN))} min` : ''}` : 'open to traffic', href: '#water' };
  },
  bus(D, now) {
    const g = dLineDowntown(D, now);
    if (!g) return null;
    return { icon: 'transit', label: 'D Line → Downtown', value: minsText(g.arrivals[0].t, now), sub: g.arrivals[1] ? `then ${minsText(g.arrivals[1].t, now)}` : g.stopName, href: '#move' };
  },
  tide(D, now) {
    const c = currentTide(D, now);
    if (!c || !isNum(c.ft)) return null;
    const n = c.next[0];
    return { icon: 'tide', label: 'Tide', value: `${r1(c.ft)} ft ${c.trend === 'rising' ? '↑' : c.trend === 'falling' ? '↓' : ''}`.trim(), sub: n ? `${n.type === 'H' ? 'High' : 'Low'} ${r1(n.ft)} ft at ${time(n.t)}` : '', href: '#water' };
  },
  air(D) {
    const a = aqiNow(D);
    if (!a) return null;
    return { icon: 'air', label: 'Air quality', value: `AQI ${r0(a.aqi)}`, sub: aqiInfo(a.aqi).label, tone: a.aqi > 100 ? 'warn' : 'ok', href: '#weather' };
  },
  sun(D, now) {
    const n = nextSun(D, now);
    if (!n) return null;
    return { icon: n.kind === 'sunset' ? 'sunset' : 'sunrise', label: cap(n.kind), value: time(n.t), sub: `in ${duration(n.t - now)}`, href: '#weather' };
  },
  locks(D) {
    const l = D('lockages');
    if (!l || !l.today) return null;
    return { icon: 'locks', label: 'Ballard Locks', value: `${l.today.total} lockages`, sub: l.queued ? `${plural(l.queued, 'vessel')} waiting` : 'no queue', href: '#water' };
  },
  fire(D) {
    const f = D('fire911');
    if (!f) return null;
    return { icon: 'fire', label: '911 nearby', value: f.activeKnown === false ? '–' : `${f.activeCount || 0} active`, sub: `${plural(arr(f.incidents).length, 'call')} in 24 h`, tone: f.activeCount ? 'warn' : '', href: '#safety' };
  },
  aircraft(D) {
    const a = D('aircraft');
    if (!a) return null;
    const n = a.nearest;
    return { icon: 'aircraft', label: 'Overhead', value: `${a.airborne ?? a.count} aircraft`, sub: n ? `nearest ${n.callsign || n.reg || n.hex}` : 'quiet skies', href: '#live' };
  },
  traffic(D) {
    const t = D('traffic');
    const s = t && arr(t.sites).find((x) => x.id === '1991');
    const l = s && arr(s.links).find((x) => /downtown/i.test(x.name));
    if (!l || !isNum(l.minutes)) return null;
    return { icon: 'traffic', label: 'Drive downtown', value: `${l.minutes} min`, sub: 'from 15th & 61st', href: '#move' };
  },
  lime(D) {
    const l = D('lime');
    if (!l || !l.near) return null;
    return { icon: 'transit', label: 'Scooters nearby', value: `${l.near.total}`, sub: 'within a 10-min walk', href: '#move' };
  },
};
/** Which summary best represents a card (for For You / Share). */
export const CARD_SUMMARY = { now: 'weather', hourly: 'weather', daily: 'weather', nws: 'weather', transit: 'bus', bridges: 'bridge', tides: 'tide', air: 'air', sun: 'sun', locks: 'locks', lake: 'locks', fire: 'fire', aircraft: 'aircraft', traffic: 'traffic', lime: 'lime', 'water-wx': 'tide', currents: 'tide', timeline: 'sun' };

// ======================================================================= live activities (the header pill)

/**
 * What is live right now, most important first:
 * { id, icon, tone ('alert'|'warn'|'info'|'ok'), text, detail, timer?: { since } | { until }, href, priority }.
 * text is short (fits a pill); timer, if present, is rendered live by the caller.
 */
export function liveActivities(D, now, { favorites = [], activity = [] } = {}) {
  const out = [];
  for (const a of arr((D('alerts') || {}).alerts)) {
    if (!/extreme|severe/i.test(a.severity || '')) continue;
    out.push({ id: `alert:${a.id}`, icon: 'alert', tone: 'alert', text: a.event, detail: a.headline || '', href: '#weather', priority: 100 });
  }
  const ac = D('aircraft');
  for (const x of arr(ac && ac.aircraft).filter((y) => y.emergency)) {
    out.push({ id: `ac:${x.hex}`, icon: 'aircraft', tone: 'alert', text: `${x.callsign || x.reg || x.hex} ${x.emergency}`, detail: `squawk ${x.squawk || ''} · ${isNum(x.altFt) ? r0(x.altFt) + ' ft' : ''}`, href: '#live', priority: 98 });
  }
  const b = ballardBridge(D);
  if (b && b.up) out.push({ id: 'bridge:ballard', icon: 'bridge', tone: 'warn', text: 'Ballard Bridge up', detail: 'Raised for boats; road traffic stopped', timer: b.sinceKnown && isNum(b.since) ? { since: b.since } : null, href: '#water', priority: 95 });
  const o = D('outages');
  if (o && arr(o.ballard).length) out.push({ id: 'outage', icon: 'power', tone: 'warn', text: 'Power outage in Ballard', detail: `${o.ballard.reduce((s, x) => s + (x.customers || 0), 0)} customers`, href: '#safety', priority: 85 });
  const w = D('weather');
  if (w) {
    const rt = rainTimes(w, now);
    if (isNum(rt.startsAt) && rt.startsAt > now && rt.startsAt - now <= 45 * MIN) out.push({ id: 'rain', icon: 'drop', tone: 'info', text: 'Rain', detail: `starting around ${time(rt.startsAt)}`, timer: { until: rt.startsAt }, href: '#weather', priority: 80 });
  }
  const f = D('fire911');
  const fire = arr(f && f.incidents).find((x) => x.active && now - x.t < 20 * MIN && /fire|rescue|hazmat/i.test(x.type) && !/alarm|bell/i.test(x.type));
  if (fire) out.push({ id: `fire:${fire.id}`, icon: 'fire', tone: 'warn', text: fire.type, detail: fire.address, href: '#safety', priority: 75 });
  const fb = fremontBridge(D);
  if (fb && fb.up) out.push({ id: 'bridge:fremont', icon: 'bridge', tone: 'warn', text: 'Fremont Bridge up', detail: 'Raised for boats', timer: fb.sinceKnown && isNum(fb.since) ? { since: fb.since } : null, href: '#water', priority: 70 });
  // Buses: favorites first, else the D Line downtown.
  const tr = D('transit');
  if (tr) {
    const groups = liveGroups(tr, now);
    const favs = new Set(favorites);
    const pick = groups.filter((g) => favs.has(`${g.route}|${g.headsign}`)).sort((x, y) => x.arrivals[0].t - y.arrivals[0].t)[0] || dLineDowntown(D, now);
    if (pick && pick.arrivals[0].t - now <= 12 * MIN) {
      out.push({ id: `bus:${pick.route}|${pick.headsign}`, icon: 'transit', tone: 'info', text: `${pick.route === 'D Line' ? 'D Line' : pick.route} ${(pick.dir || pick.headsign).replace(/^to /, '→ ')}`, detail: pick.stopName, timer: { until: pick.arrivals[0].t }, href: '#move', priority: 60 });
    }
  }
  const fresh = arr(activity).find((x) => now - x.t < 3 * MIN && ['warn', 'alert', 'notice'].includes(x.severity));
  if (fresh) out.push({ id: `act:${fresh.id}`, icon: 'sparkle', tone: 'info', text: fresh.title, detail: fresh.detail || '', href: '#live', priority: 55 });
  const n = nextSun(D, now);
  if (n && n.t - now <= 60 * MIN) out.push({ id: `sun:${n.kind}`, icon: n.kind === 'sunset' ? 'sunset' : 'sunrise', tone: 'ok', text: cap(n.kind), detail: time(n.t), timer: { until: n.t }, href: '#weather', priority: 40 });
  const td = D('tides');
  const nt = td && nextTides(td, now)[0];
  if (nt && nt.t - now <= 60 * MIN) out.push({ id: `tide:${nt.t}`, icon: 'tide', tone: 'ok', text: `${nt.type === 'H' ? 'High' : 'Low'} tide`, detail: `${r1(nt.ft)} ft at ${time(nt.t)}`, timer: { until: nt.t }, href: '#water', priority: 30 });
  return out.sort((x, y) => y.priority - x.priority);
}

// ======================================================================= moments (spotlight)

const NOTABLE_LIFE = /\b(eagle|osprey|hawk|falcon|owl|heron|kingfisher|seal|sea lion|otter|orca|whale|porpoise|coyote|beaver|octopus|salmon|loon|cormorant|pelican|merganser)\b/i;

/**
 * Contextual suggestions, best first: { id, icon, kicker, title, body, score (0-100), tone, href, image?, until? }.
 * opts.series(key, hours) may supply history for "vs usual" moments.
 */
// ======================================================================= baselines ("usual for this hour")

const hourWord = (t) => { const hh = pparts(t).hh; return hh === 0 ? 'midnight' : hh === 12 ? 'noon' : `${hh % 12} ${hh < 12 ? 'am' : 'pm'}`; };
const fmtWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long' });

/** When a baseline is from, in words: "on Saturdays around 11 am", "around 11 am", "yesterday around 11 am". */
export function usualBasis(u, now) {
  if (!u) return '';
  const h = hourWord(now);
  if (u.basis === 'hour-of-week') return `on ${fmtWeekday.format(now)}s around ${h}`;
  return u.n === 1 ? `yesterday around ${h}` : `around ${h}`;
}

/**
 * Compare a live value with its learned baseline u = { usual, p25, p75, n, basis } (from /api/baseline).
 * "Usual" is the middle half of past values at this hour, widened by a tolerance (half the spread, 12% of the usual
 * value, or opts.minDiff, whichever is largest) so small wobbles don't count. With a single past day (n = 1) the
 * comparison is honestly "vs yesterday" (vs: 'yesterday') rather than "vs usual".
 * opts: { better: 'lower' | 'higher' | null, unit, dp, minDiff = 1 }
 * -> { dir: 'above' | 'below' | 'usual', tone: 'good' | 'bad' | '', vs, usual, usualText, text, title, basis } or null.
 */
export function vsUsual(u, value, now, { better = null, unit = '', dp = 0, minDiff = 1 } = {}) {
  if (!u || !isNum(u.usual) || !isNum(value)) return null;
  const lo = isNum(u.p25) ? Math.min(u.p25, u.usual) : u.usual, hi = isNum(u.p75) ? Math.max(u.p75, u.usual) : u.usual;
  const tol = Math.max((hi - lo) * 0.5, Math.abs(u.usual) * 0.12, minDiff);
  const dir = value > hi + tol ? 'above' : value < lo - tol ? 'below' : 'usual';
  const fmt = (v) => (dp ? (Math.round(v * 10 ** dp) / 10 ** dp).toFixed(dp) : String(Math.round(v)));
  const tone = dir === 'usual' || !better ? '' : (dir === 'above') === (better === 'higher') ? 'good' : 'bad';
  const basis = usualBasis(u, now);
  const vs = u.n === 1 ? 'yesterday' : 'usual';
  const span = `${u.n} ${u.basis === 'hour-of-week' ? 'weeks' : 'days'}`;
  const range = isNum(u.p25) && isNum(u.p75) && fmt(u.p25) !== fmt(u.p75) && u.n >= 3 ? `${fmt(u.p25)}–${fmt(u.p75)}${unit} over the last ${span}` : `last ${span}`;
  const title = u.n === 1 ? `Yesterday around ${hourWord(now)}: ${fmt(u.usual)}${unit}` : `Usually ${fmt(u.usual)}${unit} ${basis} (${range})`;
  const text = dir === 'usual' ? (vs === 'usual' ? 'about usual' : 'about the same as yesterday') : `${dir} ${vs === 'usual' ? 'usual' : "yesterday's"}`;
  return { dir, tone, vs, usual: u.usual, basis, text, usualText: `${fmt(u.usual)}${unit}`, title };
}

export function moments(D, now, { series = null, favorites = [], baseline = null } = {}) {
  const out = [];
  const add = (m) => { if (m && m.title) out.push(m); };
  const p = pparts(now);
  const sun = sunPosition(now);
  const w = D('weather');
  const hourly = arr(w && w.hourly);
  const sky = D('sky');

  // Bridge up now
  const b = ballardBridge(D);
  if (b && b.up) add({ id: 'bridge-up', icon: 'bridge', kicker: 'Live now', title: 'The Ballard Bridge is up', body: 'Road traffic on 15th Ave is stopped while boats pass. Drivers: expect a few minutes; the Fremont Bridge may be faster.', score: 96, tone: 'warn', href: '#water' });

  // Unusual right now: live values against what this dashboard has learned is usual for this hour.
  if (typeof baseline === 'function') {
    const base = baseline;
    baseline = (k) => { const u = base(k); return u && u.n >= 2 ? u : null; }; // one day is not "usual" yet
    const tr = D('traffic');
    const site = tr && arr(tr.sites).find((x) => x.id === '1991');
    const link = site && arr(site.links).find((l) => /downtown/i.test(l.name));
    const vt = link && vsUsual(baseline('traffic.downtown1991'), link.minutes, now, { better: 'lower', unit: ' min', minDiff: 4 });
    if (vt && vt.dir === 'above') add({ id: 'usual-traffic', icon: 'traffic', kicker: 'Unusual right now', title: 'Traffic is heavier than usual', body: `${link.minutes} min to downtown from 15th & 61st. ${vt.title}.`, score: 74, tone: 'warn', href: '#move' });
    const aq = aqiNow(D);
    const va = aq && vsUsual(baseline('purpleair.aqi'), aq.aqi, now, { better: 'lower', minDiff: 12 });
    if (va && va.dir === 'above' && aq.aqi >= 51) add({ id: 'usual-air', icon: 'air', kicker: 'Unusual right now', title: 'The air is worse than usual', body: `Ballard AQI ${r0(aq.aqi)} (${aqiInfo(aq.aqi).label.toLowerCase()}). ${va.title}.`, score: 72, tone: 'warn', href: '#weather' });
    const wp = D('westpoint');
    const vw = wp && vsUsual(baseline('westpoint.windKt'), wp.windKt, now, { better: 'lower', unit: ' kt', minDiff: 5 });
    if (vw && vw.dir === 'above' && wp.windKt >= 12) add({ id: 'usual-wind', icon: 'wind', kicker: 'On the water', title: 'Windier than usual on the Sound', body: `${r0(wp.windKt)} kt at West Point${isNum(wp.gustKt) && wp.gustKt > wp.windKt ? `, gusting ${r0(wp.gustKt)}` : ''}. ${vw.title}.`, score: 60, tone: 'warn', href: '#water' });
    const lk = D('lockages');
    const vl = lk && lk.today && vsUsual(baseline('lockages.today'), lk.today.total, now, { better: 'higher', minDiff: 4 });
    if (vl && vl.dir === 'above') add({ id: 'usual-locks', icon: 'locks', kicker: 'At the Locks', title: 'A busy day on the water', body: `${lk.today.total} lockages so far today. ${vl.title}.`, score: 48, tone: 'ok', href: '#water' });
    const f = D('fire911');
    const vf = f && vsUsual(baseline('fire911.count24h'), arr(f.incidents).length, now, { better: 'lower', minDiff: 6 });
    if (vf && vf.dir === 'above') add({ id: 'usual-911', icon: 'fire', kicker: 'Nearby', title: 'More 911 calls than usual', body: `${plural(arr(f.incidents).length, 'call')} near Ballard in the last 24 hours. ${vf.title}.`, score: 44, tone: 'info', href: '#safety' });
    const wc = w && w.current;
    const vtp = wc && vsUsual(baseline('weather.tempF'), wc.tempF, now, { unit: '°', minDiff: 7 });
    if (vtp && vtp.dir !== 'usual') add({ id: 'usual-temp', icon: 'thermo', kicker: 'Right now', title: vtp.dir === 'above' ? 'Warmer than usual' : 'Cooler than usual', body: `${r0(wc.tempF)}° now. ${vtp.title}.`, score: 42, tone: 'info', href: '#weather' });
  }

  // Golden hour / clear sunset
  if (sky && sky.sun && isNum(sky.sun.set)) {
    const set = sky.sun.set;
    const atSet = hourly.find((h) => Math.abs(h.t - set) <= 45 * MIN) || hourly[0] || {};
    const clearish = isNum(atSet.cloud) ? atSet.cloud < 55 : true;
    const dry = (atSet.pop || 0) < 30;
    if (sun.elevation > 0 && sun.elevation < 7 && now < set) add({ id: 'golden', icon: 'sun', kicker: 'Right now', title: 'Golden hour', body: `The sun sets at ${time(set)}. ${clearish ? 'Clear enough to glow — Golden Gardens and the Locks face west over the Olympics.' : 'Clouds may soften the light, but it can still color up.'}`, score: clearish ? 88 : 60, tone: 'ok', href: '#weather' });
    else if (now < set && set - now < 4 * H && clearish && dry) add({ id: 'sunset', icon: 'sun', kicker: `Tonight · ${time(set)}`, title: 'A clear sunset over the Olympics', body: `About ${r0(atSet.cloud ?? 20)}% cloud cover around sunset. Golden Gardens beach or the Locks' lawn are the classic spots.`, score: set - now < 2 * H ? 78 : 62, tone: 'ok', href: '#weather', until: set });
  }

  // Tides: minus / very low tide in daylight within 36 h
  const td = D('tides');
  if (td) {
    const low = nextTides(td, now).filter((e) => e.type === 'L' && e.t - now < 36 * H && isNum(e.ft) && e.ft <= 0.6 && sunIsUp(e.t)).sort((a, x) => a.ft - x.ft)[0];
    if (low) add({ id: `lowtide-${low.t}`, icon: 'tide', kicker: `${dayLabel(low.t)} · ${time(low.t)}`, title: `${low.ft <= 0 ? 'Minus' : 'Very low'} tide: ${r1(low.ft)} ft`, body: 'Tidepooling at Golden Gardens and Discovery Park: sea stars, crabs and anemones. Go an hour before low.', score: (low.t - now < 4 * H ? 80 : 58) + (low.ft < 0 ? 8 : 0), tone: 'ok', href: '#water', until: low.t });
  }

  // Moon & aurora
  if (sky && sky.moon && isNum(sky.moon.illum) && sky.moon.illum >= 96 && isNum(sky.moon.rise) && sky.moon.rise > now - 30 * MIN && sky.moon.rise - now < 8 * H) {
    add({ id: 'fullmoon', icon: 'moon', kicker: `Tonight · ${time(sky.moon.rise)}`, title: 'Full moon rising', body: `It rises over the Cascades to the east at ${time(sky.moon.rise)}${hourly.length && (hourly.find((h) => Math.abs(h.t - sky.moon.rise) < H) || {}).cloud < 50 ? ' — skies should be fairly clear' : ''}.`, score: 55, tone: 'ok', href: '#weather', until: sky.moon.rise });
  }
  const kp = D('kp');
  if (kp && isNum(kp.kp) && kp.kp >= 5) add({ id: 'aurora', icon: 'sky', kicker: 'Space weather', title: `Aurora possible tonight (Kp ${r1(kp.kp)})`, body: 'Look north after dark from Golden Gardens or Sunset Hill, away from streetlights. Phone cameras see it better than eyes.', score: sun.elevation < -6 ? 92 : 70, tone: 'info', href: '#weather' });

  // Rain / dry windows / nice weather
  if (w) {
    const rt = rainTimes(w, now);
    if (isNum(rt.startsAt) && rt.startsAt > now && rt.startsAt - now < 2 * H) add({ id: 'rain-soon', icon: 'drop', kicker: `Soon · ${time(rt.startsAt)}`, title: `Rain arriving around ${time(rt.startsAt)}`, body: 'Finish outdoor errands before then, or grab a jacket.', score: 70, tone: 'info', href: '#weather', until: rt.startsAt });
    else if (isNum(rt.endsAt) && rt.endsAt > now) add({ id: 'rain-end', icon: 'drop', kicker: `Later · ${time(rt.endsAt)}`, title: `Rain easing around ${time(rt.endsAt)}`, body: 'A dry window may follow — check the next 24 hours.', score: 48, tone: 'info', href: '#weather' });
    const c = w.current || {};
    if (isNum(c.tempF) && c.tempF >= 62 && c.code <= 2 && sun.elevation > 10 && (hourly[0] || {}).pop < 20) {
      add({ id: 'nice', icon: 'sun', kicker: 'Right now', title: `Beautiful out: ${r0(c.tempF)}° and ${wxText(c.code).toLowerCase()}`, body: p.wd === 0 || p.wd === 6 ? 'A good afternoon for the Burke-Gilman, Golden Gardens or a patio on Ballard Ave.' : 'A good time for a walk along the Ship Canal or Shilshole.', score: 52 + (p.wd === 0 || p.wd === 6 ? 8 : 0), tone: 'ok', href: '#weather' });
    }
  }

  // Water: wind on the Sound
  const wp = D('westpoint');
  if (wp && isNum(wp.windKt)) {
    const adv = marineAdvisory(D);
    const g0 = wp.gustKt ?? wp.peakGustKt;
    const gust = isNum(g0) && g0 > wp.windKt ? g0 : null;
    if (adv) add({ id: 'marine-adv', icon: 'water', kicker: 'On the water', title: adv.event, body: 'Small boats and paddlers should stay in protected water today.', score: 64, tone: 'warn', href: '#weather' });
    else if (wp.windKt >= 8 && wp.windKt <= 18 && (gust || 0) < 24) add({ id: 'sail', icon: 'water', kicker: 'On the water', title: `Good sailing breeze: ${r0(wp.windKt)} kt`, body: `From the ${compass(wp.windDir)} at West Point${isNum(gust) ? `, gusting ${r0(gust)}` : ''}. Shilshole sailors, this is your window.`, score: 42, tone: 'ok', href: '#weather' });
    else if (wp.windKt < 6 && sun.elevation > 5) add({ id: 'paddle', icon: 'water', kicker: 'On the water', title: 'Calm water for paddling', body: `Only ${r0(wp.windKt)} kt at West Point. Kayaks and paddleboards out of Shilshole or the Ship Canal.`, score: 44, tone: 'ok', href: '#weather' });
  }

  // Bridge odds and the rush-hour rule
  const odds = D('bridge-odds');
  if (odds && odds.now && b && !b.up) {
    if (!odds.now.restricted && odds.now.chanceNext30Min >= 0.45) add({ id: 'bridge-likely', icon: 'bridge', kicker: 'Next 30 min', title: `Bridge opening likely (${r0(odds.now.chanceNext30Min * 100)}%)`, body: `Ballard usually sees ~${r1(odds.now.expectedPerHour)} openings an hour now. Driving 15th Ave? Budget a few extra minutes.`, score: 50, tone: 'info', href: '#water' });
    if (isNum(odds.next) && odds.nextStarts && odds.next - now < 45 * MIN) add({ id: 'bridge-rule', icon: 'bridge', kicker: `Starts ${time(odds.next)}`, title: 'Rush-hour bridge rule', body: 'From then the Ballard, Fremont and University bridges don\'t open for most boats for two hours (33 CFR 117.1051).', score: 36, tone: 'info', href: '#water', until: odds.next });
  }

  // Salmon, the Locks, the market, events
  const s = D('salmon');
  for (const sp of arr(s && s.species)) {
    if (isNum(sp.latestT) && now - sp.latestT < 8 * DAY && (sp.latestCount || 0) >= 50) {
      add({ id: `salmon-${sp.name}`, icon: 'wildlife', kicker: 'At the Locks', title: `${sp.name} are running`, body: `${sp.latestCount.toLocaleString()} counted on ${sp.latestDate} (season ${isNum(sp.total) ? sp.total.toLocaleString() : '—'}). Watch them climb at the fish-ladder windows.`, score: 46, tone: 'ok', href: '#water' });
      break;
    }
  }
  const lk = D('lockages');
  const big = arr(lk && lk.recent).find((v) => v.commercial && !/^(comm other|recreational)/i.test(v.name || '') && (!isNum(v.end) || now - v.end < 30 * MIN) && now - v.arrival < 2 * H);
  if (big) add({ id: `ship-${big.name}`, icon: 'locks', kicker: 'At the Locks', title: `${big.name.trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())} ${big.direction === 'up' ? 'is heading into the lake' : 'is heading out to the Sound'}`, body: `${isNum(big.end) ? 'Just locked through' : 'In the lock or waiting now'} — the big chamber is a great show from the viewing walls.`, score: 38, tone: 'ok', href: '#water' });
  const market = PLACES[0], ms = placeStatus(market, now);
  if (ms.open) add({ id: 'market', icon: 'event', kicker: 'Today', title: `The farmers market is on until 2`, body: 'Ballard Ave NW between 20th and 22nd. Year-round, rain or shine.', score: 66, tone: 'ok', href: '#community', until: ms.closesAt });
  const ev = D('events');
  const endOfDay = now + ((24 - p.hh) * 60 - p.mm) * MIN + 2 * H; // through ~2 am
  const tonight = arr(ev && ev.events).filter((e) => !e.allDay && !e.canceled && e.start > now && e.start < endOfDay).sort((x, y) => x.start - y.start);
  if (tonight.length && p.hh >= 12) add({ id: 'tonight', icon: 'event', kicker: 'Tonight', title: `${plural(tonight.length, 'thing')} happening tonight`, body: `Starting with ${tonight[0].title} at ${time(tonight[0].start)}${tonight[0].venue ? ` (${tonight[0].venue})` : ''}.`, score: 40 + Math.min(10, tonight.length), tone: 'ok', href: '#community' });

  // Wildlife with a photo
  const wl = D('wildlife');
  const star = arr(wl && wl.observations).find((o) => isNum(o.t) && now - o.t < 3 * DAY && o.photo && (o.taxon.iconic === 'Mammalia' || NOTABLE_LIFE.test(`${o.taxon.common} ${o.taxon.name}`)) && !/squirrel|rat|mouse|human/i.test(o.taxon.common || ''));
  if (star) add({ id: `wild-${star.id}`, icon: 'wildlife', kicker: `${dayLabel(star.t)} · iNaturalist`, title: `${star.taxon.common || star.taxon.name} spotted`, body: `${star.place ? `Near ${star.place.replace(/, Seattle, WA, US$|, WA, US$|, US$/, '')}. ` : ''}Photo by ${star.user || 'a neighbor'}.`, score: 45, tone: 'ok', href: '#community', image: star.photo, link: star.url });

  // Aircraft
  const ac = D('aircraft');
  const sea = arr(ac && ac.aircraft).find((x) => x.kind === 'seaplane' && !x.onGround && x.distKm < 4);
  if (sea) add({ id: `sea-${sea.hex}`, icon: 'aircraft', kicker: 'Overhead now', title: 'Floatplane overhead', body: `${sea.callsign || sea.reg || sea.hex.toUpperCase()}${sea.type ? ` (${sea.type})` : ''} at ${isNum(sea.altFt) ? r0(sea.altFt).toLocaleString() + ' ft' : 'low altitude'} — probably a Kenmore Air run from Lake Union.`, score: 34, tone: 'ok', href: '#live' });

  // Problems worth knowing
  const aq = aqiNow(D);
  if (aq && aq.aqi > 100) add({ id: 'aqi', icon: 'air', kicker: 'Air quality', title: `${aqiInfo(aq.aqi).label} (AQI ${r0(aq.aqi)})`, body: 'Consider limiting long outdoor exertion; close windows if it smells smoky.', score: 90, tone: 'warn', href: '#weather' });
  const o = D('outages');
  if (o && arr(o.ballard).length) add({ id: 'outage', icon: 'power', kicker: 'Power', title: 'Power outage in Ballard', body: `${o.ballard.reduce((sum, x) => sum + (x.customers || 0), 0)} customers affected. Seattle City Light is on it.`, score: 88, tone: 'warn', href: '#safety' });
  if (typeof series === 'function') {
    const d = series('transit.delay.D', 2);
    const last = d && d[d.length - 1];
    if (last && now - last[0] < 20 * MIN && last[1] >= 5) add({ id: 'dlate', icon: 'transit', kicker: 'Transit', title: `D Line running ~${r0(last[1])} min late`, body: 'Averaged over the buses on the route right now. Leave a little later — or earlier to be safe.', score: 58, tone: 'warn', href: '#move' });
  }
  const quake = arr((D('quakes') || {}).notable).find((q) => now - q.t < DAY);
  if (quake) add({ id: `quake-${quake.id}`, icon: 'quake', kicker: rel(quake.t, now), title: `M${quake.mag.toFixed(1)} earthquake`, body: quake.place, score: 72, tone: 'warn', href: '#safety', link: quake.url });
  const seen = new Set();
  return out.filter((m) => !seen.has(m.id) && seen.add(m.id)).sort((a, x) => x.score - a.score);
}

// ======================================================================= Ask Ballard

const INTENTS = [
  ['nav', /^(settings|preferences|dark mode|light mode|theme|kiosk|notifications?|map|help|shortcuts)$/],
  ['events', /\bwhat'?s (happening|going on|on)\b.*\b(tonight|today|tomorrow|this weekend|weekend)\b|\b(things to do|what to do)\b/],
  ['camera', /\b(cameras?|cams?|webcams?|live view|look at)\b/],
  ['brief', /\b(brief|briefing|summary|summarize|good (morning|afternoon|evening)|overview|catch me up)\b|^what'?s (up|happening|going on)\??$/],
  ['boating', /\b(kayak|paddl|sail|boat(ing)?\b|sup\b|paddleboard|on the water|marine|small craft|currents?)/],
  ['traffic', /\b(traffic|drive|driving|car\b|road|travel time|congest)/],
  ['bridge', /\b(bridge|drawbridge|bascule)\b/],
  ['tide', /\b(tides?|low tide|high tide|tidepool)/],
  ['sun', /\b(sunset|sunrise|golden hour|daylight|dark out|moon|stars?|aurora|northern lights)\b/],
  ['air', /\b(air|aqi|smoke|smoky|pollution|pm ?2|breath)/],
  ['aircraft', /\b(planes?|aircraft|flights?|flying|helicopters?|jets?|seaplanes?|float ?planes?|overhead)\b/],
  ['fire', /\b(sirens?|fire|911|emergenc|ambulance|medics?|what happened|police|cops|crime)\b/],
  ['bus', /\b(bus(es)?|d ?line|rapid ?ride|route|44|40|17|28|metro|transit|commute)\b/],
  ['weather', /\b(weather|rain(y|ing)?|umbrella|temp(erature)?|hot|cold|warm|forecast|snow|sunny|cloud(y|s)?|jacket|wind(y)?|storm)\b/],
  ['events', /\b(events?|things to do|what to do|concert|music|show|kids|festival|happening tonight|tonight)\b/],
  ['news', /\b(news|headlines?|stories|reddit)\b/],
  ['salmon', /\b(salmon|fish(es)?|coho|chinook|sockeye|fish ?ladder)\b/],
  ['wildlife', /\b(wildlife|birds?|seals?|otters?|eagles?|herons?|animals?|nature|whales?|critters?)\b/],
  ['locks', /\b(locks?|lockages?|ships?|vessels?|chittenden)\b/],
  ['power', /\b(power|outages?|electric|blackout)\b/],
  ['quake', /\b(earthquakes?|quakes?|shak(e|ing)|seismic)\b/],
  ['open', /\b(open|hours|library|farmers|market|nordic|museum|closed)\b/],
  ['scooter', /\b(scooters?|lime|bike ?share|e-?bikes?)\b/],
];

/** Detect the intent of a question. */
export function intentOf(q) {
  const s = ` ${String(q || '').toLowerCase().replace(/[’']/g, "'").replace(/[^\w\s'/.-]/g, ' ')} `.replace(/\s+/g, ' ');
  for (const [id, re] of INTENTS) if (re.test(s.trim())) return id;
  return null;
}

/** Time words in a question: 'now' | 'today' | 'tonight' | 'tomorrow' | 'weekend' | null. */
export function whenOf(q) {
  const s = String(q || '').toLowerCase();
  if (/\btonight|this evening\b/.test(s)) return 'tonight';
  if (/\btomorrow\b/.test(s)) return 'tomorrow';
  if (/\bweekend|saturday|sunday\b/.test(s)) return 'weekend';
  if (/\btoday|this afternoon|this morning\b/.test(s)) return 'today';
  if (/\bnow|right now|currently\b/.test(s)) return 'now';
  return null;
}

const COMPASS_WORDS = { N: 'north', NNE: 'north-northeast', NE: 'northeast', ENE: 'east-northeast', E: 'east', ESE: 'east-southeast', SE: 'southeast', SSE: 'south-southeast', S: 'south', SSW: 'south-southwest', SW: 'southwest', WSW: 'west-southwest', W: 'west', WNW: 'west-northwest', NW: 'northwest', NNW: 'north-northwest' };
const compassWord = (deg) => COMPASS_WORDS[compass(deg)] || '';
const row = (k, v) => `<div class="ans-row"><span>${k}</span><b>${v}</b></div>`;
const badge = (r) => `<span class="ans-route ${r === 'D Line' ? 'd' : ''}">${esc(r === 'D Line' ? 'D' : r)}</span>`;
const noData = (what) => ({ title: `No ${what} data yet`, icon: 'info', html: `<p class="ans-p">The ${esc(what)} feed hasn't loaded. Try again in a moment.</p>`, speak: `I don't have ${what} data yet.` });

/**
 * Answer a natural-language question from live data.
 * Returns { intent, title, icon, html (trusted markup), speak (plain text), actions: [{ label, href }] } or null.
 * opts: { activity: [items], series(key, hours), favorites: ['route|headsign'] }
 */
export function answer(q, D, now = Date.now(), opts = {}) {
  const intent = intentOf(q);
  const when = whenOf(q);
  const s = String(q || '').toLowerCase();
  const fn = ANSWERS[intent];
  let a = null;
  if (fn) { try { a = fn({ q: s, when, D, now, ...opts }); } catch (err) { console.error('answer', intent, err); a = null; } }
  if (!a) a = searchAnswer(q, D, now, opts);
  return a ? { intent: intent || 'search', actions: [], ...a } : null;
}

const ANSWERS = {
  nav: ({ q }) => {
    const map = { settings: ['Settings', 'prefs:open'], preferences: ['Settings', 'prefs:open'], notifications: ['Notifications', 'notify:open'], notification: ['Notifications', 'notify:open'], kiosk: ['Kiosk mode', 'kiosk:toggle'], map: ['Map', '#map-section'], help: ['Keyboard shortcuts', 'shortcuts'], shortcuts: ['Keyboard shortcuts', 'shortcuts'], 'dark mode': ['Toggle theme', 'theme'], 'light mode': ['Toggle theme', 'theme'], theme: ['Toggle theme', 'theme'] };
    const [label, action] = map[q.trim()] || [];
    return label ? { title: label, icon: 'gear', html: '', speak: '', actions: [{ label: `Open ${label.toLowerCase()}`, action }] } : null;
  },
  brief: ({ D, now, activity, baseline }) => { const b = brief(D, now, { activity, baseline }); return { title: b.title, icon: 'sparkle', html: b.html, speak: b.text }; },
  bus: ({ q, D, now, favorites = [] }) => {
    const tr = D('transit');
    if (!tr) return noData('bus');
    let groups = liveGroups(tr, now);
    const route = /\b(d ?line|rapid ?ride|\bd\b)/.test(q) ? 'D Line' : /\b44\b/.test(q) ? '44' : /\b40\b/.test(q) ? '40' : /\b17\b/.test(q) ? '17' : /\b28\b/.test(q) ? '28' : null;
    if (route) groups = groups.filter((g) => g.route === route);
    if (/downtown|uw|university|u district|fremont/.test(q)) groups = groups.filter((g) => new RegExp(q.match(/downtown|uw|university|u district|fremont/)[0].replace('uw', 'uw|university'), 'i').test(`${g.headsign} ${g.dir}`) || /downtown/.test(q) && /downtown|uptown/i.test(`${g.headsign} ${g.dir}`));
    const favs = new Set(favorites);
    groups.sort((a, x) => (favs.has(`${x.route}|${x.headsign}`) - favs.has(`${a.route}|${a.headsign}`)) || a.arrivals[0].t - x.arrivals[0].t);
    if (!groups.length) return { title: 'No matching buses soon', icon: 'transit', html: '<p class="ans-p">Nothing matching in the next 45 minutes near Market St.</p>', speak: 'I don\'t see a matching bus in the next 45 minutes.' };
    const g0 = groups[0];
    const html = `<div class="ans-list">${groups.slice(0, 6).map((g) => `<div class="ans-bus">${badge(g.route)}<div class="grow"><b>${esc(g.dir || g.headsign)}</b><div class="ans-sub">${esc(g.stopName || '')}</div></div><div class="ans-eta">${g.arrivals.slice(0, 3).map((a, i) => `<span class="${i ? 'more' : ''}" data-eta="${a.t}">${esc(etaText(a.t, now))}</span>`).join(' · ')} <small>min</small></div></div>`).join('')}</div>`;
    const t0 = g0.arrivals[0], t1 = g0.arrivals[1];
    const speak = `The next ${g0.route === 'D Line' ? 'D Line' : 'route ' + g0.route} ${(g0.dir || g0.headsign).replace(/^to /, 'to ')} ${etaText(t0.t, now) === 'now' ? 'is arriving now' : `comes in ${etaText(t0.t, now)} minutes`}${t1 ? `, then in ${etaText(t1.t, now)} minutes` : ''}${t0.confidence === 'live' ? '' : ', going by the schedule'}.`;
    return { title: 'Next buses near Market St', icon: 'transit', html, speak, actions: [{ label: 'All buses', href: '#move' }] };
  },
  bridge: ({ D, now, series }) => {
    const b = ballardBridge(D);
    if (!b) return noData('bridge');
    const odds = D('bridge-odds');
    const lines = [];
    const since = b.sinceKnown && isNum(b.since) ? b.since : null;
    lines.push(row('Ballard Bridge', b.up ? `<span class="ans-warn">UP</span>${since ? ` for ${duration(now - since)}` : ''}` : `down${since ? ` since ${time(since)}` : ''}`));
    const fb = fremontBridge(D);
    if (fb) lines.push(row('Fremont Bridge', fb.up ? '<span class="ans-warn">UP</span>' : 'down'));
    let speak = `The Ballard Bridge is ${b.up ? `up right now${since ? `, for ${Math.max(1, r0((now - since) / MIN))} minutes so far` : ''}` : 'down and open to traffic'}.`;
    if (odds && odds.now) {
      if (odds.now.restricted) { lines.push(row('Rush-hour rule', `no openings for most boats until ${time(odds.next)}`)); speak += ` The rush-hour rule is in effect until ${time(odds.next)}, so it won't open for most boats.`; }
      else {
        lines.push(row('Chance of an opening in 30 min', `${r0(odds.now.chanceNext30Min * 100)}%`));
        lines.push(row('Usual right now', `~${r1(odds.now.expectedPerHour)} openings/hr, ${isNum(odds.now.typicalMinutes) ? r0(odds.now.typicalMinutes) + ' min each' : ''}`));
        speak += ` There's about a ${r0(odds.now.chanceNext30Min * 100)} percent chance it opens in the next half hour.`;
        if (isNum(odds.next) && odds.nextStarts) lines.push(row('Rush-hour rule starts', time(odds.next)));
      }
    }
    if (typeof series === 'function') {
      const s = series('bridges.ballardUp', 24);
      if (s && s.length > 10) {
        let n = 0, prev = 0;
        const p = pparts(now), midnight = now - ((p.hh * 60 + p.mm) * MIN);
        for (const [t, v] of s) { if (t >= midnight && v >= 1 && prev < 1) n++; prev = v; }
        lines.push(row('Openings seen today', String(n)));
      }
    }
    return { title: b.up ? 'The Ballard Bridge is up' : 'The Ballard Bridge is down', icon: 'bridge', html: `<div class="ans-rows">${lines.join('')}</div>`, speak, actions: [{ label: 'Bridge details', href: '#water' }] };
  },
  tide: ({ D, now }) => {
    const c = currentTide(D, now);
    if (!c) return noData('tide');
    const next = c.next.slice(0, 4);
    const low = c.next.filter((e) => e.type === 'L' && e.t - now < 48 * H && e.ft <= 0.6 && sunIsUp(e.t)).sort((a, x) => a.ft - x.ft)[0];
    const html = `<div class="ans-rows">${row('Now', `${r1(c.ft)} ft ${c.trend || ''}`)}${next.map((e) => row(`${e.type === 'H' ? 'High' : 'Low'} · ${dayLabel(e.t)}`, `${r1(e.ft)} ft at ${time(e.t)}`)).join('')}</div>${low ? `<p class="ans-p">${icon('sparkle', { size: 14 })} ${low.ft <= 0 ? 'Minus' : 'Very low'} tide ${dayLabel(low.t).toLowerCase()} at ${time(low.t)} (${r1(low.ft)} ft) — good tidepooling.</p>` : ''}`;
    const n0 = next[0];
    return { title: `Tide ${c.trend || ''} · ${r1(c.ft)} ft`, icon: 'tide', html, speak: `The tide is ${r1(c.ft)} feet and ${c.trend || 'changing'}.${n0 ? ` Next ${n0.type === 'H' ? 'high' : 'low'} is ${r1(n0.ft)} feet at ${time(n0.t)}.` : ''}${low ? ` There's a ${low.ft <= 0 ? 'minus' : 'very low'} tide ${dayLabel(low.t).toLowerCase()} at ${time(low.t)}.` : ''}`, actions: [{ label: 'Tide chart', href: '#water' }] };
  },
  boating: ({ D, now }) => {
    const wp = D('westpoint');
    const adv = marineAdvisory(D);
    if (!wp) return noData('marine');
    const wind = wp.windKt;
    const g0 = wp.gustKt ?? wp.peakGustKt;
    const gust = isNum(g0) && g0 > wind ? g0 : null;
    let verdict, tone;
    if (adv || wind > 15 || (gust || 0) > 22) { verdict = 'Not a good time for kayaks or paddleboards on the Sound'; tone = 'warn'; }
    else if (wind > 9 || (gust || 0) > 15) { verdict = 'Okay for experienced paddlers; good for sailing'; tone = 'info'; }
    else { verdict = 'Good conditions for paddling'; tone = 'ok'; }
    const mf = D('marine');
    const cur = D('currents');
    const nextCur = arr(cur && cur.events).find((e) => e.t > now);
    const c = currentTide(D, now);
    const html = `<p class="ans-verdict ${tone}">${esc(verdict)}</p><div class="ans-rows">
      ${row('Wind at West Point', `${r0(wind)} kt from the ${compass(wp.windDir)}${isNum(gust) ? `, gusts ${r0(gust)}` : ''}`)}
      ${adv ? row('Advisory', `<span class="ans-warn">${esc(adv.event)}</span>`) : ''}
      ${nextCur ? row('Next current', `${nextCur.type === 'slack' ? 'slack' : `max ${nextCur.type} ${r1(Math.abs(nextCur.knots))} kt`} at ${time(nextCur.t)}`) : ''}
      ${c && isNum(c.ft) ? row('Tide', `${r1(c.ft)} ft ${c.trend || ''}`) : ''}</div>
      ${mf && arr(mf.periods)[0] ? `<p class="ans-p"><b>${esc(mf.periods[0].name)}:</b> ${esc(mf.periods[0].text)}</p>` : ''}`;
    return { title: 'On the water', icon: 'water', html, speak: `${verdict}. Wind at West Point is ${r0(wind)} knots from the ${compassWord(wp.windDir)}${isNum(gust) ? `, gusting ${r0(gust)}` : ''}${adv ? `, and there's a ${adv.event}` : ''}.`, actions: [{ label: 'Marine forecast', href: '#weather' }] };
  },
  weather: ({ q, when, D, now }) => {
    const w = D('weather');
    if (!w || !w.current) return noData('weather');
    const c = w.current;
    const hourly = arr(w.hourly);
    const nws = arr((D('nws-forecast') || {}).periods);
    const umbrella = /umbrella|rain|jacket/.test(q);
    if (when === 'tomorrow' || when === 'weekend' || when === 'tonight') {
      const periods = nws.filter((p) => (when === 'tonight' ? /tonight|this evening|overnight/i.test(p.name) : when === 'tomorrow' ? dayKey(p.start) === dayKey(now + DAY) : /saturday|sunday/i.test(p.name))).slice(0, when === 'weekend' ? 4 : 2);
      if (periods.length) return { title: `${cap(when)} in Ballard`, icon: 'weather', html: periods.map((p) => `<p class="ans-p"><b>${esc(p.name)}:</b> ${esc(p.detail || p.short)}</p>`).join(''), speak: periods.map((p) => `${p.name}: ${p.detail || p.short}`).join(' '), actions: [{ label: 'Forecast', href: '#weather' }] };
    }
    const next12 = hourly.filter((h) => h.t >= now - H && h.t < now + 12 * H);
    const wet = next12.filter((h) => (h.pop || 0) >= 40);
    const rt = rainTimes(w, now);
    let rainLine;
    if (isNum(rt.startsAt) && rt.startsAt > now) rainLine = `Rain likely from about ${time(rt.startsAt)}.`;
    else if (isNum(rt.endsAt)) rainLine = `It's raining; easing around ${time(rt.endsAt)}.`;
    else if (wet.length) rainLine = `Rain chances reach ${Math.max(...wet.map((h) => h.pop))}% around ${hour(wet[0].t)}.`;
    else rainLine = 'No rain expected in the next 12 hours.';
    const d0 = arr(w.daily)[0] || {};
    const verdict = umbrella ? (wet.length || isNum(rt.startsAt) || isNum(rt.endsAt) ? 'Yes — bring an umbrella or a rain jacket.' : 'No umbrella needed.') : null;
    const html = `${verdict ? `<p class="ans-verdict ${wet.length ? 'info' : 'ok'}">${esc(verdict)}</p>` : ''}<div class="ans-big">${r0(c.tempF)}°<small>${esc(wxText(c.code))} · feels ${r0(c.feelsF)}°</small></div>
      <div class="ans-rows">${row('Today', `H ${r0(d0.hiF)}° · L ${r0(d0.loF)}°${d0.pop ? ` · ${d0.pop}% rain` : ''}`)}${row('Wind', `${r0(c.windMph)} mph ${compass(c.windDir)}${c.gustMph - c.windMph > 6 ? `, gusts ${r0(c.gustMph)}` : ''}`)}${row('Rain', esc(rainLine))}</div>
      ${nws[0] ? `<p class="ans-p"><b>${esc(nws[0].name)}:</b> ${esc(nws[0].detail || nws[0].short)}</p>` : ''}`;
    return { title: `${r0(c.tempF)}° and ${wxText(c.code).toLowerCase()}`, icon: 'weather', html, speak: `${verdict ? verdict + ' ' : ''}It's ${r0(c.tempF)} degrees and ${wxText(c.code).toLowerCase()} in Ballard, with a high of ${r0(d0.hiF)}. ${rainLine}`, actions: [{ label: 'Full forecast', href: '#weather' }] };
  },
  sun: ({ q, D, now }) => {
    const s = D('sky');
    if (!s || !s.sun) return noData('sun and moon');
    const { civilDawn, rise, set, civilDusk } = s.sun;
    const pos = sunPosition(now);
    const lines = [row('Sunrise', time(rise)), row('Sunset', time(set)), row('Last light', time(civilDusk)), row('Daylight', isNum(rise) && isNum(set) ? duration(set - rise) : '–')];
    if (s.moon) lines.push(row('Moon', `${esc(s.moon.phase || '')}, ${r0(s.moon.illum)}% · rises ${time(s.moon.rise)}`));
    const kp = D('kp');
    if (kp && isNum(kp.kp)) lines.push(row('Aurora (Kp)', `${r1(kp.kp)} ${kp.kp >= 5 ? '— possible!' : '— unlikely'}`));
    const golden = isNum(set) ? set - 60 * MIN : null;
    const aurora = /aurora|northern/.test(q);
    const speak = aurora ? `The planetary K index is ${r1(kp && kp.kp)}. ${kp && kp.kp >= 5 ? 'Aurora is possible tonight; look north after dark.' : 'Aurora is unlikely from Seattle right now.'}`
      : /moon/.test(q) ? `The moon is ${s.moon ? `${s.moon.phase}, ${r0(s.moon.illum)} percent lit, rising at ${time(s.moon.rise)}` : 'not available'}.`
        : `${now < set ? `Sunset is at ${time(set)}${golden && now < golden ? `, with golden hour from about ${time(golden)}` : ''}` : `Sunrise is at ${time(s.tomorrowSun && s.tomorrowSun.rise)}`}. The sun is ${pos.elevation > 0 ? `${r0(pos.elevation)} degrees up` : 'below the horizon'}.`;
    void civilDawn;
    return { title: aurora ? 'Aurora outlook' : /moon/.test(q) ? 'The moon tonight' : `Sunset ${time(set)}`, icon: /moon|aurora|star/.test(q) ? 'moon' : 'sunset', html: `<div class="ans-rows">${lines.join('')}</div>`, speak, actions: [{ label: 'Sun & moon', href: '#weather' }] };
  },
  air: ({ D }) => {
    const a = aqiNow(D);
    if (!a) return noData('air quality');
    const info = aqiInfo(a.aqi);
    const advice = a.aqi <= 50 ? 'Great air — enjoy being outside.' : a.aqi <= 100 ? 'Acceptable; unusually sensitive people may want to take it easier.' : a.aqi <= 150 ? 'Sensitive groups should limit long or heavy exertion outdoors.' : 'Everyone should limit outdoor exertion; close windows.';
    const an = D('airnow');
    const off = an && arr(an.observed).find((x) => x.primary);
    return { title: `Air: ${info.label} (${r0(a.aqi)})`, icon: 'air', html: `<div class="ans-big" style="color:${info.color}">${r0(a.aqi)}<small>AQI · ${esc(info.label)}</small></div><p class="ans-p">${esc(advice)}</p><div class="ans-rows">${row('Source', esc(a.src))}${off ? row('Official (AirNow)', `${off.aqi} ${esc(off.category || '')}`) : ''}</div>`, speak: `Air quality is ${info.label.toLowerCase()}, with an AQI of ${r0(a.aqi)}. ${advice}`, actions: [{ label: 'Air sensors on the map', href: '#map-section' }] };
  },
  fire: ({ q, D, now }) => {
    if (/police|cops|crime/.test(q)) {
      const c = D('crime');
      const reps = arr(c && c.reports).slice(0, 5);
      return { title: 'Recent police reports', icon: 'civic', html: `<p class="ans-p ans-muted">SPD publishes reports about a day late.</p><div class="ans-list">${reps.map((r) => `<div class="ans-item"><b>${esc(arr(r.offenses).join(', '))}</b><div class="ans-sub">${esc(r.block || '')} · ${esc(dayLabel(r.t))}</div></div>`).join('') || '<p class="ans-p">None in the last week.</p>'}</div>`, speak: reps.length ? `The latest reports include ${reps.slice(0, 2).map((r) => arr(r.offenses)[0]).join(' and ')}.` : 'No recent police reports.', actions: [{ label: 'Safety section', href: '#safety' }] };
    }
    const f = D('fire911');
    if (!f) return noData('911');
    const inc = arr(f.incidents).slice(0, 6);
    if (!inc.length) return { title: 'No 911 calls nearby', icon: 'fire', html: '<p class="ans-p">No Seattle Fire calls within 1.2 miles in the last 24 hours.</p>', speak: 'There have been no fire department calls nearby today.' };
    const x = inc[0];
    const html = `<div class="ans-list">${inc.map((i) => `<div class="ans-item ${i.active ? 'active' : ''}"><b>${esc(i.type)}</b>${i.active ? ' <span class="ans-warn">active</span>' : ''}<div class="ans-sub">${esc(i.address || '')} · ${time(i.t)} (${esc(rel(i.t, now))})${i.units ? ` · ${esc(i.units)}` : ''}</div></div>`).join('')}</div>`;
    return { title: /siren|what happened/.test(q) ? 'Probably this' : 'Recent 911 calls nearby', icon: 'fire', html, speak: `The most recent call was ${x.type} at ${String(x.address || '').replace(/\bNw\b/i, 'Northwest')}, ${rel(x.t, now)}${x.units ? `, with ${x.units.split(' ').length} unit${x.units.split(' ').length > 1 ? 's' : ''} dispatched` : ''}. ${f.activeCount ? `${f.activeCount} ${f.activeCount === 1 ? 'call is' : 'calls are'} still active nearby.` : ''}`, actions: [{ label: '911 on the map', href: '#map-section' }] };
  },
  aircraft: ({ q, D }) => {
    const a = D('aircraft');
    if (!a) return noData('aircraft');
    let list = arr(a.aircraft).filter((x) => !x.onGround);
    if (/helicopter/.test(q)) list = list.filter((x) => x.kind === 'helicopter');
    if (/seaplane|float/.test(q)) list = list.filter((x) => x.kind === 'seaplane');
    if (!list.length) return { title: 'Nothing matching overhead', icon: 'aircraft', html: `<p class="ans-p">${a.airborne ?? 0} aircraft within ${a.radiusNm || 8} nm, none matching.</p>`, speak: 'I don\'t see one overhead right now.' };
    const n = list[0];
    const name = n.callsign || n.reg || n.hex.toUpperCase();
    const html = `<div class="ans-list">${list.slice(0, 6).map((x) => `<div class="ans-item"><b>${esc(x.callsign || x.reg || x.hex.toUpperCase())}</b> <span class="ans-sub">${esc([x.operator, x.desc || x.type].filter(Boolean).join(' · '))}</span><div class="ans-sub">${isNum(x.altFt) ? r0(x.altFt).toLocaleString() + ' ft' : '–'} · ${isNum(x.gsKt) ? r0(x.gsKt) + ' kt' : ''} ${isNum(x.track) ? compass(x.track) : ''} · ${(x.distKm * 0.621).toFixed(1)} mi</div></div>`).join('')}</div>`;
    const speakName = n.operator ? `${n.operator} ${String(name).replace(/^[A-Z]{3}/, 'flight ')}` : name;
    return { title: `${list.length} overhead · nearest ${name}`, icon: 'aircraft', html, speak: `That's probably ${speakName}${n.desc || n.type ? `, a ${n.desc || n.type}` : ''}, at ${isNum(n.altFt) ? r0(n.altFt) + ' feet' : 'low altitude'}, ${(n.distKm * 0.621).toFixed(1)} miles away${isNum(n.track) ? `, heading ${compassWord(n.track)}` : ''}.`, actions: [{ label: 'Aircraft on the map', href: '#map-section' }] };
  },
  events: ({ when, D, now }) => {
    const ev = D('events');
    if (!ev) return noData('events');
    const p = pparts(now);
    const sod = now - ((p.hh * 60 + p.mm) * MIN);
    let from = now - H, to = sod + DAY + 2 * H, label = 'Coming up';
    if (when === 'tonight') { from = Math.max(now - H, sod + 17 * H); to = sod + DAY + 2 * H; label = 'Tonight'; }
    else if (when === 'tomorrow') { from = sod + DAY; to = sod + 2 * DAY; label = 'Tomorrow'; }
    else if (when === 'weekend') { const toSat = (6 - p.wd + 7) % 7; from = p.wd === 0 ? sod : sod + toSat * DAY; to = p.wd === 0 ? sod + DAY : from + 2 * DAY; label = 'This weekend'; }
    else if (when === 'today' || when === 'now') { from = now - H; to = sod + DAY; label = 'Today'; }
    const list = arr(ev.events).filter((e) => !e.canceled && e.start >= from && e.start < to).sort((a, x) => a.start - x.start);
    const html = list.length ? `<div class="ans-list">${list.slice(0, 8).map((e) => `<a class="ans-item" href="${href(e.url)}" target="_blank" rel="noopener"><b>${esc(e.title)}</b><div class="ans-sub">${e.allDay ? 'All day' : `${esc(dayLabel(e.start))} ${time(e.start)}`}${e.venue ? ` · ${esc(e.venue)}` : ''}${e.cost ? ` · ${esc(e.cost)}` : ''}</div></a>`).join('')}</div>` : '<p class="ans-p">Nothing listed for then.</p>';
    return { title: `${label}: ${plural(list.length, 'event')}`, icon: 'event', html, speak: list.length ? `${label}, there ${list.length === 1 ? 'is one event' : `are ${list.length} events`}, including ${listJoin(list.slice(0, 3).map((e) => `${e.title} at ${time(e.start)}`))}.` : `I don't see any events listed for ${label.toLowerCase()}.`, actions: [{ label: 'All events', href: '#community' }] };
  },
  news: ({ D, now }) => {
    const n = D('news');
    const items = arr(n && n.items).filter((x) => x.ballard).slice(0, 6);
    const r = arr((D('reddit') || {}).items).slice(0, 3);
    if (!items.length && !r.length) return noData('news');
    const html = `<div class="ans-list">${items.map((x) => `<a class="ans-item" href="${href(x.link)}" target="_blank" rel="noopener"><b>${esc(x.title)}</b><div class="ans-sub">${esc(x.source || '')} · ${esc(rel(x.t, now))}</div></a>`).join('')}${r.map((x) => `<a class="ans-item" href="${href(x.link)}" target="_blank" rel="noopener"><b>${esc(x.title)}</b><div class="ans-sub">${esc(x.sub)} · ${esc(rel(x.t, now))}</div></a>`).join('')}</div>`;
    return { title: 'Latest from Ballard', icon: 'news', html, speak: items.length ? `The latest Ballard headline: ${items[0].title}.` : `On Reddit: ${r[0].title}.`, actions: [{ label: 'All news', href: '#community' }] };
  },
  salmon: ({ D }) => {
    const s = D('salmon');
    if (!s) return noData('salmon');
    const sp = arr(s.species);
    const html = `<div class="ans-rows">${sp.map((x) => row(esc(x.name), `${isNum(x.total) ? x.total.toLocaleString() : '–'} this season${isNum(x.latestCount) ? ` · ${x.latestCount.toLocaleString()} on ${esc(x.latestDate)}` : ''}`)).join('')}</div><p class="ans-p">Watch from the fish-ladder viewing room at the Ballard Locks (south side).</p>`;
    const running = sp.filter((x) => (x.latestCount || 0) > 0);
    return { title: `Salmon at the Locks · ${s.year || ''}`, icon: 'wildlife', html, speak: running.length ? `${listJoin(running.map((x) => `${x.latestCount} ${x.name.toLowerCase()}`))} were counted on the latest day.` : 'No salmon counted in the latest reports.', actions: [{ label: 'Salmon card', href: '#water' }] };
  },
  wildlife: ({ q, D, now }) => {
    const w = D('wildlife');
    if (!w) return noData('wildlife');
    let obs = arr(w.observations);
    const m = q.match(/\b(birds?|seals?|otters?|eagles?|herons?|whales?)\b/);
    if (m) {
      const k = m[1].replace(/s$/, '');
      obs = obs.filter((o) => (k === 'bird' ? o.taxon.iconic === 'Aves' : new RegExp(k, 'i').test(`${o.taxon.common} ${o.taxon.name}`)));
    }
    const html = obs.length ? `<div class="ans-photos">${obs.slice(0, 8).map((o) => `<a href="${href(o.url)}" target="_blank" rel="noopener" title="${esc(o.taxon.common || o.taxon.name)}">${o.photo && /^https:\/\/[\w.-]+\/[\w/.%~-]+$/.test(o.photo) ? `<img src="${esc(o.photo)}" alt="${esc(o.taxon.common || o.taxon.name)}" loading="lazy">` : ''}<span>${esc(o.taxon.common || o.taxon.name)}<small>${esc(rel(o.t || o.created, now))}</small></span></a>`).join('')}</div>` : '<p class="ans-p">No recent sightings like that.</p>';
    const title = m && !obs.length ? `No ${m[1].replace(/s?$/, 's')} reported lately` : `${plural(w.counts ? w.counts.species : obs.length, 'species', 'species')} seen lately`;
    return { title, icon: 'wildlife', html, speak: obs.length ? `Recent sightings include ${listJoin(obs.slice(0, 3).map((o) => o.taxon.common || o.taxon.name))}.` : 'I don\'t see recent sightings like that.', actions: [{ label: 'All sightings', href: '#community' }] };
  },
  locks: ({ D, now }) => {
    const l = D('lockages');
    if (!l) return noData('Locks');
    const st = D('stoppages');
    const closed = arr(st && st.active);
    const rec = arr(l.recent).slice(0, 5);
    const html = `<div class="ans-rows">${row('Lockages today', `${l.today ? l.today.total : '–'} (${l.today ? `${l.today.up} in, ${l.today.down} out` : ''})`)}${row('Waiting now', String(l.queued || 0))}${row('Chambers', closed.length ? `<span class="ans-warn">chamber ${esc(closed[0].chamber)} closed</span>` : 'both operating')}</div>
      <div class="ans-list">${rec.map((v) => `<div class="ans-item"><b>${esc(v.name.trim())}</b><div class="ans-sub">${v.direction === 'up' ? 'into the lake' : 'out to the Sound'} · ${isNum(v.end) ? time(v.end) : isNum(v.start) ? 'locking now' : 'waiting'}</div></div>`).join('')}</div>`;
    return { title: 'The Ballard Locks', icon: 'locks', html, speak: `${l.today ? l.today.total : 'No'} lockages so far today, with ${l.queued || 0} ${l.queued === 1 ? 'vessel' : 'vessels'} waiting.${closed.length ? ` Chamber ${closed[0].chamber} is closed.` : ''}`, actions: [{ label: 'Locks card', href: '#water' }] };
  },
  power: ({ D }) => {
    const o = D('outages');
    if (!o) return noData('outage');
    const b = arr(o.ballard);
    return { title: b.length ? 'Power outage in Ballard' : 'No outages in Ballard', icon: 'power', html: b.length ? `<div class="ans-list">${b.map((x) => `<div class="ans-item"><b>${x.customers} customers</b><div class="ans-sub">${esc(x.cause || '')} · since ${time(x.start)}${isNum(x.etr) ? ` · restoration ~${time(x.etr)}` : ''}</div></div>`).join('')}</div>` : `<p class="ans-p">Seattle City Light shows no outages in Ballard. Citywide: ${o.citywide ? o.citywide.count : 0} (${o.citywide ? o.citywide.customers : 0} customers).</p>`, speak: b.length ? `There's an outage in Ballard affecting ${b.reduce((s2, x) => s2 + x.customers, 0)} customers.` : 'There are no power outages in Ballard.' };
  },
  quake: ({ D, now }) => {
    const qd = D('quakes');
    if (!qd) return noData('earthquake');
    const list = [...arr(qd.notable), ...arr(qd.recent)].sort((a, x) => x.t - a.t).slice(0, 6);
    return { title: 'Recent earthquakes', icon: 'quake', html: `<div class="ans-list">${list.map((x) => `<a class="ans-item" href="${href(x.url)}" target="_blank" rel="noopener"><b>M${x.mag.toFixed(1)}</b> ${esc(x.place)}<div class="ans-sub">${esc(rel(x.t, now))} · ${r0(x.distKm * 0.621)} mi away</div></a>`).join('')}</div>`, speak: list.length ? `The most recent was a magnitude ${list[0].mag.toFixed(1)}, ${list[0].place}, ${rel(list[0].t, now)}.` : 'No recent earthquakes.' };
  },
  open: ({ q, now }) => {
    let places = PLACES;
    if (/library/.test(q)) places = [PLACES[1]]; else if (/market|farmers/.test(q)) places = [PLACES[0]]; else if (/nordic|museum/.test(q)) places = [PLACES[2]];
    const st = places.map((pl) => ({ pl, s: placeStatus(pl, now) }));
    return { title: 'Open now?', icon: 'clock', html: `<div class="ans-rows">${st.map(({ pl, s }) => row(esc(pl.name), `${s.open ? '<span class="ans-ok">Open</span>' : 'Closed'} · ${esc(s.text)}`)).join('')}</div>`, speak: st.map(({ pl, s }) => `${pl.name} is ${s.open ? 'open' : 'closed'}, ${s.text}.`).join(' ') };
  },
  scooter: ({ D }) => {
    const l = D('lime');
    if (!l) return noData('scooter');
    return { title: `${l.near.total} Lime vehicles nearby`, icon: 'transit', html: `<div class="ans-rows">${row('Scooters', l.near.scooters)}${row('E-bikes', l.near.ebikes)}${row('In all of Ballard', l.inBbox)}</div>`, speak: `There are ${l.near.scooters} scooters and ${l.near.ebikes} e-bikes within a ten-minute walk.` };
  },
  camera: ({ q, D }) => {
    const c = D('cameras');
    if (!c) return noData('camera');
    let cams = arr(c.cameras).filter((x) => x.ok);
    const words = q.replace(/\b(show|me|the|camera|cam|webcam|at|look|of|on)\b/g, ' ').split(/\s+/).filter((x) => x.length > 1);
    const scored = cams.map((x) => ({ x, s: words.filter((w2) => x.label.toLowerCase().includes(w2)).length + (/bridge/.test(q) && /nickerson|emerson/i.test(x.label) ? 2 : 0) })).sort((a, b) => b.s - a.s);
    cams = scored[0] && scored[0].s ? scored.filter((y) => y.s === scored[0].s).map((y) => y.x) : cams.slice(0, 4);
    return { title: cams.length === 1 ? cams[0].label : 'Traffic cameras', icon: 'camera', html: `<div class="ans-cams">${cams.slice(0, 4).map((x) => `<figure><img src="${camSrc(x.url, x.lastModified)}" alt="${esc(x.label)}"><figcaption>${esc(x.label)}</figcaption></figure>`).join('')}</div>`, speak: '', actions: [{ label: 'All cameras', href: '#move' }] };
  },
  traffic: ({ D, now, series, baseline }) => {
    const t = D('traffic');
    if (!t) return noData('traffic');
    const lines = [];
    let speak = '';
    for (const s of arr(t.sites)) {
      for (const l of arr(s.links)) {
        let usual = '';
        const v = /downtown/i.test(l.name) && typeof baseline === 'function' ? vsUsual(baseline(`traffic.downtown${s.id}`), l.minutes, now, { better: 'lower', unit: ' min', minDiff: 3 }) : null;
        if (v) usual = v.dir === 'usual' ? ` (${v.text})` : ` (${v.dir === 'above' ? 'slower' : 'faster'} than ${v.vs === 'usual' ? 'the usual' : "yesterday's"} ${v.usualText})`;
        else if (/downtown/i.test(l.name) && typeof series === 'function') {
          const sr = series(`traffic.downtown${s.id}`, 48);
          if (sr && sr.length > 60) { const ys = sr.map((p) => p[1]).sort((a, b) => a - b); usual = ` (usually ${ys[ys.length >> 1]})`; }
        }
        lines.push(row(`${esc(l.name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()))} <span class="ans-sub">from ${esc(s.id === '1991' ? '15th & 61st' : 'Holman Rd')}</span>`, `${isNum(l.minutes) ? l.minutes + ' min' : 'n/a'}${usual}`));
        if (!speak && /downtown/i.test(l.name) && isNum(l.minutes)) speak = `Driving downtown from 15th Avenue takes about ${l.minutes} minutes right now${usual ? `,${usual.replace(/[()]/g, '')}` : ''}.`;
      }
    }
    const b = ballardBridge(D);
    if (b && b.up) speak += ' Heads up: the Ballard Bridge is up.';
    return { title: 'Drive times now', icon: 'traffic', html: `<div class="ans-rows">${lines.join('')}</div>${b && b.up ? '<p class="ans-verdict warn">The Ballard Bridge is up — 15th Ave is stopped.</p>' : ''}`, speak, actions: [{ label: 'Cameras', href: '#move' }] };
  },
};

/** Full-text fallback over events, news, activity, wildlife and card titles. */
function searchAnswer(q, D, now, { activity = [] } = {}) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return null;
  const hits = [];
  const test = (s) => { const t = String(s || '').toLowerCase(); return words.filter((w) => t.includes(w)).length; };
  for (const e of arr((D('events') || {}).events)) { const s = test(`${e.title} ${e.venue}`); if (s) hits.push({ s: s + 0.3, html: `<a class="ans-item" href="${href(e.url)}" target="_blank" rel="noopener"><b>${esc(e.title)}</b><div class="ans-sub">Event · ${esc(dayLabel(e.start))} ${time(e.start)}${e.venue ? ` · ${esc(e.venue)}` : ''}</div></a>` }); }
  for (const n of arr((D('news') || {}).items)) { const s = test(n.title); if (s) hits.push({ s, html: `<a class="ans-item" href="${href(n.link)}" target="_blank" rel="noopener"><b>${esc(n.title)}</b><div class="ans-sub">News · ${esc(n.source || '')} · ${esc(rel(n.t, now))}</div></a>` }); }
  for (const a of arr(activity)) { const s = test(`${a.title} ${a.detail}`); if (s) hits.push({ s: s + 0.2, html: `<div class="ans-item"><b>${esc(a.title)}</b><div class="ans-sub">Activity · ${time(a.t)} ${esc(dayLabel(a.t))}</div></div>` }); }
  for (const o of arr((D('wildlife') || {}).observations)) { const s = test(`${o.taxon.common} ${o.taxon.name}`); if (s) hits.push({ s, html: `<a class="ans-item" href="${href(o.url)}" target="_blank" rel="noopener"><b>${esc(o.taxon.common || o.taxon.name)}</b><div class="ans-sub">Wildlife · ${esc(rel(o.t || o.created, now))}</div></a>` }); }
  if (!hits.length) return null;
  hits.sort((a, b) => b.s - a.s);
  return { intent: 'search', title: `${plural(hits.length, 'result')} for “${String(q).trim()}”`, icon: 'search', html: `<div class="ans-list">${hits.slice(0, 8).map((h) => h.html).join('')}</div>`, speak: '' };
}

/** Suggested questions for right now (shown when Ask opens). */
export function suggestions(D, now) {
  const p = pparts(now);
  const out = [];
  const b = ballardBridge(D);
  out.push(b && b.up ? 'How long has the bridge been up?' : 'Will the bridge open soon?');
  out.push(p.hh < 10 ? 'When is the next D Line downtown?' : p.hh >= 16 && p.hh < 19 ? 'How\'s the drive downtown?' : 'When\'s the next bus?');
  const w = D('weather');
  out.push(w && (arr(w.hourly).slice(0, 6).some((h) => h.pop >= 40)) ? 'Do I need an umbrella?' : 'What\'s the weather tonight?');
  out.push(p.hh >= 15 ? 'What\'s happening tonight?' : 'Good time to kayak?');
  out.push('What were those sirens?', 'What plane is that?', 'When is low tide?', 'Brief me');
  return [...new Set(out)].slice(0, 8);
}

// ======================================================================= the brief

/** A short narrative of Ballard right now: { title, text (for speech), html }. */
export function brief(D, now, { activity = [], baseline = null } = {}) {
  const p = pparts(now);
  const greet = p.hh < 5 ? 'Good night' : p.hh < 12 ? 'Good morning' : p.hh < 17 ? 'Good afternoon' : 'Good evening';
  const parts = [];
  const w = D('weather');
  if (w && w.current) {
    const c = w.current, d0 = arr(w.daily)[0] || {}, d1 = arr(w.daily)[1] || {};
    parts.push(`It's ${r0(c.tempF)}° and ${wxText(c.code).toLowerCase()} in Ballard${p.hh < 15 && isNum(d0.hiF) ? `, headed for ${r0(d0.hiF)}°` : p.hh >= 18 && isNum(d1.loF) ? `, down to about ${r0(Math.min(d0.loF ?? 99, d1.loF))}° tonight` : ''}.`);
    const rt = rainTimes(w, now);
    if (isNum(rt.startsAt) && rt.startsAt > now && rt.startsAt - now < 6 * H) parts.push(`Rain starts around ${time(rt.startsAt)}.`);
    else if (isNum(rt.endsAt)) parts.push(`The rain should ease around ${time(rt.endsAt)}.`);
    else if (!arr(w.hourly).slice(0, 8).some((h) => h.pop >= 40)) parts.push('No rain in the next few hours.');
  }
  const b = ballardBridge(D);
  if (b) parts.push(b.up ? 'The Ballard Bridge is up right now.' : 'The Ballard Bridge is down.');
  const g = dLineDowntown(D, now);
  if (g) parts.push(`The next D Line downtown is ${etaText(g.arrivals[0].t, now) === 'now' ? 'arriving now' : `in ${etaText(g.arrivals[0].t, now)} minutes`}.`);
  const td = D('tides');
  const nt = td && nextTides(td, now)[0];
  if (nt) parts.push(`${nt.type === 'H' ? 'High' : 'Low'} tide is ${r1(nt.ft)} feet at ${time(nt.t)}.`);
  const aq = aqiNow(D);
  if (aq) parts.push(`Air quality is ${aqiInfo(aq.aqi).label.toLowerCase()}.`);
  const n = nextSun(D, now);
  if (n) parts.push(`${cap(n.kind)} is at ${time(n.t)}.`);
  const ms = placeStatus(PLACES[0], now);
  if (ms.open) parts.push('The farmers market is open until 2.');
  if (typeof baseline === 'function') for (const m of moments(D, now, { baseline }).filter((x) => /^usual-/.test(x.id)).slice(0, 2)) parts.push(`${m.title}.`);
  const ev = D('events');
  const later = arr(ev && ev.events).filter((e) => !e.allDay && !e.canceled && e.start > now && dayKey(e.start) === dayKey(now)).sort((a, x) => a.start - x.start);
  if (later.length) parts.push(`${later.length === 1 ? 'One event' : `${later.length} events`} later today, starting with ${later[0].title} at ${time(later[0].start)}.`);
  const hour1 = arr(activity).filter((x) => now - x.t < H && x.t <= now);
  if (hour1.length) {
    const by = {};
    for (const x of hour1) by[x.kind] = (by[x.kind] || 0) + 1;
    const words = { bridge: ['bridge update', 'bridge updates'], fire: ['911 call', '911 calls'], transit: ['transit update', 'transit updates'], news: ['news story', 'news stories'], aircraft: ['aircraft sighting', 'aircraft sightings'], weather: ['weather update', 'weather updates'] };
    const bits = Object.entries(by).filter(([k]) => words[k]).map(([k, c]) => `${c === 1 ? 'one' : c} ${words[k][c === 1 ? 0 : 1]}`);
    if (bits.length) parts.push(`In the last hour: ${listJoin(bits)}.`);
  }
  const text = `${greet}. ${parts.join(' ')}`;
  return { title: `${greet} from Ballard`, text, html: `<p class="ans-brief">${esc(text)}</p>` };
}
void md; void wd; void clamp; void closureToday;
