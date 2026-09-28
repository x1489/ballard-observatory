// group `move` parsers (sources/move.mjs _test) on real fixtures, with a fixed clock.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { _test as M } from '../../sources/move.mjs';
import { haversineKm, CENTER } from '../../lib.mjs';
import { NOW, MIN, HOUR, DAY, fixtureJson, fixtureText, assertContract, hygiene, knownDeviation } from './_helpers.mjs';
import * as S from './_schemas.mjs';

const Z = (s) => Date.parse(s);
const clone = (o) => JSON.parse(JSON.stringify(o));

describe('transit (OBA arrivals-and-departures-for-location)', () => {
  const j = fixtureJson('move/oba-arrivals.json');
  const out = M.parseTransit(j, NOW);

  test('meets the contract', () => assertContract(out, S.transit));
  test('now is OBA currentTime; groups sorted by route (D Line, 40, 44) then headsign', () => {
    assert.equal(out.now, j.currentTime);
    assert.deepEqual(out.groups.map((g) => [g.route, g.headsign, g.dir, g.stopId]), [
      ['D Line', 'Crown Hill', 'to Crown Hill', '1_14230'],
      ['D Line', 'Downtown Seattle Uptown', 'to Downtown', '1_13721'],
      ['40', 'Downtown Seattle Fremont', 'to Downtown', '1_18120'],
      ['40', 'Northgate Station', 'to Northgate', '1_18740'],
      ['44', 'Ballard Wallingford', 'to Ballard', '1_18740'],
      ['44', 'University District', 'to U District', '1_18120'],
      ['44', 'University Of Washington Medical Center Wallingford', 'to UW Medical Center', '1_18120'],
    ]);
    // 'D Line | Ballard' and '40 | Northgate Station Ballard' share trips with the groups above, so they merged.
    assert.equal(out.groups.filter((g) => g.headsign === 'Ballard' || g.headsign === 'Northgate Station Ballard').length, 0);
  });
  test('exact first arrival, derived minutes and deviation', () => {
    const g = out.groups[0];
    assert.equal(g.stopName, '15th Ave NW & NW Market St');
    assert.equal(g.stopDir, 'N');
    assert.deepEqual(g.arrivals[0], {
      t: 1790387432000, predicted: true, min: 8.7, vehicleId: '1_6054', stopsAway: 5, distM: 3342, occupancy: 'MANY_SEATS_AVAILABLE',
      deviationSec: 272, confidence: 'live',
    });
    for (const grp of out.groups) {
      assert.ok(grp.arrivals.length <= 4);
      grp.arrivals.forEach((a, i) => {
        assert.ok(a.t >= out.now - 30e3);
        assert.equal(a.min, Math.round(((a.t - out.now) / 60000) * 10) / 10);
        if (i) assert.ok(a.t >= grp.arrivals[i - 1].t);
      });
    }
  });
  test('the same trip listed twice (duplicate stopIds) is one arrival; a live row beats a placeholder double', () => {
    const x = clone(j);
    const list = x.data.entry.arrivalsAndDepartures;
    const a = list.find((r) => r.stopId === '1_13721' && r.predicted);
    list.push({ ...clone(a), vehicleId: '1_8247382', predictedArrivalTime: a.scheduledArrivalTime, predicted: true });
    list.push(clone(a));
    const g = M.parseTransit(x, NOW).groups.find((grp) => grp.stopId === '1_13721');
    assert.deepEqual(g, out.groups[1]);
  });
  test("a 7+ digit placeholder vehicle with zero deviation is 'low' confidence", () => {
    const a = M.normArrival({ predicted: true, predictedArrivalTime: NOW + 5 * MIN, scheduledArrivalTime: NOW + 5 * MIN, vehicleId: '1_8247382' }, NOW);
    assert.equal(a.confidence, 'low');
    const s = M.normArrival({ predicted: false, predictedArrivalTime: 0, scheduledArrivalTime: NOW + 5 * MIN, vehicleId: '1_6231', distanceFromStop: 100 }, NOW);
    assert.deepEqual({ c: s.confidence, t: s.t, dev: s.deviationSec, distM: s.distM, min: s.min }, { c: 'scheduled', t: NOW + 5 * MIN, dev: null, distM: null, min: 5 });
    assert.equal(M.normArrival({ predicted: false, scheduledArrivalTime: 0 }, NOW), null);
  });
  test('without currentTime the caller clock is used; arrivals already gone are dropped', () => {
    const x = clone(j);
    delete x.currentTime;
    const o = M.parseTransit(x, j.currentTime + 10 * MIN);
    assert.equal(o.now, j.currentTime + 10 * MIN);
    assert.ok(o.groups.every((g) => g.arrivals.every((a) => a.t >= o.now - 30e3)));
    assert.ok(o.groups.length > 0);
  });
  test('empty upstream list, limitExceeded, and situations mapped to route names', () => {
    const x = clone(j);
    x.data.entry.arrivalsAndDepartures = [];
    x.data.entry.limitExceeded = true;
    x.data.references.situations = [{
      id: '1_s1', summary: { value: 'Detour on 15th' }, description: { value: 'Use stop 1_18120' }, severity: 'WARNING',
      allAffects: [{ routeId: '1_102581' }, { routeId: '1_100224' }, { routeId: '1_nope' }],
    }];
    const o = M.parseTransit(x, NOW);
    assert.deepEqual(o.groups, []);
    assert.deepEqual(o.warnings, ['OBA limitExceeded: some stops may be missing']);
    assert.deepEqual(o.situations, [{ id: '1_s1', summary: 'Detour on 15th', description: 'Use stop 1_18120', severity: 'WARNING', routes: ['D Line', '44'] }]);
    assertContract(o, S.transit);
  });
  test('dirLabel and route ordering helpers', () => {
    assert.equal(M.dirLabel('Downtown Seattle Uptown'), 'to Downtown');
    assert.equal(M.dirLabel('Crown Hill'), 'to Crown Hill');
    assert.equal(M.dirLabel('University Of Washington Medical Center Wallingford'), 'to UW Medical Center');
    assert.equal(M.dirLabel('Northgate Station Ballard'), 'to Northgate');
    assert.equal(M.dirLabel('Rapid Ride Transit Center'), 'to Rapid Ride TC');
    assert.equal(M.dirLabel('  Lake   City  '), 'to Lake City');
    assert.equal(M.dirLabel(''), '');
    assert.deepEqual(['28', 'E Line', '44', '5', '17', 'D Line', '40'].sort(M.compareRouteNames), ['D Line', '40', '44', '17', '28', '5', 'E Line']);
  });
  test('an arrival with an empty headsign: only the known "" deviation (open issue for B1)', (t) => {
    const x = clone(j);
    for (const a of x.data.entry.arrivalsAndDepartures) if (a.routeShortName === '44') a.tripHeadsign = '';
    knownDeviation(t, hygiene(M.parseTransit(x, NOW)), [/\.groups\[\d+\]\.(headsign|dir): ""$/]);
  });
});

describe('vehicles (OBA trips-for-route)', () => {
  const parsed = Object.fromEntries(M.VEHICLE_ROUTES.map(([rid, name]) => [name, M.parseTripsForRoute(fixtureJson(`move/oba-trips-${rid}.json`), rid, name)]));
  const all = Object.values(parsed).flat();

  test('meets the contract; one vehicle per active trip, all within 6 km', () => {
    assertContract({ vehicles: all }, S.vehicles);
    assert.deepEqual(Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v.length])), { 'D Line': 8, 40: 13, 44: 9 });
    for (const v of all) assert.ok(haversineKm(v.lat, v.lon) <= 6);
    assert.ok(all.every((v) => !/^1_\d{7,}$/.test(v.vehicleId)));
  });
  test('exact first D Line vehicle: GPS fix time, compass heading, deviation', () => {
    assert.deepEqual(parsed['D Line'][0], {
      route: 'D Line', headsign: 'Ballard Uptown', vehicleId: '1_6091', lat: 47.66709, lon: -122.37622, heading: 0, deviationSec: 370, t: 1790386843000,
    });
  });
  test('placeholders, interlined trips, missing fixes and far-away buses are skipped; OBA orientation -> compass', () => {
    const trip = { id: 't1', routeId: '1_102581', tripHeadsign: 'Crown Hill' };
    const other = { id: 't2', routeId: '1_100512', tripHeadsign: 'E Line' };
    const st = (o) => ({ vehicleId: '1_6000', activeTripId: 't1', position: { lat: 47.67, lon: -122.38 }, lastKnownLocation: { lat: 47.67, lon: -122.38 }, lastLocationUpdateTime: NOW - MIN, orientation: 0, predicted: true, scheduleDeviation: 61.4, ...o });
    const j = { data: { references: { trips: [trip, other] }, list: [
      { status: st({}) },
      { status: st({ vehicleId: '1_8247382', activeTripId: 'x' }) },
      { status: st({ vehicleId: '1_6001', activeTripId: 't2' }) },
      { status: st({ vehicleId: '1_6002', lastKnownLocation: null }) },
      { status: st({ vehicleId: '1_6003', lastLocationUpdateTime: 0 }) },
      { status: st({ vehicleId: '1_6004', position: { lat: 47.9, lon: -122.3 } }) },
      { status: null },
    ] } };
    const v = M.parseTripsForRoute(j, '1_102581', 'D Line');
    assert.deepEqual(v, [{ route: 'D Line', headsign: 'Crown Hill', vehicleId: '1_6000', lat: 47.67, lon: -122.38, heading: 90, deviationSec: 61, t: NOW - MIN }]);
    const heading = (o) => M.parseTripsForRoute({ data: { references: { trips: [trip] }, list: [{ status: st({ orientation: o }) }] } }, '1_102581', 'D Line')[0].heading;
    assert.deepEqual([0, 90, 180, 270, 359.6].map(heading), [90, 0, 270, 180, 90]);
  });
  test('carriedVehicles keeps < 5 min old positions of routes that failed this round', () => {
    const prev = { vehicles: [{ route: '40', t: NOW - 4 * MIN }, { route: '40', t: NOW - 6 * MIN }, { route: '44', t: NOW - MIN }, { route: '40', t: null }] };
    assert.deepEqual(M.carriedVehicles(prev, ['40'], NOW), [{ route: '40', t: NOW - 4 * MIN }]);
  });
});

describe('metro-alerts (KCM GTFS-rt JSON)', () => {
  const j = fixtureJson('move/kcm-alerts.json');
  test('meets the contract; the real upcoming 44 stop closure', () => {
    const out = M.parseMetroAlerts(j, NOW);
    assertContract(out, S.metroAlerts);
    assert.equal(out.total, j.entity.length);
    assert.equal(out.alerts.length, 1);
    assert.deepEqual({ ...out.alerts[0], description: undefined }, {
      id: '95308', header: 'Stop #29217 NW Market St & 11th Ave NW (EB) closed from 7:00 AM to 3:00 PM on Sat Sep 26 due to construction.',
      description: undefined, effect: 'NO_SERVICE', severity: 'WARNING', start: Z('2026-09-26T14:00:00Z'), end: Z('2026-09-26T22:00:00Z'),
      routes: ['44'], stops: [], url: 'https://tripplanner.kingcounty.gov/#/app/nextdepartures/stoproutes/6414',
    });
  });
  test('active/upcoming windows relative to now; route and stop matching; severity sort', () => {
    const nowS = NOW / 1000;
    const tr = (text) => ({ translation: [{ text: `${text} (es)`, language: 'es' }, { text, language: 'en' }] });
    const ent = (id, alert) => ({ id, alert: { header_text: tr(`h${id}`), effect: 'DETOUR', ...alert } });
    const x = { entity: [
      ent('expired', { informed_entity: [{ route_id: '102581' }], active_period: [{ start: nowS - 7200, end: nowS - 60 }] }),
      ent('far', { informed_entity: [{ route_id: '102581' }], active_period: [{ start: nowS + 8 * 86400 }] }),
      ent('other-route', { informed_entity: [{ route_id: '100512' }], active_period: [{ start: nowS - 60 }] }),
      ent('stop-only', { informed_entity: [{ stop_id: '1_18120' }], active_period: [{ start: nowS - 60, end: nowS + 60 }], severity_level: 'INFO' }),
      ent('no-period', { informed_entity: [{ route_id: '1_100062' }, { route_id: '100169' }], severity_level: 'SEVERE' }),
      ent('second-period', { informed_entity: [{ route_id: '102574' }], severity_level: 'WARNING', active_period: [{ start: nowS - 9000, end: nowS - 8000 }, { start: nowS + 3600, end: nowS + 7200 }] }),
    ] };
    const out = M.parseMetroAlerts(x, NOW);
    assert.deepEqual(out.alerts.map((a) => a.id), ['no-period', 'second-period', 'stop-only']);
    assert.deepEqual(out.alerts[0], { id: 'no-period', header: 'hno-period', description: null, effect: 'DETOUR', severity: 'SEVERE', start: null, end: null, routes: ['17', '28'], stops: [], url: null });
    assert.deepEqual([out.alerts[1].start, out.alerts[1].end], [NOW + HOUR, NOW + 2 * HOUR]);
    assert.deepEqual([out.alerts[2].routes, out.alerts[2].stops], [[], ['18120']]);
    assert.equal(out.total, 6);
    assertContract(out, S.metroAlerts);
  });
  test('no entity array (error body) throws', () => {
    assert.throws(() => M.parseMetroAlerts({ message: 'Access Denied' }, NOW), /no entity array/);
    assert.throws(() => M.parseMetroAlerts(null, NOW), /no entity array/);
    assert.deepEqual(M.parseMetroAlerts({ entity: [] }, NOW), { alerts: [], total: 0 });
  });
});

describe('cameras (SDOT HEAD)', () => {
  const heads = fixtureJson('move/sdot-camera-heads.json');
  const cam = (id) => { const [cid, label, lat, lon, file] = M.CAMERAS.find((c) => c[0] === id); return { id: cid, label, lat, lon, url: `https://www.seattle.gov/trafficcams/images/${file}`, lastModified: null, ok: false }; };
  const res = (h, o = {}) => ({ status: h.status, redirected: h.redirected, headers: new Headers(Object.fromEntries(Object.entries(h.headers).filter(([, v]) => v != null))), ...o });

  test('real HEADs: all 8 fresh live frames are ok', () => {
    const cameras = heads.map((h) => M.applyCameraHead(cam(h.id), res(h), NOW));
    assertContract({ cameras }, S.cameras);
    assert.ok(cameras.every((c) => c.ok));
    assert.equal(cameras[0].lastModified, Z('2026-09-26T01:39:04Z'));
  });
  test('stale (> 30 min), maintenance placeholder, wrong type, redirect, error status and no Last-Modified are not ok', () => {
    const h = heads[0];
    const check = (r, now = NOW) => M.applyCameraHead(cam(h.id), r, now);
    assert.equal(check(res(h), Z('2026-09-26T02:09:05Z')).ok, false);
    assert.equal(check(res(h), Z('2026-09-26T02:09:04Z')).ok, true);
    assert.equal(check(res({ ...h, headers: { ...h.headers, 'content-length': '29904' } })).ok, false);
    assert.equal(check(res({ ...h, headers: { ...h.headers, 'content-type': 'text/html' } })).ok, false);
    assert.equal(check(res(h, { redirected: true })).ok, false);
    assert.equal(check(res({ ...h, status: 404 })).ok, false);
    const noLm = check(res({ ...h, headers: { 'content-type': 'image/jpeg' } }));
    assert.deepEqual([noLm.ok, noLm.lastModified], [false, null]);
  });
});

describe('traffic (SDOT travel times)', () => {
  test('meets the contract with exact values; DOWNTOWN first', () => {
    const sites = M.TRAFFIC_SITES.map(([id, name]) => M.parseTrafficSite(fixtureJson(`move/sdot-links-${id}.json`), id, name));
    assertContract({ sites }, S.traffic);
    assert.deepEqual(sites[0], {
      id: '1991', name: '15th Ave NW & NW 61st St',
      links: [{ name: 'DOWNTOWN', minutes: 23 }, { name: 'AURORA BR', minutes: 16 }, { name: 'I-5/DENNY', minutes: 21 }, { name: 'LW QN ANN', minutes: 12 }],
    });
    assert.equal(sites[1].links[0].name, 'DOWNTOWN');
    assert.equal(sites[1].links[0].minutes, 30);
  });
  test('Status != 1 is null, < 30 s is 1 min, JSON-string bodies, fallback name', () => {
    const arr = [{ LinkDisplayName: 'A', Status: 0, Value: 600 }, { LinkDisplayName: 'B', Status: 1, Value: 20 }, { LinkDisplayName: 'DOWNTOWN', Status: '1', Value: '90' }, { Status: 1 }];
    assert.deepEqual(M.parseTrafficSite(JSON.stringify(arr), '9', 'Fallback'), {
      id: '9', name: 'Fallback', links: [{ name: 'DOWNTOWN', minutes: 2 }, { name: 'A', minutes: null }, { name: 'B', minutes: 1 }],
    });
  });
  test('an HTML error page or an object throws', () => {
    assert.throws(() => M.parseTrafficSite('<html><body>Runtime Error</body></html>', '1991', 'x'), SyntaxError);
    assert.throws(() => M.parseTrafficSite({ Message: 'An error has occurred.' }, '1991', 'x'), /not an array/);
  });
});

describe('incidents (SDOT Travelers)', () => {
  const j = fixtureJson('move/sdot-incidents.json');
  test('real fixture: nothing near Ballard, citywide count', () => {
    const out = M.parseIncidents(j);
    assertContract(out, S.incidents);
    assert.deepEqual(out, { incidents: [], citywide: 5 });
  });
  test('a Ballard incident: Pacific AM/PM times, mojibake repaired, location, distance; sorted newest first', () => {
    const x = clone(j);
    x.Features.push({ PointCoordinate: [47.66851, -122.37621], Incidents: [{
      Id: 90001, Description: 'Collision at 15th Ave NW â€“ NW Market St.  Expect delays.', Type: 'Collision', StartDateTime: '9/25/2026 5:10:00 PM',
      EndDateTime: '', Direction: 'NB', StartLocationDescription: '15th Ave NW', EndLocationDescription: 'NW Market St', Url: '',
    }, {
      Id: 90002, Description: 'Older one', Type: '', StartDateTime: '9/24/2026 8:00:00 AM', EndDateTime: '9/24/2026 9:00:00 AM', StartLocationDescription: 'Leary Way NW',
    }] });
    x.Features.push({ PointCoordinate: [47.9, -122.2], Incidents: [{ Id: 90003, Description: 'Far away', StartDateTime: '9/25/2026 6:00:00 PM' }] });
    const out = M.parseIncidents(JSON.stringify(x)); // JSON-string bodies are accepted too
    assertContract(out, S.incidents);
    assert.equal(out.citywide, 8);
    assert.deepEqual(out.incidents[0], {
      id: '90001', type: 'Collision', description: 'Collision at 15th Ave NW – NW Market St. Expect delays.', start: Z('2026-09-26T00:10:00Z'), end: null,
      direction: 'NB', location: '15th Ave NW to NW Market St', lat: 47.66851, lon: -122.37621, url: null, distKm: 0.64,
    });
    assert.deepEqual([out.incidents[1].type, out.incidents[1].location, out.incidents[1].end], ['Incident', 'Leary Way NW', Z('2026-09-24T16:00:00Z')]);
  });
  test('fixMojibake1252 repairs cp1252 runs and leaves clean text alone', () => {
    assert.equal(M.fixMojibake1252('Aurora Ave N â€“ N 38th St'), 'Aurora Ave N – N 38th St');
    assert.equal(M.fixMojibake1252('Driverâ€™s side'), 'Driver’s side');
    assert.equal(M.fixMojibake1252('Café – ok'), 'Café – ok');
  });
  test('no Features array or an HTML page throws', () => {
    assert.throws(() => M.parseIncidents({ Message: 'error' }), /no Features array/);
    assert.throws(() => M.parseIncidents('<html>Server Error</html>'), SyntaxError);
  });
});

describe('lime (GBFS)', () => {
  const j = fixtureJson('move/lime-free-bike-status.json');
  test('meets the contract with exact values', () => {
    const out = M.parseLime(j);
    assertContract(out, S.lime);
    assert.equal(out.t, Z('2026-09-26T01:42:01Z'));
    assert.deepEqual(out.near, { total: 80, scooters: 26, ebikes: 54, bikes: 0 });
    assert.equal(out.inBbox, 150);
    assert.equal(out.points.length, 150);
    for (const [lat, lon, kind] of out.points) {
      assert.ok(Number.isFinite(lat) && Number.isFinite(lon));
      assert.ok(['s', 'e', 'b'].includes(kind));
    }
  });
  test('disabled and reserved vehicles are excluded', () => {
    const b = (o) => ({ bike_id: Math.random().toString(36), lat: CENTER.lat, lon: CENTER.lon, is_reserved: false, is_disabled: false, vehicle_type_id: '1', ...o });
    const out = M.parseLime({ last_updated: 1790386921, data: { bikes: [b({}), b({ is_disabled: true }), b({ is_reserved: 1 }), b({ vehicle_type_id: '4' })] } });
    assert.deepEqual(out.near, { total: 2, scooters: 1, ebikes: 0, bikes: 1 });
    assert.equal(out.inBbox, 2);
  });
  test('points are capped at 1000 (the count is not)', () => {
    const bikes = Array.from({ length: 1200 }, (_, i) => ({ bike_id: String(i), lat: 47.66 + (i % 30) * 0.001, lon: -122.40 + (i % 40) * 0.001, vehicle_type_id: '3' }));
    const out = M.parseLime({ last_updated: 'x', data: { bikes } });
    assert.equal(out.inBbox, 1200);
    assert.equal(out.points.length, 1000);
    assert.equal(out.t, null);
  });
  test('limeKind: type ids and vehicle_type names', () => {
    assert.deepEqual([{ vehicle_type_id: '1' }, { vehicle_type_id: '3' }, { vehicle_type_id: '4' }, { vehicle_type: 'e-bike' }, { vehicle_type: 'Bicycle' }, {}].map(M.limeKind), ['s', 'e', 'b', 'e', 'b', 's']);
  });
  test('no data.bikes (error body) throws', () => {
    assert.throws(() => M.parseLime({ error: 'rate limited' }), /no data\.bikes/);
    assert.throws(() => M.parseLime(null), /no data\.bikes/);
  });
});
