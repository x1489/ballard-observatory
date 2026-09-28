// Moving-things sources: the GTFS-realtime decoder (round trip through its own encoder), King County Metro buses
// joined with trip updates, Amtrak trains on the Ballard line, CelesTrak element sets, and the flight lookup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFeed, encode } from '../../sources/gtfsrt.mjs';
import { parseBuses, parseTrains, parseTle, ballardPass, BUS_AREA } from '../../sources/tracks.mjs';
import { lookupFlight, parseRoute, parseAircraft, parsePhoto, memoryCache } from '../../sources/lookup.mjs';

const NOW = Date.parse('2026-09-28T15:00:00Z');
const S = Math.floor(NOW / 1000);

function feed(entities) { return encode({ header: { version: '2.0', timestamp: S }, entity: entities }); }

test('gtfs-rt: decodes what it encodes, including negative delays and floats', () => {
  const bytes = feed([{ id: 'e1', tripUpdate: { trip: { tripId: 't1', routeId: '102581', directionId: 1 }, delay: -95,
    stops: [{ seq: 4, stopId: '13721', arrival: { time: S + 60, delay: -2504 } }] } }]);
  const f = decodeFeed(bytes);
  assert.equal(f.header.timestamp, S);
  const u = f.entity[0].tripUpdate;
  assert.equal(u.trip.tripId, 't1');
  assert.equal(u.trip.directionId, 1);
  assert.equal(u.delay, -95);
  assert.equal(u.stops[0].arrival.delay, -2504);
  assert.equal(u.stops[0].arrival.time, S + 60);
});

test('gtfs-rt: skips unknown fields and survives empty feeds', () => {
  const f = decodeFeed(feed([]));
  assert.deepEqual(f.entity, []);
  // an unknown varint field (#9) and length-delimited field (#10) in the header are skipped
  const extra = new Uint8Array([0x0a, 0x0a, 0x0a, 0x03, 0x32, 0x2e, 0x30, 0x48, 0x05, 0x52, 0x01, 0x41]);
  assert.equal(decodeFeed(extra).header.version, '2.0');
});

test('buses: keeps vehicles in the Ballard area, joins upcoming stops, drops stale fixes', () => {
  const vp = feed([
    { id: 'a', vehicle: { trip: { tripId: 'T44', routeId: '100224', directionId: 0 }, position: { lat: 47.6687, lon: -122.3847 }, stopSeq: 12, stopId: '29225', timestamp: S - 20, vehicle: { id: '4312', label: '4312' } } },
    { id: 'b', vehicle: { trip: { tripId: 'TX', routeId: '100001' }, position: { lat: 47.50, lon: -122.25 }, timestamp: S - 20, vehicle: { id: '9999' } } }, // outside
    { id: 'c', vehicle: { trip: { tripId: 'TOLD', routeId: '102581' }, position: { lat: 47.67, lon: -122.376 }, timestamp: S - 3600, vehicle: { id: '6069' } } }, // stale
  ]);
  const tu = feed([{ id: 'u', tripUpdate: { trip: { tripId: 'T44' }, stops: [
    { seq: 11, stopId: 'PAST', arrival: { time: S - 60, delay: 30 } },
    { seq: 12, stopId: '29225', arrival: { time: S + 30, delay: 120 } },
    { seq: 13, stopId: '29582', arrival: { time: S + 120, delay: 120 } }] } }]);
  const out = parseBuses(vp, tu, NOW);
  assert.equal(out.count, 1);
  const v = out.vehicles[0];
  assert.equal(v.id, '4312');
  assert.equal(v.route, '100224');
  assert.equal(v.delay, 120);
  assert.deepEqual(v.next.map((n) => n[0]), ['29225', '29582']);
  assert.equal(v.next[0][2], (S + 30) * 1000);
  assert.ok(v.lat >= BUS_AREA.s && v.lat <= BUS_AREA.n);
  // positions still come through without predictions
  assert.equal(parseBuses(vp, null, NOW).vehicles[0].next.length, 0);
});

const station = (code, name, sch, est, status = '') => ({ code, name, schArr: sch, schDep: sch, arr: est, dep: est, status });
test('trains: only trains via Ballard (Seattle to Edmonds and north); estimates the Ballard crossing', () => {
  const iso = (m) => new Date(NOW + m * 60e3).toISOString();
  const j = {
    517: [{ routeName: 'Amtrak Cascades', trainNum: '517', trainID: '517-28', lat: 47.66, lon: -122.40, heading: 'S', velocity: 58, trainState: 'Active',
      origCode: 'VAC', origName: 'Vancouver', destCode: 'SEA', destName: 'Seattle', lastValTS: iso(-1),
      stations: [station('VAC', 'Vancouver', iso(-240), iso(-238), 'Departed'), station('EDM', 'Edmonds', iso(-20), iso(-18), 'Departed'), station('SEA', 'Seattle', iso(12), iso(14), 'Enroute')] }],
    501: [{ routeName: 'Amtrak Cascades', trainNum: '501', trainID: '501-28', lat: 47.4, lon: -122.3, trainState: 'Active', origCode: 'SEA', destCode: 'PDX',
      stations: [station('SEA', 'Seattle', iso(-30), iso(-30)), station('TAC', 'Tacoma', iso(10), iso(12))] }],
    8: [{ routeName: 'Empire Builder', trainNum: '8', trainID: '8-28', lat: 47.598, lon: -122.33, trainState: 'Predeparture', origCode: 'SEA', destCode: 'CHI',
      stations: [station('SEA', 'Seattle', iso(120), iso(120)), station('EDM', 'Edmonds', iso(147), iso(147)), station('EVR', 'Everett', iso(170), iso(170))] }],
  };
  const out = parseTrains(j, NOW);
  assert.deepEqual(out.trains.map((t) => t.num), ['517']);
  assert.equal(out.trains[0].pass.northbound, false);
  assert.deepEqual(out.upcoming.map((t) => t.num), ['8']);
  const p = out.upcoming[0].pass;
  assert.equal(p.northbound, true);
  // 36% of the way from Seattle (dep +120 min) to Edmonds (+147 min)
  assert.ok(Math.abs(p.t - (NOW + (120 + 27 * 0.36) * 60e3)) < 1000);
  assert.equal(ballardPass([station('SEA', 'Seattle', null, null)]), null);
});

test('satellites: parses three-line element sets', () => {
  const txt = `ISS (ZARYA)
1 25544U 98067A   26270.17419514  .00009528  00000+0  18291-3 0  9990
2 25544  51.6315 155.3455 0007168 193.0560 167.0244 15.48664528587565
junk line
`;
  const s = parseTle(txt);
  assert.equal(s.length, 1);
  assert.equal(s[0].id, 25544);
  assert.equal(s[0].name, 'ISS (ZARYA)');
});

test('flight lookup: parses adsbdb and planespotters, caches hits and misses', async () => {
  const route = { response: { flightroute: { callsign: 'ASA1085', callsign_iata: 'AS1085', airline: { name: 'Alaska Airlines', iata: 'AS', icao: 'ASA' },
    origin: { iata_code: 'SEA', icao_code: 'KSEA', name: 'Seattle-Tacoma', municipality: 'Seattle', latitude: 47.45, longitude: -122.31 },
    destination: { iata_code: 'PDX', icao_code: 'KPDX', name: 'Portland', municipality: 'Portland', latitude: 45.59, longitude: -122.6 } } } };
  assert.equal(parseRoute(route).destination.iata, 'PDX');
  assert.equal(parseAircraft({ response: { aircraft: { type: '737-990ER', icao_type: 'B739', manufacturer: 'Boeing', registration: 'N413AS', registered_owner: 'A Person' } } }).registration, 'N413AS');
  assert.equal(parseAircraft({ response: { aircraft: { registered_owner: 'A Person' } } }).owner, undefined, 'owners are never returned');
  assert.equal(parsePhoto({ photos: [{ thumbnail_large: { src: 'https://t.plnspttrs.net/x.jpg', size: { width: 420, height: 280 } }, link: 'https://www.planespotters.net/photo/1', photographer: 'J. Doe' }] }).credit, 'J. Doe');
  assert.equal(parsePhoto({ photos: [] }), null);
  const calls = [];
  const fetchJson = async (u) => {
    calls.push(u);
    if (u.includes('/callsign/')) return route;
    const e = new Error('404'); e.status = 404; throw e;
  };
  const cache = memoryCache();
  const a = await lookupFlight({ callsign: 'asa1085', hex: 'A1B2C3' }, cache, fetchJson);
  assert.equal(a.route.airline.iata, 'AS');
  assert.equal(a.aircraft, null);
  const n = calls.length;
  await lookupFlight({ callsign: 'ASA1085', hex: 'a1b2c3' }, cache, fetchJson);
  assert.equal(calls.length, n, 'second lookup served from cache, including the 404s');
  const bad = await lookupFlight({ callsign: '<script>', hex: 'zz' }, memoryCache(), fetchJson);
  assert.equal(bad.route, null);
});
