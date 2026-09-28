// v2 intelligence for the v1 sources: metrics (history time series), detectors (activity feed) and idle
// refresh rates, keyed by source id. sources/index.mjs merges these into the loaded source definitions; a
// field the source module defines itself always wins. See CORE.md ("Adding metrics, a detector, or idleTtl").
//
// Detector rules (CORE.md): pure and cheap, never throw on odd data, return [] when prev is null, and build
// `key` from stable identity (never from the refresh time) so the activity log's 7-day dedupe works.
import { TZ } from '../lib.mjs';

const MIN = 60e3;
const HOUR = 60 * MIN;

// ---------------------------------------------------------------- helpers

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (isNum(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const r0 = (v) => Math.round(v);
const r1 = (v) => Math.round(v * 10) / 10;

const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
/** '9:45 pm' in Pacific time. */
export const hm = (t) => (isNum(t) ? timeFmt.format(t).replace(' AM', ' am').replace(' PM', ' pm') : '');
const wday = (t) => (isNum(t) ? dayFmt.format(t) : '');

/** Short stable hash (djb2, base36) for long identities such as URLs. */
export function hash(s) {
  let h = 5381;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Metric-key-safe slug: 'AURORA BR' -> 'aurora_br'. */
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'x';

const clip = (s, n = 140) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const titleCase = (s = '') => String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(Nw|Ne|Sw|Se)\b/g, (m) => m.toUpperCase());

/** Ids present in `next` but not in `prev` (by keyFn). */
function added(prevList, nextList, keyFn) {
  const seen = new Set(arr(prevList).map(keyFn));
  return arr(nextList).filter((x) => { try { return !seen.has(keyFn(x)); } catch { return false; } });
}

/**
 * Hysteresis state machines shared across refreshes (module state; rebuilt from `prev` after a restart).
 * enter: value >= on switches the state on; value < off switches it off. Returns 'on' | 'off' | null (no change).
 */
const machines = new Map();
export function hysteresis(name, prevValue, nextValue, on, off) {
  if (!isNum(nextValue)) return null;
  let state = machines.get(name);
  if (state === undefined) state = isNum(prevValue) ? prevValue >= on : false;
  let change = null;
  if (!state && nextValue >= on) { state = true; change = 'on'; }
  else if (state && nextValue < off) { state = false; change = 'off'; }
  machines.set(name, state);
  return change;
}
export function _resetMachines() { machines.clear(); }

const guard = (fn) => (prev, next, ctx) => {
  if (!prev || !next) return [];
  try { return fn(prev, next, ctx || { now: Date.now() }) || []; } catch { return []; }
};

// ---------------------------------------------------------------- per-source logic

const FIRE_BIG = /\b(fire|rescue|hazmat|haz mat|explosion|collapse|marine|shooting|stabbing|assault w|mass casualty|smoke|gas leak|natural gas)\b/i;
const FIRE_ROUTINE = /\b(alarm|bell|investigate|false|smoke detector|odor|trouble)\b/i;
function fireSeverity(type = '') {
  if (/\bMVI\b|motor vehicle/i.test(type)) return 'notice';
  if (FIRE_BIG.test(type) && !FIRE_ROUTINE.test(type)) return 'warn';
  return 'info';
}

const NWS_SEV = { Extreme: 'alert', Severe: 'warn', Moderate: 'notice', Minor: 'notice' };

function meanDelayByRoute(v) {
  const by = {};
  for (const x of arr(v && v.vehicles)) {
    if (!isNum(x.deviationSec) || !x.route) continue;
    (by[x.route] ||= []).push(x.deviationSec / 60);
  }
  const out = {};
  for (const [route, xs] of Object.entries(by)) out[route] = { mean: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length };
  return out;
}

const AQI_CATS = [[50, 'Good'], [100, 'Moderate'], [150, 'Unhealthy for sensitive groups'], [200, 'Unhealthy'], [300, 'Very unhealthy'], [Infinity, 'Hazardous']];
const aqiCat = (aqi) => (isNum(aqi) ? AQI_CATS.find(([hi]) => aqi <= hi)[1] : null);

const GENERIC_VESSEL = /^(recreational|rec\b|comm other|fed vessels|state or city|research vessels|police|fireboat|unknown|other)/i;

function median(xs) {
  const a = xs.filter(isNum).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ---------------------------------------------------------------- the table

export const INTEL = {
  // ---------------- weather & sky
  weather: {
    idleTtl: 1800, // history continuity (temperature/wind trends) at a low upstream rate
    metrics: (d) => {
      const c = (d && d.current) || {};
      const h0 = arr(d && d.hourly)[0] || {};
      return {
        'weather.tempF': num(c.tempF), 'weather.feelsF': num(c.feelsF), 'weather.windMph': num(c.windMph),
        'weather.gustMph': num(c.gustMph), 'weather.humidity': num(c.humidity), 'weather.pressureHpa': num(c.pressureHpa),
        'weather.cloud': num(c.cloud), 'weather.pop1h': num(h0.pop),
      };
    },
    detect: guard((prev, next, ctx) => {
      const out = [];
      const now = ctx.now;
      // Rain starting within the hour: one item per rain episode (bucketed start time).
      if (!isNum(prev.rainStartsAt) && isNum(next.rainStartsAt) && next.rainStartsAt - now <= HOUR && next.rainStartsAt >= now - 15 * MIN) {
        out.push({ key: `rain:start:${Math.round(next.rainStartsAt / (30 * MIN))}`, t: now, kind: 'weather', severity: 'notice',
          title: `Rain starting around ${hm(next.rainStartsAt)}`, detail: 'From the 15-minute nowcast (Open-Meteo).' });
      }
      if (!isNum(prev.rainEndsAt) && isNum(next.rainEndsAt) && next.rainEndsAt - now <= 2 * HOUR) {
        out.push({ key: `rain:end:${Math.round(next.rainEndsAt / (30 * MIN))}`, t: now, kind: 'weather', severity: 'info',
          title: `Rain easing around ${hm(next.rainEndsAt)}` });
      }
      // Windy: gusts crossing 35 mph (off below 25).
      const g = hysteresis('weather:gust', num(prev.current && prev.current.gustMph), num(next.current && next.current.gustMph), 35, 25);
      if (g === 'on') out.push({ key: `wind:gust:${Math.floor(now / (3 * HOUR))}`, t: now, kind: 'weather', severity: 'notice',
        title: `Gusty: winds gusting to ${r0(next.current.gustMph)} mph` });
      return out;
    }),
  },
  'nws-forecast': { idleTtl: 3600 },
  alerts: {
    idleTtl: 600, // warnings matter even when nobody is looking
    detect: guard((prev, next, ctx) => {
      const out = [];
      for (const a of added(prev.alerts, next.alerts, (x) => x.id)) {
        out.push({ key: `alert:${a.id}`, t: isNum(a.onset) ? Math.min(a.onset, ctx.now) : undefined, kind: 'alert',
          severity: NWS_SEV[a.severity] || 'info', title: a.event || 'Weather alert',
          detail: clip(a.headline || a.description, 200), link: 'https://forecast.weather.gov/MapClick.php?lat=47.6687&lon=-122.3847' });
      }
      for (const a of added(next.alerts, prev.alerts, (x) => x.id)) {
        out.push({ key: `alert:${a.id}:ended`, kind: 'alert', severity: 'info', title: `${a.event || 'Weather alert'} ended` });
      }
      return out;
    }),
  },
  stations: {
    idleTtl: 900,
    metrics: (d) => ({ 'stations.medianTempF': num(d && d.medianTempF) }),
  },
  westpoint: {
    idleTtl: 1200,
    metrics: (d) => ({
      'westpoint.windKt': num(d && d.windKt),
      // Gust at the observation time when NDBC reports one, else the hourly peak gust (see CONTRACT.md).
      'westpoint.gustKt': num(d && d.gustKt) ?? num(d && d.peakGustKt),
      'westpoint.pressureHpa': num(d && d.pressureHpa), 'westpoint.airTempF': num(d && d.airTempF),
    }),
    detect: guard((prev, next, ctx) => {
      const g = hysteresis('westpoint:gale', num(prev.gustKt) ?? num(prev.peakGustKt), num(next.gustKt) ?? num(next.peakGustKt), 30, 22);
      if (g !== 'on') return [];
      const kt = num(next.gustKt) ?? num(next.peakGustKt);
      return [{ key: `westpoint:gale:${Math.floor(ctx.now / (3 * HOUR))}`, kind: 'water', severity: 'notice',
        title: `Strong gusts on the Sound: ${r0(kt)} kt at West Point`, lat: 47.662, lon: -122.435,
        link: 'https://www.ndbc.noaa.gov/station_page.php?station=wpow1' }];
    }),
  },
  marine: { idleTtl: 3600 },
  afd: { idleTtl: 7200 },
  sky: { idleTtl: 21600 },
  kp: {
    idleTtl: 1800,
    metrics: (d) => ({ 'kp.kp': num(d && d.kp) }),
    detect: guard((prev, next, ctx) => {
      const out = [];
      for (const [lvl, sev, text] of [[5, 'notice', 'Aurora possible from dark spots tonight (look north)'], [7, 'warn', 'Strong geomagnetic storm: good aurora odds after dark']]) {
        if (hysteresis(`kp:${lvl}`, num(prev.kp), num(next.kp), lvl, lvl - 1) === 'on') {
          out.push({ key: `kp:${lvl}:${Math.floor(ctx.now / (6 * HOUR))}`, kind: 'sky', severity: sev, title: `Kp ${r1(next.kp)}: ${text}`,
            link: 'https://www.swpc.noaa.gov/products/aurora-30-minute-forecast' });
        }
      }
      return out;
    }),
  },
  radar: { idleTtl: null }, // only metadata for the browser's tile layer
  airnow: {
    idleTtl: 3600,
    metrics: (d) => {
      const o = arr(d && d.observed);
      const pm = o.find((x) => x.param === 'PM2.5');
      const oz = o.find((x) => x.param === 'OZONE');
      return { 'airnow.pm25aqi': num(pm && pm.aqi), 'airnow.ozoneaqi': num(oz && oz.aqi) };
    },
    detect: guard((prev, next) => {
      const p = arr(prev.observed).find((x) => x.primary) || arr(prev.observed)[0];
      const n = arr(next.observed).find((x) => x.primary) || arr(next.observed)[0];
      if (!p || !n || !n.category || p.category === n.category) return [];
      const bad = !/^(good|moderate)$/i.test(n.category);
      return [{ key: `airnow:${n.category}:${n.t}`, t: n.t, kind: 'air', severity: bad ? 'warn' : 'info',
        title: `Official air quality now ${n.category} (${n.param} AQI ${n.aqi})`, link: 'https://www.airnow.gov/?city=Seattle&state=WA' }];
    }),
  },
  purpleair: {
    idleTtl: 1800,
    metrics: (d) => ({ 'purpleair.aqi': num(d && d.medianAqi), 'purpleair.pm25': num(d && d.medianPm25), 'purpleair.sensors': num(d && d.count) }),
    detect: guard((prev, next, ctx) => {
      const out = [];
      // Two hysteresis bands so readings hovering near a breakpoint don't flap.
      const usg = hysteresis('purpleair:usg', num(prev.medianAqi), num(next.medianAqi), 101, 85);
      const mod = hysteresis('purpleair:moderate', num(prev.medianAqi), num(next.medianAqi), 60, 42);
      const aqi = num(next.medianAqi);
      if (usg === 'on') out.push({ key: `aqi:usg:${Math.floor(ctx.now / (6 * HOUR))}`, kind: 'air', severity: 'warn', title: `Air quality unhealthy for sensitive groups (AQI ${aqi})`, detail: 'Median of the PurpleAir sensors in Ballard.' });
      else if (usg === 'off') out.push({ key: `aqi:usg-off:${Math.floor(ctx.now / (6 * HOUR))}`, kind: 'air', severity: 'notice', title: `Air quality improving (AQI ${aqi})` });
      else if (mod === 'on') out.push({ key: `aqi:mod:${Math.floor(ctx.now / (6 * HOUR))}`, kind: 'air', severity: 'info', title: `Air quality now ${aqiCat(aqi)} (AQI ${aqi})` });
      else if (mod === 'off') out.push({ key: `aqi:mod-off:${Math.floor(ctx.now / (6 * HOUR))}`, kind: 'air', severity: 'info', title: `Air quality back to Good (AQI ${aqi})` });
      return out;
    }),
  },

  // ---------------- water & the Locks
  tides: {
    idleTtl: 3600,
    metrics: (d) => ({ 'tides.observedFt': num(d && d.latest && d.latest.ft), 'tides.anomalyFt': num(d && d.latest && d.latest.anomalyFt) }),
    detect: guard((prev, next, ctx) => {
      const out = [];
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ctx.now);
      const today = arr(next.hilo).filter((e) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(e.t) === day);
      const minus = today.filter((e) => e.type === 'L' && isNum(e.ft) && e.ft <= 0).sort((a, b) => a.ft - b.ft)[0];
      if (minus) out.push({ key: `tide:minus:${day}`, t: ctx.now, kind: 'water', severity: 'info',
        title: `Minus tide today: ${r1(minus.ft)} ft at ${hm(minus.t)}`, detail: 'A good tidepooling window at Golden Gardens and Discovery Park.', lat: 47.6883, lon: -122.403 });
      const king = today.filter((e) => e.type === 'H' && isNum(e.ft) && e.ft >= 12.5).sort((a, b) => b.ft - a.ft)[0];
      if (king) out.push({ key: `tide:king:${day}`, t: ctx.now, kind: 'water', severity: 'notice',
        title: `Very high tide today: ${r1(king.ft)} ft at ${hm(king.t)}`, detail: 'Watch low spots along Seaview Ave and Shilshole.', lat: 47.6883, lon: -122.403 });
      // A storm surge / anomaly over 1.5 ft at the Seattle gauge.
      if (hysteresis('tides:surge', num(prev.latest && prev.latest.anomalyFt), num(next.latest && next.latest.anomalyFt), 1.5, 1.0) === 'on') {
        out.push({ key: `tide:surge:${Math.floor(ctx.now / (6 * HOUR))}`, kind: 'water', severity: 'notice',
          title: `Water running ${r1(next.latest.anomalyFt)} ft above the predicted tide`, link: 'https://tidesandcurrents.noaa.gov/stationhome.html?id=9447130' });
      }
      return out;
    }),
  },
  currents: {},
  lake: {
    idleTtl: 1800,
    metrics: (d) => ({ 'lake.ft': num(d && d.ft), 'lake.outflowCfs': num(d && d.outflowCfs) }),
  },
  lockages: {
    idleTtl: 900,
    metrics: (d) => {
      const t = (d && d.today) || {};
      return { 'lockages.today': num(t.total), 'lockages.up': num(t.up), 'lockages.down': num(t.down), 'lockages.commercial': num(t.commercial), 'lockages.queued': num(d && d.queued) };
    },
    detect: guard((prev, next, ctx) => {
      const out = [];
      const id = (v) => `${v.name}|${v.arrival}`;
      for (const v of added(prev.recent, next.recent, id)) {
        if (!v.commercial || !v.name || GENERIC_VESSEL.test(v.name.trim())) continue;
        if (!isNum(v.arrival) || ctx.now - v.arrival > 3 * HOUR) continue;
        out.push({ key: `lock:${hash(id(v))}`, t: v.arrival, kind: 'locks', severity: 'info',
          title: `${titleCase(v.name.trim())} ${v.direction === 'up' ? 'heading into the lake' : 'heading out to the Sound'}`,
          detail: 'Ballard Locks, large chamber', lat: 47.6655, lon: -122.3972,
          link: isNum(v.mmsi) ? `https://www.marinetraffic.com/en/ais/details/ships/mmsi:${v.mmsi}` : undefined });
      }
      if (hysteresis('lockages:queue', num(prev.queued), num(next.queued), 3, 2) === 'on') {
        out.push({ key: `lock:queue:${Math.floor(ctx.now / (2 * HOUR))}`, kind: 'locks', severity: 'notice',
          title: `${next.queued} vessels waiting at the Locks`, lat: 47.6655, lon: -122.3972 });
      }
      return out;
    }),
  },
  stoppages: {
    idleTtl: 3600,
    detect: guard((prev, next) => {
      const id = (s) => `${s.chamber}|${s.begin}`;
      const out = [];
      for (const s of added(prev.active, next.active, id)) out.push({ key: `stop:${hash(id(s))}`, t: s.begin, kind: 'locks', severity: 'warn',
        title: `Locks chamber ${s.chamber} closed`, detail: clip(s.reason, 160) + (isNum(s.end) ? ` · until ${wday(s.end)} ${hm(s.end)}` : ''), lat: 47.6655, lon: -122.3972 });
      for (const s of added(next.active, prev.active, id)) out.push({ key: `stop:${hash(id(s))}:end`, kind: 'locks', severity: 'info',
        title: `Locks chamber ${s.chamber} reopened`, lat: 47.6655, lon: -122.3972 });
      return out;
    }),
  },
  bridges: {
    // background: true in water.mjs (always polled every 20 s)
    metrics: (d) => {
      const b = arr(d && d.bridges);
      const by = (re) => { const x = b.find((y) => re.test(y.name)); return x ? (x.up ? 1 : 0) : null; };
      return { 'bridges.ballardUp': by(/ballard/i), 'bridges.fremontUp': by(/fremont/i), 'bridges.up': b.filter((x) => x.up).length };
    },
    detect: guard((prev, next, ctx) => {
      const out = [];
      // After a polling gap (sleep, outage, restart) water.mjs resets observingSince: a state that differs from
      // before the gap changed at an unknown time, so don't announce it as if it just happened.
      if (isNum(prev.observingSince) && isNum(next.observingSince) && next.observingSince !== prev.observingSince) return [];
      const before = new Map(arr(prev.bridges).map((x) => [x.id, x]));
      for (const x of arr(next.bridges)) {
        const p = before.get(x.id);
        if (!p || p.up === x.up) continue;
        const main = /ballard|fremont/i.test(x.name);
        const at = x.sinceKnown && isNum(x.since) ? x.since : ctx.now;
        if (x.up) {
          out.push({ key: `bridge:${x.id}:up:${Math.floor(at / MIN)}`, t: at, kind: 'bridge', severity: main ? 'notice' : 'info',
            title: `${x.name} Bridge is UP`, detail: 'Raised for boats; road traffic stopped.', lat: x.lat, lon: x.lon });
        } else {
          const log = arr(next.log).find((l) => l.bridge === x.name && isNum(l.downAt) && Math.abs(l.downAt - at) < 5 * MIN);
          out.push({ key: `bridge:${x.id}:down:${Math.floor(at / MIN)}`, t: at, kind: 'bridge', severity: 'info',
            title: `${x.name} Bridge is back down`, detail: log && isNum(log.minutes) ? `It was up for ${log.minutes} min.` : 'Open to traffic again.', lat: x.lat, lon: x.lon });
        }
      }
      return out;
    }),
  },
  'bridge-history': { idleTtl: 21600 },
  salmon: {
    detect: guard((prev, next) => {
      const out = [];
      const before = new Map(arr(prev.species).map((s) => [s.name, s]));
      for (const s of arr(next.species)) {
        const p = before.get(s.name);
        if (!p || !s.latestDate || p.latestDate === s.latestDate || !(s.latestCount > 0)) continue;
        out.push({ key: `salmon:${s.name}:${next.year}:${s.latestDate}`, t: s.latestT, kind: 'wildlife', severity: 'info',
          title: `${s.latestCount.toLocaleString('en-US')} ${s.name.toLowerCase()} counted at the Locks on ${s.latestDate}`,
          detail: isNum(s.total) ? `Season total ${s.total.toLocaleString('en-US')} (WDFW, preliminary)` : undefined,
          lat: 47.6655, lon: -122.3972, link: next.source });
      }
      return out;
    }),
  },
  cso: {
    idleTtl: 1200,
    metrics: (d) => ({ 'cso.overflowing': num(d && d.overflowing), 'cso.recent': num(d && d.recent) }),
    detect: guard((prev, next) => {
      const out = [];
      const before = new Map(arr(prev.sites).map((s) => [s.tag, s]));
      for (const s of arr(next.sites)) {
        const p = before.get(s.tag);
        if (!p || p.status === s.status) continue;
        if (s.status === 'overflowing') out.push({ key: `cso:${s.tag}:on:${s.t}`, t: s.t, kind: 'water', severity: 'warn',
          title: `Sewer overflow: ${s.name}`, detail: 'Avoid contact with the water nearby for 48 hours.', lat: s.lat, lon: s.lon,
          link: 'https://kingcounty.gov/en/dept/dnrp/waste-services/wastewater-treatment/sewer-system-services/cso-status' });
        else if (p.status === 'overflowing') out.push({ key: `cso:${s.tag}:off:${s.t}`, t: s.t, kind: 'water', severity: 'info',
          title: `Overflow stopped: ${s.name}`, detail: 'Still avoid water contact for 48 hours after an overflow.', lat: s.lat, lon: s.lon });
      }
      return out;
    }),
  },

  // ---------------- getting around
  transit: { idleTtl: null }, // arrival predictions are useless when nobody is looking, and the OBA TEST key is shared
  vehicles: {
    idleTtl: 600, // keeps the per-route delay history continuous at a gentle rate
    metrics: (d) => {
      const m = meanDelayByRoute(d);
      const out = { 'transit.vehicles': arr(d && d.vehicles).length };
      for (const [route, key] of [['D Line', 'D'], ['40', '40'], ['44', '44']]) out[`transit.delay.${key}`] = m[route] ? r1(m[route].mean) : null;
      return out;
    },
    detect: guard((prev, next, ctx) => {
      const out = [];
      const a = meanDelayByRoute(prev), b = meanDelayByRoute(next);
      for (const route of ['D Line', '40', '44']) {
        const nb = b[route];
        const change = hysteresis(`delay:${route}`, a[route] && a[route].mean, nb && nb.n >= 2 ? nb.mean : null, 5, 3);
        if (change === 'on') out.push({ key: `delay:${route}:on:${Math.floor(ctx.now / MIN)}`, kind: 'transit', severity: 'notice',
          title: `${route === 'D Line' ? 'D Line' : 'Route ' + route} running about ${r0(nb.mean)} min late`, detail: `Average of ${nb.n} buses on the route right now.` });
        else if (change === 'off') out.push({ key: `delay:${route}:off:${Math.floor(ctx.now / MIN)}`, kind: 'transit', severity: 'info',
          title: `${route === 'D Line' ? 'D Line' : 'Route ' + route} back near schedule` });
      }
      return out;
    }),
  },
  'metro-alerts': {
    idleTtl: 1800,
    detect: guard((prev, next) => added(prev.alerts, next.alerts, (a) => a.id).map((a) => ({
      key: `metro:${a.id}`, kind: 'transit', severity: /severe/i.test(a.severity || '') ? 'warn' : 'notice',
      title: `${arr(a.routes).length ? arr(a.routes).map((r) => (r === 'D Line' ? 'D' : r)).join('/') + ': ' : ''}${clip(a.header, 120)}`,
      detail: a.description ? clip(a.description, 200) : undefined, link: a.url || 'https://kingcounty.gov/en/dept/metro/rider-tools/service-advisories',
    }))),
  },
  cameras: { idleTtl: null }, // HEAD checks only matter while someone is looking at the images
  traffic: {
    idleTtl: 600,
    metrics: (d) => {
      const out = {};
      for (const s of arr(d && d.sites)) {
        for (const l of arr(s.links)) {
          out[`traffic.${slug(s.id)}.${slug(l.name)}`] = num(l.minutes);
          if (/downtown/i.test(l.name)) out[`traffic.downtown${s.id}`] = num(l.minutes);
        }
      }
      return out;
    },
    detect: guard((prev, next, ctx) => {
      const out = [];
      for (const s of arr(next.sites)) {
        const l = arr(s.links).find((x) => /downtown/i.test(x.name));
        if (!l || !isNum(l.minutes)) continue;
        const series = ctx.history && typeof ctx.history.get === 'function' ? ctx.history.get(`traffic.downtown${s.id}`, 48) : null;
        const usual = median(arr(series).map((p) => p[1]));
        if (!isNum(usual) || arr(series).length < 60) continue; // need about an hour of history first
        const p = arr(prev.sites).find((x) => x.id === s.id);
        const pl = p && arr(p.links).find((x) => /downtown/i.test(x.name));
        const ratio = (v) => (isNum(v) ? v / Math.max(usual, 5) : null);
        const change = hysteresis(`traffic:${s.id}`, ratio(pl && pl.minutes), ratio(l.minutes), 1.6, 1.25);
        if (change === 'on') out.push({ key: `traffic:${s.id}:slow:${Math.floor(ctx.now / MIN)}`, kind: 'traffic', severity: 'notice',
          title: `Slow drive downtown from ${s.name}: ${l.minutes} min`, detail: `Usually about ${r0(usual)} min (48-hour median).` });
      }
      return out;
    }),
  },
  incidents: {
    idleTtl: 900,
    detect: guard((prev, next) => added(prev.incidents, next.incidents, (x) => x.id).map((x) => ({
      key: `sdot:${x.id}`, t: x.start, kind: 'traffic', severity: /collision/i.test(x.type || '') ? 'warn' : 'notice',
      title: `${x.type || 'Incident'}: ${clip(x.location || x.description, 90)}`, detail: clip(x.description, 200), lat: x.lat, lon: x.lon, link: x.url,
    }))),
  },
  lime: {
    idleTtl: 1800, // a 3 MB feed: sample it gently while idle
    metrics: (d) => {
      const n = (d && d.near) || {};
      return { 'lime.near': num(n.total), 'lime.scooters': num(n.scooters), 'lime.ebikes': num(n.ebikes), 'lime.inBbox': num(d && d.inBbox) };
    },
  },

  // ---------------- safety & community
  fire911: {
    idleTtl: 300,
    metrics: (d) => ({ 'fire911.count24h': arr(d && d.incidents).length, 'fire911.active': d && d.activeKnown !== false ? num(d.activeCount) : null }),
    detect: guard((prev, next, ctx) => added(prev.incidents, next.incidents, (x) => x.id)
      .filter((x) => isNum(x.t) && ctx.now - x.t < 2 * HOUR)
      .map((x) => ({
        key: `fire:${x.id}`, t: x.t, kind: 'fire', severity: fireSeverity(x.type),
        title: `${x.type || 'Incident'} · ${titleCase(x.address || '')}`,
        detail: [x.units ? `Units ${x.units}` : '', isNum(x.distKm) ? `${(x.distKm * 0.621).toFixed(1)} mi from Market & Ballard Ave` : ''].filter(Boolean).join(' · ') || undefined,
        lat: num(x.lat) ?? undefined, lon: num(x.lon) ?? undefined,
        link: 'https://web.seattle.gov/sfd/realtime911/getRecsForDatePub.asp?action=Today&incDate=&rad1=des',
      }))),
  },
  crime: {
    detect: guard((prev, next) => added(prev.reports, next.reports, (x) => x.id)
      .filter((x) => x.category === 'PERSON')
      .map((x) => ({
        key: `spd:${x.id}`, t: x.t, kind: 'civic', severity: 'info',
        title: `Police report: ${arr(x.offenses).join(', ') || 'offense'}`,
        detail: `${x.block || 'Location withheld'} · reported ${wday(x.t)} ${hm(x.t)} (SPD data is about a day behind)`,
        lat: num(x.lat) ?? undefined, lon: num(x.lon) ?? undefined,
      }))),
  },
  quakes: {
    idleTtl: 900,
    detect: guard((prev, next) => {
      const seen = new Set([...arr(prev.recent), ...arr(prev.notable)].map((q) => q.id));
      const out = [];
      for (const q of [...arr(next.notable), ...arr(next.recent)]) {
        if (seen.has(q.id) || !isNum(q.mag)) continue;
        seen.add(q.id);
        const near = isNum(q.distKm) && q.distKm <= 50 && q.mag >= 1.5;
        const felt = isNum(q.distKm) && q.distKm <= 300 && q.mag >= 2.5;
        if (!near && !felt) continue;
        out.push({ key: `quake:${q.id}`, t: q.t, kind: 'quake', severity: q.mag >= 5.5 ? 'alert' : q.mag >= 4 ? 'warn' : 'notice',
          title: `M${q.mag.toFixed(1)} earthquake · ${q.place}`, detail: isNum(q.distKm) ? `${r0(q.distKm * 0.621)} mi away, ${isNum(q.depthKm) ? r0(q.depthKm) + ' km deep' : ''}` : undefined,
          lat: q.lat, lon: q.lon, link: q.url });
      }
      return out;
    }),
  },
  outages: {
    idleTtl: 600,
    metrics: (d) => ({ 'outages.ballard': arr(d && d.ballard).length, 'outages.citywideCustomers': num(d && d.citywide && d.citywide.customers) }),
    detect: guard((prev, next) => {
      const out = [];
      for (const o of added(prev.ballard, next.ballard, (x) => x.id)) out.push({ key: `outage:${o.id}`, t: o.start, kind: 'power', severity: 'warn',
        title: `Power outage in Ballard: ${o.customers} customer${o.customers === 1 ? '' : 's'}`, detail: [o.cause, isNum(o.etr) ? `estimated restoration ${hm(o.etr)}` : ''].filter(Boolean).join(' · '),
        lat: o.lat, lon: o.lon, link: 'https://www.seattle.gov/city-light/outages' });
      for (const o of added(next.ballard, prev.ballard, (x) => x.id)) out.push({ key: `outage:${o.id}:restored`, kind: 'power', severity: 'info',
        title: 'Power restored in Ballard', detail: `${o.customers} customer${o.customers === 1 ? '' : 's'} affected`, lat: o.lat, lon: o.lon });
      return out;
    }),
  },
  news: {
    idleTtl: 3600,
    detect: guard((prev, next, ctx) => added(prev.items, next.items, (x) => x.link)
      .filter((x) => x.ballard && isNum(x.t) && ctx.now - x.t < 24 * HOUR)
      .slice(0, 5)
      .map((x) => ({ key: `news:${hash(x.link)}`, t: x.t, kind: 'news', severity: /my ballard/i.test(x.source || '') ? 'notice' : 'info',
        title: clip(x.title, 140), detail: x.source, link: x.link }))),
  },
  reddit: {
    idleTtl: 7200,
    detect: guard((prev, next, ctx) => added(prev.items, next.items, (x) => x.link)
      .filter((x) => isNum(x.t) && ctx.now - x.t < 24 * HOUR)
      .slice(0, 5)
      .map((x) => ({ key: `reddit:${hash(x.link)}`, t: x.t, kind: 'social', severity: 'info', title: clip(x.title, 140), detail: x.sub, link: x.link }))),
  },
  events: {
    idleTtl: 3600,
    // Time-based: every event that starts within the next hour, once (the key is the event id).
    detect: guard((prev, next, ctx) => arr(next.events)
      .filter((e) => !e.allDay && !e.canceled && isNum(e.start) && e.start > ctx.now && e.start - ctx.now <= HOUR)
      .slice(0, 6)
      .map((e) => ({ key: `event:${e.id}:soon`, kind: 'event', severity: 'info',
        title: `Starting ${hm(e.start)}: ${clip(e.title, 110)}`, detail: [e.venue, e.cost].filter(Boolean).join(' · ') || undefined, link: e.url }))),
  },
  closures: {
    detect: guard((prev, next) => added(prev.closures, next.closures, (x) => x.permit).map((x) => ({
      key: `closure:${x.permit}`, kind: 'traffic', severity: 'info',
      title: `Street closure: ${x.street}${x.from ? ` (${x.from} to ${x.to || '…'})` : ''}`,
      detail: [x.type, x.todayHours ? `today ${x.todayHours}` : ''].filter(Boolean).join(' · '),
      lat: arr(arr(x.segments)[0] && x.segments[0].line)[0]?.[0], lon: arr(arr(x.segments)[0] && x.segments[0].line)[0]?.[1],
    }))),
  },
  requests311: {},
  permits: {},
};
