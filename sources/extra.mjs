// New v2 sources: aircraft overhead (ADS-B), wildlife sightings (iNaturalist) and Ballard/Fremont bridge-opening
// odds (Seattle open data + 33 CFR 117.1051). Shapes: GOAL.md "New source shapes" and CONTRACT.md.
// All upstreams are free and need no key; see tools/research-extra.md.
import {
  get, sleep, fromPacific, fromUTC, pacificDate, pacificParts, pacificToEpoch, toPacificFloating, haversineKm, CENTER, BBOX, TZ,
} from '../lib.mjs';

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOr = (v) => (isNum(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const hm = (t) => (isNum(t) ? timeFmt.format(t).replace(' AM', ' am').replace(' PM', ' pm') : '');

// =================================================================== aircraft

// 20 nm takes in the approaches to Sea-Tac, Boeing Field and Paine Field and the Lake Union floatplanes.
const RADIUS_NM = 20;
const AC_PRIMARY = `https://api.adsb.lol/v2/point/${CENTER.lat}/${CENTER.lon}/${RADIUS_NM}`;
const AC_FALLBACK = `https://opendata.adsb.fi/api/v2/lat/${CENTER.lat}/lon/${CENTER.lon}/dist/${RADIUS_NM}`;

// ICAO airline designators seen around Seattle (callsign prefix -> operator).
const OPERATORS = {
  ASA: 'Alaska Airlines', QXE: 'Horizon Air', SWA: 'Southwest', DAL: 'Delta', UAL: 'United', AAL: 'American', SKW: 'SkyWest',
  FDX: 'FedEx', UPS: 'UPS', JBU: 'JetBlue', FFT: 'Frontier', NKS: 'Spirit', HAL: 'Hawaiian', ACA: 'Air Canada', JZA: 'Air Canada Jazz',
  WJA: 'WestJet', WEN: 'WestJet Encore', KAL: 'Korean Air', AAR: 'Asiana', ANA: 'All Nippon', JAL: 'Japan Airlines', BAW: 'British Airways',
  DLH: 'Lufthansa', AFR: 'Air France', KLM: 'KLM', CPA: 'Cathay Pacific', EVA: 'EVA Air', CAL: 'China Airlines', UAE: 'Emirates',
  QTR: 'Qatar Airways', ICE: 'Icelandair', CPZ: 'Compass', RPA: 'Republic', ENY: 'Envoy', GTI: 'Atlas Air', ABX: 'ABX Air',
  CKS: 'Kalitta Air', SCX: 'Sun Country', VXP: 'Avelo', PAC: 'Polar Air Cargo', ASH: 'Mesa', AMX: 'Aeromexico', VOI: 'Volaris',
  SIA: 'Singapore Airlines', THY: 'Turkish Airlines', SAS: 'SAS', FIN: 'Finnair', CSN: 'China Southern', CES: 'China Eastern', CCA: 'Air China',
};
const MILITARY_CS = /^(RCH|CNV|PAT|NAVY|ARMY|EVAC|REACH|TOPCAT|SAM|VENUS|SPAR|CGNR|COAST|C\d{4})/;
const HELI_TYPES = /^(EC\d|AS\d|B06|B40|B42|B43|R22|R44|R66|S76|S92|A109|A119|A139|A169|BK17|H60|H47|UH\d|CH\d|MD5|MD6|MD9|EH10|AW|H125|H130|H135|H145|H160)/;
const SEAPLANE_TYPES = /^(DHC2|DH2T|DHC3|DH3T)$/;

const EMERG = { 7500: 'hijack', 7600: 'radio failure', 7700: 'general emergency' };

export function aircraftKind(x) {
  const cat = String(x.category || '').toUpperCase();
  const type = String(x.type || '').toUpperCase();
  const cs = String(x.callsign || '').toUpperCase();
  if (cat === 'A7' || HELI_TYPES.test(type)) return 'helicopter';
  if (SEAPLANE_TYPES.test(type)) return 'seaplane';
  if ((isNum(x.dbFlags) && (x.dbFlags & 1)) || MILITARY_CS.test(cs)) return 'military';
  if (['A3', 'A4', 'A5'].includes(cat) || (x.operator && !/^N\d/.test(cs))) return 'airliner';
  if (['A1', 'A2', 'B1', 'B4', 'B6'].includes(cat)) return 'light';
  return 'unknown';
}

/** Normalize one readsb/tar1090 aircraft record. Returns null for records without a usable position. */
export function normalizeAircraft(a, nowMs) {
  if (!a || !isNum(a.lat) || !isNum(a.lon)) return null;
  const posAgeS = isNum(a.seen_pos) ? a.seen_pos : isNum(a.seen) ? a.seen : 0;
  if (posAgeS > 60) return null;
  const callsign = String(a.flight || '').trim() || null;
  const onGround = a.alt_baro === 'ground';
  const altFt = onGround ? 0 : isNum(a.alt_baro) ? a.alt_baro : isNum(a.alt_geom) ? a.alt_geom : null;
  const squawk = a.squawk ? String(a.squawk) : null;
  const emergency = a.emergency && a.emergency !== 'none' ? String(a.emergency) : squawk && EMERG[squawk] ? EMERG[squawk] : null;
  const prefix = callsign && /^[A-Z]{3}\d/.test(callsign) ? callsign.slice(0, 3) : null;
  const operator = prefix && OPERATORS[prefix] ? OPERATORS[prefix] : null;
  const out = {
    hex: String(a.hex || '').replace(/^~/, '').toLowerCase(),
    callsign, reg: a.r || null, type: a.t || null, desc: a.desc || null,
    lat: a.lat, lon: a.lon, altFt, gsKt: numOr(a.gs), track: numOr(a.track ?? a.true_heading ?? a.mag_heading),
    vrFpm: numOr(a.baro_rate ?? a.geom_rate), squawk, onGround, emergency, category: a.category || null,
    operator, distKm: Math.round(haversineKm(a.lat, a.lon) * 100) / 100, posAgeS: Math.round(posAgeS),
    t: nowMs - Math.round(posAgeS * 1000),
  };
  out.kind = aircraftKind({ ...out, dbFlags: a.dbFlags });
  return out.hex ? out : null;
}

export function buildAircraft(json, provider, fallbackNow = Date.now()) {
  let now = isNum(json && json.now) ? json.now : fallbackNow;
  if (now < 1e12) now *= 1000; // adsb.fi reports seconds, adsb.lol milliseconds
  const list = arr(json && (json.ac || json.aircraft)).map((a) => normalizeAircraft(a, now)).filter(Boolean)
    .filter((a) => !a.onGround || a.distKm < 6) // not the whole Sea-Tac ramp: ground traffic only near Ballard (Lake Union)
    .sort((a, b) => a.distKm - b.distKm);
  const airborne = list.filter((a) => !a.onGround);
  return { t: now, radiusNm: RADIUS_NM, provider, aircraft: list, count: list.length, airborne: airborne.length, nearest: airborne[0] || null };
}

async function fetchAircraft() {
  let lastErr;
  for (const [url, provider] of [[AC_PRIMARY, 'adsb.lol'], [AC_FALLBACK, 'adsb.fi']]) {
    try {
      const j = await get(url, { timeout: 8000, retries: 0, headers: { Accept: 'application/json' } });
      if (!j || !(Array.isArray(j.ac) || Array.isArray(j.aircraft))) throw new Error(`${provider}: unexpected response`);
      return buildAircraft(j, provider);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const aircraftDetect = (prev, next, ctx) => {
  if (!prev || !next) return [];
  try {
    const now = (ctx && ctx.now) || Date.now();
    const hourB = Math.floor(now / HOUR);
    const out = [];
    const prevEm = new Set(arr(prev.aircraft).filter((a) => a.emergency).map((a) => `${a.hex}:${a.squawk}`));
    for (const a of arr(next.aircraft)) {
      const name = a.callsign || a.reg || a.hex.toUpperCase();
      if (a.emergency && !prevEm.has(`${a.hex}:${a.squawk}`)) {
        out.push({ key: `ac:emerg:${a.hex}:${a.squawk}:${hourB}`, kind: 'aircraft', severity: 'alert',
          title: `${name} squawking ${a.squawk || ''} (${a.emergency})`.replace('  ', ' '), detail: [a.operator, a.desc || a.type, isNum(a.altFt) ? `${a.altFt.toLocaleString('en-US')} ft` : ''].filter(Boolean).join(' · '),
          lat: a.lat, lon: a.lon, link: `https://globe.adsb.lol/?icao=${a.hex}` });
      }
    }
    const wasLow = new Set(arr(prev.aircraft).filter(isLowOverhead).map((a) => a.hex));
    for (const a of arr(next.aircraft).filter(isLowOverhead)) {
      if (wasLow.has(a.hex)) continue;
      const name = a.callsign || a.reg || a.hex.toUpperCase();
      out.push({ key: `ac:low:${a.hex}:${hourB}`, kind: 'aircraft', severity: 'info',
        title: `${a.kind === 'helicopter' ? 'Helicopter' : a.kind === 'military' ? 'Military aircraft' : 'Aircraft'} low over Ballard: ${name} at ${a.altFt.toLocaleString('en-US')} ft`,
        detail: [a.operator, a.desc || a.type].filter(Boolean).join(' · ') || undefined, lat: a.lat, lon: a.lon, link: `https://globe.adsb.lol/?icao=${a.hex}` });
      if (out.length >= 4) break;
    }
    return out;
  } catch { return []; }
};
// Low and close, excluding floatplanes (Kenmore Air's Lake Union traffic is routine) and anything on the ground.
function isLowOverhead(a) {
  return a && !a.onGround && isNum(a.altFt) && a.altFt > 0 && a.altFt < 1000 && a.distKm < 2 && a.kind !== 'seaplane';
}

// =================================================================== wildlife

const PAD_LAT = 0.009, PAD_LON = 0.0134; // ~1 km
const INAT_BOX = { nelat: BBOX.n + PAD_LAT, nelng: BBOX.e + PAD_LON, swlat: BBOX.s - PAD_LAT, swlng: BBOX.w - PAD_LON };
const INAT = 'https://api.inaturalist.org/v1';
const NOTABLE = /\b(eagle|osprey|hawk|falcon|kestrel|merlin|owl|heron|kingfisher|harbor seal|seal|sea lion|otter|orca|whale|porpoise|coyote|beaver|octopus|jelly|salmon|cormorant|pelican|loon|grebe|merganser|scoter|harlequin|murrelet|guillemot|dolphin|raccoon|opossum|deer|bat)\b/i;
const ROUTINE_MAMMAL = /\b(squirrel|rat|mouse|mice|vole|chipmunk|human)\b/i;

function inatQuery(extra = {}, now = Date.now()) {
  const q = new URLSearchParams({ ...Object.fromEntries(Object.entries(INAT_BOX).map(([k, v]) => [k, v.toFixed(4)])), d1: pacificDate(-14, now), captive: 'false', locale: 'en', ...extra });
  return q.toString();
}

export function normalizeObservation(r) {
  if (!r || !r.taxon || !r.id) return null;
  let lat = null, lon = null;
  if (r.geojson && Array.isArray(r.geojson.coordinates)) [lon, lat] = r.geojson.coordinates;
  else if (typeof r.location === 'string') [lat, lon] = r.location.split(',').map(Number);
  const t = r.time_observed_at ? Date.parse(r.time_observed_at) : r.observed_on ? fromPacific(r.observed_on) : null;
  const photo = arr(r.photos)[0];
  return {
    id: r.id,
    t: isNum(t) ? t : null,
    timeKnown: !!r.time_observed_at,
    observedOn: r.observed_on || null,
    created: r.created_at ? Date.parse(r.created_at) : null,
    taxon: { name: r.taxon.name, common: r.taxon.preferred_common_name || null, iconic: r.taxon.iconic_taxon_name || null, rank: r.taxon.rank || null },
    photo: photo && photo.url ? photo.url.replace('/square.', '/medium.') : null,
    photoCredit: photo && photo.attribution ? String(photo.attribution).slice(0, 160) : null,
    lat: isNum(lat) ? lat : null, lon: isNum(lon) ? lon : null, obscured: !!r.obscured,
    place: r.place_guess || null, url: r.uri || `https://www.inaturalist.org/observations/${r.id}`,
    user: r.user && r.user.login ? r.user.login : null, quality: r.quality_grade || null,
  };
}

export function buildWildlife(obsJson, speciesJson, iconicJson) {
  const observations = arr(obsJson && obsJson.results).map(normalizeObservation).filter(Boolean)
    .sort((a, b) => (b.t || 0) - (a.t || 0));
  const byIconic = {};
  for (const r of arr(iconicJson && iconicJson.results)) if (r.taxon && r.taxon.name) byIconic[r.taxon.name] = r.count;
  return {
    observations,
    counts: {
      total: isNum(obsJson && obsJson.total_results) ? obsJson.total_results : observations.length,
      species: isNum(speciesJson && speciesJson.total_results) ? speciesJson.total_results : new Set(observations.map((o) => o.taxon.name)).size,
      byIconic,
    },
    days: 14,
  };
}

async function fetchWildlife() {
  const obs = await get(`${INAT}/observations?${inatQuery({ photos: 'true', order_by: 'created_at', order: 'desc', per_page: '80' })}`, { timeout: 20000 });
  let species = null, iconic = null;
  const warnings = [];
  try { await sleep(1100); species = await get(`${INAT}/observations/species_counts?${inatQuery({ per_page: '1' })}`, { timeout: 15000 }); } catch (e) { warnings.push(`species count: ${e.message}`); }
  try { await sleep(1100); iconic = await get(`${INAT}/observations/iconic_taxa_counts?${inatQuery()}`, { timeout: 15000 }); } catch (e) { warnings.push(`group counts: ${e.message}`); }
  const out = buildWildlife(obs, species, iconic);
  if (warnings.length) out.warnings = warnings;
  return out;
}

const wildlifeDetect = (prev, next, ctx) => {
  if (!prev || !next) return [];
  try {
    const now = (ctx && ctx.now) || Date.now();
    const seen = new Set(arr(prev.observations).map((o) => o.id));
    const fresh = arr(next.observations).filter((o) => !seen.has(o.id) && isNum(o.created) && now - o.created < 12 * HOUR);
    const out = [];
    let infos = 0;
    for (const o of fresh) {
      const name = o.taxon.common || o.taxon.name;
      const notable = (o.taxon.iconic === 'Mammalia' && !ROUTINE_MAMMAL.test(name)) || NOTABLE.test(name);
      if (!notable && (o.quality !== 'research' || infos >= 3)) continue;
      if (!notable) infos++;
      out.push({ key: `inat:${o.id}`, t: o.t || o.created, kind: 'wildlife', severity: notable ? 'notice' : 'info',
        title: `${name} spotted${o.place ? ` near ${o.place.replace(/, Seattle, WA, US$/, '').replace(/, US$/, '')}` : ''}`,
        detail: [o.taxon.common ? o.taxon.name : null, o.user ? `by ${o.user} on iNaturalist` : null].filter(Boolean).join(' · ') || undefined,
        lat: o.obscured ? undefined : (o.lat ?? undefined), lon: o.obscured ? undefined : (o.lon ?? undefined), link: o.url });
      if (out.length >= 6) break;
    }
    return out;
  } catch { return []; }
};

// =================================================================== bridge odds

const DRAWBRIDGE = 'https://data.seattle.gov/resource/gm8h-9449.json';
const WINDOW_DAYS = 84;

/** US federal holidays (observed dates) for a year, as 'YYYY-MM-DD' -> name. */
export function federalHolidays(year) {
  const out = {};
  const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const nth = (y, m, weekday, n) => { let d = 1 + ((weekday - dow(y, m, 1) + 7) % 7); d += (n - 1) * 7; return d; };
  const last = (y, m, weekday) => { const dim = new Date(Date.UTC(y, m, 0)).getUTCDate(); return dim - ((dow(y, m, dim) - weekday + 7) % 7); };
  const fixed = (y, m, d, name) => {
    const w = dow(y, m, d);
    const t = new Date(Date.UTC(y, m - 1, d + (w === 6 ? -1 : w === 0 ? 1 : 0)));
    out[ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())] = name;
  };
  fixed(year, 1, 1, "New Year's Day");
  fixed(year + 1, 1, 1, "New Year's Day"); // may be observed on Dec 31 of `year`
  out[ymd(year, 1, nth(year, 1, 1, 3))] = 'Martin Luther King Jr. Day';
  out[ymd(year, 2, nth(year, 2, 1, 3))] = "Washington's Birthday";
  out[ymd(year, 5, last(year, 5, 1))] = 'Memorial Day';
  fixed(year, 6, 19, 'Juneteenth');
  fixed(year, 7, 4, 'Independence Day');
  out[ymd(year, 9, nth(year, 9, 1, 1))] = 'Labor Day';
  out[ymd(year, 10, nth(year, 10, 1, 2))] = 'Columbus Day';
  fixed(year, 11, 11, 'Veterans Day');
  out[ymd(year, 11, nth(year, 11, 4, 4))] = 'Thanksgiving Day';
  fixed(year, 12, 25, 'Christmas Day');
  return out;
}

/**
 * 33 CFR 117.1051(d)(2): the Ballard, Fremont and University bridges need not open 7-9 am and 4-6 pm Mon-Fri,
 * except all Federal holidays but Columbus Day, for vessels under 1000 tons. (d)(3): 11 pm-7 am needs 1 hour's notice.
 */
export function restrictionAt(t) {
  const p = pacificParts(t);
  const key = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  const hol = federalHolidays(p.y)[key];
  const exempt = hol && hol !== 'Columbus Day';
  const weekday = p.weekday >= 1 && p.weekday <= 5;
  const h = p.hh + p.mm / 60;
  const rush = weekday && !exempt && ((h >= 7 && h < 9) || (h >= 16 && h < 18));
  const night = h >= 23 || h < 7;
  return { rush, night, holiday: hol || null };
}

/** Next time the rush-hour restriction starts or ends after t (epoch ms), within 8 days. */
export function nextRestrictionChange(t) {
  const now = restrictionAt(t).rush;
  const p = pacificParts(t);
  for (let d = 0; d < 9; d++) {
    const date = new Date(Date.UTC(p.y, p.m - 1, p.d + d));
    for (const hh of [7, 9, 16, 18]) {
      const at = pacificToEpoch(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hh, 0, 0);
      if (at <= t) continue;
      if (restrictionAt(at).rush !== now) return { at, starts: !now };
    }
  }
  return null;
}

/** Merge sensor events that are really one opening (< 3 min between a close and the next open). */
export function mergeOpenings(rows) {
  const out = [];
  for (const r of rows.slice().sort((a, b) => a.open - b.open)) {
    const last = out[out.length - 1];
    if (last && isNum(last.close) && r.open - last.close < 3 * MIN) {
      last.close = Math.max(last.close, r.close ?? last.close);
      continue;
    }
    out.push({ ...r });
  }
  for (const o of out) o.minutes = isNum(o.close) ? Math.max(0, Math.round((o.close - o.open) / MIN)) : null;
  return out;
}

export function buildOdds(openings, now, windowStart) {
  const newest = openings.length ? Math.max(...openings.map((o) => o.open)) : now;
  // Whole Pacific days from windowStart up to the day before `newest` (the dataset lags about a day).
  const counts = Array.from({ length: 168 }, () => ({ n: 0, minutes: 0, withMin: 0 }));
  const slots = [0, 0, 0, 0, 0, 0, 0];
  const endDay = pacificDate(0, newest);
  let day = pacificDate(0, windowStart);
  let guard = 0;
  while (day < endDay && guard++ < 400) {
    const [y, m, d] = day.split('-').map(Number);
    slots[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]++;
    day = pacificDate(1, pacificToEpoch(y, m, d, 12));
  }
  const endT = fromPacific(endDay);
  let basis = 0;
  for (const o of openings) {
    if (o.open < windowStart || o.open >= endT) continue;
    const p = pacificParts(o.open);
    const c = counts[p.weekday * 24 + p.hh];
    c.n++;
    basis++;
    if (isNum(o.minutes)) { c.minutes += o.minutes; c.withMin++; }
  }
  const hourly = counts.map((c, i) => ({
    dow: Math.floor(i / 24), hour: i % 24,
    avgOpenings: slots[Math.floor(i / 24)] ? Math.round((c.n / slots[Math.floor(i / 24)]) * 100) / 100 : 0,
    avgMinutes: c.withMin ? Math.round((c.minutes / c.withMin) * 10) / 10 : null,
  }));
  const rateAt = (t) => { const p = pacificParts(t); return hourly[p.weekday * 24 + p.hh].avgOpenings; };
  // Expected openings per hour over the next 30 minutes (sample its midpoint, blending the two hours around it).
  const mid = now + 15 * MIN;
  const pm = pacificParts(mid);
  const frac = pm.mm / 60;
  const rate = (1 - frac) * rateAt(mid) + frac * rateAt(mid + HOUR);
  const cur = hourly[pacificParts(now).weekday * 24 + pacificParts(now).hh];
  const allMin = openings.map((o) => o.minutes).filter(isNum).sort((a, b) => a - b);
  const typicalMinutes = isNum(cur.avgMinutes) ? cur.avgMinutes : allMin.length ? allMin[allMin.length >> 1] : null;
  const r = restrictionAt(now);
  const next = nextRestrictionChange(now);
  let restrictionText = null;
  if (r.rush) restrictionText = `Rush-hour rule: no openings for boats under 1,000 tons until ${hm(next && next.at)}`;
  else if (next && next.starts && next.at - now <= 3 * HOUR) restrictionText = `Rush-hour closure to most boats from ${hm(next.at)}`;
  else if (r.night) restrictionText = 'Overnight: openings need an hour\'s notice to the drawtender';
  return {
    now: {
      expectedPerHour: Math.round(rate * 100) / 100,
      chanceNext30Min: Math.round((1 - Math.exp(-rate * 0.5)) * 100) / 100,
      typicalMinutes, restricted: r.rush, night: r.night, holiday: r.holiday,
    },
    next: next ? next.at : null, nextStarts: next ? next.starts : null, restrictionText,
    hourly, basis, newest,
  };
}

const oddsCache = { rows: null, at: 0 };
async function fetchBridgeOdds() {
  const now = Date.now();
  const since = now - WINDOW_DAYS * DAY;
  const q = new URLSearchParams({
    $select: 'entityname,opendatetime,closedatetime',
    $where: `entityname in('Ballard','Fremont') AND opendatetime > '${toPacificFloating(since)}'`,
    $order: 'opendatetime ASC', $limit: '50000',
  });
  // The dataset updates about once a day, so the rows are cached for 6 h; the odds are recomputed every fetch.
  let rows = oddsCache.rows;
  if (!rows || now - oddsCache.at > 6 * HOUR) {
    rows = await get(`${DRAWBRIDGE}?${q}`, { timeout: 25000 });
    if (!Array.isArray(rows) || !rows.length) throw new Error('drawbridge dataset returned no rows');
    oddsCache.rows = rows; oddsCache.at = now;
  }
  const by = { Ballard: [], Fremont: [] };
  for (const r of rows) {
    const open = fromPacific(r.opendatetime);
    if (!isNum(open) || !by[r.entityname]) continue;
    by[r.entityname].push({ open, close: fromPacific(r.closedatetime) });
  }
  const ballard = buildOdds(mergeOpenings(by.Ballard), now, since);
  const fremont = buildOdds(mergeOpenings(by.Fremont), now, since);
  return {
    windowDays: WINDOW_DAYS, basis: ballard.basis, hourly: ballard.hourly, now: ballard.now,
    next: ballard.next, nextStarts: ballard.nextStarts, restrictionText: ballard.restrictionText, newest: ballard.newest,
    fremont: { now: fremont.now, basis: fremont.basis },
    rule: '33 CFR 117.1051(d)',
  };
}

// =================================================================== definitions

export default [
  {
    id: 'aircraft', title: 'Aircraft overhead (ADS-B)', ttl: 15, idleTtl: 300, persist: false, fetch: fetchAircraft,
    metrics: (d) => ({ 'aircraft.count': isNum(d && d.count) ? d.count : null, 'aircraft.airborne': isNum(d && d.airborne) ? d.airborne : null }),
    detect: aircraftDetect,
  },
  {
    id: 'wildlife', title: 'Wildlife sightings (iNaturalist)', ttl: 1800, idleTtl: 3600, fetch: fetchWildlife,
    metrics: (d) => ({ 'wildlife.count14d': d && d.counts && isNum(d.counts.total) ? d.counts.total : null, 'wildlife.species14d': d && d.counts && isNum(d.counts.species) ? d.counts.species : null }),
    detect: wildlifeDetect,
  },
  {
    id: 'bridge-odds', title: 'Bridge opening odds (Seattle open data)', ttl: 900, idleTtl: 3600, daily: true, fetch: fetchBridgeOdds,
    metrics: (d) => ({ 'bridgeOdds.chance30': d && d.now && isNum(d.now.chanceNext30Min) ? d.now.chanceNext30Min : null }),
  },
];

export const _test = { normalizeAircraft, buildAircraft, aircraftKind, aircraftDetect, normalizeObservation, buildWildlife, wildlifeDetect, federalHolidays, restrictionAt, nextRestrictionChange, mergeOpenings, buildOdds, fromUTC };
