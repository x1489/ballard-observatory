// Fetch-level edge cases through the real fetch() functions (fixture-backed globalThis.fetch, pinned clock):
// conditional GET / 304 reuse, the Pacific-midnight rollover through those caches, host fallback, NOAA's
// error-as-200, HTML where JSON/CSV/RSS was expected, OBA's 429-in-body retry, and partial failures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NOW, MIN, FIXTURE_ROUTES, fixtureFetch, fixtureText, assertContract } from './_helpers.mjs';
import * as S from './_schemas.mjs';

const Z = (s) => Date.parse(s);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ballard-wiring-errors-'));
const realFetch = globalThis.fetch;
const realNow = Date.now;
let clock = NOW;
let overrides = [];
const log = [];
const seenHeaders = [];
const src = {};
const html = (status = 200) => new Response('<!DOCTYPE html>\n<html>\n<head><title>Service Unavailable</title></head>\n<body>Down for maintenance</body>\n</html>\n', { status, headers: { 'content-type': 'text/html' } });
const run = (id, prev = null) => src[id].fetch({ prev, fetchedAt: 0 }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));

before(async () => {
  process.env.BALLARD_DATA_DIR = tmp;
  // Overrides are consulted first, so each phase below can script failures; everything else is served from fixtures.
  globalThis.fetch = (input, init = {}) => {
    seenHeaders.push({ url: String(input), headers: { ...(init.headers || {}) } });
    return fixtureFetch({ log, routes: [...overrides, ...FIXTURE_ROUTES] })(input, init);
  };
  Date.now = () => clock;
  for (const g of ['weather', 'water', 'move', 'civic']) {
    for (const s of (await import(`../../sources/${g}.mjs`)).default) src[s.id] = s;
  }
});

after(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('AirNow / PurpleAir: If-Modified-Since on the second fetch, 304 reuses the parsed rows', async () => {
  const [a1, p1] = await Promise.all([run('airnow'), run('purpleair')]);
  assert.ok(a1.ok && p1.ok);
  clock = NOW + 10 * MIN;
  const ims = [];
  overrides = [[/airnowtech\.org|purple_air/, (u, init) => {
    ims.push(init.headers['If-Modified-Since']);
    return new Response(null, { status: 304 });
  }]];
  const [a2, p2] = await Promise.all([run('airnow'), run('purpleair')]);
  overrides = [];
  assert.deepEqual(ims.sort(), ['Sat, 26 Sep 2026 01:17:07 GMT', 'Sat, 26 Sep 2026 01:31:10 GMT']);
  assert.deepEqual(a2.value, a1.value);
  assert.deepEqual(p2.value, p1.value);

  // Just after Pacific midnight the cached (304) AirNow rows are re-evaluated for the new day.
  clock = Z('2026-09-26T07:00:30Z');
  overrides = [[/airnowtech\.org/, () => new Response(null, { status: 304 })]];
  const a3 = await run('airnow');
  overrides = [];
  assert.equal(a3.value.forecast[0].date, '2026-09-26');
  assertContract(a3.value, S.airnow);
  clock = NOW;
});

test('sky: per-date USNO cache; after Pacific midnight it asks for the new dates', async () => {
  const s1 = await run('sky');
  assert.equal(s1.value.date, '2026-09-25');
  const before = log.filter((l) => l.includes('aa.usno.navy.mil')).length;
  const s2 = await run('sky');
  assert.deepEqual(s2.value, s1.value);
  assert.equal(log.filter((l) => l.includes('aa.usno.navy.mil')).length, before, 'cached dates must not be refetched');

  clock = Z('2026-09-26T07:00:30Z'); // Sat 00:00:30 PDT
  const s3 = await run('sky');
  clock = NOW;
  assert.ok(s3.ok, s3.error && s3.error.message);
  assert.equal(s3.value.date, '2026-09-26');
  assert.equal(s3.value.sun.rise, Z('2026-09-26T14:02:00Z'));
  assert.ok(log.some((l) => /rstt\/oneday\?date=2026-09-27&/.test(l)));
  // 2026-09-27 and its phases were never captured, so they 404: tomorrowSun is null with a warning, and the next
  // phase falls back to the rstt closestphase.
  assert.deepEqual(s3.value.tomorrowSun, { rise: null, set: null });
  assert.deepEqual(s3.value.nextPhase, { phase: 'Full Moon', t: Z('2026-09-26T16:49:00Z') });
  assert.ok(s3.value.warnings.some((w) => /^tomorrow: /.test(w)));
});

test('failures that must throw (so the server keeps the last good data and flags the error)', async () => {
  overrides = [
    [/datagetter\?.*product=currents_predictions/, () => new Response(JSON.stringify({ error: { message: 'No Predictions data was found. Please make sure the Datum input is valid.' } }))],
    [/tazs-3rd5\.json/, () => html()],
    [/CSO_metadata\.CSV/, () => html()],
    [/lock_queue_json/, () => new Response('[]', { headers: { 'content-type': 'application/json' } })],
    [/GetBridgeData/, () => html()],
    [/free_bike_status/, () => html(503)],
  ];
  const [cur, crime, cso, lock, bridges, lime] = await Promise.all(['currents', 'crime', 'cso', 'lockages', 'bridges', 'lime'].map((id) => run(id)));
  overrides = [];
  assert.match(cur.error.message, /^NOAA PUG1515 currents_predictions: No Predictions data was found/);
  assert.match(crime.error.message, /^Bad JSON from data\.seattle\.gov: <!DOCTYPE html>/);
  assert.match(cso.error.message, /^cso: unexpected CSV header/);
  assert.match(lock.error.message, /^LPMS lock queue: empty response/);
  assert.match(bridges.error.message, /^bridges: bad JSON: <!DOCTYPE html>/);
  assert.match(lime.error.message, /^HTTP 503 from data\.lime\.bike/);
  assert.ok(!fs.existsSync(path.join(tmp, 'bridges.json')), 'a failed bridges poll must not write state');
});

test('partial failures return what they have, with warnings', async () => {
  overrides = [
    [/^https:\/\/public\.crohms\.org\//, () => html(503)],
    [/^https:\/\/www\.nwd-wc\.usace\.army\.mil\/dd\/common\/web_service\/webexec\/getjson\?/, () => new Response(fixtureText('water/usace-lake.json'))],
    [/stations\/E7826\/observations\/latest$/, () => new Response('{"status":404}', { status: 404 })],
    [/WPOW1\.cwind$/, () => new Response('Not Found', { status: 404 })],
    [/phinneywood\.com\/feed/, () => new Response('Forbidden', { status: 403 })],
    [/seattletimes\.com\/seattle-news\/feed/, () => html()],
    [/trumba\.com/, () => new Response('{"error":"Calendar not found"}')],
  ];
  const [lake, stations, westpoint, news, events] = await Promise.all(['lake', 'stations', 'westpoint', 'news', 'events'].map((id) => run(id)));
  overrides = [];
  assert.deepEqual(lake.value.warnings, ['primary host failed, used fallback (public.crohms.org: HTTP 503 from public.crohms.org)']);
  assertContract(lake.value, S.lake);
  assert.deepEqual(stations.value.warnings, ['E7826: HTTP 404 from api.weather.gov']);
  assert.equal(stations.value.stations.length, 3);
  assertContract(stations.value, S.stations);
  assert.deepEqual(westpoint.value.warnings, ['.cwind: HTTP 404 from www.ndbc.noaa.gov']);
  assert.equal(westpoint.value.windKt, 8.9); // from .txt
  assertContract(westpoint.value, S.westpoint);
  assert.deepEqual(news.value.feeds.filter((f) => !f.ok), [
    { name: 'PhinneyWood', ok: false, count: 0, error: 'HTTP 403 from phinneywood.com' },
    { name: 'Seattle Times', ok: false, count: 0, error: 'not an RSS/Atom feed' },
  ]);
  assert.ok(news.value.items.length > 20);
  assert.deepEqual(events.value.warnings, ['SPL Ballard failed: SPL Trumba: unexpected response']);
  assert.ok(events.value.events.every((e) => e.source === 'Visit Ballard'));
});

test('Visit Ballard paging: next_rest_url is followed; a failed later page keeps the pages already fetched', async () => {
  const page1 = JSON.parse(fixtureText('civic/visitballard-events.json'));
  const extra = { ...page1.events[5], id: 99999, title: 'Page Two Social', url: 'https://www.visitballard.com/event/page-two/' };
  const next = 'https://www.visitballard.com/wp-json/tribe/events/v1/events?per_page=50&page=2';
  let page2 = () => new Response(JSON.stringify({ events: [extra] }));
  overrides = [
    [/visitballard\.com\/.*[?&]page=2/, () => page2()],
    [/visitballard\.com\/wp-json\/tribe\/events\/v1\/events\?/, () => new Response(JSON.stringify({ ...page1, next_rest_url: next }))],
  ];
  const ok2 = await run('events');
  page2 = () => html(500);
  const bad2 = await run('events');
  overrides = [];
  assert.ok(ok2.value.events.some((e) => e.id === 'vb-99999'));
  assert.equal(ok2.value.warnings, undefined);
  assert.ok(!bad2.value.events.some((e) => e.id === 'vb-99999'));
  assert.equal(bad2.value.events.length, 37);
  assert.deepEqual(bad2.value.warnings, ['Visit Ballard page 2 failed (HTTP 500 from www.visitballard.com); showing the first 1']);
});

test('fire911: live page down -> Socrata rows, active unknown; Socrata down -> unlocated live Ballard rows', async () => {
  overrides = [[/realtime911\/getRecsForDatePub\.asp\?action=Today/, () => html(503)]];
  const a = await run('fire911');
  overrides = [[/kzjm-xkqj\.json\?\$where/, () => html(503)]];
  const b = await run('fire911');
  overrides = [];
  assert.ok(a.ok, a.error && a.error.message);
  assert.equal(a.value.incidents.length, 14);
  assert.deepEqual([a.value.activeKnown, a.value.activeCount], [false, null]);
  assert.deepEqual(a.value.warnings, ['realtime911 HTTP 503 from web.seattle.gov; units/level/active unavailable']);
  assertContract(a.value, S.fire911);
  assert.ok(b.ok, b.error && b.error.message);
  assert.ok(b.value.incidents.length >= 10 && b.value.incidents.every((i) => !i.located));
  assert.equal(b.value.activeKnown, true);
  assert.deepEqual(b.value.warnings, ['Socrata kzjm-xkqj failed (HTTP 503 from data.seattle.gov); showing unlocated live rows only']);
  assertContract(b.value, S.fire911);
});

test("OBA reports 429 inside a 200 body: transit retries after a backoff and succeeds", async () => {
  let calls = 0;
  overrides = [[/arrivals-and-departures-for-location\.json/, () => {
    calls++;
    return calls === 1
      ? new Response(JSON.stringify({ code: 429, currentTime: NOW, text: 'rate limit exceeded', version: 2 }))
      : new Response(fixtureText('move/oba-arrivals.json'));
  }]];
  const t = await run('transit');
  overrides = [];
  assert.equal(calls, 2);
  assert.ok(t.ok, t.error && t.error.message);
  assert.equal(t.value.groups.length, 7);
});
