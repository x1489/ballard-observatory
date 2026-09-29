// Moving things for the live 3D scene (no keys needed):
//   buses       King County Metro GTFS-realtime: every Metro/ST Express bus in and around Ballard, with the trip's
//               upcoming stops and predicted times (s3.amazonaws.com/kcm-alerts-realtime-prod, public).
//   trains      Amtrak trains on the Seattle - Everett line that runs along Ballard's shore (Amtrak Cascades to
//               Vancouver BC, Empire Builder), plus upcoming passes (Amtraker v3, which relays Amtrak's train map).
//   satellites  CelesTrak element sets for the space stations and the ~150 brightest satellites; the browser
//               propagates them (SGP4) to show what is overhead.
import { get, CENTER, round } from '../lib.mjs';
import { decodeFeed, VEHICLE_STATUS } from './gtfsrt.mjs';

const MIN = 60e3;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// =================================================================== buses
const KCM_VP = 'https://s3.amazonaws.com/kcm-alerts-realtime-prod/vehiclepositions.pb';
const KCM_TU = 'https://s3.amazonaws.com/kcm-alerts-realtime-prod/tripupdates.pb';
export const BUS_AREA = { s: 47.630, n: 47.718, w: -122.440, e: -122.318 };
const inArea = (a, lat, lon) => lat >= a.s && lat <= a.n && lon >= a.w && lon <= a.e;

/** Pure: GTFS-rt vehicle positions (+ trip updates) bytes -> `buses` output. */
export function parseBuses(vpBytes, tuBytes, now = Date.now()) {
  const vp = decodeFeed(vpBytes);
  const vehicles = [];
  for (const e of vp.entity) {
    const v = e.vehicle;
    if (!v || !v.position || !isNum(v.position.lat) || !isNum(v.position.lon)) continue;
    const { lat, lon } = v.position;
    if (!inArea(BUS_AREA, lat, lon)) continue;
    const t = isNum(v.timestamp) && v.timestamp > 0 ? v.timestamp * 1000 : null;
    if (t != null && now - t > 15 * MIN) continue;
    const trip = v.trip || {};
    vehicles.push({
      id: (v.vehicle && (v.vehicle.id || v.vehicle.label)) || e.id,
      trip: trip.tripId || null, route: trip.routeId || null, dir: isNum(trip.directionId) ? trip.directionId : null,
      lat: round(lat, 6), lon: round(lon, 6),
      bearing: isNum(v.position.bearing) ? round(v.position.bearing, 1) : null, speed: isNum(v.position.speed) ? round(v.position.speed, 1) : null,
      t, stopSeq: isNum(v.stopSeq) ? v.stopSeq : null, stopId: v.stopId || null, status: VEHICLE_STATUS[v.status || 0] || null,
      delay: null, next: [],
    });
  }
  if (tuBytes && vehicles.length) {
    const byTrip = new Map(vehicles.filter((v) => v.trip).map((v) => [v.trip, v]));
    const tu = decodeFeed(tuBytes);
    for (const e of tu.entity) {
      const u = e.tripUpdate;
      const v = u && u.trip && byTrip.get(u.trip.tripId);
      if (!v) continue;
      const stops = (u.stops || []).filter((s) => v.stopSeq == null || s.seq >= v.stopSeq).slice(0, 16);
      v.next = stops.map((s) => {
        const ev = s.arrival && s.arrival.time ? s.arrival : s.departure || {};
        return [s.stopId || null, s.seq ?? null, ev.time ? ev.time * 1000 : null, isNum(ev.delay) ? ev.delay : null];
      }).filter((s) => s[2] != null);
      const d = v.next.find((s) => s[3] != null);
      v.delay = isNum(u.delay) ? u.delay : d ? d[3] : null;
    }
  }
  vehicles.sort((a, b) => String(a.route).localeCompare(String(b.route)) || String(a.id).localeCompare(String(b.id)));
  const t = vp.header && isNum(vp.header.timestamp) ? vp.header.timestamp * 1000 : now;
  return { t, area: BUS_AREA, vehicles, count: vehicles.length };
}

async function fetchBuses() {
  const [vp, tu] = await Promise.all([
    get(KCM_VP, { as: 'buffer', timeout: 15000 }),
    get(KCM_TU, { as: 'buffer', timeout: 20000 }).catch(() => null), // positions still render without predictions
  ]);
  return parseBuses(vp, tu, Date.now());
}

// =================================================================== trains
const AMTRAKER = 'https://api-v3.amtraker.com/v3/trains';
// The BNSF line north of King Street: Seattle - (Ballard) - Edmonds - Everett.
const CORRIDOR = { s: 47.59, n: 47.99, w: -122.46, e: -122.18 };
const NORTH = new Set(['EDM', 'EVR', 'MVW', 'STW', 'BEL', 'VAC']);
// Fraction of the scheduled Seattle -> Edmonds running time at which a train crosses Salmon Bay (Ballard): about
// 10.5 of the 29 track-km. An estimate for "passes Ballard at about".
const BALLARD_FRACTION = 0.36;

const ts = (s) => { const t = Date.parse(s || ''); return Number.isFinite(t) ? t : null; };
function stationTimes(st) {
  return { code: st.code, name: st.name, schArr: ts(st.schArr), schDep: ts(st.schDep), arr: ts(st.arr), dep: ts(st.dep), status: st.status || null };
}
/** Estimated time the train crosses Ballard, between its Seattle and Edmonds times (either direction). */
export function ballardPass(stations) {
  const sea = stations.find((s) => s.code === 'SEA'), edm = stations.find((s) => s.code === 'EDM');
  if (!sea || !edm) return null;
  const seaI = stations.indexOf(sea), edmI = stations.indexOf(edm);
  const northbound = seaI < edmI;
  const tSea = northbound ? (sea.dep ?? sea.schDep) : (sea.arr ?? sea.schArr);
  const tEdm = northbound ? (edm.arr ?? edm.schArr) : (edm.dep ?? edm.schDep);
  if (tSea == null || tEdm == null) return null;
  const f = northbound ? BALLARD_FRACTION : 1 - BALLARD_FRACTION;
  return { t: Math.round(tSea + (tEdm - tSea) * f), northbound };
}

/** Pure: Amtraker v3 /trains -> `trains` output (on the corridor now, and passes through Ballard in 8 hours). */
export function parseTrains(j, now = Date.now()) {
  const active = [], upcoming = [];
  for (const list of Object.values(j || {})) {
    for (const t of Array.isArray(list) ? list : []) {
      if (!t || !/Cascades|Empire Builder/i.test(t.routeName || '')) continue;
      const stations = (t.stations || []).map(stationTimes);
      if (!stations.some((s) => s.code === 'SEA') || !stations.some((s) => NORTH.has(s.code))) continue; // not via Ballard
      const pass = ballardPass(stations);
      const lat = +t.lat, lon = +t.lon;
      const row = {
        id: String(t.trainID || `${t.trainNum}`), num: String(t.trainNum), route: t.routeName, state: t.trainState || null,
        lat: isNum(lat) ? round(lat, 6) : null, lon: isNum(lon) ? round(lon, 6) : null, heading: t.heading || null,
        speedMph: isNum(t.velocity) ? round(t.velocity, 1) : null, updated: ts(t.lastValTS), origin: { code: t.origCode, name: t.origName },
        dest: { code: t.destCode, name: t.destName }, next: t.eventCode || null, pass, stations: stations.filter((s) => s.code === 'SEA' || s.code === 'EDM' || NORTH.has(s.code) || s.code === t.origCode || s.code === t.destCode),
      };
      if (isNum(lat) && lat >= CORRIDOR.s && lat <= CORRIDOR.n && lon >= CORRIDOR.w && lon <= CORRIDOR.e && t.trainState === 'Active') active.push(row);
      else if (pass && pass.t > now - 2 * MIN && pass.t < now + 8 * 60 * MIN) upcoming.push({ id: row.id, num: row.num, route: row.route, pass, origin: row.origin, dest: row.dest, state: row.state });
    }
  }
  upcoming.sort((a, b) => a.pass.t - b.pass.t);
  return { t: now, trains: active, upcoming: upcoming.slice(0, 8) };
}

async function fetchTrains() {
  return parseTrains(await get(AMTRAKER, { timeout: 20000 }), Date.now());
}

// =================================================================== satellites
const CELESTRAK = (group) => `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;
// ISS, Tiangong, Hubble: the ones worth stepping outside for (tle.ivanstanojevic.me relays CelesTrak's sets).
const FALLBACK = [[25544, 'Space stations'], [48274, 'Space stations'], [20580, 'Brightest satellites']];

/** Pure: CelesTrak 3-line TLE text -> [{ name, id, l1, l2 }]. */
export function parseTle(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const out = [];
  for (let i = 0; i + 2 < lines.length + 0; i++) {
    if (lines[i + 1] && lines[i + 1].startsWith('1 ') && lines[i + 2] && lines[i + 2].startsWith('2 ')) {
      out.push({ name: lines[i].trim(), id: +lines[i + 1].slice(2, 7), l1: lines[i + 1], l2: lines[i + 2] });
      i += 2;
    }
  }
  return out;
}

async function fetchSatellites({ prev } = {}) {
  const groups = { stations: 'Space stations', visual: 'Brightest satellites' };
  const sats = new Map();
  const errors = [];
  for (const [g, label] of Object.entries(groups)) {
    try {
      for (const s of parseTle(await get(CELESTRAK(g), { as: 'text', timeout: 45000, retries: 0 }))) if (!sats.has(s.id)) sats.set(s.id, { ...s, group: label });
    } catch (e) { errors.push(`${g}: ${e.message}`); }
  }
  if (!sats.size) {
    // CelesTrak often refuses cloud egress: fall back to single-object lookups for the objects people look for.
    for (const [id, group] of FALLBACK) {
      try {
        const j = await get(`https://tle.ivanstanojevic.me/api/tle/${id}`, { timeout: 12000, retries: 0 });
        if (j && j.line1 && j.line2) sats.set(id, { name: j.name, id, l1: j.line1, l2: j.line2, group });
      } catch (e) { errors.push(`tle api ${id}: ${e.message}`); }
    }
  }
  if (!sats.size) {
    if (prev && Array.isArray(prev.sats) && prev.sats.length) return { ...prev, warnings: [`kept previous element sets (${errors.join('; ')})`] };
    throw new Error(`CelesTrak unavailable: ${errors.join('; ')}`);
  }
  const out = { t: Date.now(), observer: { lat: CENTER.lat, lon: CENTER.lon }, sats: [...sats.values()] };
  if (errors.length) out.warnings = errors;
  return out;
}

export default [
  { id: 'buses', title: 'Buses around Ballard (King County Metro GTFS-rt)', ttl: 10, idleTtl: 600, persist: false, fetch: fetchBuses,
    metrics: (d) => ({ 'buses.count': d && Array.isArray(d.vehicles) ? d.vehicles.length : null }) },
  { id: 'trains', title: 'Amtrak trains through Ballard (Amtraker)', ttl: 60, idleTtl: 900, persist: false, fetch: fetchTrains },
  { id: 'satellites', title: 'Satellites (CelesTrak)', ttl: 6 * 3600, idleTtl: 12 * 3600, daily: false, deadlineMs: 100000, fetch: fetchSatellites },
];
