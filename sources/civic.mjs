// Civic group: public safety, community news, events and city data for Ballard.
// All output timestamps are epoch ms. Socrata floating timestamps and the SFD realtime911 page are
// Pacific wall-clock (fromPacific); USGS, DataCapable and RSS dates are absolute (UTC / explicit offsets).
import {
  get, discard, sleep, fromPacific, fromUTC, pacificDate, pacificParts, toPacificFloating,
  parseFeed, stripTags, decodeEntities, fixMojibake, haversineKm, inBbox, round, num, readState, writeState, CENTER, BBOX,
} from '../lib.mjs';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const SODA = 'https://data.seattle.gov/resource/';

// ---------- local helpers ----------

/** Socrata SODA 2.0 GET. params keys keep their literal '$'. */
function soda(dataset, params, opts = {}) {
  const q = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return get(`${SODA}${dataset}.json?${q}`, { timeout: 20000, ...opts });
}

/** Validated Seattle-area coordinates (rejects 'REDACTED', '-1.0', 0, ...). */
function coords(lat, lon) {
  const la = num(lat), lo = num(lon);
  if (la == null || lo == null || la < 45 || la > 50 || lo < -126 || lo > -119) return [null, null];
  return [la, lo];
}

const distKm = (lat, lon) => (lat == null || lon == null ? null : round(haversineKm(lat, lon), 2));

/** 'W COMMODORE WAY' / '8th Ave Nw / Nw Market St' -> 'W Commodore Way' / '8th Ave NW / NW Market St'. */
function titleCase(s) {
  if (s == null) return null;
  return String(s).trim().toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\b(Nw|Ne|Sw|Se)\b/g, (x) => x.toUpperCase())
    .replace(/'([A-Z])\b/g, (m, c) => `'${c.toLowerCase()}`) // Hattie'S -> Hattie's
    .replace(/(\d+)xx Block Of\b/gi, '$1XX block of');
}

const clean = (s) => {
  if (s == null) return null;
  const v = fixMojibake(decodeEntities(String(s))).replace(/\s+/g, ' ').trim();
  return v || null;
};

const newestT = (arr, key = 't') => arr.reduce((m, x) => (Number.isFinite(x[key]) && (m == null || x[key] > m) ? x[key] : m), null);

// ======================================================================================
// fire911: Socrata kzjm-xkqj (located, ~5-10 min lag) + realtime911 HTML (units/level/active, live)
// ======================================================================================

const RT911_BASE = 'https://web.seattle.gov/sfd/realtime911/getRecsForDatePub.asp';
const RT911_URL = `${RT911_BASE}?action=Today&incDate=&rad1=des`;
const rt911 = { t: 0, byId: null, inflight: null }; // 60 s sub-cache of the parsed HTML
// action=Today lists only the current Pacific calendar day. Socrata rows from before midnight (most of the 24 h
// window) and calls still active across midnight are only on the previous day's page (incDate=M/D/YYYY).
const rt911Prev = { date: null, t: 0, byId: null, inflight: null };

function parseRt911(html) {
  const byId = new Map();
  for (const tr of html.matchAll(/<tr id=row_\d+[^>]*>([\s\S]*?)<\/tr>/gi)) {
    try {
      const cells = [...tr[1].matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi)].map((c) => ({
        cls: (c[1].match(/class="?([\w-]+)/i) || [])[1] || '',
        text: stripTags(c[2]),
      }));
      if (cells.length < 6) continue;
      const id = cells[1].text;
      if (!/^F\d+$/i.test(id)) continue;
      const t = fromPacific(cells[0].text); // 'M/D/YYYY h:mm:ss AM' Pacific wall-clock
      const units = cells[3].text.split(/\s+/).filter(Boolean);
      const level = num(cells[2].text);
      const active = cells.some((c) => c.cls.toLowerCase() === 'active');
      const cur = byId.get(id);
      if (cur) { // the same incident can span several rows (one per unit group)
        for (const u of units) cur.units.add(u);
        if (level != null && (cur.level == null || level > cur.level)) cur.level = level;
        cur.active = cur.active || active;
        if (t != null && (cur.t == null || t < cur.t)) cur.t = t;
      } else {
        byId.set(id, { id, t, level, active, units: new Set(units), address: cells[4].text, type: cells[5].text });
      }
    } catch { /* skip a malformed row */ }
  }
  return byId;
}

async function getRt911() {
  if (rt911.byId && Date.now() - rt911.t < 60e3) return rt911;
  if (!rt911.inflight) {
    rt911.inflight = get(RT911_URL, { as: 'text', timeout: 20000 })
      .then((html) => {
        const byId = parseRt911(html);
        if (!byId.size && !/Incident #/i.test(html)) throw new Error('realtime911: unexpected page layout');
        rt911.byId = byId;
        rt911.t = Date.now();
        return rt911;
      })
      .finally(() => { rt911.inflight = null; });
  }
  return rt911.inflight;
}

/** Parsed page for the previous Pacific day. Its active flags only change for calls spanning midnight. */
function getRt911Prev() {
  const date = pacificDate(-1);
  const maxAge = pacificParts().hh < 3 ? 2 * 60e3 : 15 * 60e3;
  if (rt911Prev.byId && rt911Prev.date === date && Date.now() - rt911Prev.t < maxAge) return Promise.resolve(rt911Prev.byId);
  if (!rt911Prev.inflight) {
    const [y, m, d] = date.split('-').map(Number);
    rt911Prev.inflight = get(`${RT911_BASE}?incDate=${encodeURIComponent(`${m}/${d}/${y}`)}&rad1=des`, { as: 'text', timeout: 20000 })
      .then((html) => {
        const byId = parseRt911(html);
        if (!byId.size && !/Incident #/i.test(html)) throw new Error('realtime911 (previous day): unexpected page layout');
        Object.assign(rt911Prev, { date, t: Date.now(), byId });
        return byId;
      })
      .finally(() => { rt911Prev.inflight = null; });
  }
  return rt911Prev.inflight;
}

// Heuristic: an SFD address that is in Ballard (for live rows that Socrata has not ingested yet).
const BALLARD_ANY = /\b(Ballard|Shilshole|Leary|Market St)\b/i;
const BALLARD_NW_NAMED = /\b(Seaview|Golden Gardens|Alonzo|Sycamore|Mary Ave|Jones Ave|Russell Ave|Tallman|Dock Pl|Vernon Pl|Ione Pl|Brygger|Canal St)\b/i;
function looksBallard(addr) {
  if (!addr) return false;
  if (BALLARD_ANY.test(addr)) return true;
  if (!/\bNw\b/i.test(addr)) return false;
  if (BALLARD_NW_NAMED.test(addr)) return true;
  for (const m of addr.matchAll(/\bNw (\d{2,3})(?:st|nd|rd|th) St\b/gi)) if (+m[1] >= 45 && +m[1] <= 85) return true;
  const h = addr.match(/^(\d{4,5})\s+(\d{1,2})(?:st|nd|rd|th) Ave Nw\b/i); // '6512 4th Ave Nw'
  return !!(h && +h[1] >= 4500 && +h[1] <= 8599 && +h[2] <= 36);
}

async function fetchFire911() {
  const now = Date.now();
  const since = toPacificFloating(now - DAY); // datetime is floating Pacific
  // The realtime911 page is sometimes very slow (seen: 18 s). Wait at most 8 s for it; a slower fetch keeps
  // running and fills the sub-cache for the next call, and this call uses the previous page (<= 10 min old).
  const htmlP = getRt911().then((v) => ({ status: 'fulfilled', value: v }), (e) => ({ status: 'rejected', reason: e }));
  const prevP = getRt911Prev().then((v) => ({ status: 'fulfilled', value: v }), (e) => ({ status: 'rejected', reason: e }));
  const [socR, maxR, htmlR, prevR] = await Promise.all([
    soda('kzjm-xkqj', {
      $where: `within_circle(report_location,${CENTER.lat},${CENTER.lon},2000) AND datetime > '${since}'`,
      $order: 'datetime DESC',
      $limit: 100,
    }).then((v) => ({ status: 'fulfilled', value: v }), (e) => ({ status: 'rejected', reason: e })),
    soda('kzjm-xkqj', { $select: 'max(datetime) as newest' }, { timeout: 10000, retries: 0 })
      .then((v) => ({ status: 'fulfilled', value: v }), (e) => ({ status: 'rejected', reason: e })),
    Promise.race([htmlP, sleep(8000).then(() => ({ status: 'rejected', reason: new Error('slow response (>8 s)') }))]),
    Promise.race([prevP, sleep(8000).then(() => ({ status: 'rejected', reason: new Error('slow response (>8 s)') }))]),
  ]);
  const warnings = [];
  const staleOk = rt911.byId && Date.now() - rt911.t < 10 * 60e3;
  if (socR.status === 'rejected' && htmlR.status === 'rejected' && !staleOk) {
    throw new Error(`Socrata: ${socR.reason.message}; realtime911: ${htmlR.reason.message}`);
  }
  if (socR.status === 'rejected') warnings.push(`Socrata kzjm-xkqj failed (${socR.reason.message}); showing unlocated live rows only`);
  if (htmlR.status === 'rejected') {
    // Serve a slightly stale parse if we have one, otherwise no enrichment.
    if (staleOk) warnings.push(`realtime911 ${htmlR.reason.message}; using page from ${Math.max(1, Math.round((Date.now() - rt911.t) / 60e3))} min ago`);
    else warnings.push(`realtime911 ${htmlR.reason.message}; units/level/active unavailable`);
  }
  const todayLive = htmlR.status === 'fulfilled' ? htmlR.value.byId : (staleOk ? rt911.byId : null);
  // Yesterday's page (a slightly older copy is fine: its rows only lose their active flag over time).
  const prevLive = prevR.status === 'fulfilled' ? prevR.value
    : rt911Prev.byId && rt911Prev.date === pacificDate(-1) ? rt911Prev.byId : null;
  const live = mergeRt911(todayLive, prevLive);
  if (!prevLive && socR.status === 'fulfilled' && Array.isArray(socR.value)
    && socR.value.some((r) => { const t = fromPacific(r && r.datetime); return t != null && t < fromPacific(pacificDate(0)); })) {
    warnings.push(`realtime911 previous day ${prevR.reason ? prevR.reason.message : 'unavailable'}; units/level/active missing for calls before midnight`);
  }

  const out = buildFire911({
    socOk: socR.status === 'fulfilled', socRows: socR.value,
    maxRows: maxR.status === 'fulfilled' ? maxR.value : null,
    live, activeKnown: todayLive != null, now,
  });
  if (warnings.length) out.warnings = warnings;
  return out;
}

/** Pure: today's and the previous day's parsed realtime911 pages -> one Map (today's rows win), or null. */
function mergeRt911(todayLive, prevLive) {
  return todayLive || prevLive ? new Map([...(prevLive || []), ...(todayLive || [])]) : null;
}

/**
 * Pure: join the Socrata kzjm-xkqj rows with the live realtime911 rows -> `fire911` output (without warnings).
 * socOk: the Socrata query succeeded; socRows: its rows; maxRows: the citywide max(datetime) query rows (or null);
 * live: mergeRt911() Map or null; activeKnown: today's page (or a <= 10 min old copy) was available.
 */
function buildFire911({ socOk, socRows, maxRows, live, activeKnown, now }) {
  const incidents = [];
  const seen = new Set();
  for (const r of (socOk && Array.isArray(socRows) ? socRows : [])) {
    try {
      const id = r.incident_number;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      let [lat, lon] = coords(r.latitude, r.longitude);
      if (lat == null && r.report_location && Array.isArray(r.report_location.coordinates)) {
        [lat, lon] = coords(r.report_location.coordinates[1], r.report_location.coordinates[0]);
      }
      const h = live && live.get(id);
      incidents.push({
        id,
        type: clean(r.type) || (h && h.type) || null,
        address: titleCase(r.address || (h && h.address)),
        t: (h && h.t) || fromPacific(r.datetime), // HTML has seconds; both are Pacific wall-clock
        lat, lon,
        units: h && h.units.size ? [...h.units].join(' ') : null,
        level: h ? h.level : null,
        active: h ? h.active : null,
        distKm: distKm(lat, lon),
        located: lat != null,
      });
    } catch { /* skip bad row */ }
  }

  // Live rows not yet in Socrata. Socrata's citywide max(datetime) tells us what has been ingested:
  // anything older that is missing from our circle query is simply outside 2 km.
  if (live) {
    let ingestedTo = maxRows && maxRows[0] ? fromPacific(maxRows[0].newest) : null;
    if (ingestedTo == null) ingestedTo = now - 30 * 60e3;
    for (const h of live.values()) {
      if (seen.has(h.id) || h.t == null || h.t < now - DAY) continue;
      if (socOk && h.t < ingestedTo - 10 * 60e3) continue;
      if (!looksBallard(h.address)) continue;
      seen.add(h.id);
      incidents.push({
        id: h.id, type: h.type || null, address: titleCase(h.address), t: h.t, lat: null, lon: null,
        units: h.units.size ? [...h.units].join(' ') : null, level: h.level, active: h.active, distKm: null, located: false,
      });
    }
  }

  incidents.sort((a, b) => (b.t || 0) - (a.t || 0));
  // Active flags are only current when today's page (live, or a copy <= 10 min old) was used; otherwise the
  // count is unknown, not 0.
  return {
    incidents,
    activeCount: activeKnown ? incidents.filter((i) => i.active === true).length : null,
    activeKnown,
    newest: newestT(incidents),
  };
}

// ======================================================================================
// crime: SPD tazs-3rd5, Ballard North/South, last 7 days by report_date_time
// ======================================================================================

const CAT_RANK = { PERSON: 3, PROPERTY: 2, SOCIETY: 1 };
const usableBlock = (b) => (b && /[a-z0-9]/i.test(b) && !/REDACTED/i.test(b) ? titleCase(b) : null);

async function fetchCrime() {
  const now = Date.now();
  const rows = await soda('tazs-3rd5', {
    $select: 'report_number,report_date_time,offense_date,nibrs_offense_code_description,nibrs_crime_against_category,block_address,latitude,longitude,beat',
    $where: `neighborhood in('BALLARD NORTH','BALLARD SOUTH') AND report_date_time > '${toPacificFloating(now - 7 * DAY)}'`,
    $order: 'report_date_time DESC',
    $limit: 1000,
  });
  return parseCrime(rows, now);
}

/** Pure: tazs-3rd5 rows -> `crime` output (lagHours is relative to `now`). */
function parseCrime(rows, now) {
  if (!Array.isArray(rows)) throw new Error('SPD crime: unexpected response');
  const byId = new Map();
  for (const r of rows) {
    try {
      const id = r.report_number;
      if (!id) continue;
      let g = byId.get(id);
      if (!g) {
        const [lat, lon] = coords(r.latitude, r.longitude);
        const block = usableBlock(r.block_address);
        g = { id, t: fromPacific(r.report_date_time), offenseT: null, offenses: [], cats: [], block, lat, lon, beat: r.beat || null };
        byId.set(id, g);
      }
      const ot = fromPacific(r.offense_date);
      if (ot != null && (g.offenseT == null || ot < g.offenseT)) g.offenseT = ot;
      const off = clean(r.nibrs_offense_code_description);
      if (off && !g.offenses.includes(off)) g.offenses.push(off);
      const cat = r.nibrs_crime_against_category;
      if (cat && !g.cats.includes(cat)) g.cats.push(cat);
      if (g.lat == null) [g.lat, g.lon] = coords(r.latitude, r.longitude);
      if (!g.block) g.block = usableBlock(r.block_address);
    } catch { /* skip bad row */ }
  }
  const byCategory = { PROPERTY: 0, PERSON: 0, SOCIETY: 0 };
  const reports = [];
  for (const g of byId.values()) {
    const ranked = g.cats.filter((c) => CAT_RANK[c]).sort((a, b) => CAT_RANK[b] - CAT_RANK[a]);
    const category = ranked[0] || g.cats[0] || null;
    if (byCategory[category] != null) byCategory[category]++;
    const offenses = g.offenses.length > 1 ? g.offenses.filter((o) => !/^Not Reportable/i.test(o)) : g.offenses;
    reports.push({ id: g.id, t: g.t, offenseT: g.offenseT, offenses, category, block: g.block, lat: g.lat, lon: g.lon, beat: g.beat });
  }
  reports.sort((a, b) => (b.t || 0) - (a.t || 0));
  const newest = newestT(reports);
  return {
    reports: reports.slice(0, 80),
    byCategory,
    newest,
    lagHours: newest != null ? round((now - newest) / HOUR, 1) : null,
  };
}

// ======================================================================================
// quakes: USGS FDSN
// ======================================================================================

function usgsUrl({ radiusKm, days, minMag, limit }) {
  return `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=${CENTER.lat}&longitude=${CENTER.lon}` +
    `&maxradiuskm=${radiusKm}&starttime=NOW-${days}days&minmagnitude=${minMag}&orderby=time&limit=${limit}`;
}

function mapQuake(f) {
  const p = f.properties || {};
  const [lon, lat, depth] = (f.geometry && f.geometry.coordinates) || [];
  if (!Number.isFinite(p.time) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    id: f.id,
    mag: round(num(p.mag), 2),
    place: p.place || null,
    t: p.time, // epoch ms UTC
    depthKm: round(num(depth), 1),
    lat: round(lat, 4),
    lon: round(lon, 4),
    url: p.url || null,
    felt: Number.isFinite(p.felt) ? p.felt : null,
    distKm: round(haversineKm(lat, lon), 1),
  };
}

async function fetchQuakes() {
  const [a, b] = await Promise.allSettled([
    get(usgsUrl({ radiusKm: 150, days: 7, minMag: 1.0, limit: 30 })),
    get(usgsUrl({ radiusKm: 300, days: 30, minMag: 2.5, limit: 10 })),
  ]);
  return buildQuakes(a, b);
}

/** Pure: settled [recent 150 km, notable 300 km] USGS GeoJSON -> `quakes` output. */
function buildQuakes(a, b) {
  if (a.status === 'rejected' && b.status === 'rejected') throw new Error(`USGS: ${a.reason.message}`);
  const list = (r, max) => (r.status === 'fulfilled' && r.value && Array.isArray(r.value.features)
    ? r.value.features.map((f) => { try { return mapQuake(f); } catch { return null; } }).filter(Boolean).sort((x, y) => y.t - x.t).slice(0, max)
    : []);
  const out = { recent: list(a, 30), notable: list(b, 10) };
  const warnings = [];
  if (a.status === 'rejected') warnings.push(`recent (150 km) query failed: ${a.reason.message}`);
  if (b.status === 'rejected') warnings.push(`notable (300 km) query failed: ${b.reason.message}`);
  if (warnings.length) out.warnings = warnings;
  return out;
}

// ======================================================================================
// outages: Seattle City Light via DataCapable
// ======================================================================================

const epochOrNull = (v) => { const n = num(v); return n != null && n > 1e11 ? n : null; };

async function fetchOutages() {
  const [evR, stR] = await Promise.allSettled([
    get('https://utilisocial.io/datacapable/v2/p/scl/map/events', { timeout: 15000 }),
    get('https://utilisocial.io/datacapable/v2/p/scl/map/stats', { timeout: 10000 }),
  ]);
  return buildOutages(evR, stR);
}

/** Pure: settled [DataCapable events, stats] -> `outages` output. */
function buildOutages(evR, stR) {
  if (evR.status === 'rejected') throw new Error(`SCL events: ${evR.reason.message}`);
  const events = Array.isArray(evR.value) ? evR.value : [];
  if (!Array.isArray(evR.value)) throw new Error('SCL events: unexpected response');
  const ballard = [];
  let customers = 0;
  for (const e of events) {
    try {
      const n = num(e.numPeople) || 0;
      customers += n;
      const [lat, lon] = coords(e.latitude, e.longitude);
      if (lat == null || !inBbox(lat, lon, 1)) continue;
      const rings = e.polygons && Array.isArray(e.polygons.rings) ? e.polygons.rings : null;
      const ring = rings && Array.isArray(rings[0])
        ? rings[0].filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map(([x, y]) => [round(y, 5), round(x, 5)])
        : null;
      ballard.push({
        id: e.id,
        start: epochOrNull(e.startTime),
        updated: epochOrNull(e.lastUpdatedTime),
        etr: epochOrNull(e.etrTime),
        customers: n,
        status: e.status || null,
        cause: e.cause || null,
        lat, lon,
        ring: ring && ring.length ? ring : null,
      });
    } catch { /* skip bad row */ }
  }
  ballard.sort((a, b) => (b.customers - a.customers) || ((b.start || 0) - (a.start || 0)));
  let updated = stR.status === 'fulfilled' && stR.value ? epochOrNull(stR.value.lastUpdatedTime) : null;
  const out = { ballard, citywide: { count: events.length, customers }, updated };
  if (updated == null) {
    out.updated = events.reduce((m, e) => Math.max(m, epochOrNull(e.lastUpdatedTime) || 0), 0) || null;
    if (stR.status === 'rejected') out.warnings = [`SCL stats failed: ${stR.reason.message}`];
  }
  return out;
}

// ======================================================================================
// news: merged RSS
// ======================================================================================

const NEWS_FEEDS = [
  { name: 'My Ballard', url: 'https://www.myballard.com/feed/', always: true },
  { name: 'PhinneyWood', url: 'https://phinneywood.com/feed/' },
  { name: 'Seattle Times', url: 'https://www.seattletimes.com/seattle-news/feed/', citywide: true },
  { name: 'SPD Blotter', url: 'https://spdblotter.seattle.gov/feed/', citywide: true },
  { name: 'SFD Fireline', url: 'https://fireline.seattle.gov/feed/', citywide: true },
  { name: 'SDOT Blog', url: 'https://sdotblog.seattle.gov/feed/', citywide: true },
  { name: 'Seattle Parks', url: 'https://parkways.seattle.gov/feed/', citywide: true },
  { name: 'Google News', url: 'https://news.google.com/rss/search?q=%22Ballard%22+Seattle+when:7d&hl=en-US&gl=US&ceid=US:en', google: true },
];
const BALLARD_RE = /\b(Ballard|Golden Gardens|Shilshole|Crown Hill|Loyal Heights|Sunset Hill|Whittier Heights|Nordic Museum|Ballard Locks)\b/i;
const NOISE_RE = /(maxpreps|nfhs)/i; // no \b: must also catch 'nfhsnetwork.com'
const HS_GAME_RE = /\b(JV|Junior Varsity|Varsity|Middle School)\b.*\b(Basketball|Football|Soccer|Volleyball|Baseball|Softball|Wrestling|Swimming)\b/i; // game-page noise

const normTitle = (s) => String(s || '').toLowerCase().replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

function cleanSummary(s) {
  if (!s) return null;
  let v = s.includes('<') ? stripTags(s) : s; // some feeds double-encode their HTML
  v = v.replace(/\s*The post .{0,300}? appeared first on .*$/i, '')
    .replace(/\s*(\.\.\.|…)?\s*(Read more|Continue reading)\b.*$/i, '…')
    .replace(/\s*\[(…|&hellip;|\.\.\.)\]\s*$/, '…')
    .replace(/\s+/g, ' ').trim();
  if (!v || v === '…') return null;
  return v.length > 280 ? v.slice(0, 277).replace(/\s+\S*$/, '') + '…' : v;
}

function cleanLink(link) {
  try {
    const u = new URL(link);
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch { return link || null; }
}

async function fetchNews() {
  return buildNews(await Promise.allSettled(NEWS_FEEDS.map((f) => get(f.url, { as: 'text', timeout: 15000 }))));
}

/** Pure: settled feed texts, in NEWS_FEEDS order -> `news` output. */
function buildNews(results) {
  const feeds = [];
  const items = [];
  const seen = new Set();
  results.forEach((r, i) => {
    const f = NEWS_FEEDS[i];
    if (r.status === 'rejected') { feeds.push({ name: f.name, ok: false, count: 0, error: r.reason.message }); return; }
    let parsed;
    try { parsed = parseFeed(r.value); } catch (e) { feeds.push({ name: f.name, ok: false, count: 0, error: `parse: ${e.message}` }); return; }
    if (!parsed.length && !/<(rss|feed)[\s>]/i.test(r.value)) { feeds.push({ name: f.name, ok: false, count: 0, error: 'not an RSS/Atom feed' }); return; }
    feeds.push({ name: f.name, ok: true, count: parsed.length });
    let mapped = [];
    for (const it of parsed) {
      try {
        if (!it.title || it.t == null) continue;
        let title = fixMojibake(it.title);
        let source = f.name;
        let summary = f.google ? null : cleanSummary(fixMojibake(it.summary || ''));
        if (f.google) {
          let host = '';
          try { host = new URL(it.link).host; } catch { /* no usable link */ }
          if (NOISE_RE.test(title) || NOISE_RE.test(it.source || '') || NOISE_RE.test(host) || HS_GAME_RE.test(title)) continue;
          const src = it.source && title.endsWith(` - ${it.source}`) ? it.source : (title.match(/ - ([^-]+)$/) || [])[1];
          if (src) { title = title.slice(0, title.length - src.length - 3).trim(); source = src.trim(); }
        }
        const ballard = !!f.always || BALLARD_RE.test(title) || BALLARD_RE.test(summary || '');
        mapped.push({ source, title, link: cleanLink(it.link), t: it.t, summary, ballard });
      } catch { /* skip bad item */ }
    }
    mapped.sort((a, b) => b.t - a.t);
    if (f.citywide) mapped = mapped.filter((m, idx) => m.ballard || idx < 3);
    for (const m of mapped) {
      const key = normTitle(m.title);
      if (!key || seen.has(key)) continue; // direct feeds come before Google News, so they win
      seen.add(key);
      items.push(m);
    }
  });
  if (!feeds.some((f) => f.ok)) throw new Error(`all news feeds failed: ${feeds.map((f) => `${f.name}: ${f.error}`).join('; ')}`);
  items.sort((a, b) => b.t - a.t);
  return { items: items.slice(0, 60), feeds };
}

// ======================================================================================
// reddit: r/Ballard new + r/Seattle search "ballard" (Atom)
// Measured quota (unauthenticated, per IP): 1 request per clock minute; x-ratelimit-reset counts down
// to the next minute (boundary jitter ~1-2 s). A 429 does not penalize the next window. So requests
// are serialized and spaced by the reset header + 3 s (never < 4 s apart). A sub that cannot be fetched
// within this call's time budget is fetched in the background into a sub-cache and served from there
// on the next refresh. Pacing and the sub-cache persist in data/reddit.json across restarts.
// ======================================================================================

const REDDIT = [
  { sub: 'r/Ballard', url: 'https://www.reddit.com/r/Ballard/new/.rss' },
  { sub: 'r/Seattle', url: 'https://www.reddit.com/r/Seattle/search.rss?q=ballard&restrict_sr=on&sort=new&t=month' },
];
const REDDIT_STATE = 'reddit.json';
const REDDIT_BUDGET_MS = 36000; // server deadline is 45 s
const reddit = { nextAt: 0, cache: {}, lock: Promise.resolve(), bg: new Set(), loaded: false };

function redditLoad() {
  if (reddit.loaded) return;
  reddit.loaded = true;
  const s = readState(REDDIT_STATE, null);
  if (s && typeof s === 'object') {
    if (Number.isFinite(s.nextAt) && s.nextAt < Date.now() + 10 * 60e3) reddit.nextAt = Math.max(reddit.nextAt, s.nextAt);
    if (s.cache && typeof s.cache === 'object') {
      for (const src of REDDIT) {
        const c = s.cache[src.sub];
        if (c && Array.isArray(c.items) && Number.isFinite(c.t) && !reddit.cache[src.sub]) reddit.cache[src.sub] = c;
      }
    }
  }
}
const redditSave = () => writeState(REDDIT_STATE, { nextAt: reddit.nextAt, cache: reddit.cache });

function redditLocked(fn) {
  const run = reddit.lock.then(fn, fn);
  reddit.lock = run.catch(() => {});
  return run;
}

async function redditFetchOne(src) {
  let res;
  try {
    res = await get(src.url, { as: 'response', retries: 0, timeout: 12000, headers: { Accept: 'application/atom+xml,application/xml;q=0.9,*/*;q=0.8' } });
  } catch (e) {
    reddit.nextAt = Date.now() + 65000;
    redditSave();
    throw e;
  }
  const remaining = parseFloat(res.headers.get('x-ratelimit-remaining'));
  const reset = parseFloat(res.headers.get('x-ratelimit-reset'));
  const toWindow = Number.isFinite(reset) ? reset * 1000 + 3000 : 65000;
  let gap = Number.isFinite(remaining) && remaining >= 1 ? 4000 : toWindow;
  if (res.status === 403) gap = 5 * 60e3; // blocked: back off harder
  reddit.nextAt = Date.now() + Math.max(4000, gap);
  if (!res.ok) {
    redditSave();
    await discard(res);
    const e = new Error(`HTTP ${res.status} from reddit`);
    e.status = res.status;
    throw e;
  }
  const xml = await res.text();
  const items = redditItems(xml, src.sub);
  if (!items.length && !/<feed[\s>]/i.test(xml)) { redditSave(); throw new Error('reddit: not an Atom feed'); }
  reddit.cache[src.sub] = { items, t: Date.now() };
  redditSave();
  return items;
}

/** Pure: a reddit Atom feed -> `reddit` item rows for `sub`. */
function redditItems(xml, sub) {
  const items = [];
  for (const it of parseFeed(xml)) {
    if (!it.title || !it.link || it.t == null) continue;
    items.push({ sub, title: fixMojibake(it.title), link: it.link, t: it.t, author: it.author ? it.author.replace(/^\//, '') : null });
  }
  return items;
}

function redditBackground(src) {
  if (reddit.bg.has(src.sub)) return;
  reddit.bg.add(src.sub);
  setTimeout(() => {
    redditLocked(async () => {
      const w = reddit.nextAt - Date.now();
      if (w > 0) await sleep(w);
      await redditFetchOne(src);
    }).catch(() => {}).finally(() => reddit.bg.delete(src.sub));
  }, Math.max(0, reddit.nextAt - Date.now())).unref();
}

async function fetchReddit({ prev }) {
  redditLoad();
  const start = Date.now();
  const warnings = [];
  const order = [...REDDIT].sort((a, b) => ((reddit.cache[a.sub] || {}).t || 0) - ((reddit.cache[b.sub] || {}).t || 0));
  for (const src of order) {
    if (reddit.bg.size) continue; // a deferred background fetch owns the next quota slot; serve the sub-cache meanwhile
    await redditLocked(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const wait = Math.max(0, reddit.nextAt - Date.now());
        if (Date.now() - start + wait + 6000 > REDDIT_BUDGET_MS) {
          redditBackground(src); // silent unless the sub ends up with no data or stale data (below)
          return;
        }
        if (wait > 0) await sleep(wait);
        try {
          await redditFetchOne(src);
          return;
        } catch (e) {
          if (e.status === 429 && attempt === 0) continue; // nextAt now points past the reset
          warnings.push(`${src.sub}: ${e.message}`);
          return;
        }
      }
    });
  }
  const items = [];
  for (const src of REDDIT) {
    const c = reddit.cache[src.sub];
    if (c) {
      items.push(...c.items);
      if (Date.now() - c.t > 2 * 1800e3) warnings.push(`${src.sub}: items as of ${Math.round((Date.now() - c.t) / 60e3)} min ago`);
    } else if (prev && Array.isArray(prev.items) && prev.items.some((i) => i.sub === src.sub)) {
      items.push(...prev.items.filter((i) => i.sub === src.sub));
      warnings.push(`${src.sub}: showing previous items`);
    } else if (reddit.bg.has(src.sub)) {
      warnings.push(`${src.sub}: pending (reddit allows ~1 request/min; fetching in background)`);
    }
  }
  if (!items.length && !REDDIT.some((s) => reddit.cache[s.sub])) {
    if (prev && Array.isArray(prev.items)) return { ...prev, warnings };
    throw new Error(`reddit unavailable: ${warnings.join('; ')}`);
  }
  const seen = new Set();
  const out = {
    items: items.filter((i) => (seen.has(i.link) ? false : seen.add(i.link))).sort((a, b) => b.t - a.t).slice(0, 30),
  };
  if (warnings.length) out.warnings = warnings;
  return out;
}

// ======================================================================================
// events: Visit Ballard (The Events Calendar REST) + SPL Ballard Branch (Trumba)
// ======================================================================================

const SPL_BALLARD_ADDR = '5614 22nd Ave NW';

async function fetchVisitBallard(warnings = []) {
  let url = `https://www.visitballard.com/wp-json/tribe/events/v1/events?per_page=50&start_date=${pacificDate(0)}&end_date=${pacificDate(7)}`;
  const out = [];
  // Up to 4 sequential pages at 20 s (+retry) each could run past the server's 45 s deadline, which would fail the
  // whole source and throw away SPL too. Budget the paging and keep the pages already fetched.
  const budgetEnd = Date.now() + 32000;
  for (let page = 0; page < 4 && url; page++) {
    const left = budgetEnd - Date.now();
    let j;
    if (page) {
      if (left < 3000) { warnings.push(`Visit Ballard: stopped after ${page} page(s), upstream is slow`); break; }
      try { j = await get(url, { timeout: Math.min(15000, left), retries: 0 }); } catch (e) {
        warnings.push(`Visit Ballard page ${page + 1} failed (${e.message}); showing the first ${page}`);
        break;
      }
    } else j = await get(url, { timeout: 15000 });
    if (!j || !Array.isArray(j.events)) {
      if (page) { warnings.push(`Visit Ballard page ${page + 1}: unexpected response`); break; }
      throw new Error('Visit Ballard: unexpected response');
    }
    out.push(...mapVisitBallardEvents(j.events));
    url = j.next_rest_url || null;
  }
  return out;
}

/** Pure: Visit Ballard (The Events Calendar REST) `events` array -> `events` rows. */
function mapVisitBallardEvents(list) {
  const out = [];
  for (const e of list) {
    try {
      const start = fromUTC(e.utc_start_date) ?? fromPacific(e.start_date);
      if (start == null) continue;
      const end = fromUTC(e.utc_end_date) ?? fromPacific(e.end_date);
      const v = Array.isArray(e.venue) ? e.venue[0] : e.venue;
      const title = clean(e.title);
      out.push({
        id: `vb-${e.id}`,
        title,
        start,
        end: end != null && end >= start ? end : null,
        allDay: !!e.all_day,
        venue: v && typeof v === 'object' ? clean(v.venue) : null,
        address: v && typeof v === 'object' ? clean(String(v.address || '').replace(/[\s,]+$/, '')) : null,
        cost: clean(e.cost),
        url: e.url || null,
        source: 'Visit Ballard',
        canceled: /\bcancell?ed\b/i.test(title || ''),
        category: Array.isArray(e.categories) && e.categories[0] ? clean(e.categories[0].name) : null,
      });
    } catch { /* skip bad event */ }
  }
  return out;
}

function trumbaTime(dt, off) {
  if (!dt) return null;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(off || '');
  if (m && /T\d{2}:\d{2}/.test(dt)) {
    const t = Date.parse(`${dt.slice(0, 19)}${m[1]}${m[2]}:${m[3]}`);
    if (Number.isFinite(t)) return t;
  }
  return fromPacific(dt);
}

async function fetchSplBallard() {
  return parseSplBallard(await get('https://www.trumba.com/calendars/kalendaro.json?search=Ballard%20Branch&days=14', { timeout: 20000 }));
}

/** Pure: Trumba kalendaro.json -> `events` rows for the Ballard Branch only. */
function parseSplBallard(j) {
  if (!Array.isArray(j)) throw new Error('SPL Trumba: unexpected response');
  const out = [];
  for (const e of j) {
    try {
      if (stripTags(e.location || '') !== 'Ballard Branch') continue;
      const start = trumbaTime(e.startDateTime, e.startTimeZoneOffset);
      if (start == null) continue;
      const end = trumbaTime(e.endDateTime, e.endTimeZoneOffset || e.startTimeZoneOffset);
      const canceled = !!e.canceled || /^CANCELL?ED\b/i.test(e.title || '');
      out.push({
        id: `spl-${e.eventID}`,
        title: clean(stripTags(e.title || '').replace(/^CANCELL?ED\s*[-–:]\s*/i, '')),
        start,
        end: end != null && end >= start ? end : null,
        allDay: !!e.allDay,
        venue: 'Ballard Branch',
        address: SPL_BALLARD_ADDR,
        cost: null,
        url: e.permaLinkUrl || e.webLink || 'https://www.spl.org/hours-and-locations/ballard-branch',
        source: 'SPL Ballard',
        canceled,
        category: null,
      });
    } catch { /* skip bad event */ }
  }
  return out;
}

async function fetchEvents() {
  const warnings = [];
  const [vb, spl] = await Promise.allSettled([fetchVisitBallard(warnings), fetchSplBallard()]);
  if (vb.status === 'rejected' && spl.status === 'rejected') throw new Error(`Visit Ballard: ${vb.reason.message}; SPL: ${spl.reason.message}`);
  if (vb.status === 'rejected') warnings.push(`Visit Ballard failed: ${vb.reason.message}`);
  if (spl.status === 'rejected') warnings.push(`SPL Ballard failed: ${spl.reason.message}`);
  const out = { events: mergeEvents(vb.value || [], spl.value || [], Date.now()) };
  if (warnings.length) out.warnings = warnings;
  return out;
}

/** Pure: Visit Ballard + SPL rows -> the `events` list (not yet over at `now`, deduped, sorted, max 150). */
function mergeEvents(vbList, splList, now) {
  const seen = new Set();
  return [...vbList, ...splList]
    .filter((e) => (e.end ?? e.start + 2 * HOUR) >= now)
    .filter((e) => { const k = `${e.source}|${normTitle(e.title)}|${e.start}|${e.venue}`; return seen.has(k) ? false : seen.add(k); })
    .sort((a, b) => a.start - b.start || String(a.title).localeCompare(String(b.title)))
    .slice(0, 150);
}

// ======================================================================================
// closures: Seattle Street Closures ium9-iqtc (community/event closures), bbox, active today
// ======================================================================================

const DAY_KEYS = [['sunday', 'sun'], ['monday', 'mon'], ['tuesday', 'tue'], ['wednesday', 'wed'], ['thursday', 'thu'], ['friday', 'fri'], ['saturday', 'sat']];

function lineCoords(ls) {
  if (!ls || !Array.isArray(ls.coordinates)) return null;
  let c = ls.coordinates;
  if (Array.isArray(c[0]) && Array.isArray(c[0][0])) c = c.flat(1); // MultiLineString
  const pts = c.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map(([x, y]) => [round(y, 5), round(x, 5)]);
  return pts.length ? pts : null;
}

/** Overall from/to of contiguous segments on one street (chains a.to === b.from); else the first segment's. */
function segmentSpan(segs) {
  if (!segs.length) return { from: null, to: null };
  const tos = new Set(segs.map((x) => x.to));
  const head = segs.find((x) => !tos.has(x.from)) || segs[0];
  let cur = head, n = 1;
  const used = new Set([head]);
  for (;;) {
    const next = segs.find((x) => !used.has(x) && x.from && x.from === cur.to);
    if (!next) break;
    used.add(next); cur = next; n++;
  }
  return n === segs.length ? { from: head.from || null, to: cur.to || null } : { from: segs[0].from || null, to: segs[0].to || null };
}

async function fetchClosures() {
  const today = pacificDate(0);
  const rows = await soda('ium9-iqtc', {
    $where: `within_box(line_string,${BBOX.n},${BBOX.w},${BBOX.s},${BBOX.e}) AND start_date <= '${today}T23:59:59' AND end_date >= '${today}T00:00:00'`,
    $order: 'start_date DESC',
    $limit: 500,
  });
  return parseClosures(rows, Date.now());
}

/** Pure: ium9-iqtc rows -> `closures` output (todayHours is for the Pacific weekday of `now`). */
function parseClosures(rows, now) {
  if (!Array.isArray(rows)) throw new Error('street closures: unexpected response');
  const maxYear = pacificParts(now).y + 5;
  const todayKey = DAY_KEYS[pacificParts(now).weekday][1];
  const byPermit = new Map();
  for (const r of rows) {
    try {
      const start = fromPacific(r.start_date), end = fromPacific(r.end_date);
      if (start == null || end == null) continue;
      const sy = +String(r.start_date).slice(0, 4), ey = +String(r.end_date).slice(0, 4);
      if (sy > maxYear || ey > maxYear || sy < 2000) continue; // absurd dates (e.g. 2924)
      const permit = r.permit_number || `${r.project_name}|${r.start_date}`;
      let g = byPermit.get(permit);
      if (!g) {
        g = { permit, type: r.permit_type || null, name: clean(r.project_name), streets: [], start, end, daySets: {}, segments: [] };
        byPermit.set(permit, g);
      }
      g.start = Math.min(g.start, start);
      g.end = Math.max(g.end, end);
      for (const [long, short] of DAY_KEYS) {
        const v = clean(r[long]);
        if (!v) continue;
        (g.daySets[short] ||= []).includes(v) || g.daySets[short].push(v);
      }
      const street = titleCase(r.street_on);
      if (street && !g.streets.includes(street)) g.streets.push(street);
      g.segments.push({ street, from: titleCase(r.street_from), to: titleCase(r.street_to), line: lineCoords(r.line_string) });
    } catch { /* skip bad row */ }
  }
  const closures = [...byPermit.values()].map((g) => {
    const days = {};
    for (const [, short] of DAY_KEYS) if (g.daySets[short]) days[short] = g.daySets[short].join(', ');
    const span = segmentSpan(g.segments.filter((x) => x.street === g.streets[0]));
    return {
      permit: g.permit, type: g.type, name: g.name,
      street: g.streets.join(', ') || null,
      from: span.from,
      to: span.to,
      todayHours: days[todayKey] || null,
      days, start: g.start, end: g.end,
      segments: g.segments,
    };
  });
  closures.sort((a, b) => (!!b.todayHours - !!a.todayHours) || a.start - b.start);
  return { closures };
}

// ======================================================================================
// requests311: Seattle customer service requests 5ngg-rpne within 2 km (~1 day behind)
// ======================================================================================

async function fetchRequests311() {
  const rows = await soda('5ngg-rpne', {
    $select: 'servicerequestnumber,webintakeservicerequests,servicerequeststatusname,createddate,location,latitude,longitude,community_reporting_area',
    $where: `within_circle(latitude_longitude,${CENTER.lat},${CENTER.lon},2000)`,
    $order: 'createddate DESC',
    $limit: 40,
  });
  return parseRequests311(rows);
}

/** Pure: 5ngg-rpne rows -> `requests311` output. */
function parseRequests311(rows) {
  if (!Array.isArray(rows)) throw new Error('311: unexpected response');
  const requests = [];
  for (const r of rows) {
    try {
      const [lat, lon] = coords(r.latitude, r.longitude);
      const addr = r.location ? r.location.replace(/,\s*SEATTLE\b.*$/i, '').trim() : '';
      requests.push({
        id: r.servicerequestnumber || null,
        type: clean(r.webintakeservicerequests),
        status: clean(r.servicerequeststatusname),
        t: fromPacific(r.createddate), // floating Pacific
        address: addr ? titleCase(addr) : null,
        lat, lon,
        area: r.community_reporting_area ? titleCase(r.community_reporting_area) : null,
      });
    } catch { /* skip bad row */ }
  }
  return { requests, newest: newestT(requests) };
}

// ======================================================================================
// permits: Seattle building permits 76t5-zqzr within 2 km, issued in the last 30 days
// ======================================================================================

async function fetchPermits() {
  const now = Date.now();
  const rows = await soda('76t5-zqzr', {
    $select: 'permitnum,permittypedesc,description,originaladdress1,issueddate,statuscurrent,estprojectcost,housingunitsadded,latitude,longitude,link',
    $where: `within_circle(location1,${CENTER.lat},${CENTER.lon},2000) AND issueddate > '${pacificDate(-30)}T00:00:00'`,
    $order: 'issueddate DESC',
    $limit: 200,
  });
  return parsePermits(rows, now);
}

/** Pure: 76t5-zqzr rows -> `permits` output (rows issued after `now` are dropped). */
function parsePermits(rows, now) {
  if (!Array.isArray(rows)) throw new Error('permits: unexpected response');
  const all = [];
  const seen = new Set();
  for (const r of rows) {
    try {
      if (!r.permitnum || seen.has(r.permitnum)) continue;
      const issued = fromPacific(r.issueddate); // date-only floating Pacific -> local midnight
      if (issued == null || issued > now) continue; // 'Ready for Issuance' rows can carry future dates
      seen.add(r.permitnum);
      const [lat, lon] = coords(r.latitude, r.longitude);
      const cost = num(r.estprojectcost);
      const units = num(r.housingunitsadded);
      let desc = clean(r.description) || '';
      if (desc.length > 300) desc = desc.slice(0, 297).replace(/\s+\S*$/, '') + '…';
      all.push({
        id: r.permitnum,
        type: clean(r.permittypedesc),
        description: desc || null,
        address: titleCase(r.originaladdress1),
        issued,
        status: clean(r.statuscurrent),
        cost: cost != null && cost > 0 ? Math.round(cost) : null,
        units: units != null ? units : null,
        lat, lon,
        url: (r.link && r.link.url) || null,
      });
    } catch { /* skip bad row */ }
  }
  // 'Issued' preferred: fill the 25 slots with Issued permits first, then the rest; show newest first.
  const pick = [...all.filter((p) => p.status === 'Issued'), ...all.filter((p) => p.status !== 'Issued')].slice(0, 25);
  pick.sort((a, b) => b.issued - a.issued);
  return { permits: pick };
}

// ======================================================================================

export default [
  { id: 'fire911', title: 'Seattle Fire 911', ttl: 90, background: false, fetch: fetchFire911 },
  { id: 'crime', title: 'SPD Crime Reports', ttl: 3600, background: false, fetch: fetchCrime },
  { id: 'quakes', title: 'Earthquakes (USGS)', ttl: 180, background: false, fetch: fetchQuakes },
  { id: 'outages', title: 'City Light Outages', ttl: 120, background: false, fetch: fetchOutages },
  { id: 'news', title: 'Local News', ttl: 900, background: false, fetch: fetchNews },
  { id: 'reddit', title: 'Reddit', ttl: 1800, background: false, fetch: fetchReddit },
  { id: 'events', title: 'Events', ttl: 3600, background: false, daily: true, fetch: fetchEvents },
  { id: 'closures', title: 'Street Closures', ttl: 21600, background: false, daily: true, fetch: fetchClosures },
  { id: 'requests311', title: '311 Requests', ttl: 3600, background: false, fetch: fetchRequests311 },
  { id: 'permits', title: 'Building Permits', ttl: 21600, background: false, fetch: fetchPermits },
];

// Pure parsers/normalizers, exported for offline tests only (the server uses the default export).
// Each takes the upstream payload (and `now` where the output depends on the clock) and does no I/O.
export const _test = {
  titleCase, looksBallard, parseRt911, mergeRt911, buildFire911, parseCrime, mapQuake, buildQuakes, buildOutages,
  NEWS_FEEDS, normTitle, cleanSummary, cleanLink, buildNews, redditItems, mapVisitBallardEvents, trumbaTime,
  parseSplBallard, mergeEvents, lineCoords, segmentSpan, parseClosures, parseRequests311, parsePermits,
};
