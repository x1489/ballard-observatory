// group `move`: transit, traffic & getting around. See CONTRACT.md and tools/research-move.md.
import {
  get, limiter, sleep, fromPacific, haversineKm, inBbox, fixMojibake, round,
} from '../lib.mjs';

// ---------------------------------------------------------------------------
// OneBusAway (Puget Sound, shared TEST key): ONE serial queue for every call.
// ---------------------------------------------------------------------------
const OBA = 'https://api.pugetsound.onebusaway.org/api/where';
const obaQueue = limiter(1600); // >= 1500 ms between request starts, across transit + vehicles

// deadline (epoch ms): stop retrying past it so a source never blows the server's 45 s fetch deadline.
async function oba(path, params = '', deadline = Date.now() + 35000) {
  const url = `${OBA}/${path}?key=TEST${params ? '&' + params : ''}`;
  let lastErr;
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt && Date.now() > deadline) break;
    try {
      const j = await obaQueue(() => get(url, { retries: 0, timeout: 12000 }));
      // OBA sometimes reports errors inside a 200 body ({code: 429, text: 'rate limit exceeded'}).
      if (j && j.code != null && j.code !== 200) {
        const e = new Error(`OBA ${j.code}: ${j.text || 'error'}`);
        e.status = j.code;
        throw e;
      }
      if (!j || !j.data) throw new Error('OBA: response has no data');
      return j;
    } catch (e) {
      lastErr = e;
      const retryable = e.status === 429 || e.status >= 500 || !e.status;
      const backoff = 2000 + Math.random() * 2000; // 2-4 s, slept outside the queue
      if (attempt < 3 && retryable && Date.now() + backoff < deadline) {
        await sleep(backoff);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

const ROUTE_ORDER = ['D Line', '40', '44', '17', '28'];
const PRIMARY_STOPS = ['1_13721', '1_14230', '1_18120', '1_18740', '1_18145', '1_18720', '1_29215', '1_29700'];
const isPlaceholderVehicle = (v) => typeof v === 'string' && /^1_\d{7,}$/.test(v);

// Known KCM destinations (headsigns are "<destination> <via>"), longest match first.
const DESTS = [
  [/^downtown seattle\b/i, 'Downtown'], [/^downtown\b/i, 'Downtown'],
  [/^university of washington medical center\b/i, 'UW Medical Center'], [/^uw medical center\b/i, 'UW Medical Center'],
  [/^university district\b/i, 'U District'], [/^u-district\b/i, 'U District'],
  [/^northgate\b/i, 'Northgate'], [/^crown hill\b/i, 'Crown Hill'], [/^ballard\b/i, 'Ballard'],
  [/^loyal heights\b/i, 'Loyal Heights'], [/^broadview\b/i, 'Broadview'], [/^greenwood\b/i, 'Greenwood'],
  [/^fremont\b/i, 'Fremont'], [/^wallingford\b/i, 'Wallingford'], [/^aurora village\b/i, 'Aurora Village'],
  [/^shoreline\b/i, 'Shoreline'], [/^lake city\b/i, 'Lake City'], [/^magnolia\b/i, 'Magnolia'],
  [/^uptown\b/i, 'Uptown'], [/^seattle center\b/i, 'Seattle Center'], [/^interbay\b/i, 'Interbay'],
  [/^roosevelt\b/i, 'Roosevelt'], [/^green lake\b/i, 'Green Lake'], [/^capitol hill\b/i, 'Capitol Hill'],
  [/^south lake union\b/i, 'South Lake Union'], [/^sunset hill\b/i, 'Sunset Hill'], [/^phinney\b/i, 'Phinney Ridge'],
];

// Output headsign: upstream text, whitespace-normalized only.
const cleanHeadsign = (h) => String(h || '').replace(/\s+/g, ' ').trim();
// For the fallback `dir` label only.
const tidyHeadsign = (h) => cleanHeadsign(h).replace(/\bOf\b/g, 'of').replace(/\bTransit Center\b/g, 'TC');

function dirLabel(headsign) {
  const h = tidyHeadsign(headsign);
  for (const [re, label] of DESTS) if (re.test(h)) return `to ${label}`;
  return h ? `to ${h}` : '';
}

function routeRank(name) {
  const i = ROUTE_ORDER.indexOf(name);
  return i >= 0 ? i : ROUTE_ORDER.length;
}

function compareRouteNames(a, b) {
  const ra = routeRank(a), rb = routeRank(b);
  if (ra !== rb) return ra - rb;
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(a).localeCompare(String(b));
}

const val = (x) => (x && typeof x === 'object' ? x.value ?? null : x ?? null);

function normArrival(a, now) {
  const predT = a.predictedArrivalTime || a.predictedDepartureTime || 0;
  const schedT = a.scheduledArrivalTime || a.scheduledDepartureTime || 0;
  const predicted = !!a.predicted && predT > 0;
  const t = predicted ? predT : schedT;
  if (!t) return null;
  const vehicleId = a.vehicleId || null;
  // Stop-level deviation. tripStatus.scheduleDeviation describes the vehicle's *active* trip,
  // which is the previous trip on the block when the bus has not started this one yet.
  const deviationSec = predicted && schedT ? Math.round((predT - schedT) / 1000) : null;
  const confidence = isPlaceholderVehicle(vehicleId) && deviationSec === 0 ? 'low' : predicted ? 'live' : 'scheduled';
  return {
    t,
    predicted,
    min: round((t - now) / 60000, 1),
    vehicleId,
    stopsAway: predicted && Number.isFinite(a.numberOfStopsAway) ? a.numberOfStopsAway : null,
    distM: predicted && Number.isFinite(a.distanceFromStop) ? Math.round(a.distanceFromStop) : null,
    occupancy: a.occupancyStatus || null,
    deviationSec,
    confidence,
  };
}

const CONF_RANK = { live: 0, scheduled: 1, low: 2 };

async function fetchTransit() {
  const j = await oba('arrivals-and-departures-for-location.json',
    'lat=47.6680&lon=-122.3805&radius=650&minutesBefore=0&minutesAfter=45', Date.now() + 35000);
  return parseTransit(j, Date.now());
}

/** Pure: OBA arrivals-and-departures-for-location JSON -> `transit` output. `fallbackNow` is used only without currentTime. */
function parseTransit(j, fallbackNow) {
  const now = Number.isFinite(j.currentTime) ? j.currentTime : fallbackNow;
  const entry = j.data.entry || {};
  const refs = j.data.references || {};
  const stops = new Map((refs.stops || []).map((s) => [s.id, s]));
  const routes = new Map((refs.routes || []).map((r) => [r.id, r]));
  const warnings = [];
  const list = Array.isArray(entry.arrivalsAndDepartures) ? entry.arrivalsAndDepartures : [];
  if (entry.limitExceeded) warnings.push('OBA limitExceeded: some stops may be missing');

  // Headsigns change along a route (40 'Northgate Station Ballard' -> 'Northgate Station' after
  // Market St; D Line 'Ballard' -> 'Crown Hill'), so union (route, headsign) keys that share a
  // trip. Each resulting cluster is one direction of travel -> one group at its primary stop.
  const parent = new Map();
  const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  const tripKey = new Map();
  const rows = [];
  for (const a of list) {
    try {
      if (!a || !a.routeId || !a.stopId || !a.tripId) continue;
      const hk = `${a.routeId}\u0001${a.tripHeadsign || ''}`;
      if (!parent.has(hk)) parent.set(hk, hk);
      const tk = `${a.routeId}\u0001${a.tripId}\u0001${a.serviceDate || ''}`;
      if (tripKey.has(tk)) union(tripKey.get(tk), hk); else tripKey.set(tk, hk);
      rows.push({ a, hk, tk });
    } catch { /* skip bad row */ }
  }
  const clusters = new Map();
  for (const r of rows) {
    const c = find(r.hk);
    if (!clusters.has(c)) clusters.set(c, []);
    clusters.get(c).push(r);
  }

  const groups = [];
  for (const members of clusters.values()) {
    try {
      const stopIds = [...new Set(members.map((r) => r.a.stopId))];
      let primary = PRIMARY_STOPS.find((id) => stopIds.includes(id));
      if (!primary) {
        let best = Infinity;
        for (const id of stopIds) {
          const s = stops.get(id);
          const d = s ? haversineKm(s.lat, s.lon) : Infinity;
          if (d < best || !primary) { best = d; primary = id; }
        }
      }
      // Dedupe the same trip at the primary stop (duplicate stopIds, placeholder vehicle doubles).
      const byTrip = new Map();
      for (const r of members) {
        if (r.a.stopId !== primary) continue;
        const n = normArrival(r.a, now);
        if (!n || n.t < now - 30000) continue;
        const cur = byTrip.get(r.tk);
        if (!cur || CONF_RANK[n.confidence] < CONF_RANK[cur.n.confidence]) byTrip.set(r.tk, { n, a: r.a });
      }
      const picked = [...byTrip.values()].sort((x, y) => x.n.t - y.n.t).slice(0, 4);
      if (!picked.length) continue;
      const first = picked[0].a;
      const route = routes.get(first.routeId);
      const stop = stops.get(primary) || {};
      const headsign = cleanHeadsign(first.tripHeadsign);
      groups.push({
        route: first.routeShortName || (route && (route.shortName || route.longName)) || first.routeId,
        routeId: first.routeId,
        headsign,
        dir: dirLabel(first.tripHeadsign || ''),
        stopId: primary,
        stopName: stop.name || null,
        stopDir: stop.direction || null,
        arrivals: picked.map((p) => p.n),
      });
    } catch (e) {
      warnings.push(`group skipped: ${e.message}`);
    }
  }
  groups.sort((x, y) => compareRouteNames(x.route, y.route) || x.headsign.localeCompare(y.headsign));

  const situations = [];
  for (const s of refs.situations || []) {
    try {
      const rs = new Set();
      for (const af of s.allAffects || s.affects || []) {
        const r = af && af.routeId && routes.get(af.routeId);
        if (r) rs.add(r.shortName || r.id);
      }
      situations.push({
        id: s.id,
        summary: val(s.summary) || '',
        description: val(s.description) || null,
        severity: s.severity || null,
        routes: [...rs].sort(compareRouteNames),
      });
    } catch { /* skip */ }
  }

  const out = { now, groups, situations };
  if (warnings.length) out.warnings = warnings;
  return out;
}

// ---------------------------------------------------------------------------
// vehicles: trips-for-route for D Line, 40, 44
// ---------------------------------------------------------------------------
const VEHICLE_ROUTES = [['1_102581', 'D Line'], ['1_102574', '40'], ['1_100224', '44']];

async function fetchVehicles({ prev } = {}) {
  const vehicles = [];
  const warnings = [];
  const failed = [];
  let okCount = 0;
  const deadline = Date.now() + 35000; // shared across the three sequential calls
  for (const [routeId, name] of VEHICLE_ROUTES) {
    let j;
    try {
      j = await oba(`trips-for-route/${routeId}.json`, 'includeStatus=true&includeSchedule=false', deadline);
      okCount++;
    } catch (e) {
      warnings.push(`${name}: ${e.message}`);
      failed.push(name);
      continue;
    }
    vehicles.push(...parseTripsForRoute(j, routeId, name));
  }
  if (!okCount) throw new Error(`all trips-for-route calls failed: ${warnings.join('; ')}`);
  // A route that failed this round (usually a TEST-key 429) keeps its recent positions from the
  // last good result instead of vanishing from the map; each still carries its own old `t`.
  if (failed.length && prev && Array.isArray(prev.vehicles)) {
    const carried = carriedVehicles(prev, failed, Date.now());
    if (carried.length) {
      vehicles.push(...carried);
      warnings.push(`kept ${carried.length} previous position(s) for ${failed.join(', ')}`);
    }
  }
  const out = { vehicles };
  if (warnings.length) out.warnings = warnings;
  return out;
}

/** Pure: previous `vehicles` rows to keep for routes whose call failed this round (fixes < 5 min old). */
function carriedVehicles(prev, failed, now) {
  return prev.vehicles.filter((v) => failed.includes(v.route) && Number.isFinite(v.t) && now - v.t < 5 * 60000);
}

/** Pure: one OBA trips-for-route JSON -> that route's `vehicles` rows (one per active trip). */
function parseTripsForRoute(j, routeId, name) {
  const trips = new Map(((j.data.references || {}).trips || []).map((t) => [t.id, t]));
  const byTrip = new Map();
  for (const item of j.data.list || []) {
    try {
      const s = item.status;
      if (!s || !s.vehicleId || !s.position) continue;
      // Skip OBA's 7+ digit placeholder vehicles (schedule-only, parked at a terminal) and anything
      // without a real GPS fix: no lastKnownLocation or no lastLocationUpdateTime (0 = never).
      if (isPlaceholderVehicle(s.vehicleId)) continue;
      const fix = s.lastKnownLocation;
      if (!fix || !Number.isFinite(+fix.lat) || !Number.isFinite(+fix.lon) || (+fix.lat === 0 && +fix.lon === 0)) continue;
      if (!Number.isFinite(s.lastLocationUpdateTime) || s.lastLocationUpdateTime <= 0) continue;
      const trip = trips.get(s.activeTripId);
      if (!trip || trip.routeId !== routeId) continue; // interlined blocks (E Line, 70, 45...)
      const lat = +s.position.lat, lon = +s.position.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
      if (haversineKm(lat, lon) > 6) continue;
      // OBA orientation: 0 = east, 90 = north (counterclockwise). Convert to compass bearing.
      const heading = Number.isFinite(s.orientation) ? ((Math.round(450 - s.orientation) % 360) + 360) % 360 : null;
      const v = {
        route: name,
        headsign: cleanHeadsign(trip.tripHeadsign),
        vehicleId: s.vehicleId,
        lat: round(lat, 5),
        lon: round(lon, 5),
        heading,
        deviationSec: s.predicted && Number.isFinite(s.scheduleDeviation) ? Math.round(s.scheduleDeviation) : null,
        t: s.lastLocationUpdateTime, // the GPS fix time; lastUpdateTime advances even without a fix
      };
      // One vehicle per trip.
      if (!byTrip.has(s.activeTripId)) byTrip.set(s.activeTripId, v);
    } catch { /* skip bad row */ }
  }
  return [...byTrip.values()];
}

// ---------------------------------------------------------------------------
// metro-alerts: KCM GTFS-rt alerts (JSON)
// ---------------------------------------------------------------------------
const KCM_ROUTES = { 102581: 'D Line', 102574: '40', 100224: '44', 100062: '17', 100169: '28' };
const BALLARD_STOPS = new Set([
  '13721', '14230', '13760', '14200', '18120', '18740', '18145', '18720', '29215', '29700',
  '18090', '18770', '28210', '28470', '17951', '35530',
  // other stops the OBA 650 m location query returns around Market St / 15th / 24th / Leary
  '13700', '14250', '18151', '18152', '18165', '18696', '19340', '19360', '19510', '19530', '29213', '29720',
]);
const SEV_RANK = { SEVERE: 0, WARNING: 1, INFO: 2, UNKNOWN_SEVERITY: 3 };

function tr(ts) {
  const list = ts && Array.isArray(ts.translation) ? ts.translation : [];
  const t = list.find((x) => !x.language || /^en/i.test(x.language)) || list[0];
  return t && t.text ? String(t.text).replace(/\r\n?/g, '\n').trim() : null;
}

async function fetchMetroAlerts() {
  return parseMetroAlerts(await get('https://s3.amazonaws.com/kcm-alerts-realtime-prod/alerts_enhanced.json', { timeout: 20000 }), Date.now());
}

/** Pure: KCM alerts_enhanced.json -> `metro-alerts` output (active now or starting within 7 days of `now`). */
function parseMetroAlerts(j, now) {
  const entities = Array.isArray(j && j.entity) ? j.entity : null;
  if (!entities) throw new Error('KCM alerts: no entity array');
  const nowS = now / 1000;
  const horizon = nowS + 7 * 86400;
  const alerts = [];
  for (const e of entities) {
    try {
      const a = e.alert;
      if (!a) continue;
      const routes = new Set();
      const stopsHit = new Set();
      for (const ie of a.informed_entity || []) {
        const rid = ie.route_id != null ? String(ie.route_id).replace(/^1_/, '') : null;
        const sid = ie.stop_id != null ? String(ie.stop_id).replace(/^1_/, '') : null;
        if (rid && KCM_ROUTES[rid]) routes.add(KCM_ROUTES[rid]);
        if (sid && BALLARD_STOPS.has(sid)) stopsHit.add(sid);
      }
      if (!routes.size && !stopsHit.size) continue;
      // Pick the period covering now, else the earliest one starting within 7 days.
      const periods = Array.isArray(a.active_period) && a.active_period.length ? a.active_period : [{}];
      let period = null;
      for (const p of periods) {
        const s = +p.start || 0, en = +p.end || 0;
        if (s <= nowS && (!en || en >= nowS)) { period = p; break; }
      }
      if (!period) {
        const upcoming = periods.filter((p) => +p.start > nowS && +p.start <= horizon).sort((x, y) => x.start - y.start);
        period = upcoming[0] || null;
      }
      if (!period) continue;
      alerts.push({
        id: String(e.id),
        header: tr(a.header_text) || tr(a.short_header_text) || tr(a.service_effect_text) || '',
        description: tr(a.description_text),
        effect: a.effect || 'UNKNOWN_EFFECT',
        severity: a.severity_level || null,
        start: +period.start ? +period.start * 1000 : null,
        end: +period.end ? +period.end * 1000 : null,
        routes: [...routes].sort(compareRouteNames),
        stops: [...stopsHit],
        url: tr(a.url),
      });
    } catch { /* skip bad entity */ }
  }
  alerts.sort((x, y) => (SEV_RANK[x.severity] ?? 3) - (SEV_RANK[y.severity] ?? 3) || (x.start || 0) - (y.start || 0));
  return { alerts, total: entities.length };
}

// ---------------------------------------------------------------------------
// cameras: SDOT traffic cameras (HEAD each)
// ---------------------------------------------------------------------------
const CAM_BASE = 'https://www.seattle.gov/trafficcams/images/';
const CAMERAS = [
  ['CMR-0011', '15th Ave NW & NW Market St', 47.66851, -122.37621, '15_NW_Market_1.jpg'],
  ['CMR-0322', '24th Ave NW & NW Market St', 47.66868, -122.38758, '24_NW_Market_EW.jpg'],
  ['CMR-0009', '15th Ave NW & NW Leary Way', 47.66365, -122.37530, '15_NW_Leary_EW.jpg'],
  ['CMR-0390', '15th Ave W & W Nickerson St (Ballard Bridge south approach)', 47.65347, -122.37618, '15_W_Nickerson.jpg'],
  ['CMR-0013', '15th Ave W & W Emerson St', 47.65389, -122.37626, '15_W_Emerson_NS.jpg'],
  ['CMR-0253', 'Leary Way NW & NW 43rd St', 47.65894, -122.36472, 'Leary_NW_43_EW.jpg'],
  ['CMR-0007', '15th Ave NW & NW 65th St', 47.67636, -122.37676, '15_NW_65_1.jpg'],
  ['CMR-0008', '15th Ave NW & NW 85th St', 47.69061, -122.37681, '15_NW_85_NS.jpg'],
];

/** Pure: fold a HEAD response ({ status, redirected, headers.get }) into a camera row (lastModified, ok). */
function applyCameraHead(cam, res, now) {
  const lm = Date.parse(res.headers.get('last-modified') || '');
  cam.lastModified = Number.isFinite(lm) ? lm : null;
  const type = res.headers.get('content-type') || '';
  // SDOT's 352x240 'CAMERA UNDER MAINTENANCE' JPEG (~29.9 KB) is re-stamped every couple of
  // hours, so a fresh Last-Modified alone doesn't prove a live feed. Real frames are 55-150 KB.
  const len = Number(res.headers.get('content-length'));
  const placeholder = Number.isFinite(len) && len > 0 && len < 31000;
  cam.ok = res.status === 200 && !res.redirected && /image\/jpeg/i.test(type) && !placeholder
    && cam.lastModified != null && now - cam.lastModified <= 30 * 60000;
  return cam;
}

async function fetchCameras() {
  let errors = 0;
  const now = Date.now();
  const cameras = await Promise.all(CAMERAS.map(async ([id, label, lat, lon, file]) => {
    const url = CAM_BASE + file;
    const cam = { id, label, lat, lon, url, lastModified: null, ok: false };
    try {
      applyCameraHead(cam, await get(url, { as: 'response', method: 'HEAD', timeout: 8000 }), now);
    } catch {
      errors++;
    }
    return cam;
  }));
  if (errors === CAMERAS.length) throw new Error('all camera HEAD requests failed');
  const out = { cameras };
  if (errors) out.warnings = [`${errors} camera HEAD request(s) failed`];
  return out;
}

// ---------------------------------------------------------------------------
// traffic: SDOT arterial travel times
// ---------------------------------------------------------------------------
const TRAFFIC_SITES = [['1991', '15th Ave NW & NW 61st St'], ['1990', 'Holman Rd NW & 14th Ave NW']];

/** Pure: one LinksBySiteID response (array, or a JSON string of one) -> a `traffic` site row. */
function parseTrafficSite(arr, id, fallbackName) {
  if (typeof arr === 'string') arr = JSON.parse(arr);
  if (!Array.isArray(arr)) throw new Error('not an array');
  const links = [];
  let name = fallbackName;
  for (const l of arr) {
    if (!l || !l.LinkDisplayName) continue;
    if (l.SrcSiteName) name = String(l.SrcSiteName).trim();
    const v = Number(l.Value);
    const minutes = Number(l.Status) !== 1 || !Number.isFinite(v) ? null : v < 30 ? 1 : Math.round(v / 60);
    links.push({ name: String(l.LinkDisplayName).trim(), minutes });
  }
  links.sort((a, b) => (b.name === 'DOWNTOWN') - (a.name === 'DOWNTOWN'));
  return { id, name, links };
}

async function fetchTraffic() {
  const warnings = [];
  const results = await Promise.all(TRAFFIC_SITES.map(async ([id, fallbackName]) => {
    try {
      return parseTrafficSite(await get(`https://web.seattle.gov/Travelers/api/Map/LinksBySiteID?siteId=${id}`, { timeout: 10000 }), id, fallbackName);
    } catch (e) {
      warnings.push(`site ${id}: ${e.message}`);
      return null;
    }
  }));
  const sites = results.filter(Boolean);
  if (!sites.length) throw new Error(`travel times unavailable: ${warnings.join('; ')}`);
  const out = { sites };
  if (warnings.length) out.warnings = warnings;
  return out;
}

// ---------------------------------------------------------------------------
// incidents: SDOT Travelers (type=1)
// ---------------------------------------------------------------------------
// SDOT text is UTF-8 that was decoded as Windows-1252 ('â€“' = U+00E2 U+20AC U+201C for '–').
// lib's fixMojibake round-trips through latin1, which maps '€'/'“' to the wrong bytes and so
// leaves this unchanged; repair each mojibake run through a cp1252 byte table instead.
const CP1252 = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
const CONT = '\\u0080-\\u00bf' + Object.keys(CP1252).map((c) => '\\u' + (+c).toString(16).padStart(4, '0')).join('');
const MOJIBAKE_RUN = new RegExp(`[\\u00c2-\\u00f4][${CONT}]+`, 'g');
function fixMojibake1252(s) {
  s = fixMojibake(s);
  if (!/[Â-ô]/.test(s)) return s;
  return s.replace(MOJIBAKE_RUN, (run) => {
    const bytes = [...run].map((ch) => { const c = ch.codePointAt(0); return c < 0x100 ? c : CP1252[c]; });
    if (bytes.some((b) => b == null)) return run;
    const out = Buffer.from(bytes).toString('utf8');
    return out.includes('�') ? run : out;
  });
}
async function fetchIncidents() {
  return parseIncidents(await get('https://web.seattle.gov/Travelers/api/Map/Data?zoomId=18&type=1', { timeout: 12000 }));
}

/** Pure: SDOT Map/Data type=1 JSON (or a JSON string of it) -> `incidents` output. */
function parseIncidents(j) {
  if (typeof j === 'string') j = JSON.parse(j);
  const features = Array.isArray(j && j.Features) ? j.Features : null;
  if (!features) throw new Error('SDOT incidents: no Features array');
  let citywide = 0;
  const incidents = [];
  for (const f of features) {
    const pc = Array.isArray(f && f.PointCoordinate) ? f.PointCoordinate : [];
    const lat = +pc[0], lon = +pc[1];
    for (const inc of (f && f.Incidents) || []) {
      citywide++;
      try {
        if (!inBbox(lat, lon, 1.5)) continue;
        const clean = (s) => (s == null ? '' : fixMojibake1252(String(s)).replace(/\s+/g, ' ').trim());
        const from = clean(inc.StartLocationDescription), to = clean(inc.EndLocationDescription);
        incidents.push({
          id: String(inc.Id),
          type: clean(inc.Type) || 'Incident',
          description: clean(inc.Description),
          start: fromPacific(inc.StartDateTime),
          end: fromPacific(inc.EndDateTime),
          direction: clean(inc.Direction) || null,
          location: from && to ? `${from} to ${to}` : from || to || null,
          lat: round(lat, 6),
          lon: round(lon, 6),
          url: clean(inc.Url) || null,
          distKm: round(haversineKm(lat, lon), 2),
        });
      } catch { /* skip bad row */ }
    }
  }
  incidents.sort((a, b) => (b.start || 0) - (a.start || 0));
  return { incidents, citywide };
}

// ---------------------------------------------------------------------------
// lime: GBFS free_bike_status (~3 MB) reduced to Ballard
// ---------------------------------------------------------------------------
const LIME_KIND = { 1: 's', 2: 's', 3: 'e', 4: 'b' };
function limeKind(b) {
  const k = LIME_KIND[b.vehicle_type_id];
  if (k) return k;
  const vt = String(b.vehicle_type || '').toLowerCase();
  if (vt.includes('scooter')) return 's';
  if (vt.includes('e-bike') || vt.includes('electric')) return 'e';
  if (vt.includes('bike') || vt.includes('bicycle')) return 'b';
  return 's';
}

async function fetchLime() {
  return parseLime(await get('https://data.lime.bike/api/partners/v2/gbfs/seattle/free_bike_status', { timeout: 25000 }));
}

/** Pure: Lime GBFS free_bike_status JSON -> `lime` output. */
function parseLime(j) {
  const bikes = j && j.data && Array.isArray(j.data.bikes) ? j.data.bikes : null;
  if (!bikes) throw new Error('Lime GBFS: no data.bikes');
  const near = { total: 0, scooters: 0, ebikes: 0, bikes: 0 };
  const field = { s: 'scooters', e: 'ebikes', b: 'bikes' };
  let inBboxCount = 0;
  const points = [];
  for (const b of bikes) {
    if (!b || b.is_disabled || b.is_reserved) continue;
    const lat = +b.lat, lon = +b.lon;
    if (!inBbox(lat, lon, 1)) continue; // cheap prefilter before haversine
    const kind = limeKind(b);
    if (haversineKm(lat, lon) <= 0.8) { near.total++; near[field[kind]]++; }
    if (inBbox(lat, lon)) {
      inBboxCount++;
      if (points.length < 1000) points.push([round(lat, 5), round(lon, 5), kind]);
    }
  }
  return { t: Number.isFinite(+j.last_updated) ? +j.last_updated * 1000 : null, near, inBbox: inBboxCount, points };
}

// ---------------------------------------------------------------------------
export default [
  { id: 'transit', title: 'Buses near Market St (OneBusAway)', ttl: 45, background: false, fetch: fetchTransit },
  { id: 'vehicles', title: 'Bus positions: D Line, 40, 44', ttl: 90, background: false, fetch: fetchVehicles },
  { id: 'metro-alerts', title: 'King County Metro alerts (Ballard)', ttl: 300, background: false, fetch: fetchMetroAlerts },
  { id: 'cameras', title: 'SDOT traffic cameras', ttl: 120, background: false, fetch: fetchCameras },
  { id: 'traffic', title: 'Travel times to downtown (SDOT)', ttl: 120, background: false, fetch: fetchTraffic },
  { id: 'incidents', title: 'Traffic incidents (SDOT)', ttl: 180, background: false, fetch: fetchIncidents },
  { id: 'lime', title: 'Lime scooters & bikes', ttl: 90, background: false, fetch: fetchLime },
];

// Pure parsers/normalizers, exported for offline tests only (the server uses the default export).
// Each takes the upstream payload (and `now` where the output depends on the clock) and does no I/O.
export const _test = {
  parseTransit, normArrival, dirLabel, compareRouteNames, isPlaceholderVehicle, parseTripsForRoute, carriedVehicles,
  VEHICLE_ROUTES, parseMetroAlerts, CAMERAS, applyCameraHead, parseTrafficSite, TRAFFIC_SITES, parseIncidents,
  fixMojibake1252, limeKind, parseLime,
};

