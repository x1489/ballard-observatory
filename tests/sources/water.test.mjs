// group `water` parsers (sources/water.mjs _test) on real fixtures, with a fixed clock.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { _test as W } from '../../sources/water.mjs';
import { NOW, MIN, HOUR, DAY, fixtureJson, fixtureText, ok, fail, assertContract, hygiene } from './_helpers.mjs';
import * as S from './_schemas.mjs';

const Z = (s) => Date.parse(s);
const clone = (o) => JSON.parse(JSON.stringify(o));

describe('tides (NOAA, time_zone=gmt)', () => {
  const hilo = fixtureJson('water/noaa-hilo-9447265.json');
  const curve = fixtureJson('water/noaa-curve-9447130.json');
  const wl = fixtureJson('water/noaa-wl-9447130.json');
  const out = W.buildTides([ok(hilo), ok(curve), ok(wl)], NOW);

  test('request windows: hilo from Pacific midnight, curve covers now-6h..now+24h', () => {
    assert.deepEqual(W.tidesWindow(NOW), {
      dayStart: Z('2026-09-25T07:00:00Z'), hiloEnd: Z('2026-09-27T07:00:00Z'), curveStart: Z('2026-09-25T07:00:00Z'), curveHours: 45,
    });
    // 03:00 PDT: the curve must start before midnight to cover now-6h.
    const early = W.tidesWindow(Z('2026-09-25T10:00:00Z'));
    assert.equal(early.curveStart, Z('2026-09-25T03:00:00Z'));
    assert.equal(early.curveStart + early.curveHours * HOUR, Z('2026-09-26T19:00:00Z')); // midnight + 36 h
    assert.equal(W.noaaGmt(Z('2026-09-25T07:00:00Z')), '20260925 07:00');
  });
  test('meets the contract', () => assertContract(out, S.tides));
  test('GMT strings convert exactly; hilo is today + tomorrow (Pacific)', () => {
    assert.deepEqual(out.hilo[0], { t: Z('2026-09-25T11:27:00Z'), ft: 9.54, type: 'H' }); // 04:27 PDT
    assert.equal(out.hilo.length, 8);
    assert.ok(out.hilo.every((h) => h.t >= Z('2026-09-25T07:00:00Z') && h.t < Z('2026-09-27T07:00:00Z')));
    assert.deepEqual(out.next.map((h) => [h.t, h.type]), [
      [Z('2026-09-26T06:16:00Z'), 'L'], [Z('2026-09-26T12:12:00Z'), 'H'], [Z('2026-09-26T18:13:00Z'), 'L'], [Z('2026-09-27T00:25:00Z'), 'H'],
    ]);
    assert.equal(out.trend, 'falling'); // after the 17:04 PDT high
  });
  test('latest observed vs the interpolated prediction', () => {
    assert.deepEqual(out.latest, { t: Z('2026-09-26T01:36:00Z'), ft: 10.57, predictedFt: 9.99, anomalyFt: 0.58 });
    assert.equal(out.observed.length, 240);
    assert.equal(out.curve.length, 451);
    out.curve.forEach((p, i) => i && assert.equal(p.t - out.curve[i - 1].t, 6 * MIN));
  });
  test("midnight rollover: at 00:00:01 PDT yesterday's extremes leave hilo", () => {
    const o = W.buildTides([ok(hilo), ok(curve), ok(wl)], Z('2026-09-26T07:00:01Z'));
    assert.equal(o.hilo[0].t, Z('2026-09-26T12:12:00Z'));
    assert.ok(o.hilo.every((h) => h.t >= Z('2026-09-26T07:00:00Z')));
    const before = W.buildTides([ok(hilo), ok(curve), ok(wl)], Z('2026-09-26T06:59:59Z'));
    assert.equal(before.hilo[0].t, Z('2026-09-25T11:27:00Z'));
  });
  test('partial failure: warnings, and trend falls back to the next hilo event', () => {
    const o = W.buildTides([ok(hilo), fail('HTTP 500'), fail('timeout')], NOW);
    assert.deepEqual(o.curve, []);
    assert.equal(o.latest, null);
    assert.equal(o.trend, 'falling'); // next event is a low
    assert.deepEqual(o.warnings, ['curve (9447130): HTTP 500', 'observed (9447130): timeout']);
    assertContract(o, S.tides);
  });
  test('nothing usable throws; empty responses too', () => {
    assert.throws(() => W.buildTides([fail('a'), fail('b'), fail('c')], NOW), /tides: no usable data/);
    assert.throws(() => W.buildTides([ok({ predictions: [] }), ok({ predictions: [] }), ok({ data: [] })], NOW), /no usable data/);
  });
  test('bad rows are dropped, never NaN', () => {
    const x = clone(wl);
    x.data.push({ t: '2026-09-26 01:42', v: '', s: '', f: '1,1,1,1', q: 'p' }, { t: 'garbage', v: '1.0' });
    const o = W.buildTides([ok(hilo), ok(curve), ok(x)], NOW);
    assert.equal(o.observed.length, 240);
    assert.deepEqual(hygiene(o), []);
  });
  test('interpAt: exact points, midpoints, outside the range', () => {
    const s = [{ t: 0, ft: 1 }, { t: 10, ft: 3 }];
    assert.equal(W.interpAt(s, 0), 1);
    assert.equal(W.interpAt(s, 5), 2);
    assert.equal(W.interpAt(s, 10), 3);
    assert.equal(W.interpAt(s, 11), null);
    assert.equal(W.interpAt([], 5), null);
  });
});

describe('currents (NOAA PUG1515)', () => {
  const out = W.parseCurrents(fixtureJson('water/noaa-currents-PUG1515.json'));
  test('meets the contract with exact values', () => {
    assertContract(out, S.currents);
    assert.equal(out.station, 'West Point');
    assert.equal(out.events.length, 16);
    assert.deepEqual(out.events.slice(0, 3), [
      { t: Z('2026-09-25T07:41:00Z'), type: 'flood', knots: 0.69 },
      { t: Z('2026-09-25T10:50:00Z'), type: 'slack', knots: 0 },
      { t: Z('2026-09-25T12:49:00Z'), type: 'ebb', knots: -0.52 },
    ]);
    assert.ok(out.events.every((e) => !Object.is(e.knots, -0)));
  });
  test('empty or unknown types throw / are skipped', () => {
    assert.throws(() => W.parseCurrents({ current_predictions: { cp: [] } }), /no predictions/);
    assert.throws(() => W.parseCurrents({}), /no predictions/);
    const o = W.parseCurrents({ current_predictions: { cp: [{ Type: 'max', Time: '2026-09-25 07:41', Velocity_Major: 1 }, { Type: 'ebb', Time: '2026-09-25 08:00', Velocity_Major: 'x' }] } });
    assert.deepEqual(o.events, [{ t: Z('2026-09-25T08:00:00Z'), type: 'ebb', knots: null }]);
  });
});

describe('lake (USACE LWSC)', () => {
  const j = fixtureJson('water/usace-lake.json');
  test('meets the contract with exact values', () => {
    const out = W.parseLake(j, []);
    assertContract(out, S.lake);
    assert.equal(out.t, Z('2026-09-26T00:15:00Z'));
    assert.equal(out.ft, 20.3);
    assert.equal(out.outflowCfs, 216);
    // The daily average stamped 2026-09-25T07:00Z covers Thu Sep 24 (PDT): report that day's Pacific midnight.
    assert.equal(out.outflowT, Z('2026-09-24T07:00:00Z'));
    assert.equal(out.history.at(-1).t, out.t);
    assert.ok(out.history.length >= 48 && out.history.length <= 50, String(out.history.length));
    assert.ok(out.history[0].t >= out.t - 48 * HOUR);
  });
  test('honors a non-zero tz_offset (fixed PST mode)', () => {
    const x = clone(j);
    x.LWSC.tz_offset = -8;
    const out = W.parseLake(x, []);
    assert.equal(out.t, Z('2026-09-26T08:15:00Z'));
  });
  test('sensor garbage dropped; missing flow is a warning; host-fallback warnings pass through', () => {
    const x = clone(j);
    const elev = Object.keys(x.LWSC.timeseries).find((k) => k.includes('Elev'));
    const flow = Object.keys(x.LWSC.timeseries).find((k) => k.includes('Flow'));
    x.LWSC.timeseries[elev].values.push(['2026-09-26T00:30:00', -99.9, 0], ['2026-09-26T00:45:00', null, 0]);
    x.LWSC.timeseries[flow].values = [];
    const out = W.parseLake(x, ['primary host failed, used fallback (x)']);
    assert.equal(out.t, Z('2026-09-26T00:15:00Z'));
    assert.equal(out.outflowCfs, null);
    assert.deepEqual(out.warnings, ['primary host failed, used fallback (x)', 'no daily outflow value in the last 3 days']);
    assertContract(out, S.lake);
  });
  test('no elevation values throws', () => {
    const x = clone(j);
    for (const k of Object.keys(x.LWSC.timeseries)) x.LWSC.timeseries[k].values = [];
    assert.throws(() => W.parseLake(x, []), /no elevation values/);
  });
});

describe('lockages (USACE LPMS queue, Pacific wall-clock)', () => {
  const rows = fixtureJson('water/lpms-lock-queue.json');
  const out = W.parseLockages(rows, NOW);
  test('meets the contract with exact values', () => {
    assertContract(out, S.lockages);
    assert.deepEqual(out.today, { up: 15, down: 21, total: 36, commercial: 12 });
    assert.equal(out.queued, 0);
    assert.equal(out.avgWaitMin, 13);
    assert.equal(out.lastEnd, Z('2026-09-26T01:01:00Z')); // 18:01 PDT
    assert.equal(out.recent.length, 30);
    // Raw row: arrivalDate '09/25/26 17:40', SOLdate '09/25/26 17:48', endOfLockage '09/25/26 18:01' (Pacific, 'PST' label).
    assert.deepEqual(out.recent[0], {
      name: 'RECREATIONAL VESSEL', direction: 'down', arrival: Z('2026-09-26T00:40:00Z'), start: Z('2026-09-26T00:48:00Z'),
      end: Z('2026-09-26T01:01:00Z'), waitMin: 8, commercial: false, mmsi: null,
    });
    out.recent.forEach((r, i) => i && assert.ok(r.arrival <= out.recent[i - 1].arrival));
  });
  test("midnight rollover: 'today' is the Pacific date, switching at 00:00 PDT", () => {
    assert.equal(W.parseLockages(rows, Z('2026-09-26T06:59:59Z')).today.total, 36);
    assert.equal(W.parseLockages(rows, Z('2026-09-26T07:00:00Z')).today.total, 0);
    const yesterday = W.parseLockages(rows, Z('2026-09-25T06:59:59Z')).today.total;
    assert.ok(yesterday > 0 && yesterday !== 36, String(yesterday));
  });
  test('a vessel still waiting counts as queued', () => {
    const waiting = { vesselName: 'POLAR RANGER ', vesselNo: '1234567', direction: 'U', numBarges: 0, SOLdate: null, arrivalDate: '09/25/26 18:20', endOfLockage: null, timezone: 'PST', MMSI: 366907790 };
    const o = W.parseLockages([...rows, waiting], NOW);
    assert.equal(o.queued, 1);
    assert.deepEqual(o.recent[0], { name: 'POLAR RANGER', direction: 'up', arrival: Z('2026-09-26T01:20:00Z'), start: null, end: null, waitMin: null, commercial: true, mmsi: 366907790 });
    assert.equal(o.today.commercial, 13);
  });
  test('empty array, HTML page and junk rows', () => {
    assert.throws(() => W.parseLockages([], NOW), /empty response/);
    assert.throws(() => W.parseLockages('<html>Service Unavailable</html>', NOW), /unexpected response shape/);
    assert.throws(() => W.parseLockages({ error: 'x' }, NOW), /unexpected response shape/);
    assert.throws(() => W.parseLockages([null, { direction: 'X', arrivalDate: '09/25/26 18:20' }, { direction: 'U' }], NOW), /no parseable rows/);
  });
  test('isCommercial: recreational, government and named vessels', () => {
    assert.equal(W.isCommercial('RECREATIONAL VESSEL', '9999999'), false);
    assert.equal(W.isCommercial('REC', 'U999999'), false);
    assert.equal(W.isCommercial('SEATTLE FIREBOAT', 'S222222'), false);
    assert.equal(W.isCommercial('FED VESSELS', 'G222222'), false);
    assert.equal(W.isCommercial('COMM OTHER', '5555555'), true);
    assert.equal(W.isCommercial('STARLIGHT 101', '0697962'), true);
  });
});

describe('stoppages (USACE LPMS)', () => {
  test('real nationwide fixture has no Seattle rows: all lists empty', () => {
    const out = W.parseStoppages(fixtureJson('water/lpms-stoppages.json'), NOW);
    assertContract(out, S.stoppages);
    assert.deepEqual(out, { active: [], upcoming: [], recent: [] });
  });
  test('synthetic WS rows: active / upcoming / recent, open-ended, PST, sorting (fixture is SYNTHETIC)', () => {
    const out = W.parseStoppages(fixtureJson('water/lpms-stoppages-ws-synthetic.json'), NOW);
    assertContract(out, S.stoppages);
    assert.deepEqual(out.active, [
      { chamber: 2, begin: Z('2026-09-24T13:00:00Z'), end: null, reason: 'Lock hardware or equipment malfunction', scheduled: false, trafficStopped: false },
      { chamber: 1, begin: Z('2026-09-25T15:00:00Z'), end: Z('2026-09-26T05:00:00Z'), reason: 'Maintaining lock or lock equipment', scheduled: true, trafficStopped: true },
    ]);
    assert.deepEqual(out.upcoming.map((s) => s.begin), [Z('2026-09-28T14:00:00Z'), Z('2026-10-05T14:00:00Z'), Z('2027-01-15T15:00:00Z')]);
    assert.deepEqual(out.recent.map((s) => s.end), [Z('2026-09-22T20:55:00Z'), Z('2026-09-20T19:00:00Z')]); // newest end first; 09/10 is > 7 days
  });
  test('an active stoppage becomes recent once it ends', () => {
    const out = W.parseStoppages(fixtureJson('water/lpms-stoppages-ws-synthetic.json'), Z('2026-09-26T05:00:01Z'));
    assert.equal(out.active.length, 1);
    assert.equal(out.recent[0].end, Z('2026-09-26T05:00:00Z'));
  });
});

describe('bridges (SDOT live, observed transitions)', () => {
  const arr = W.parseBridgeBody(fixtureText('water/sdot-bridges.txt'));
  const fresh = () => ({ observingSince: null, lastPoll: 0, bridges: {}, log: [] });
  const withStatus = (status) => arr.map((b) => ({ ...b, Status: status[b.DisplayName] || 'Closed' }));

  test('parseBridgeBody: double-encoded JSON; plain JSON too; errors', () => {
    assert.equal(arr.length, 5);
    assert.deepEqual(W.parseBridgeBody(JSON.stringify(arr)), arr);
    assert.throws(() => W.parseBridgeBody('<html><body>Server Error</body></html>'), /bridges: bad JSON/);
    assert.throws(() => W.parseBridgeBody('"[]"'), /empty bridge list/);
    assert.throws(() => W.parseBridgeBody('{}'), /empty bridge list/);
  });
  test('first observation: all down, since unknown; Ballard first, Fremont second', () => {
    const out = W.observeBridges(fresh(), arr, NOW);
    assertContract(out, S.bridges);
    assert.deepEqual(out.bridges.map((b) => b.name), ['Ballard', 'Fremont', '1st Ave S', 'Montlake', 'South Park']);
    assert.ok(out.bridges.every((b) => b.up === false && b.since === null && b.sinceKnown === false));
    assert.deepEqual(out.log, []);
    assert.equal(out.observingSince, NOW);
  });
  test('an opening seen going up: since = midpoint of the two polls; an open log entry', () => {
    const st = fresh();
    W.observeBridges(st, arr, NOW);
    const out = W.observeBridges(st, withStatus({ Ballard: 'Open' }), NOW + 20e3);
    assert.deepEqual(out.bridges[0], { ...out.bridges[0], up: true, since: NOW + 10e3, sinceKnown: true });
    assert.deepEqual(out.log, [{ bridge: 'Ballard', upAt: NOW + 10e3, downAt: null, minutes: null }]);
    assert.equal(st.lastPoll, NOW + 20e3);
  });
  test('continuous polling closes the log entry; a < 90 s blip reopens the same opening', () => {
    const st = fresh();
    let t = NOW;
    W.observeBridges(st, arr, t);
    const poll = (status) => { t += 20e3; return W.observeBridges(st, withStatus(status), t); };
    poll({ Ballard: 'Open' }); // up at NOW+10s
    for (let i = 0; i < 14; i++) poll({ Ballard: 'Open' });
    let out = poll({}); // down
    const downAt = t - 10e3;
    assert.deepEqual(out.log[0], { bridge: 'Ballard', upAt: NOW + 10e3, downAt, minutes: Math.round(((downAt - NOW - 10e3) / 60e3) * 10) / 10 });
    assert.equal(out.bridges[0].up, false);
    assert.equal(out.bridges[0].since, downAt);
    out = poll({ Ballard: 'Open' }); // back up 20 s later: same opening
    assert.equal(out.log.length, 1);
    assert.deepEqual(out.log[0], { bridge: 'Ballard', upAt: NOW + 10e3, downAt: null, minutes: null });
    assert.equal(out.bridges[0].since, NOW + 10e3);
    assertContract(out, S.bridges);
  });
  test('a polling gap > 5 min loses continuity: since unknown, open log entries dropped', () => {
    const st = fresh();
    W.observeBridges(st, arr, NOW);
    W.observeBridges(st, withStatus({ Fremont: 'Open' }), NOW + 20e3);
    const out = W.observeBridges(st, withStatus({ Fremont: 'Open' }), NOW + 20e3 + 6 * MIN);
    assert.equal(out.bridges[1].name, 'Fremont');
    assert.deepEqual([out.bridges[1].up, out.bridges[1].since, out.bridges[1].sinceKnown], [true, null, false]);
    assert.deepEqual(out.log, []);
    assert.equal(out.observingSince, NOW + 20e3 + 6 * MIN);
  });
  test('a bridge already up when watching started: its closing is not logged (upAt unknown)', () => {
    const st = fresh();
    W.observeBridges(st, withStatus({ Ballard: 'Open' }), NOW);
    const out = W.observeBridges(st, withStatus({}), NOW + 20e3);
    assert.deepEqual(out.log, []);
    assert.deepEqual([out.bridges[0].since, out.bridges[0].sinceKnown], [NOW + 10e3, true]);
  });
  test('the output log is capped at 50, newest first; rows without an id are skipped', () => {
    const st = fresh();
    st.log = Array.from({ length: 80 }, (_, i) => ({ bridge: 'Fremont', upAt: NOW - (i + 1) * HOUR, downAt: NOW - (i + 1) * HOUR + 5 * MIN, minutes: 5 }));
    const out = W.observeBridges(st, [...arr, { DisplayName: 'Ghost' }], NOW);
    assert.equal(out.log.length, 50);
    assert.equal(out.log[0].upAt, NOW - HOUR);
    assert.equal(out.bridges.length, 5);
    assert.throws(() => W.observeBridges(fresh(), [{ Status: 'Closed' }], NOW), /no usable rows/);
  });
});

describe('bridge-history (Seattle open data gm8h-9449, floating Pacific)', () => {
  const rows = fixtureJson('water/socrata-gm8h-9449.json');
  const out = W.parseBridgeHistory(rows);
  test('meets the contract with exact values', () => {
    assertContract(out, S.bridgeHistory);
    assert.equal(out.newest, Z('2026-09-25T05:26:00Z')); // 2026-09-24T22:26:00.000 PDT
    assert.deepEqual(out.openings[0], { bridge: 'Ballard', open: Z('2026-09-25T05:26:00Z'), close: Z('2026-09-25T05:31:00Z'), minutes: 5 });
    assert.deepEqual(out.stats.Ballard, { last24h: 10, last7d: 65, avgMin: 3.7, latest: Z('2026-09-25T05:26:00Z') });
    assert.equal(out.stats.Fremont.last24h, 10);
    assert.equal(out.stats.Fremont.last7d, 94);
    assert.equal(out.openings.length, 100);
    out.openings.forEach((o, i) => i && assert.ok(o.open <= out.openings[i - 1].open));
    assert.ok(out.openings.every((o) => o.open > out.newest - 7 * DAY));
  });
  test('minutes are derived from close - open when missing', () => {
    const o = W.parseBridgeHistory([{ entityname: 'Ballard', opendatetime: '2026-09-24T10:00:00.000', closedatetime: '2026-09-24T10:04:30.000' }]);
    assert.equal(o.openings[0].minutes, 4.5);
  });
  test('empty dataset: warning, empty stats; non-array throws; other bridges ignored', () => {
    const o = W.parseBridgeHistory([{ entityname: 'Montlake', opendatetime: '2026-09-24T10:00:00.000' }]);
    assert.deepEqual(o.openings, []);
    assert.equal(o.newest, null);
    assert.deepEqual(o.stats.Ballard, { last24h: 0, last7d: 0, avgMin: null, latest: null });
    assert.deepEqual(o.warnings, ['no Ballard/Fremont openings in the last 9 days (dataset may be stale)']);
    assertContract(o, S.bridgeHistory);
    assert.throws(() => W.parseBridgeHistory({ error: true, message: 'query timeout' }), /unexpected response/);
  });
});

describe('salmon (WDFW HTML tables)', () => {
  const html = fixtureText('water/wdfw-salmon.html');
  test('meets the contract with exact values', () => {
    const out = W.parseSalmon(html, NOW);
    assertContract(out, S.salmon);
    assert.equal(out.year, 2026);
    const by = Object.fromEntries(out.species.map((s) => [s.name, s]));
    assert.deepEqual(Object.keys(by), ['Sockeye', 'Chinook', 'Coho']);
    assert.deepEqual({ ...by.Chinook, recent: by.Chinook.recent.length }, {
      name: 'Chinook', latestDate: '9/24', latestT: Z('2026-09-24T07:00:00Z'), latestCount: 217, total: 14668, recent: 7,
    });
    assert.deepEqual(by.Coho.recent.at(-1), { date: '9/24', count: 1338 });
    assert.equal(by.Coho.total, 12299);
    assert.equal(by.Sockeye.latestDate, '9/10'); // a zero count is still a count
    assert.equal(by.Sockeye.latestCount, 0);
  });
  test('a missing table is a warning; no tables (error page) throws', () => {
    const noCoho = html.replace(/<table[^>]*id="lw-coho-counts"[\s\S]*?<\/table>/, '');
    const o = W.parseSalmon(noCoho, NOW);
    assert.deepEqual(o.species.map((s) => s.name), ['Sockeye', 'Chinook']);
    assert.deepEqual(o.warnings, ['Coho: table lw-coho-counts not found']);
    assert.throws(() => W.parseSalmon('<html><body>Access denied</body></html>', NOW), /no count tables parsed/);
  });
  test('the year falls back to the Pacific year of now when captions lack one', () => {
    const noYear = html.replace(/2026 daily counts/g, 'Daily counts');
    const o = W.parseSalmon(noYear, NOW);
    assert.equal(o.year, 2026);
    assert.equal(o.species[1].latestT, Z('2026-09-24T07:00:00Z'));
  });
});

describe('cso (King County CSV)', () => {
  const text = fixtureText('water/kc-cso.csv');
  test('meets the contract with exact values', () => {
    const out = W.parseCso(text);
    assertContract(out, S.cso);
    assert.equal(out.sites.length, 17);
    assert.equal(out.overflowing, 3);
    assert.equal(out.recent, 1);
    assert.equal(out.t, Z('2026-09-26T01:40:00Z')); // '09/25/2026 18:40' Pacific
    assert.deepEqual(out.sites[0], { tag: 'NPDES147', name: 'Seattle CSO #147', lat: 47.64756843, lon: -122.3426858, status: 'overflowing', t: Z('2026-09-26T01:40:00Z') });
    assert.ok(out.sites.every((s) => !/^Dummy/.test(s.name) && !/^CSO_Status/.test(s.tag)));
    const rank = { overflowing: 0, recent: 1, nodata: 2, none: 3 };
    out.sites.forEach((s, i) => i && assert.ok(rank[s.status] >= rank[out.sites[i - 1].status]));
  });
  test('an HTML maintenance page throws instead of reading as "no overflows"', () => {
    assert.throws(() => W.parseCso('<html>\n<head><title>Maintenance</title></head>\n<body>Back soon</body>\n</html>\n'), /unexpected CSV header/);
    assert.throws(() => W.parseCso('<html><body>Back soon</body></html>'), /empty CSV/); // one line = a header with no rows
    assert.throws(() => W.parseCso('CSO_TagName,X_COORD,Y_COORD,Name,DSN,DateTime,Status\n'), /empty CSV/);
    assert.throws(() => W.parseCso(''), /./);
  });
  test('no Ballard-area rows throws; unknown status is nodata', () => {
    const head = 'CSO_TagName,X_COORD,Y_COORD,Name,DSN,DateTime,Status';
    assert.throws(() => W.parseCso(`${head}\nX1,-122.2,47.5,Renton,1,09/25/2026 18:40,NoRecentOverflow\n`), /no Ballard-area outfalls/);
    const o = W.parseCso(`${head}\nX2,-122.38,47.67,Ballard Test,,09/25/2026 18:40,Weird\n`);
    assert.equal(o.sites[0].status, 'nodata');
  });
});
