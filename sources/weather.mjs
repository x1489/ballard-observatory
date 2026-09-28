// Weather, sky & air sources for Ballard Live (group `weather`). See CONTRACT.md for output shapes.
// Every timestamp emitted here is epoch ms; upstream zones are noted next to each parser.
import {
  get, discard, fromPacific, fromUTC, pacificDate, haversineKm, inBbox, median, pm25ToAqi,
  round, num, cToF, kmhToMph, msToMph, msToKt, CENTER,
} from '../lib.mjs';

const MIN = 60e3;
const HOUR = 60 * MIN;

// ---------- small local helpers ----------

/** Parse an ISO string that carries its own offset/Z. null if unparseable. */
const isoT = (s) => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};
const int = (v) => { const n = num(v); return n == null ? null : Math.round(n); };
const div = (v, k) => (v == null ? null : v / k);
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** Unwrap hard-wrapped NWS text: single newlines -> spaces, keep blank-line paragraph breaks. */
const paragraphs = (s) => String(s ?? '').replace(/\r/g, '').split(/\n\s*\n/).map(clean).filter(Boolean).join('\n\n');
const errMsg = (e) => String((e && e.message) || e);
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
/** Epoch for a wall-clock time with an explicit US Pacific abbreviation (PDT/PST); falls back to fromPacific. */
function zonedT(y, m, d, hh, mm, zone) {
  const off = { PDT: -7, PST: -8 }[zone];
  if (off == null) return fromPacific(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} ${hh}:${String(mm).padStart(2, '0')}`);
  return Date.UTC(y, m - 1, d, hh - off, mm);
}

const NWS = 'https://api.weather.gov';
const nwsGet = (path, opts = {}) => get(NWS + path, { headers: { Accept: 'application/geo+json' }, retries: 2, ...opts });
// Per-station calls run up to two deep (latest, then the recent list); with the default 15 s x 3 attempts one slow
// station would push the whole source past the server's 45 s deadline and drop the stations that did answer.
const STATION_REQ = { timeout: 8000, retries: 1 };

/**
 * Conditional GET keeping Last-Modified in `cache` (module state). Returns { text } on 200,
 * or { notModified: true } on 304 (only sent when cache.data exists).
 */
async function conditionalText(url, cache) {
  const headers = {};
  if (cache.data != null && cache.lastModified) headers['If-Modified-Since'] = cache.lastModified;
  const res = await get(url, { as: 'response', headers, timeout: 30000 });
  if (res.status === 304 && cache.data != null) return { notModified: true };
  if (!res.ok) {
    await discard(res);
    const e = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    e.status = res.status;
    throw e;
  }
  const text = await res.text();
  cache.lastModified = res.headers.get('last-modified') || null;
  return { text };
}

// =====================================================================
// weather: Open-Meteo forecast + minutely_15 nowcast in one call.
// Open-Meteo local times are wall-clock with NO offset, generated with ONE fixed offset for the whole
// response (utc_offset_seconds; verified: no DST gap across a transition), so convert with that offset.
// =====================================================================
const OM_URL = 'https://api.open-meteo.com/v1/forecast'
  + `?latitude=${CENTER.lat}&longitude=${CENTER.lon}`
  + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day,visibility,uv_index,pressure_msl'
  + '&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,uv_index,cloud_cover'
  + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,uv_index_max,sunrise,sunset'
  + '&minutely_15=precipitation,weather_code&forecast_minutely_15=12'
  + '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch'
  + '&timezone=America%2FLos_Angeles&forecast_days=7&forecast_hours=24';

const WET_IN = 0.001; // precip threshold for "raining" in a 15-min slot

async function fetchWeather() {
  return parseWeather(await get(OM_URL, { retries: 2 }), Date.now());
}

/** Pure: Open-Meteo response -> `weather` output. */
function parseWeather(d, now) {
  if (d.error) throw new Error(`Open-Meteo: ${d.reason || 'error'}`);
  const off = Number.isFinite(d.utc_offset_seconds) ? d.utc_offset_seconds : null;
  const T = (s) => {
    const m = typeof s === 'string' && s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return null;
    if (off == null) return fromPacific(s);
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - off * 1000;
  };
  const warnings = [];

  const c = d.current || {};
  const current = {
    t: T(c.time),
    tempF: round(num(c.temperature_2m), 1),
    feelsF: round(num(c.apparent_temperature), 1),
    humidity: int(c.relative_humidity_2m),
    precipIn: round(num(c.precipitation), 3),
    code: int(c.weather_code),
    cloud: int(c.cloud_cover),
    windMph: round(num(c.wind_speed_10m), 1),
    gustMph: round(num(c.wind_gusts_10m), 1),
    windDir: int(c.wind_direction_10m),
    isDay: c.is_day == null ? null : !!Number(c.is_day),
    visMi: round(div(num(c.visibility), 5280), 1), // imperial visibility is in FEET
    uv: round(num(c.uv_index), 1),
    pressureHpa: round(num(c.pressure_msl), 1),
  };

  const H = d.hourly || {};
  const hourStart = Math.floor(now / HOUR) * HOUR;
  const hourly = [];
  (H.time || []).forEach((s, i) => {
    const t = T(s);
    if (t == null || t < hourStart) return;
    hourly.push({
      t,
      tempF: round(num(H.temperature_2m?.[i]), 1),
      feelsF: round(num(H.apparent_temperature?.[i]), 1),
      pop: int(H.precipitation_probability?.[i]),
      precipIn: round(num(H.precipitation?.[i]), 3),
      code: int(H.weather_code?.[i]),
      windMph: round(num(H.wind_speed_10m?.[i]), 1),
      gustMph: round(num(H.wind_gusts_10m?.[i]), 1),
      windDir: int(H.wind_direction_10m?.[i]),
      uv: round(num(H.uv_index?.[i]), 1),
      cloud: int(H.cloud_cover?.[i]),
    });
  });
  hourly.splice(24);

  const D = d.daily || {};
  const daily = (D.time || []).slice(0, 7).map((date, i) => ({
    date,
    t: fromPacific(date), // true Pacific local midnight
    code: int(D.weather_code?.[i]),
    hiF: round(num(D.temperature_2m_max?.[i]), 1),
    loF: round(num(D.temperature_2m_min?.[i]), 1),
    pop: int(D.precipitation_probability_max?.[i]),
    precipIn: round(num(D.precipitation_sum?.[i]), 3),
    windMph: round(num(D.wind_speed_10m_max?.[i]), 1),
    gustMph: round(num(D.wind_gusts_10m_max?.[i]), 1),
    windDir: int(D.wind_direction_10m_dominant?.[i]),
    uvMax: round(num(D.uv_index_max?.[i]), 1),
    sunrise: T(D.sunrise?.[i]),
    sunset: T(D.sunset?.[i]),
  }));

  // minutely_15 slot t = end of its 15-min accumulation window (Open-Meteo "preceding 15 minutes").
  const M = d.minutely_15 || {};
  const nowcast = [];
  (M.time || []).forEach((s, i) => {
    const t = T(s);
    if (t == null || t < now - 15 * MIN) return;
    nowcast.push({ t, precipIn: round(num(M.precipitation?.[i]), 3), code: int(M.weather_code?.[i]) });
  });
  nowcast.splice(12);
  if (!nowcast.length) warnings.push('Open-Meteo returned no minutely_15 nowcast');

  const wet = (x) => x != null && x > WET_IN;
  const rainingNow = nowcast.length ? wet(nowcast[0].precipIn) : wet(current.precipIn);
  let rainStartsAt = null, rainEndsAt = null;
  if (rainingNow) rainEndsAt = nowcast.find((s) => s.precipIn != null && !wet(s.precipIn))?.t ?? null;
  else rainStartsAt = nowcast.find((s) => wet(s.precipIn))?.t ?? null;

  if (current.t == null && !hourly.length) throw new Error('Open-Meteo: no current or hourly data');
  const out = { current, hourly, daily, nowcast, rainStartsAt, rainEndsAt };
  if (warnings.length) out.warnings = warnings;
  return out;
}

// =====================================================================
// nws-forecast: gridpoint SEW/124,71 periods. Times are ISO with offset.
// =====================================================================
async function fetchNwsForecast() {
  return parseNwsForecast(await nwsGet('/gridpoints/SEW/124,71/forecast'), Date.now());
}

/** Pure: NWS gridpoint forecast -> `nws-forecast` output. */
function parseNwsForecast(d, now) {
  const p = d.properties || {};
  const periods = [];
  for (const x of p.periods || []) {
    try {
      const end = isoT(x.endTime);
      if (end != null && end <= now) continue; // drop periods already over (stale cache at NWS)
      const temp = num(x.temperature);
      periods.push({
        name: x.name || null,
        start: isoT(x.startTime),
        end,
        isDay: !!x.isDaytime,
        tempF: x.temperatureUnit === 'C' ? round(cToF(temp)) : temp,
        pop: int(x.probabilityOfPrecipitation?.value),
        wind: x.windSpeed ? clean(x.windSpeed) : null,
        windDir: x.windDirection || null,
        short: clean(x.shortForecast),
        detail: clean(x.detailedForecast),
        icon: x.icon || null,
      });
    } catch { /* skip bad period */ }
    if (periods.length >= 8) break;
  }
  if (!periods.length) throw new Error('NWS forecast: no current periods');
  return { updated: isoT(p.updateTime) ?? isoT(p.generatedAt), periods };
}

// =====================================================================
// alerts: NWS active alerts for Ballard land zones + Puget Sound marine zone. ISO with offset.
// =====================================================================
const SEVERITY_RANK = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 };

async function fetchAlerts() {
  return parseAlerts(await nwsGet('/alerts/active?zone=WAZ315,WAC033,PZZ135'));
}

/** Pure: NWS alerts GeoJSON -> `alerts` output. */
function parseAlerts(d) {
  const feats = d.features || [];
  // Drop messages superseded by another message in the same response.
  const superseded = new Set();
  for (const f of feats) for (const r of f.properties?.references || []) if (r.identifier) superseded.add(r.identifier);
  const seen = new Set();
  const alerts = [];
  for (const f of feats) {
    try {
      const p = f.properties || {};
      const id = p.id || f.id;
      if (!id || seen.has(id) || superseded.has(id)) continue;
      if (p.status && p.status !== 'Actual') continue;
      if (p.messageType === 'Cancel') continue;
      seen.add(id);
      const ugc = p.geocode?.UGC || [];
      alerts.push({
        id,
        event: p.event || 'Alert',
        severity: p.severity || null,
        urgency: p.urgency || null,
        headline: clean(p.headline || p.parameters?.NWSheadline?.[0] || p.event),
        description: paragraphs(p.description).slice(0, 4000),
        instruction: p.instruction ? paragraphs(p.instruction).slice(0, 2000) : null,
        area: clean(p.areaDesc),
        onset: isoT(p.onset) ?? isoT(p.effective),
        ends: isoT(p.ends),
        expires: isoT(p.expires),
        marine: ugc.includes('PZZ135') && !ugc.some((u) => /^WA[CZ]\d/.test(u)),
      });
    } catch { /* skip bad feature */ }
  }
  const rank = (s) => SEVERITY_RANK[s] ?? 4;
  alerts.sort((a, b) => rank(a.severity) - rank(b.severity) || (a.onset ?? 0) - (b.onset ?? 0));
  return { alerts };
}

// =====================================================================
// stations: Ballard CWOP stations via NWS. timestamp is ISO with +00:00; values are SI.
// =====================================================================
const STATION_IDS = ['AW337', 'E7826', 'F8372', 'AS437'];
// Precise coords from /stations/{id} (2026-09-24); used until the endpoint answers (obs geometry is rounded to 0.01).
const stationCoords = new Map([
  ['AW337', { lat: 47.67433, lon: -122.40133, verified: false }],
  ['E7826', { lat: 47.66933, lon: -122.41, verified: false }],
  ['F8372', { lat: 47.69717, lon: -122.37517, verified: false }],
  ['AS437', { lat: 47.65167, lon: -122.40533, verified: false }],
]);
const STALE_MS = 90 * MIN;
// The lib bbox runs to 47.700 (about NW 92nd St), which takes in part of Crown Hill; Ballard ends at NW 85th St.
const NW_85TH_LAT = 47.6905;
const BAD_QC = new Set(['X', 'B']);
const qv = (p, k) => {
  const o = p?.[k];
  if (!o || typeof o !== 'object') return null;
  if (o.qualityControl && BAD_QC.has(o.qualityControl)) return null;
  return num(o.value);
};

async function stationCoordsFor(id) {
  const c = stationCoords.get(id);
  if (c?.verified) return c;
  try {
    const s = await nwsGet(`/stations/${id}`, STATION_REQ);
    const [lon, lat] = s.geometry?.coordinates || [];
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const v = { lat, lon, verified: true };
      stationCoords.set(id, v);
      return v;
    }
  } catch { /* keep fallback */ }
  return c || null;
}

async function fetchStation(id) {
  const [coords, latest] = await Promise.all([stationCoordsFor(id), nwsGet(`/stations/${id}/observations/latest`, STATION_REQ)]);
  let obs = latest;
  // Some stations send gust-only packets; fall back to the newest recent obs that has a temperature.
  if (qv(latest.properties, 'temperature') == null) {
    try {
      const list = await nwsGet(`/stations/${id}/observations?limit=6`, STATION_REQ);
      const withTemp = (list.features || []).find((f) => qv(f.properties, 'temperature') != null);
      if (withTemp) obs = withTemp;
    } catch { /* keep latest */ }
  }
  return buildStation(id, coords, obs, Date.now());
}

/** Pure: one NWS observation (+ known coords) -> a `stations` row. */
function buildStation(id, coords, obs, now) {
  const p = obs.properties || {};
  const t = isoT(p.timestamp);
  let lat = coords?.lat, lon = coords?.lon;
  if (!Number.isFinite(lat)) [lon, lat] = obs.geometry?.coordinates || [];
  const pa = qv(p, 'barometricPressure') ?? qv(p, 'seaLevelPressure');
  return {
    id,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    distKm: Number.isFinite(lat) && Number.isFinite(lon) ? round(haversineKm(lat, lon), 2) : null,
    t,
    tempF: round(cToF(qv(p, 'temperature')), 1),
    humidity: int(qv(p, 'relativeHumidity')),
    windMph: round(kmhToMph(qv(p, 'windSpeed')), 1),
    gustMph: round(kmhToMph(qv(p, 'windGust')), 1),
    windDir: int(qv(p, 'windDirection')),
    pressureHpa: round(div(pa, 100), 1),
    stale: t == null || now - t > STALE_MS,
    // AS437 (Magnolia hill, south of Salmon Bay) and F8372 (Crown Hill, north of NW 85th) are outside Ballard.
    inBallard: inBbox(lat, lon) && lat < NW_85TH_LAT,
  };
}

async function fetchStations() {
  return summarizeStations(await Promise.allSettled(STATION_IDS.map(fetchStation)));
}

/** Pure: settled per-station results (in STATION_IDS order) -> `stations` output. */
function summarizeStations(results) {
  const stations = [], warnings = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') stations.push(r.value);
    else warnings.push(`${STATION_IDS[i]}: ${errMsg(r.reason)}`);
  });
  if (!stations.length) throw new Error(`all stations failed: ${warnings.join('; ')}`);
  stations.sort((a, b) => (a.distKm ?? 99) - (b.distKm ?? 99));
  // Median of fresh in-Ballard stations; if none of them has a fresh temperature, of all fresh stations.
  const freshTemps = (list) => list.filter((s) => !s.stale && Number.isFinite(s.tempF)).map((s) => s.tempF);
  let used = freshTemps(stations.filter((s) => s.inBallard));
  if (!used.length) used = freshTemps(stations);
  const out = { stations, medianTempF: round(median(used), 1), medianOf: used.length };
  if (warnings.length) out.warnings = warnings;
  return out;
}

// =====================================================================
// westpoint: NDBC WPOW1. Times are UTC (YY MM DD hh mm). Missing = MM / 99.0 / 999 / 9999.
// =====================================================================
const NDBC = 'https://www.ndbc.noaa.gov/data/realtime2/WPOW1';

function parseNdbc(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  if (!text.endsWith('\n')) lines.pop(); // Range response: last line may be truncated
  const head = lines.find((l) => l.startsWith('#'));
  if (!head) throw new Error('NDBC: no header');
  const names = head.slice(1).trim().split(/\s+/);
  const rows = [];
  for (const l of lines) {
    if (!l.trim() || l.startsWith('#')) continue;
    const f = l.trim().split(/\s+/);
    if (f.length < names.length) continue;
    const o = Object.fromEntries(names.map((n, i) => [n, f[i]]));
    const t = Date.UTC(+o.YY, +o.MM - 1, +o.DD, +o.hh, +o.mm);
    if (!Number.isFinite(t)) continue;
    o.t = t;
    rows.push(o);
  }
  return rows.sort((a, b) => b.t - a.t); // newest first
}
const inRange = (v, lo, hi) => { const n = num(v); return n != null && n >= lo && n <= hi ? n : null; };
const ndDir = (v) => inRange(v, 0, 360);
const ndSpd = (v) => inRange(v, 0, 80); // m/s; 99.0 = missing
const ndPres = (v) => inRange(v, 850, 1100);

async function fetchWestpoint() {
  const [cw, tx] = await Promise.allSettled([
    get(`${NDBC}.cwind`, { as: 'text', headers: { Range: 'bytes=0-1999' } }).then(parseNdbc),
    get(`${NDBC}.txt`, { as: 'text', headers: { Range: 'bytes=0-5999' } }).then(parseNdbc),
  ]);
  return buildWestpoint(cw, tx);
}

/** Pure: settled parseNdbc results for .cwind and .txt -> `westpoint` output. */
function buildWestpoint(cw, tx) {
  const warnings = [];
  const cwRows = cw.status === 'fulfilled' ? cw.value : (warnings.push(`.cwind: ${errMsg(cw.reason)}`), []);
  const txRows = tx.status === 'fulfilled' ? tx.value : (warnings.push(`.txt: ${errMsg(tx.reason)}`), []);
  if (!cwRows.length && !txRows.length) throw new Error(`WPOW1: no data (${warnings.join('; ')})`);

  const out = { lat: 47.662, lon: -122.435, t: null, windDir: null, windKt: null, windMph: null, gustKt: null, gustMph: null, peakGustKt: null, peakGustMph: null, peakGustT: null, pressureHpa: null, pressureTendencyHpa: null, airTempF: null, history: [] };
  const setWind = (ms) => { out.windKt = round(msToKt(ms), 1); out.windMph = round(msToMph(ms), 1); };
  const setGust = (ms) => { out.gustKt = round(msToKt(ms), 1); out.gustMph = round(msToMph(ms), 1); };

  const latestCw = cwRows.find((r) => ndSpd(r.WSPD) != null);
  if (latestCw) {
    out.t = latestCw.t;
    out.windDir = ndDir(latestCw.WDIR);
    setWind(ndSpd(latestCw.WSPD));
    // .cwind GST is only filled on the hourly row and is the PEAK gust of the past hour, at GTIME (hhmm UTC),
    // not the gust at the observation time. Expose it separately if it's from the last ~70 min.
    const g = cwRows.find((r) => ndSpd(r.GST) != null && r.t >= latestCw.t - 70 * MIN);
    if (g) {
      out.peakGustKt = round(msToKt(ndSpd(g.GST)), 1);
      out.peakGustMph = round(msToMph(ndSpd(g.GST)), 1);
      const gm = String(g.GTIME || '').match(/^(\d{2})(\d{2})$/);
      if (gm && +gm[1] < 24 && +gm[2] < 60) {
        let gt = Date.UTC(+g.YY, +g.MM - 1, +g.DD, +gm[1], +gm[2]);
        if (gt > g.t) gt -= 24 * HOUR; // the 00:00 row's peak (e.g. 2324) is on the previous UTC day
        out.peakGustT = gt;
      }
    }
  }
  const tx0 = txRows[0];
  if (tx0) {
    if (!latestCw) {
      out.t = tx0.t;
      out.windDir = ndDir(tx0.WDIR);
      if (ndSpd(tx0.WSPD) != null) setWind(ndSpd(tx0.WSPD));
    }
    // Current gust: only the .txt row taken at the latest obs time (otherwise null, never the hour-old peak).
    const txNow = txRows.find((r) => r.t === out.t);
    if (txNow && ndSpd(txNow.GST) != null) setGust(ndSpd(txNow.GST));
    if (tx0.t >= out.t - 3 * HOUR) {
      out.pressureHpa = ndPres(tx0.PRES);
      out.pressureTendencyHpa = inRange(tx0.PTDY, -40, 40);
      out.airTempF = round(cToF(inRange(tx0.ATMP, -50, 50)), 1);
    }
  }
  // history: one row per UTC hour (newest row wins), last 24 hours of rows, oldest first.
  const seenHour = new Set();
  for (const r of txRows) {
    const h = Math.floor(r.t / HOUR);
    if (seenHour.has(h)) continue;
    seenHour.add(h);
    const w = ndSpd(r.WSPD), g = ndSpd(r.GST);
    out.history.push({ t: r.t, windKt: round(msToKt(w), 1), gustKt: round(msToKt(g), 1), windDir: ndDir(r.WDIR), pressureHpa: ndPres(r.PRES) });
    if (out.history.length >= 24) break;
  }
  out.history.reverse();
  if (warnings.length) out.warnings = warnings;
  return out;
}

// =====================================================================
// marine: tgftp coastal waters forecast PZZ135. Expires: is UTC; issuance line carries PDT/PST.
// =====================================================================
function parseIssued(s) {
  const m = s && s.match(/^(\d{1,2})(\d{2}) (AM|PM) ([A-Z]{3}) \w{3} (\w{3}) (\d{1,2}) (\d{4})/);
  if (!m) return null;
  let hh = +m[1] % 12;
  if (m[3] === 'PM') hh += 12;
  const mon = MONTHS[m[5]];
  if (!mon) return null;
  return zonedT(+m[7], mon, +m[6], hh, +m[2], m[4]);
}

async function fetchMarine() {
  return parseMarine(await get('https://tgftp.nws.noaa.gov/data/forecasts/marine/coastal/pz/pzz135.txt', { as: 'text', retries: 2 }));
}

/** Pure: tgftp PZZ135 text -> `marine` output. */
function parseMarine(raw) {
  const text = raw.replace(/\r/g, '');
  const em = text.match(/Expires:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
  const expires = em ? Date.UTC(+em[1], +em[2] - 1, +em[3], +em[4], +em[5]) : null;

  let lines = text.split('\n');
  const zi = lines.findIndex((l) => /^PZZ\d{3}.*-\s*$/.test(l) && l.includes('135'));
  if (zi >= 0) lines = lines.slice(zi);
  const end = lines.findIndex((l) => l.trim() === '$$');
  if (end >= 0) lines = lines.slice(0, end);
  const ISSUED_RE = /^\d{1,4} (AM|PM) [A-Z]{3} \w{3} \w{3} \d{1,2} \d{4}\s*$/;
  const ii = lines.findIndex((l) => ISSUED_RE.test(l.trim()));
  const issued = ii >= 0 ? lines[ii].trim() : null;
  const body = ii >= 0 ? lines.slice(ii + 1) : lines;

  const PERIOD_RE = /^\.([A-Z][A-Z0-9 ]*?)\.\.\.\s*(.*)$/;
  const firstP = body.findIndex((l) => PERIOD_RE.test(l));
  // Headlines: '...TEXT...' blocks (may wrap across lines; several may sit back to back).
  const headlines = [];
  let hl = null;
  for (const l of firstP >= 0 ? body.slice(0, firstP) : body) {
    const s = l.trim();
    if (!s) { if (hl) headlines.push(hl); hl = null; continue; }
    if (hl == null) { if (!s.startsWith('...')) continue; hl = s; } else hl += ' ' + s;
    if (hl.length > 6 && hl.endsWith('...')) { headlines.push(hl); hl = null; }
  }
  if (hl) headlines.push(hl);
  for (let i = 0; i < headlines.length; i++) headlines[i] = clean(headlines[i].replace(/^\.\.\.\s*/, '').replace(/\s*\.\.\.$/, ''));

  const periods = [];
  if (firstP >= 0) {
    let cur = null;
    for (const l of body.slice(firstP)) {
      const m = l.match(PERIOD_RE);
      if (m) { cur = { name: m[1].trim(), text: m[2] }; periods.push(cur); } else if (cur) cur.text += '\n' + l;
    }
    for (const p of periods) p.text = clean(p.text);
  }
  if (!periods.length) throw new Error('PZZ135: no forecast periods found');
  return { issued, issuedT: parseIssued(issued), expires, headlines, periods };
}

// =====================================================================
// afd: NWS Seattle Area Forecast Discussion (issuanceTime is ISO with +00:00).
// =====================================================================
function afdSection(text, nameRe) {
  const hm = text.match(new RegExp(`^\\.(?:${nameRe})[^\\n]*?\\.\\.\\.`, 'm'));
  if (!hm) return null;
  const start = hm.index + hm[0].length;
  const rest = text.slice(start);
  const stop = rest.search(/^&&|^\.[A-Z][A-Z ]+(?:\/[^\n]*\/)?\.\.\./m);
  const body = stop >= 0 ? rest.slice(0, stop) : rest;
  const paras = body.split(/\n\s*\n/).map(clean).filter(Boolean);
  // Drop trailing forecaster tags like "21" or "JBB".
  while (paras.length && /^[A-Z0-9]{1,5}$/.test(paras[paras.length - 1])) paras.pop();
  return paras.length ? paras : null;
}

function truncate(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const dot = cut.lastIndexOf('. ');
  return (dot > max * 0.6 ? cut.slice(0, dot + 1) + ' …' : cut.replace(/\s+\S*$/, '') + '…');
}

async function fetchAfd() {
  return parseAfd(await nwsGet('/products/types/AFD/locations/SEW/latest'));
}

/** Pure: NWS AFD product JSON -> `afd` output. */
function parseAfd(d) {
  const text = String(d.productText || '').replace(/\r/g, '');
  if (!text) throw new Error('AFD: empty productText');
  const syn = afdSection(text, 'SYNOPSIS');
  const st = afdSection(text, 'SHORT TERM');
  const out = { issued: isoT(d.issuanceTime), synopsis: '', shortTerm: st ? truncate(st.join('\n\n'), 1500) : null };
  if (syn) out.synopsis = syn.join(' ');
  else {
    const alt = afdSection(text, 'UPDATE|DISCUSSION|KEY MESSAGES');
    if (!alt) throw new Error('AFD: no .SYNOPSIS section');
    out.synopsis = truncate(alt.join(' '), 1000);
    out.warnings = ['AFD has no .SYNOPSIS section; used the first discussion section'];
  }
  return out;
}

// =====================================================================
// sky: USNO rise/set/transit for today's and tomorrow's Pacific dates. USNO returns Pacific
// wall-clock ('06:59  DT') because tz=-8&dst=true; convert with fromPacific on that date.
// Results for a date never change, so they are cached per date (a new date always refetches).
// Moon phases API returns UT.
// =====================================================================
const skyCache = new Map(); // 'rstt:YYYY-MM-DD' | 'phases:YYYY-MM-DD' -> data

async function usnoCached(key, url) {
  if (skyCache.has(key)) return skyCache.get(key);
  const d = await get(url, { retries: 2, timeout: 20000 });
  if (!d || typeof d !== 'object' || d.error) throw new Error(`USNO: ${(d && d.error) || 'bad response'}`);
  if (key.startsWith('phases:') && !Array.isArray(d.phasedata)) throw new Error('USNO: no phasedata');
  skyCache.set(key, d);
  return d;
}
const usnoDay = (date) => usnoCached(`rstt:${date}`,
  `https://aa.usno.navy.mil/api/rstt/oneday?date=${date}&coords=${CENTER.lat},${CENTER.lon}&tz=-8&dst=true`)
  .then((d) => {
    const data = d?.properties?.data;
    if (!data || !Array.isArray(data.sundata)) { skyCache.delete(`rstt:${date}`); throw new Error('USNO: unexpected rstt response'); }
    return data;
  });

function usnoTime(date, list, phen) {
  const e = (list || []).find((x) => x.phen === phen);
  const m = e && String(e.time).match(/(\d{1,2}):(\d{2})/);
  return m ? fromPacific(`${date} ${m[1].padStart(2, '0')}:${m[2]}`) : null;
}

async function fetchSky() {
  const now = Date.now();
  const date = pacificDate(0, now), tomorrow = pacificDate(1, now);
  for (const k of skyCache.keys()) if (!k.endsWith(date) && !k.endsWith(tomorrow)) skyCache.delete(k);

  const results = await Promise.allSettled([
    usnoDay(date),
    usnoDay(tomorrow),
    usnoCached(`phases:${date}`, `https://aa.usno.navy.mil/api/moon/phases/date?date=${date}&nump=3`),
  ]);
  return buildSky(date, tomorrow, results, now);
}

/**
 * Pure: settled [today rstt properties.data, tomorrow rstt properties.data, moon phases JSON] -> `sky` output.
 * date/tomorrow are the Pacific 'YYYY-MM-DD' dates those rstt calls were made for.
 */
function buildSky(date, tomorrow, [today, tmr, ph], now) {
  if (today.status !== 'fulfilled') throw today.reason;
  const warnings = [];
  const d = today.value;
  const sun = {
    civilDawn: usnoTime(date, d.sundata, 'Begin Civil Twilight'),
    rise: usnoTime(date, d.sundata, 'Rise'),
    noon: usnoTime(date, d.sundata, 'Upper Transit'),
    set: usnoTime(date, d.sundata, 'Set'),
    civilDusk: usnoTime(date, d.sundata, 'End Civil Twilight'),
  };
  const moon = {
    rise: usnoTime(date, d.moondata, 'Rise'),
    set: usnoTime(date, d.moondata, 'Set'),
    phase: d.curphase || null,
    illum: int(String(d.fracillum ?? '').replace('%', '')),
  };

  let nextPhase = null;
  if (ph.status === 'fulfilled') {
    for (const p of ph.value?.phasedata || []) {
      const m = String(p.time).match(/(\d{1,2}):(\d{2})/);
      if (!m) continue;
      const t = Date.UTC(p.year, p.month - 1, p.day, +m[1], +m[2]); // UT
      if (t > now) { nextPhase = { phase: p.phase, t }; break; }
    }
  } else warnings.push(`moon phases: ${errMsg(ph.reason)}`);
  if (!nextPhase) {
    // Fallback: rstt closestphase (Pacific wall-clock), only if it's still ahead.
    const cp = d.closestphase;
    const m = cp && String(cp.time).match(/(\d{1,2}):(\d{2})/);
    const t = m ? fromPacific(`${cp.year}-${String(cp.month).padStart(2, '0')}-${String(cp.day).padStart(2, '0')} ${m[1].padStart(2, '0')}:${m[2]}`) : null;
    if (t != null && t > now) nextPhase = { phase: cp.phase, t };
  }

  let tomorrowSun = { rise: null, set: null };
  if (tmr.status === 'fulfilled') {
    tomorrowSun = { rise: usnoTime(tomorrow, tmr.value.sundata, 'Rise'), set: usnoTime(tomorrow, tmr.value.sundata, 'Set') };
  } else warnings.push(`tomorrow: ${errMsg(tmr.reason)}`);

  const out = { date, sun, moon, nextPhase, tomorrowSun };
  if (warnings.length) out.warnings = warnings;
  return out;
}

// =====================================================================
// kp: NOAA SWPC planetary K. time_tag is UTC without Z.
// =====================================================================
async function fetchKp() {
  const [m1, h3] = await Promise.allSettled([
    get('https://services.swpc.noaa.gov/json/planetary_k_index_1m.json', { retries: 2 }),
    get('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', { retries: 2 }),
  ]);
  return buildKp(m1, h3);
}

/** Pure: settled [1-minute JSON, 3-hour JSON] -> `kp` output. */
function buildKp(m1, h3) {
  const warnings = [];

  // Official 3-hour values: array of objects (current) or legacy array-of-arrays with a header row.
  let recent = [];
  if (h3.status === 'fulfilled' && Array.isArray(h3.value)) {
    let rows = h3.value;
    if (Array.isArray(rows[0])) {
      const [hdr, ...rest] = rows;
      rows = rest.map((r) => Object.fromEntries(hdr.map((h, i) => [h, r[i]])));
    }
    recent = rows.map((r) => ({ t: fromUTC(r.time_tag), kp: round(num(r.Kp ?? r.kp), 2) }))
      .filter((r) => r.t != null && r.kp != null).sort((a, b) => a.t - b.t).slice(-8);
  } else warnings.push(`3-hour Kp: ${h3.status === 'rejected' ? errMsg(h3.reason) : 'bad shape'}`);

  let t = null, kp = null, kpIndex = null;
  if (m1.status === 'fulfilled' && Array.isArray(m1.value) && m1.value.length) {
    const rows = m1.value.map((r) => ({ t: fromUTC(r.time_tag), kp: num(r.estimated_kp), idx: int(r.kp_index) }))
      .filter((r) => r.t != null && r.kp != null).sort((a, b) => a.t - b.t);
    // estimated_kp is a running estimate over the current 3-hour UTC period: it restarts at 0 on each
    // boundary (00/03/06...Z) and climbs as data accumulates (often 0 for 10+ min). For the first 30 min
    // of a period, keep showing the previous period's final estimate until the new one catches up.
    let r = rows[rows.length - 1];
    if (r) {
      const periodStart = Math.floor(r.t / (3 * HOUR)) * 3 * HOUR;
      const prevEnd = rows.filter((x) => x.t < periodStart && x.t >= periodStart - 15 * MIN).pop();
      if (prevEnd && r.t - periodStart < 30 * MIN && r.kp < prevEnd.kp) r = prevEnd;
      t = r.t; kp = round(r.kp, 2); kpIndex = r.idx ?? Math.round(r.kp);
    }
  } else warnings.push(`1-minute Kp: ${m1.status === 'rejected' ? errMsg(m1.reason) : 'bad shape'}`);

  if (kp == null) {
    const last = recent[recent.length - 1];
    if (!last) throw new Error(`SWPC Kp unavailable (${warnings.join('; ')})`);
    t = last.t; kp = last.kp; kpIndex = Math.round(last.kp);
  }
  const out = { t, kp, kpIndex, recent };
  if (warnings.length) out.warnings = warnings;
  return out;
}

// =====================================================================
// radar: IEM NEXRAD n0q composite metadata (meta.valid is UTC ISO with Z).
// =====================================================================
const IEM_LAYER = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913';
const iemTile = (suffix = '') => `${IEM_LAYER}${suffix}/{z}/{x}/{y}.png`;

async function fetchRadar() {
  return parseRadar(await get('https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0.json', { retries: 2 }));
}

/** Pure: IEM n0q_0.json -> `radar` output. */
function parseRadar(d) {
  const valid = fromUTC(d?.meta?.valid);
  if (valid == null) throw new Error('IEM n0q_0.json: no meta.valid');
  const frames = [];
  for (let m = 50; m >= 5; m -= 5) frames.push({ label: `-${m}m`, tileUrl: iemTile(`-m${String(m).padStart(2, '0')}m`) });
  frames.push({ label: 'now', tileUrl: iemTile() });
  return { valid, tileUrl: iemTile(), frames, loopGif: 'https://radar.weather.gov/ridge/standard/KATX_loop.gif' };
}

// =====================================================================
// airnow: reporting area file (pipe-delimited, local PDT/PST, TimeZone column says which).
// =====================================================================
const AIRNOW_URL = 'https://files.airnowtech.org/airnow/today/reportingarea.dat';
const AIRNOW_AREA = '|Seattle-Bellevue-Kent Valley|WA|';
const airnowCache = { lastModified: null, data: null }; // data = the Seattle lines

/** Pure: the whole reportingarea.dat text -> just the Seattle-Bellevue-Kent Valley lines (throws if none). */
function airnowLines(text) {
  const lines = text.split('\n').filter((l) => l.includes(AIRNOW_AREA)).map((l) => l.replace(/\r$/, ''));
  if (!lines.length) throw new Error('AirNow: no Seattle-Bellevue-Kent Valley lines in reportingarea.dat');
  return lines;
}

const mdyIso = (s) => {
  const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
};

/** Pure: the Seattle reportingarea.dat lines -> `airnow` output. `now` picks today's Pacific date. */
function buildAirnow(lines, now = Date.now()) {
  const today = pacificDate(0, now);
  const observed = [], fc = new Map();
  for (const line of lines) {
    try {
      const f = line.split('|');
      if (f.length < 14) continue;
      const [issue, validDate, validTime, zone, , type, primaryFlag, , , , , param, aqiS, category, , discussion] = f;
      const primary = primaryFlag === 'Y';
      const date = mdyIso(validDate);
      if (type === 'O') {
        const tm = String(validTime).match(/^(\d{1,2}):(\d{2})/);
        let t = null;
        if (date && tm) {
          const [y, mo, d] = date.split('-').map(Number);
          t = zonedT(y, mo, d, +tm[1], +tm[2], zone);
        }
        observed.push({ param, aqi: int(aqiS), category: category || null, t, primary });
      } else if (type === 'F' && date && date >= today) {
        const key = `${date}|${param}`;
        const issueIso = mdyIso(issue) || '';
        const prevF = fc.get(key);
        if (prevF && prevF.issue > issueIso) continue;
        fc.set(key, { issue: issueIso, row: { date, param, aqi: int(aqiS), category: category || null, primary }, discussion: clean(discussion) });
      }
    } catch { /* skip bad line */ }
  }
  observed.sort((a, b) => (b.primary - a.primary) || String(a.param).localeCompare(b.param));
  const fcs = [...fc.values()].sort((a, b) => a.row.date.localeCompare(b.row.date) || (b.row.primary - a.row.primary));
  const discussion = fcs.find((x) => x.discussion)?.discussion || null;
  return { observed, forecast: fcs.map((x) => x.row), discussion };
}

async function fetchAirnow() {
  const r = await conditionalText(AIRNOW_URL, airnowCache);
  if (!r.notModified) airnowCache.data = airnowLines(r.text);
  const out = buildAirnow(airnowCache.data);
  if (!out.observed.length && !out.forecast.length) throw new Error('AirNow: no usable Seattle rows');
  return out;
}

// =====================================================================
// purpleair: AirFire PurpleAir export (CSV, utc_ts like '2026-09-25 02:00:00+0000').
// =====================================================================
const PA_URL = 'https://airfire-data-exports.s3.us-west-2.amazonaws.com/maps/purple_air/v4/pas.csv';
const paCache = { lastModified: null, data: null }; // data = bbox rows (not age-filtered)
const PA_MAX_AGE = 3 * HOUR;

function parsePurpleAir(text) {
  const nl = text.indexOf('\n');
  const head = text.slice(0, nl).replace(/\r$/, '').split(',').map((h) => h.trim());
  const ix = (n) => head.indexOf(n);
  const iId = ix('sensor_index'), iLat = ix('latitude'), iLon = ix('longitude'), iTs = ix('utc_ts'), iNow = ix('epa_nowcast'), iPm = ix('epa_pm25');
  if ([iId, iLat, iLon, iTs].some((i) => i < 0)) throw new Error('PurpleAir: unexpected CSV header');
  const rows = [];
  for (const line of text.slice(nl + 1).split('\n')) {
    const f = line.split(',');
    const lat = +f[iLat], lon = +f[iLon];
    if (!inBbox(lat, lon)) continue;
    const ts = String(f[iTs] || '').trim().replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    const pm = num(f[iNow]) ?? num(f[iPm]);
    rows.push({ id: int(f[iId]), lat, lon, t: fromUTC(ts), pm25: pm });
  }
  return rows;
}

async function fetchPurpleair() {
  const r = await conditionalText(PA_URL, paCache);
  if (!r.notModified) {
    const rows = parsePurpleAir(r.text);
    if (!rows.length) throw new Error('PurpleAir: no sensors in the Ballard bbox');
    paCache.data = rows;
  }
  return buildPurpleair(paCache.data, Date.now());
}

/** Pure: parsePurpleAir rows (bbox, not age-filtered) -> `purpleair` output. */
function buildPurpleair(rows, now) {
  const sensors = rows
    .filter((s) => s.t != null && now - s.t <= PA_MAX_AGE && s.pm25 != null && s.pm25 >= 0 && s.pm25 < 1000)
    .map((s) => ({ id: s.id, lat: s.lat, lon: s.lon, t: s.t, pm25: round(s.pm25, 1), aqi: pm25ToAqi(s.pm25) }))
    .sort((a, b) => a.id - b.id);
  const out = {
    sensors,
    medianAqi: round(median(sensors.map((s) => s.aqi))),
    medianPm25: round(median(sensors.map((s) => s.pm25)), 1),
    count: sensors.length,
    t: sensors.length ? Math.max(...sensors.map((s) => s.t)) : null,
  };
  if (!sensors.length) out.warnings = [`all ${rows.length} Ballard sensors are older than 3h`];
  return out;
}

// =====================================================================

export default [
  { id: 'weather', title: 'Weather (Open-Meteo)', ttl: 600, background: false, fetch: fetchWeather },
  { id: 'nws-forecast', title: 'NWS Forecast', ttl: 1800, background: false, fetch: fetchNwsForecast },
  { id: 'alerts', title: 'NWS Alerts', ttl: 120, background: false, fetch: fetchAlerts },
  { id: 'stations', title: 'Ballard Weather Stations', ttl: 300, background: false, fetch: fetchStations },
  { id: 'westpoint', title: 'West Point Wind (NDBC)', ttl: 600, background: false, fetch: fetchWestpoint },
  { id: 'marine', title: 'Puget Sound Marine Forecast', ttl: 1800, background: false, fetch: fetchMarine },
  { id: 'afd', title: 'NWS Seattle Forecast Discussion', ttl: 3600, background: false, fetch: fetchAfd },
  { id: 'sky', title: 'Sun & Moon (USNO)', ttl: 3600, background: false, daily: true, fetch: fetchSky },
  { id: 'kp', title: 'Aurora Kp Index (SWPC)', ttl: 600, background: false, fetch: fetchKp },
  { id: 'radar', title: 'Radar (IEM NEXRAD)', ttl: 300, background: false, fetch: fetchRadar },
  { id: 'airnow', title: 'Air Quality (AirNow)', ttl: 1800, background: false, daily: true, fetch: fetchAirnow },
  { id: 'purpleair', title: 'PurpleAir Sensors', ttl: 1200, background: false, fetch: fetchPurpleair },
];

// Pure parsers/normalizers, exported for offline tests only (the server uses the default export).
// Each takes the upstream payload (and `now` where the output depends on the clock) and does no I/O.
export const _test = {
  parseWeather, parseNwsForecast, parseAlerts, buildStation, summarizeStations, STATION_IDS,
  parseNdbc, buildWestpoint, parseIssued, zonedT, parseMarine, afdSection, parseAfd,
  usnoTime, buildSky, buildKp, parseRadar, airnowLines, buildAirnow, parsePurpleAir, buildPurpleair,
};
