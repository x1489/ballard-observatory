// Shared helpers for the source parser tests (not a test file itself: node --test only runs *.test.mjs here).
// Fixtures in tests/fixtures/<group>/ are REAL upstream responses captured 2026-09-26 01:40-01:45 UTC
// (Fri 2026-09-25 18:40-18:45 PDT); tests/fixtures/manifest.json records each one's URL, capture time and trimming.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'));

/** The fixed "now" for every fixture-based test: just after the capture (18:45 PDT, Fri 2026-09-25). */
export const NOW = Date.parse('2026-09-26T01:45:00Z');
export const MIN = 60e3;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const fixtureText = (rel) => fs.readFileSync(path.join(FIXTURES, rel), 'utf8');
export const fixtureJson = (rel) => JSON.parse(fixtureText(rel));

/** Promise.allSettled-style result objects, for the build*(settled...) helpers. */
export const ok = (value) => ({ status: 'fulfilled', value });
export const fail = (msg = 'boom') => ({ status: 'rejected', reason: new Error(msg) });

/** A plausible epoch-ms number (2000-01-01 .. 2100-01-01). */
export function isEpoch(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 946684800000 && v < 4102444800000;
}

/**
 * CONTRACT.md hygiene for a whole output object: no NaN/Infinity, no undefined values, no 'MM' or '' strings,
 * and every key that names a timestamp (t, start, end, *At, *T, ...) holds an epoch-ms number or null.
 * Returns the list of problems (so a test can assert it is empty and print them all at once).
 */
const TIME_KEYS = /^(t|start|end|onset|ends|expires|updated|issued|issuedT|arrival|begin|open|close|newest|valid|sunrise|sunset|rise|set|noon|civilDawn|civilDusk|lastEnd|latestT|offenseT|peakGustT|outflowT|observingSince|since|upAt|downAt|lastModified|etr|rainStartsAt|rainEndsAt|now)$/;
export function hygiene(value, where = '$', problems = [], key = null) {
  if (value === undefined) problems.push(`${where}: undefined`);
  else if (typeof value === 'number') {
    if (!Number.isFinite(value)) problems.push(`${where}: ${value}`);
    if (key && TIME_KEYS.test(key) && !isEpoch(value)) problems.push(`${where}: ${value} is not epoch ms`);
  } else if (typeof value === 'string') {
    if (value === '' || value === 'MM') problems.push(`${where}: ${JSON.stringify(value)}`);
    if (key && TIME_KEYS.test(key) && key !== 'issued') problems.push(`${where}: timestamp is a string ${JSON.stringify(value)}`);
  } else if (Array.isArray(value)) value.forEach((v, i) => hygiene(v, `${where}[${i}]`, problems, null));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) hygiene(v, `${where}.${k}`, problems, k);
  }
  return problems;
}
export function assertHygiene(value, where = '$') {
  const p = hygiene(value, where);
  assert.deepEqual(p, [], `contract hygiene problems:\n  ${p.slice(0, 20).join('\n  ')}`);
}

/**
 * Minimal shape checker for CONTRACT.md output shapes. A schema is:
 *   'epoch' | 'num' | 'int' | 'str' | 'bool' | 'date' | 'any'   (suffix '?' = may be null)
 *   ['enum', 'a', 'b'] (a closed set of values; add null to allow null)
 *   { key: schema, ... }            (object: every listed key must be present; unlisted keys are errors,
 *                                    except 'warnings', which must be a non-empty string array when present)
 *   { $array: schema, min?, max? }  (array of schema)
 *   { $nullable: schema }           (schema or null)
 *   { $map: schema }                (object with arbitrary keys, each value schema)
 */
export function shapeProblems(value, schema, where = '$', problems = []) {
  const bad = (msg) => problems.push(`${where}: ${msg} (got ${JSON.stringify(value)?.slice(0, 80)})`);
  if (typeof schema === 'string') {
    const nullable = schema.endsWith('?');
    const type = nullable ? schema.slice(0, -1) : schema;
    if (value === null && nullable) return problems;
    if (value === null || value === undefined) { bad(`expected ${type}`); return problems; }
    switch (type) {
      case 'epoch': if (!isEpoch(value)) bad('expected epoch ms'); break;
      case 'num': if (typeof value !== 'number' || !Number.isFinite(value)) bad('expected finite number'); break;
      case 'int': if (!Number.isInteger(value)) bad('expected integer'); break;
      case 'str': if (typeof value !== 'string' || !value) bad('expected non-empty string'); break;
      case 'bool': if (typeof value !== 'boolean') bad('expected boolean'); break;
      case 'date': if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) bad('expected YYYY-MM-DD'); break;
      case 'any': break;
      default: throw new Error(`unknown schema type ${type}`);
    }
    return problems;
  }
  if (Array.isArray(schema) && schema[0] === 'enum') {
    if (!schema.slice(1).includes(value)) bad(`expected one of ${JSON.stringify(schema.slice(1))}`);
    return problems;
  }
  if (schema.$nullable) {
    if (value !== null) shapeProblems(value, schema.$nullable, where, problems);
    return problems;
  }
  if (schema.$array) {
    if (!Array.isArray(value)) { bad('expected array'); return problems; }
    if (schema.min != null && value.length < schema.min) bad(`expected >= ${schema.min} items, got ${value.length}`);
    if (schema.max != null && value.length > schema.max) bad(`expected <= ${schema.max} items, got ${value.length}`);
    value.forEach((v, i) => shapeProblems(v, schema.$array, `${where}[${i}]`, problems));
    return problems;
  }
  if (schema.$map) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { bad('expected object'); return problems; }
    for (const [k, v] of Object.entries(value)) shapeProblems(v, schema.$map, `${where}.${k}`, problems);
    return problems;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) { bad('expected object'); return problems; }
  for (const [k, s] of Object.entries(schema)) {
    if (!(k in value)) problems.push(`${where}.${k}: missing`);
    else shapeProblems(value[k], s, `${where}.${k}`, problems);
  }
  for (const k of Object.keys(value)) {
    if (k in schema) continue;
    if (k === 'warnings') {
      if (!Array.isArray(value.warnings) || !value.warnings.length || value.warnings.some((w) => typeof w !== 'string' || !w)) {
        problems.push(`${where}.warnings: must be a non-empty array of strings`);
      }
    } else problems.push(`${where}.${k}: unexpected key (not in CONTRACT.md)`);
  }
  return problems;
}
export function assertShape(value, schema, where = '$') {
  const p = shapeProblems(value, schema, where);
  assert.deepEqual(p, [], `shape problems:\n  ${p.slice(0, 25).join('\n  ')}`);
}

/**
 * For a KNOWN, reported contract deviation: pass while the only problems are the allowed ones (so the fix in the
 * source can land without touching the test), print them as a test diagnostic, and fail on anything else.
 * (node:test `todo` can't be used: a failing todo still fails the run on Node 18.)
 */
export function knownDeviation(t, problems, allowed) {
  const unexpected = problems.filter((p) => !allowed.some((re) => re.test(p)));
  assert.deepEqual(unexpected, [], `unexpected problems:\n  ${unexpected.join('\n  ')}`);
  if (problems.length) t.diagnostic(`KNOWN CONTRACT DEVIATION (reported, not yet fixed): ${problems.join('; ')}`);
}

/** Full contract check: shape + hygiene. */
export function assertContract(value, schema, where = '$') {
  assertShape(value, schema, where);
  assertHygiene(value, where);
}

// ---------------------------------------------------------------- fixture-backed fetch (for wiring tests)

const res = (body, { status = 200, headers = {} } = {}) => new Response(body, { status, headers });
const file = (rel, init) => () => res(fixtureText(rel), init);
const notFound = () => res('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });

/**
 * [RegExp, handler(url, init, match)] routes from each upstream URL the sources request to its fixture.
 * Unknown URLs throw, so a test can never reach the real network.
 */
export const FIXTURE_ROUTES = [
  // weather
  [/^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/, file('weather/open-meteo.json')],
  [/^https:\/\/api\.weather\.gov\/gridpoints\/SEW\/124,71\/forecast$/, file('weather/nws-forecast.json')],
  [/^https:\/\/api\.weather\.gov\/alerts\/active\?zone=/, file('weather/nws-alerts.json')],
  [/^https:\/\/api\.weather\.gov\/stations\/(\w+)\/observations\/latest$/, (u, i, m) => res(fixtureText(`weather/nws-obs-${m[1]}.json`))],
  [/^https:\/\/api\.weather\.gov\/stations\/\w+(\/observations\?limit=\d+)?$/, notFound], // station metadata: not captured
  [/^https:\/\/www\.ndbc\.noaa\.gov\/data\/realtime2\/WPOW1\.cwind$/, file('weather/ndbc-WPOW1.cwind', { status: 206 })],
  [/^https:\/\/www\.ndbc\.noaa\.gov\/data\/realtime2\/WPOW1\.txt$/, file('weather/ndbc-WPOW1.txt', { status: 206 })],
  [/^https:\/\/tgftp\.nws\.noaa\.gov\/data\/forecasts\/marine\/coastal\/pz\/pzz135\.txt$/, file('weather/pzz135.txt')],
  [/^https:\/\/api\.weather\.gov\/products\/types\/AFD\/locations\/SEW\/latest$/, file('weather/afd.json')],
  [/^https:\/\/aa\.usno\.navy\.mil\/api\/rstt\/oneday\?date=(\d{4}-\d{2}-\d{2})&/, (u, i, m) => res(fixtureText(`weather/usno-rstt-${m[1]}.json`))],
  [/^https:\/\/aa\.usno\.navy\.mil\/api\/moon\/phases\/date\?date=(\d{4}-\d{2}-\d{2})&/, (u, i, m) => res(fixtureText(`weather/usno-phases-${m[1]}.json`))],
  [/^https:\/\/services\.swpc\.noaa\.gov\/json\/planetary_k_index_1m\.json$/, file('weather/swpc-kp-1m.json')],
  [/^https:\/\/services\.swpc\.noaa\.gov\/products\/noaa-planetary-k-index\.json$/, file('weather/swpc-kp-3h.json')],
  [/^https:\/\/mesonet\.agron\.iastate\.edu\/data\/gis\/images\/4326\/USCOMP\/n0q_0\.json$/, file('weather/iem-n0q.json')],
  [/^https:\/\/files\.airnowtech\.org\/airnow\/today\/reportingarea\.dat$/, file('weather/airnow-reportingarea.dat', { headers: { 'last-modified': 'Sat, 26 Sep 2026 01:17:07 GMT' } })],
  [/^https:\/\/airfire-data-exports\.s3\.us-west-2\.amazonaws\.com\/maps\/purple_air\/v4\/pas\.csv$/, file('weather/purpleair-pas.csv', { headers: { 'last-modified': 'Sat, 26 Sep 2026 01:31:10 GMT' } })],
  // water
  [/^https:\/\/api\.tidesandcurrents\.noaa\.gov\/api\/prod\/datagetter\?(.*)$/, (u) => {
    const q = new URL(u).searchParams;
    if (q.get('product') === 'predictions' && q.get('interval') === 'hilo') return res(fixtureText('water/noaa-hilo-9447265.json'));
    if (q.get('product') === 'predictions') return res(fixtureText('water/noaa-curve-9447130.json'));
    if (q.get('product') === 'water_level') return res(fixtureText('water/noaa-wl-9447130.json'));
    if (q.get('product') === 'currents_predictions') return res(fixtureText('water/noaa-currents-PUG1515.json'));
    return res(JSON.stringify({ error: { message: 'unrouted NOAA product' } }));
  }],
  [/^https:\/\/public\.crohms\.org\/dd\/common\/web_service\/webexec\/getjson\?/, file('water/usace-lake.json')],
  [/^https:\/\/ndc\.ops\.usace\.army\.mil\/ords\/lpms\/json\/lock_queue_json\?/, file('water/lpms-lock-queue.json')],
  [/^https:\/\/ndc\.ops\.usace\.army\.mil\/ords\/lpms\/stall_stoppage_json\?/, file('water/lpms-stoppages.json')],
  [/^https:\/\/web\.seattle\.gov\/Travelers\/api\/Map\/GetBridgeData$/, file('water/sdot-bridges.txt')],
  [/^https:\/\/data\.seattle\.gov\/resource\/gm8h-9449\.json\?/, file('water/socrata-gm8h-9449.json')],
  [/^https:\/\/wdfw\.wa\.gov\/fishing\/reports\/counts\/lake-washington$/, file('water/wdfw-salmon.html')],
  [/^https:\/\/your\.kingcounty\.gov\/dnrp\/library\/wastewater\/cso\/img\/CSO_metadata\.CSV$/, file('water/kc-cso.csv')],
  // move
  [/^https:\/\/api\.pugetsound\.onebusaway\.org\/api\/where\/arrivals-and-departures-for-location\.json\?/, file('move/oba-arrivals.json')],
  [/^https:\/\/api\.pugetsound\.onebusaway\.org\/api\/where\/trips-for-route\/(1_\d+)\.json\?/, (u, i, m) => res(fixtureText(`move/oba-trips-${m[1]}.json`))],
  [/^https:\/\/s3\.amazonaws\.com\/kcm-alerts-realtime-prod\/alerts_enhanced\.json$/, file('move/kcm-alerts.json')],
  [/^https:\/\/www\.seattle\.gov\/trafficcams\/images\/(.+)$/, (u, i, m) => {
    const cam = fixtureJson('move/sdot-camera-heads.json').find((c) => c.file === m[1]);
    if (!cam || cam.error) return notFound();
    const headers = Object.fromEntries(Object.entries(cam.headers).filter(([, v]) => v != null));
    return res(null, { status: cam.status, headers });
  }],
  [/^https:\/\/web\.seattle\.gov\/Travelers\/api\/Map\/LinksBySiteID\?siteId=(\d+)$/, (u, i, m) => res(fixtureText(`move/sdot-links-${m[1]}.json`))],
  [/^https:\/\/web\.seattle\.gov\/Travelers\/api\/Map\/Data\?zoomId=18&type=1$/, file('move/sdot-incidents.json')],
  [/^https:\/\/data\.lime\.bike\/api\/partners\/v2\/gbfs\/seattle\/free_bike_status$/, file('move/lime-free-bike-status.json')],
  // civic
  [/^https:\/\/data\.seattle\.gov\/resource\/kzjm-xkqj\.json\?\$select=max/, file('civic/socrata-kzjm-xkqj-max.json')],
  [/^https:\/\/data\.seattle\.gov\/resource\/kzjm-xkqj\.json\?/, file('civic/socrata-kzjm-xkqj.json')],
  [/^https:\/\/web\.seattle\.gov\/sfd\/realtime911\/getRecsForDatePub\.asp\?action=Today/, file('civic/sfd-realtime911-today.html')],
  [/^https:\/\/web\.seattle\.gov\/sfd\/realtime911\/getRecsForDatePub\.asp\?incDate=/, file('civic/sfd-realtime911-prev.html')],
  [/^https:\/\/data\.seattle\.gov\/resource\/tazs-3rd5\.json\?/, file('civic/socrata-tazs-3rd5.json')],
  [/^https:\/\/earthquake\.usgs\.gov\/fdsnws\/event\/1\/query\?.*maxradiuskm=150&/, file('civic/usgs-recent.json')],
  [/^https:\/\/earthquake\.usgs\.gov\/fdsnws\/event\/1\/query\?.*maxradiuskm=300&/, file('civic/usgs-notable.json')],
  [/^https:\/\/utilisocial\.io\/datacapable\/v2\/p\/scl\/map\/events$/, file('civic/scl-events.json')],
  [/^https:\/\/utilisocial\.io\/datacapable\/v2\/p\/scl\/map\/stats$/, file('civic/scl-stats.json')],
  [/^https:\/\/www\.myballard\.com\/feed\/$/, file('civic/rss-myballard.xml')],
  [/^https:\/\/phinneywood\.com\/feed\/$/, file('civic/rss-phinneywood.xml')],
  [/^https:\/\/www\.seattletimes\.com\/seattle-news\/feed\/$/, file('civic/rss-seattletimes.xml')],
  [/^https:\/\/spdblotter\.seattle\.gov\/feed\/$/, file('civic/rss-spdblotter.xml')],
  [/^https:\/\/fireline\.seattle\.gov\/feed\/$/, file('civic/rss-fireline.xml')],
  [/^https:\/\/sdotblog\.seattle\.gov\/feed\/$/, file('civic/rss-sdotblog.xml')],
  [/^https:\/\/parkways\.seattle\.gov\/feed\/$/, file('civic/rss-parkways.xml')],
  [/^https:\/\/news\.google\.com\/rss\/search\?/, file('civic/rss-googlenews.xml')],
  [/^https:\/\/www\.reddit\.com\/r\/Ballard\/new\/\.rss$/, file('civic/reddit-ballard.xml', { headers: { 'x-ratelimit-remaining': '99', 'x-ratelimit-reset': '30' } })],
  [/^https:\/\/www\.reddit\.com\/r\/Seattle\/search\.rss\?/, file('civic/reddit-seattle.xml', { headers: { 'x-ratelimit-remaining': '99', 'x-ratelimit-reset': '30' } })],
  [/^https:\/\/www\.visitballard\.com\/wp-json\/tribe\/events\/v1\/events\?/, file('civic/visitballard-events.json')],
  [/^https:\/\/www\.trumba\.com\/calendars\/kalendaro\.json\?/, file('civic/trumba-kalendaro.json')],
  [/^https:\/\/data\.seattle\.gov\/resource\/ium9-iqtc\.json\?/, file('civic/socrata-ium9-iqtc.json')],
  [/^https:\/\/data\.seattle\.gov\/resource\/5ngg-rpne\.json\?/, file('civic/socrata-5ngg-rpne.json')],
  [/^https:\/\/data\.seattle\.gov\/resource\/76t5-zqzr\.json\?/, file('civic/socrata-76t5-zqzr.json')],
];

/**
 * A drop-in for globalThis.fetch that serves fixtures. `log` collects every URL requested.
 * HEAD requests get an empty body; unrouted URLs reject (never touch the network).
 */
export function fixtureFetch({ log = [], routes = FIXTURE_ROUTES } = {}) {
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    log.push(`${init.method || 'GET'} ${url}`);
    for (const [re, handler] of routes) {
      const m = url.match(re);
      if (m) {
        let r;
        try {
          r = await handler(url, init, m);
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
          r = notFound(); // a routed URL whose fixture was never captured (e.g. another date) behaves like an upstream 404
        }
        return (init.method || 'GET') === 'HEAD' ? new Response(null, { status: r.status, headers: r.headers }) : r;
      }
    }
    throw new TypeError('fetch failed', { cause: { code: 'EUNROUTED', message: `no fixture route for ${url}` } });
  };
}
