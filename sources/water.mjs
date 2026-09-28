// Ballard Live: water, tides and the Locks.
// Sources: tides, currents, lake, lockages, stoppages, bridges, bridge-history, salmon, cso.
// Upstream time zones (see tools/research-water.md):
//   NOAA CO-OPS (time_zone=gmt) ....... real UTC, no suffix  -> fromUTC (lst_ldt is ambiguous at fall-back)
//   USACE dataquery (timezone=GMT) ..... real UTC, no suffix -> fromUTC (minus the reported tz_offset)
//   USACE LPMS queue + stoppages ....... Pacific wall-clock (the 'PST'/'PDT' labels are static, not seasonal) -> fromPacific
//   Seattle open data gm8h-9449 ........ floating Pacific    -> fromPacific
//   King County CSO CSV ................ Pacific 'MM/DD/YYYY HH:mm' -> fromPacific
import {
  get, limiter, fromPacific, fromUTC, pacificDate, toPacificFloating,
  parseCSVObjects, stripTags, round, num, readState, writeState,
} from '../lib.mjs';

const HOUR = 3600e3;
const DAY = 24 * HOUR;

/** Epoch ms of local (Pacific) midnight, offsetDays from today. */
const pacificMidnight = (offsetDays = 0, from = Date.now()) => fromPacific(pacificDate(offsetDays, from));
const ddmmyyyy = (offsetDays = 0) => {
  const [y, m, d] = pacificDate(offsetDays).split('-');
  return `${d}${m}${y}`;
};
const errMsg = (e) => String((e && e.message) || e);
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---------------------------------------------------------------- NOAA CO-OPS

const NOAA = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';

// NOAA is queried in GMT, not lst_ldt: on the fall-back day lst_ldt prints only ONE 01:00-01:59 hour
// (the PST one, verified for 2026-11-01), which fromPacific would read as PDT, an hour early.
// GMT times are unambiguous; begin_date is then a GMT 'yyyyMMdd HH:mm'.
const pad2 = (n) => String(n).padStart(2, '0');
const noaaGmt = (t) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
};

async function noaa(params) {
  const qs = new URLSearchParams({ ...params, format: 'json', application: 'ballard_live' });
  const j = await get(`${NOAA}?${qs}`);
  // NOAA reports errors as HTTP 200 with an `error` key.
  if (!j || j.error) {
    const m = j && j.error && (j.error.message || JSON.stringify(j.error));
    throw new Error(`NOAA ${params.station} ${params.product}: ${m || 'empty response'}`);
  }
  return j;
}

/** [{t, v}] (GMT strings, time_zone=gmt) -> [{t, ft}] sorted, bad rows dropped. */
function tidePoints(rows) {
  const out = [];
  for (const r of rows || []) {
    const t = fromUTC(r && r.t);
    const ft = num(r && r.v);
    if (t == null || ft == null) continue;
    out.push({ t, ft: round(ft, 2) });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Linear interpolation of a sorted [{t, ft}] series at time t (null outside the range). */
function interpAt(series, t) {
  if (!series.length || t < series[0].t || t > series[series.length - 1].t) return null;
  let lo = 0, hi = series.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = series[lo], b = series[hi];
  if (a.t === t) return a.ft;
  if (b.t === t) return b.ft;
  return a.ft + ((b.ft - a.ft) * (t - a.t)) / (b.t - a.t);
}

/** Pure: the request windows for `tides` at time `now`. */
function tidesWindow(now) {
  const dayStart = pacificMidnight(0, now);
  const hiloEnd = pacificMidnight(2, now); // 48h window (DST-safe)
  // The dashboard chart spans now-6h .. now+24h and the data can be up to one ttl (30 min) old when drawn.
  // Midnight + 36h alone ends at noon tomorrow (an empty chart tail every afternoon/evening) and starts after
  // now-6h before 6 AM, so the curve covers from min(midnight, now-7h) to max(midnight+36h, now+26h).
  const curveStart = Math.min(dayStart, Math.floor((now - 7 * HOUR) / HOUR) * HOUR);
  const curveHours = Math.ceil((Math.max(dayStart + 36 * HOUR, now + 26 * HOUR) - curveStart) / HOUR);
  return { dayStart, hiloEnd, curveStart, curveHours };
}

async function fetchTides() {
  const now = Date.now();
  const { dayStart, curveStart, curveHours } = tidesWindow(now);
  const common = { datum: 'MLLW', units: 'english', time_zone: 'gmt' };

  const results = await Promise.allSettled([
    // 72h so that `next` always has 4 events late in the day; `hilo` is trimmed to 48h below.
    noaa({ station: '9447265', product: 'predictions', interval: 'hilo', begin_date: noaaGmt(dayStart), range: '72', ...common }),
    noaa({ station: '9447130', product: 'predictions', interval: '6', begin_date: noaaGmt(curveStart), range: String(curveHours), ...common }),
    noaa({ station: '9447130', product: 'water_level', range: '24', ...common }),
  ]);
  return buildTides(results, now);
}

/** Pure: settled [hilo 9447265, 6-min predictions 9447130, water_level 9447130] NOAA JSON -> `tides` output. */
function buildTides([hiloR, curveR, obsR], now) {
  const { dayStart, hiloEnd } = tidesWindow(now);
  const warnings = [];
  let allHilo = [];
  if (hiloR.status === 'fulfilled') {
    for (const r of hiloR.value.predictions || []) {
      const t = fromUTC(r && r.t);
      const ft = num(r && r.v);
      const type = r && (r.type === 'H' || r.type === 'L') ? r.type : null;
      if (t == null || ft == null || !type) continue;
      allHilo.push({ t, ft: round(ft, 2), type });
    }
    allHilo.sort((a, b) => a.t - b.t);
  } else warnings.push(`hilo (9447265): ${errMsg(hiloR.reason)}`);

  let curve = [];
  if (curveR.status === 'fulfilled') curve = tidePoints(curveR.value.predictions);
  else warnings.push(`curve (9447130): ${errMsg(curveR.reason)}`);

  let observed = [];
  if (obsR.status === 'fulfilled') observed = tidePoints(obsR.value.data);
  else warnings.push(`observed (9447130): ${errMsg(obsR.reason)}`);

  if (!allHilo.length && !curve.length && !observed.length) {
    throw new Error(`tides: no usable data (${warnings.join('; ') || 'empty responses'})`);
  }

  const hilo = allHilo.filter((e) => e.t >= dayStart && e.t < hiloEnd);
  const next = allHilo.filter((e) => e.t > now).slice(0, 4);

  let latest = null;
  if (observed.length) {
    const o = observed[observed.length - 1];
    const p = interpAt(curve, o.t);
    latest = { t: o.t, ft: o.ft, predictedFt: p == null ? null : round(p, 2), anomalyFt: p == null ? null : round(o.ft - p, 2) };
  }

  let trend = null;
  const a = interpAt(curve, now), b = interpAt(curve, now + 6 * 60e3);
  if (a != null && b != null && a !== b) trend = b > a ? 'rising' : 'falling';
  else if (next.length) trend = next[0].type === 'H' ? 'rising' : 'falling';
  if (!trend) {
    trend = 'rising';
    warnings.push('trend unknown (no curve or hilo covering now)');
  }

  const out = { station: 'Shilshole Bay (Meadow Point)', hilo, curve, observed, latest, next, trend };
  if (warnings.length) out.warnings = warnings;
  return out;
}

async function fetchCurrents() {
  return parseCurrents(await noaa({
    station: 'PUG1515', bin: '1', product: 'currents_predictions', begin_date: noaaGmt(pacificMidnight(0)), range: '48',
    units: 'english', time_zone: 'gmt', interval: 'MAX_SLACK',
  }));
}

/** Pure: NOAA currents_predictions JSON -> `currents` output. */
function parseCurrents(j) {
  const cp = (j.current_predictions && j.current_predictions.cp) || [];
  const events = [];
  for (const r of cp) {
    const t = fromUTC(r && r.Time); // time_zone=gmt (see noaaGmt)
    const type = String((r && r.Type) || '').toLowerCase();
    if (t == null || !['slack', 'flood', 'ebb'].includes(type)) continue;
    const k = num(r.Velocity_Major);
    events.push({ t, type, knots: k == null ? null : round(k, 2) + 0 }); // +0 turns -0 into 0
  }
  events.sort((a, b) => a.t - b.t);
  if (!events.length) throw new Error('currents: no predictions in response');
  return { station: 'West Point', events };
}

// ---------------------------------------------------------------- USACE lake level

const LAKE_ELEV = 'LWSC.Elev-Lake.Inst.15Minutes.0.IRIDIUM-REV';
const LAKE_FLOW = 'LWSC.Flow.Ave.~1Day.1Day.CENWS-COMPUTED-RAW';

// Same USACE dataquery service on two hosts. www.nwd-wc.usace.army.mil serves an incomplete TLS chain
// (leaf only, no DigiCert intermediate), so Node's fetch rejects it ('unable to verify the first
// certificate'); public.crohms.org serves identical data with a valid chain. nwd-wc stays as a fallback.
const LAKE_HOSTS = ['https://public.crohms.org', 'https://www.nwd-wc.usace.army.mil'];

async function fetchLake() {
  const path = '/dd/common/web_service/webexec/getjson?query='
    + encodeURIComponent(JSON.stringify([LAKE_ELEV, LAKE_FLOW])) + '&backward=3d&timezone=GMT';
  const warnings = [];
  let j = null;
  const errs = [];
  for (const [i, host] of LAKE_HOSTS.entries()) {
    try {
      j = await get(host + path, { timeout: 10000, retries: i === 0 ? 1 : 0 });
      if (j && j.LWSC && j.LWSC.timeseries) break;
      errs.push(`${new URL(host).host}: no LWSC timeseries`);
      j = null;
    } catch (e) {
      errs.push(`${new URL(host).host}: ${errMsg(e)}`);
    }
  }
  if (!j) throw new Error(`lake: ${errs.join('; ')}`);
  if (errs.length) warnings.push(`primary host failed, used fallback (${errs.join('; ')})`);
  return parseLake(j, warnings);
}

/** Pure: USACE dataquery JSON (with LWSC.timeseries) -> `lake` output. `warnings` carries host-fallback notes. */
function parseLake(j, warnings = []) {
  const ts = j.LWSC.timeseries;
  // timezone=GMT gives true UTC ('2026-09-25T02:00:00', no suffix). Without it the service uses fixed PST
  // (UTC-8, no DST). Honor the tz_offset (hours) it reports, so either way the epoch is right.
  const tzOff = finite(j.LWSC.tz_offset) ?? 0;
  const parseT = (s) => { const t = fromUTC(s); return t == null ? null : t - tzOff * HOUR; };

  const pts = [];
  for (const v of (ts[LAKE_ELEV] && ts[LAKE_ELEV].values) || []) {
    if (!Array.isArray(v)) continue;
    const t = parseT(v[0]);
    const ft = finite(v[1]);
    if (t == null || ft == null || ft < 5 || ft > 40) continue; // drop sensor garbage
    pts.push({ t, ft });
  }
  pts.sort((a, b) => a.t - b.t);
  if (!pts.length) throw new Error('lake: no elevation values in response');

  const last = pts[pts.length - 1];
  // Hourly thinning: first reading in each clock hour over the last 48h, plus the latest reading.
  const history = [];
  let lastHour = null;
  for (const p of pts) {
    if (p.t < last.t - 48 * HOUR) continue;
    const h = Math.floor(p.t / HOUR);
    if (h === lastHour) continue;
    lastHour = h;
    history.push({ t: p.t, ft: round(p.ft, 2) });
  }
  if (history[history.length - 1].t !== last.t) history.push({ t: last.t, ft: round(last.ft, 2) });

  let outflowCfs = null, outflowT = null;
  const flows = ((ts[LAKE_FLOW] && ts[LAKE_FLOW].values) || [])
    .map((v) => (Array.isArray(v) ? { t: parseT(v[0]), cfs: finite(v[1]) } : null))
    .filter((f) => f && f.t != null && f.cfs != null)
    .sort((a, b) => a.t - b.t);
  if (flows.length) {
    outflowCfs = round(flows[flows.length - 1].cfs, 0);
    // The daily average is stamped at the END of its day (2026-09-24T07:00Z = the average for Sep 23 PDT).
    // Report the start of the averaged day: the Pacific midnight of the date 12 h before the stamp.
    outflowT = fromPacific(pacificDate(0, flows[flows.length - 1].t - 12 * HOUR));
  } else warnings.push('no daily outflow value in the last 3 days');

  const out = { t: last.t, ft: round(last.ft, 2), history, outflowCfs, outflowT };
  if (warnings.length) out.warnings = warnings;
  return out;
}

// ---------------------------------------------------------------- USACE LPMS (5 req/min per IP, shared)

const lpmsLimit = limiter(15000);

async function lpms(url) {
  // No retry on 429: a retry would just burn another request against the per-minute quota.
  const j = await lpmsLimit(() => get(url, { timeout: 12000, retryOn: [500, 502, 503, 504] }));
  if (j && !Array.isArray(j) && j.error) throw new Error(`LPMS: ${j.error}`);
  return j;
}

const REC_NO = new Set(['9999999', 'U999999', 'D999999']);
const GOV_NO = /^[GSR]222222$/;
function isCommercial(name, no) {
  if (REC_NO.has(no) || /^REC(REATIONAL)?\b/i.test(name)) return false;
  if (GOV_NO.test(no) || /\b(FED VESSELS|STATE OR CITY|RESEARCH VESSELS|POLICE|FIREBOAT)\b/i.test(name)) return false;
  return true;
}

async function fetchLockages() {
  return parseLockages(await lpms('https://ndc.ops.usace.army.mil/ords/lpms/json/lock_queue_json?in_river=WS&in_lock=01'), Date.now());
}

/** Pure: LPMS lock_queue_json rows -> `lockages` output ("today" is the Pacific date of `now`). */
function parseLockages(rows, now) {
  if (!Array.isArray(rows)) throw new Error('LPMS lock queue: unexpected response shape');
  // The queue always holds several days of Chittenden lockages (~1000 rows). A bare [] is an upstream glitch
  // (seen live 2026-09-24 21:08 PDT, fine again a minute later); returning it would show "0 lockages today"
  // as fresh data, so throw and keep serving the last good result.
  if (!rows.length) throw new Error('LPMS lock queue: empty response');

  const all = [];
  for (const r of rows) {
    try {
      if (!r || typeof r !== 'object') continue;
      const direction = r.direction === 'U' ? 'up' : r.direction === 'D' ? 'down' : null;
      const arrival = fromPacific(r.arrivalDate);
      if (!direction || arrival == null) continue;
      const start = fromPacific(r.SOLdate);
      const end = fromPacific(r.endOfLockage);
      const name = String(r.vesselName || '').trim() || 'UNKNOWN VESSEL';
      const no = String(r.vesselNo || '').trim();
      const wait = start != null ? (start - arrival) / 60e3 : null;
      const mmsi = num(r.MMSI);
      all.push({
        name, direction, arrival, start, end,
        waitMin: wait != null && wait >= 0 && wait < 24 * 60 ? round(wait, 0) : null,
        commercial: isCommercial(name, no),
        mmsi: mmsi != null && mmsi > 0 ? mmsi : null,
      });
    } catch { /* skip malformed row */ }
  }
  if (!all.length) throw new Error('LPMS lock queue: no parseable rows');
  all.sort((a, b) => b.arrival - a.arrival);

  const d0 = pacificMidnight(0, now), d1 = pacificMidnight(1, now);
  const todayRows = all.filter((r) => r.arrival >= d0 && r.arrival < d1);
  const waits = todayRows.map((r) => r.waitMin).filter((w) => w != null);
  const ends = all.map((r) => r.end).filter((e) => e != null);

  return {
    recent: all.slice(0, 30),
    today: {
      up: todayRows.filter((r) => r.direction === 'up').length,
      down: todayRows.filter((r) => r.direction === 'down').length,
      total: todayRows.length,
      commercial: todayRows.filter((r) => r.commercial).length,
    },
    queued: all.filter((r) => r.end == null && r.arrival >= now - 3 * HOUR && r.arrival <= now + 15 * 60e3).length,
    avgWaitMin: waits.length ? round(waits.reduce((s, w) => s + w, 0) / waits.length, 1) : null,
    lastEnd: ends.length ? Math.max(...ends) : null,
  };
}

async function fetchStoppages() {
  // Window: 8 days back (for `recent`) to ~4 months ahead (for scheduled closures). Must be < 6 months.
  // The API returns every stoppage overlapping the window, nationwide (~40 KB); keep Seattle (WS) only.
  const url = `https://ndc.ops.usace.army.mil/ords/lpms/stall_stoppage_json?begin_date=${ddmmyyyy(-8)}&end_date=${ddmmyyyy(120)}`;
  const rows = await lpms(url);
  if (!Array.isArray(rows)) {
    throw new Error(`LPMS stoppages: unexpected response ${typeof rows === 'string' ? rows.slice(0, 80) : typeof rows}`);
  }
  // Nationwide over ~4 months this is never empty; [] means an upstream glitch, not "no closures at the Locks".
  if (!rows.length) throw new Error('LPMS stoppages: empty response');
  return parseStoppages(rows, Date.now());
}

function parseStoppages(rows, now) {
  const active = [], upcoming = [], recent = [];
  for (const r of rows) {
    try {
      if (!r || r.riverCode !== 'WS') continue;
      // 'MM/DD/YYYY HH:mm:ss PDT': wall-clock Pacific; the zone label is static, so ignore it.
      const begin = fromPacific(r.beginStopDate);
      if (begin == null) continue;
      const end = fromPacific(r.endStopDate); // ' PDT' (blank) -> null = open-ended
      const s = {
        chamber: num(r.chamberNumber),
        begin, end,
        reason: String(r.reasonCode || '').trim() || 'Unspecified',
        scheduled: /^y/i.test(String(r.isScheduled || '')),
        trafficStopped: /^y/i.test(String(r.trafficStopped || '')),
      };
      if (begin > now) upcoming.push(s);
      else if (end == null || end > now) active.push(s);
      else if (end >= now - 7 * DAY) recent.push(s);
    } catch { /* skip malformed row */ }
  }
  active.sort((a, b) => a.begin - b.begin);
  upcoming.sort((a, b) => a.begin - b.begin);
  recent.sort((a, b) => b.end - a.end);
  return { active, upcoming, recent };
}

// ---------------------------------------------------------------- SDOT live bridges

const BRIDGE_STATE_FILE = 'bridges.json';
const BRIDGE_GAP_MS = 5 * 60e3;   // longer than this without a successful poll => continuity lost
const BRIDGE_MERGE_MS = 90e3;     // an up->down->up blip shorter than this is one opening
const BRIDGE_LOG_KEEP = 200;

function loadBridgeState() {
  const s = readState(BRIDGE_STATE_FILE, null);
  if (s && typeof s === 'object' && s.bridges && typeof s.bridges === 'object' && Array.isArray(s.log)) {
    const log = s.log.filter((e) => e && typeof e.bridge === 'string' && finite(e.upAt) != null);
    return { observingSince: finite(s.observingSince), lastPoll: finite(s.lastPoll) || 0, bridges: s.bridges, log };
  }
  return { observingSince: null, lastPoll: 0, bridges: {}, log: [] };
}
const bst = loadBridgeState();

async function fetchBridges() {
  const arr = parseBridgeBody(await get('https://web.seattle.gov/Travelers/api/Map/GetBridgeData', { as: 'text', timeout: 10000 }));
  const out = observeBridges(bst, arr, Date.now());
  writeState(BRIDGE_STATE_FILE, bst);
  return out;
}

/** Pure: GetBridgeData body text (double-encoded JSON) -> the bridge array (throws on bad/empty). */
function parseBridgeBody(text) {
  let arr;
  try {
    arr = JSON.parse(text);
    if (typeof arr === 'string') arr = JSON.parse(arr); // body is double-encoded JSON
  } catch {
    throw new Error(`bridges: bad JSON: ${String(text).slice(0, 80)}`);
  }
  if (!Array.isArray(arr) || !arr.length) throw new Error('bridges: empty bridge list');
  return arr;
}

/** Fold one poll of the SDOT feed into `state` (mutated) and build the output. */
function observeBridges(state, arr, now) {
  const continuous = state.lastPoll > 0 && now - state.lastPoll <= BRIDGE_GAP_MS;
  const tt = continuous ? Math.round((state.lastPoll + now) / 2) : now; // best estimate of the transition time
  if (!continuous || state.observingSince == null) state.observingSince = now;

  const bridges = [];
  for (const b of arr) {
    if (!b || b.BridgeID == null) continue;
    const id = num(b.BridgeID);
    const key = String(b.BridgeID);
    const name = String(b.DisplayName || b.Name || `Bridge ${b.BridgeID}`).trim();
    const up = String(b.Status || '').trim() !== 'Closed'; // 'Closed' = down (open to cars)
    const prev = state.bridges[key];

    if (!prev) {
      state.bridges[key] = { up, since: null, sinceKnown: false };
    } else if (!continuous) {
      // We were not watching: the state may have changed any number of times.
      state.bridges[key] = { up, since: null, sinceKnown: false };
      state.log = state.log.filter((e) => !(e.bridge === name && e.downAt == null)); // its end is unknowable
    } else if (prev.up !== up) {
      const last = state.log.find((e) => e.bridge === name); // log is newest first
      if (up) {
        if (last && last.downAt != null && tt - last.downAt <= BRIDGE_MERGE_MS) {
          // down->up blip right after an opening ended: same opening, reopen it
          last.downAt = null;
          last.minutes = null;
          state.bridges[key] = { up, since: last.upAt, sinceKnown: true };
        } else {
          state.log.unshift({ bridge: name, upAt: tt, downAt: null, minutes: null });
          state.bridges[key] = { up, since: tt, sinceKnown: true };
        }
      } else {
        if (last && last.downAt == null) {
          last.downAt = tt;
          last.minutes = round((tt - last.upAt) / 60e3, 1);
        } // else: it was already up when we started watching, so upAt is unknown; not logged
        state.bridges[key] = { up, since: tt, sinceKnown: true };
      }
    }
    const st = state.bridges[key];
    bridges.push({
      id, name, lat: num(b.Latitude), lon: num(b.Longitude), up,
      since: st.sinceKnown ? st.since : null, sinceKnown: !!st.sinceKnown,
    });
  }
  if (!bridges.length) throw new Error('bridges: no usable rows');

  state.lastPoll = now;
  state.log.sort((a, b) => b.upAt - a.upAt);
  if (state.log.length > BRIDGE_LOG_KEEP) state.log.length = BRIDGE_LOG_KEEP;

  const rank = (b) => (b.id === 2 ? 0 : b.id === 3 ? 1 : 2);
  bridges.sort((a, b) => rank(a) - rank(b)); // stable sort: the rest keep feed order
  return {
    bridges,
    log: state.log.slice(0, 50).map((e) => ({ bridge: e.bridge, upAt: e.upAt, downAt: e.downAt ?? null, minutes: e.minutes ?? null })),
    observingSince: state.observingSince,
  };
}

// ---------------------------------------------------------------- Seattle open data: bridge openings

async function fetchBridgeHistory() {
  const since = toPacificFloating(Date.now() - 9 * DAY); // dataset lags ~1 day; 9 days covers 7 days back from `newest`
  const params = {
    $select: 'entityname,opendatetime,closedatetime,minutesopen',
    $where: `entityname in('Ballard','Fremont') AND opendatetime >= '${since}'`,
    $order: 'opendatetime DESC',
    $limit: '1000',
  };
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return parseBridgeHistory(await get(`https://data.seattle.gov/resource/gm8h-9449.json?${qs}`));
}

/** Pure: gm8h-9449 rows -> `bridge-history` output (windows are relative to the newest opening, not now). */
function parseBridgeHistory(rows) {
  if (!Array.isArray(rows)) throw new Error('bridge-history: unexpected response');

  const all = [];
  for (const r of rows) {
    const bridge = r && r.entityname;
    if (bridge !== 'Ballard' && bridge !== 'Fremont') continue;
    const open = fromPacific(r.opendatetime); // floating Pacific
    if (open == null) continue;
    const close = fromPacific(r.closedatetime);
    let minutes = num(r.minutesopen);
    if (minutes == null && close != null) minutes = round((close - open) / 60e3, 1);
    all.push({ bridge, open, close, minutes });
  }
  all.sort((a, b) => b.open - a.open);
  const newest = all.length ? all[0].open : null;
  const in7 = newest == null ? [] : all.filter((o) => o.open > newest - 7 * DAY);

  const stats = {};
  for (const name of ['Ballard', 'Fremont']) {
    const rs = in7.filter((o) => o.bridge === name);
    const mins = rs.map((o) => o.minutes).filter((m) => m != null);
    stats[name] = {
      last24h: rs.filter((o) => o.open > newest - DAY).length,
      last7d: rs.length,
      avgMin: mins.length ? round(mins.reduce((s, m) => s + m, 0) / mins.length, 1) : null,
      latest: rs.length ? rs[0].open : null,
    };
  }
  const out = { openings: in7.slice(0, 100), stats, newest };
  if (!all.length) out.warnings = ['no Ballard/Fremont openings in the last 9 days (dataset may be stale)'];
  return out;
}

// ---------------------------------------------------------------- WDFW salmon counts

const SALMON_URL = 'https://wdfw.wa.gov/fishing/reports/counts/lake-washington';

const countOrNull = (s) => {
  const m = String(s ?? '').replace(/[,\s]/g, '').match(/^(\d+)/);
  return m ? +m[1] : null;
};

function parseSalmonTable(html, key) {
  const m = html.match(new RegExp(`<table[^>]*id="lw-${key}-counts"[^>]*>([\\s\\S]*?)</table>`, 'i'));
  if (!m) return null;
  const cap = m[1].match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
  const ym = cap && stripTags(cap[1]).match(/\b(20\d\d)\b/);
  const body = (m[1].match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i) || [null, m[1]])[1];
  const rows = [];
  for (const tr of body.match(/<tr[\s>][\s\S]*?<\/tr>/gi) || []) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => stripTags(c[1]));
    if (cells.length >= 2) rows.push(cells);
  }
  return { year: ym ? +ym[1] : null, rows };
}

async function fetchSalmon() {
  return parseSalmon(await get(SALMON_URL, { as: 'text' }), Date.now());
}

/** Pure: WDFW Lake Washington counts HTML -> `salmon` output (`now` only supplies a fallback year). */
function parseSalmon(html, now) {
  const fallbackYear = +pacificDate(0, now).slice(0, 4);
  const species = [];
  const warnings = [];
  let year = null;
  for (const [name, key] of [['Sockeye', 'sockeye'], ['Chinook', 'chinook'], ['Coho', 'coho']]) {
    try {
      const tbl = parseSalmonTable(html, key);
      if (!tbl) { warnings.push(`${name}: table lw-${key}-counts not found`); continue; }
      const y = tbl.year || fallbackYear;
      if (year == null) year = y;
      // Only single-day rows ('M/D') with a non-empty daily count; range rows ('6/12-8/31') only feed totals.
      const counted = [];
      let lastTotal = null;
      for (const [date, daily, total] of tbl.rows) {
        const dm = String(date).match(/^(\d{1,2})\/(\d{1,2})$/);
        const c = countOrNull(daily);
        if (c == null) continue;
        const tot = countOrNull(total);
        if (tot != null) lastTotal = tot;
        if (dm) counted.push({ date: `${+dm[1]}/${+dm[2]}`, count: c, t: fromPacific(`${dm[1]}/${dm[2]}/${y}`), total: tot });
      }
      const latest = counted[counted.length - 1];
      species.push({
        name,
        latestDate: latest ? latest.date : null,
        latestT: latest ? latest.t : null,
        latestCount: latest ? latest.count : null,
        total: latest && latest.total != null ? latest.total : lastTotal,
        recent: counted.slice(-7).map(({ date, count }) => ({ date, count })),
      });
    } catch (e) {
      warnings.push(`${name}: ${errMsg(e)}`);
    }
  }
  if (!species.length) throw new Error(`salmon: no count tables parsed (${warnings.join('; ')})`);
  const out = { year: year || fallbackYear, species, source: SALMON_URL };
  if (warnings.length) out.warnings = warnings;
  return out;
}

// ---------------------------------------------------------------- King County / Seattle CSO status

const CSO_STATUS = { CurrentlyOverflowing: 'overflowing', OverflowLast48hrs: 'recent', NoRecentOverflow: 'none', NoData: 'nodata' };
const CSO_RANK = { overflowing: 0, recent: 1, nodata: 2, none: 3 };

async function fetchCso() {
  return parseCso(await get('https://your.kingcounty.gov/dnrp/library/wastewater/cso/img/CSO_metadata.CSV', { as: 'text' }));
}

/** Pure: King County CSO_metadata.CSV text -> `cso` output. */
function parseCso(text) {
  const rows = parseCSVObjects(text);
  if (!rows.length) throw new Error('cso: empty CSV');
  // An error/maintenance page served as 200 parses to rows with no known columns, i.e. zero sites, which the
  // dashboard would show as "Clear" (no overflows). Refuse it so the last good status is kept and flagged.
  if (!('CSO_TagName' in rows[0]) || !('Status' in rows[0])) throw new Error(`cso: unexpected CSV header: ${String(text).slice(0, 80)}`);
  const sites = [];
  for (const r of rows) {
    try {
      const tag = String(r.CSO_TagName || '').trim();
      const rawName = String(r.Name || '').trim();
      if (!tag || /^CSO_Status/i.test(tag) || /^Dummy/i.test(rawName)) continue; // legend rows
      const lat = num(r.Y_COORD), lon = num(r.X_COORD);
      if (lat == null || lon == null || lat < 47.64 || lat > 47.71 || lon < -122.43 || lon > -122.34) continue;
      const dsn = String(r.DSN || '').trim();
      const name = rawName === 'Seattle CSO' && dsn ? `Seattle CSO #${dsn}` : rawName || tag;
      sites.push({ tag, name, lat, lon, status: CSO_STATUS[String(r.Status || '').trim()] || 'nodata', t: fromPacific(r.DateTime) });
    } catch { /* skip malformed row */ }
  }
  if (!sites.length) throw new Error('cso: no Ballard-area outfalls in the CSV');
  sites.sort((a, b) => CSO_RANK[a.status] - CSO_RANK[b.status] || a.name.localeCompare(b.name, 'en', { numeric: true }));
  const ts = sites.map((s) => s.t).filter((t) => t != null);
  return {
    sites,
    overflowing: sites.filter((s) => s.status === 'overflowing').length,
    recent: sites.filter((s) => s.status === 'recent').length,
    t: ts.length ? Math.max(...ts) : null,
  };
}

// ----------------------------------------------------------------

export default [
  { id: 'tides', title: 'Tides (NOAA, Shilshole & Seattle)', ttl: 1800, background: false, daily: true, fetch: fetchTides },
  { id: 'currents', title: 'Currents at West Point (NOAA)', ttl: 21600, background: false, daily: true, fetch: fetchCurrents },
  { id: 'lake', title: 'Lake Washington level (USACE)', ttl: 900, background: false, fetch: fetchLake },
  { id: 'lockages', title: 'Ballard Locks traffic (USACE LPMS)', ttl: 300, background: false, daily: true, fetch: fetchLockages },
  { id: 'stoppages', title: 'Ballard Locks closures (USACE LPMS)', ttl: 1800, background: false, fetch: fetchStoppages },
  { id: 'bridges', title: 'Drawbridges live (SDOT)', ttl: 20, background: true, fetch: fetchBridges },
  { id: 'bridge-history', title: 'Bridge openings, last 7 days (Seattle Open Data)', ttl: 3600, background: false, fetch: fetchBridgeHistory },
  { id: 'salmon', title: 'Salmon counts at the Locks (WDFW)', ttl: 21600, background: false, fetch: fetchSalmon },
  { id: 'cso', title: 'Sewer overflows (King County & Seattle)', ttl: 600, background: false, fetch: fetchCso },
];

// Pure parsers, exported for offline tests only (the server uses the default export).
// Each takes the upstream payload (and `now` where the output depends on the clock) and does no I/O.
export const _test = {
  parseStoppages, observeBridges, parseBridgeBody, noaaGmt, pacificMidnight, tidePoints, interpAt, tidesWindow, buildTides,
  parseCurrents, parseLake, isCommercial, parseLockages, parseBridgeHistory, parseSalmonTable, parseSalmon, parseCso,
};
