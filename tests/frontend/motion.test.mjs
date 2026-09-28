// Motion models and fleet lookups of the live 3D scene (public/live): dead reckoning, error blending, route-following
// with predicted stop times, geodesy helpers, and aircraft/bus model selection. Plain ES modules, run under Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FlightTrack, PathTrack, KT, FPM, closestApproach } from '../../public/live/motion.js';
import { measure, along, project, distM, bearing, offset, enu, metersPerPixel } from '../../public/live/geo.js';
import { aircraftSpec, busSpec, trainConsist, AIR_MODELS } from '../../public/live/fleet.js';
import { routeFit } from '../../public/live/ui/cards.js';

const T0 = Date.parse('2026-09-28T15:00:00Z');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b} (±${tol})`);

test('geo: offsets, distances, bearings agree', () => {
  const [lon, lat] = offset(-122.3847, 47.6687, 300, 400);
  near(distM(-122.3847, 47.6687, lon, lat), 500, 1);
  near(bearing(-122.3847, 47.6687, lon, lat), 36.87, 0.2);
  const [e, n] = enu(-122.3847, 47.6687, lon, lat);
  near(e, 300, 1); near(n, 400, 1);
  near(metersPerPixel(15, 47.67), 1.609, 0.005);
});

test('geo: measure / along / project round-trip on a polyline', () => {
  const line = measure([[-122.39, 47.66], [-122.38, 47.66], [-122.38, 47.67]]);
  near(line.len, 750 + 1112, 15);
  const p = along(line, 400);
  near(p.heading, 90, 0.5);
  const q = project(line, p.lon, p.lat);
  near(q.s, 400, 0.5);
  near(q.d, 0, 0.5);
  const r = along(line, 400, 2); // 2 m to the right of travel (east) = south
  assert.ok(r.lat < p.lat);
});

test('FlightTrack: straight dead reckoning at ground speed and vertical rate', () => {
  const t = new FlightTrack('a');
  t.update({ t: T0, lon: -122.38, lat: 47.66, alt: 1000, gs: 100, trk: 0, vr: 5 }, T0);
  const s = t.at(T0 + 10000);
  near(distM(-122.38, 47.66, s.lon, s.lat), 1000, 5);
  near(s.heading, 0, 0.01);
  assert.ok(s.alt > 1040 && s.alt < 1051, `alt ${s.alt}`); // climb rate eases off when reports stop
  near(t.at(T0 + 100).pitch, Math.atan2(5, 100) * 180 / Math.PI, 0.2);
});

test('FlightTrack: a new report is blended in, not jumped to', () => {
  const t = new FlightTrack('a');
  t.update({ t: T0, lon: -122.38, lat: 47.66, alt: 1000, gs: 100, trk: 90, vr: 0 }, T0);
  const before = t.at(T0 + 10000);
  // the next report says it is 200 m further north than predicted
  const [lon, lat] = offset(before.lon, before.lat, 0, 200);
  t.update({ t: T0 + 10000, lon, lat, alt: 1000, gs: 100, trk: 90, vr: 0 }, T0 + 10000);
  const right = t.at(T0 + 10000);
  near(distM(before.lon, before.lat, right.lon, right.lat), 0, 1, 'no visible jump at the moment of the update');
  const later = t.at(T0 + 16000);
  const [, n] = enu(before.lon, before.lat, later.lon, later.lat);
  assert.ok(n > 190, 'converges onto the reported track within seconds');
});

test('FlightTrack: turning aircraft keep turning (and bank into it), then roll out', () => {
  const t = new FlightTrack('a');
  t.update({ t: T0, lon: -122.38, lat: 47.66, alt: 900, gs: 80, trk: 0, vr: 0 }, T0);
  t.update({ t: T0 + 10000, lon: -122.38, lat: 47.667, alt: 900, gs: 80, trk: 30, vr: 0 }, T0 + 10000);
  let s;
  for (let k = 0; k < 60; k++) s = t.at(T0 + 10000 + k * 100);
  assert.ok(s.heading > 30 && s.heading < 40, `still turning right: ${s.heading}`);
  assert.ok(s.bank > 5, `banked right: ${s.bank}`);
  const much = t.at(T0 + 10000 + 45000);
  assert.ok(much.heading < 30 + 3 * 25 + 1, 'the turn fades out');
});

test('PathTrack: follows predicted stop times and never slides backwards', () => {
  const line = measure([[-122.39, 47.66], [-122.37, 47.66]]);
  const b = new PathTrack('bus', line);
  const [lon, lat] = along(line, 100) && [along(line, 100).lon, along(line, 100).lat];
  b.update({ t: T0, lon, lat, plan: [[T0 + 60000, 400], [T0 + 120000, 700]] }, T0);
  near(b.at(T0 + 30000).s, 250, 1, 'halfway to the first stop at the halfway time');
  near(b.at(T0 + 90000).s, 550, 1);
  // a report that is 30 m behind what we drew: hold, don't reverse
  const shown = b.at(T0 + 95000).s;
  const back = along(line, shown - 30);
  b.update({ t: T0 + 95000, lon: back.lon, lat: back.lat, plan: [[T0 + 120000, 700]] }, T0 + 95000);
  assert.ok(b.at(T0 + 95100).s >= shown - 0.01);
  const rear = b.behind(b.at(T0 + 96000).s, 9.6);
  near(distM(rear.lon, rear.lat, along(line, b.at(T0 + 96000).s).lon, along(line, b.at(T0 + 96000).s).lat), 9.6, 0.5);
});

test('closest approach of a straight track', () => {
  const c = closestApproach(-1000, -1000, 45, 10);
  near(c.dM, 0, 1);
  near(c.tS, Math.hypot(1000, 1000) / 10, 1);
});

test('fleet: aircraft types map to models scaled to real length and span', () => {
  const s = aircraftSpec({ type: 'B738' });
  assert.equal(s.model, 'b789');
  near(s.scale[0] * AIR_MODELS.b789.dims[0], 39.5, 0.01);
  near(s.scale[2] * AIR_MODELS.b789.dims[2], 35.8, 0.01);
  assert.equal(aircraftSpec({ type: 'DHC2' }).floats, true);
  assert.equal(aircraftSpec({ type: 'EC35' }).heli, true);
  assert.equal(aircraftSpec({ type: 'ZZZZ', category: 'A7' }).model, 'bell206');
  assert.equal(aircraftSpec({ type: '', kind: 'seaplane' }).floats, true);
});

test('fleet: Metro vehicle numbers pick the right bus and livery', () => {
  const trolley = busSpec('4312', '44');
  assert.equal(trolley.trolley, true); assert.equal(trolley.artic, false); assert.equal(trolley.front, 'trolley40');
  const rapid = busSpec('6069', 'D Line');
  assert.equal(rapid.artic, true); assert.equal(rapid.front, 'bus60f-rapid'); assert.equal(rapid.rear, 'bus60r-rapid');
  const artic = busSpec('8123', '40');
  assert.equal(artic.artic, true); assert.ok(/^bus60f-(teal|blue|green)$/.test(artic.front));
  assert.equal(busSpec('', '44').trolley, true, 'unknown vehicle on a trolley route');
  assert.equal(trainConsist('Amtrak Cascades').loco, 'loco-cascades');
});

test('route fit: accepts a filed route that matches the position, rejects one that does not', () => {
  const sea = { lat: 47.45, lon: -122.31, iata: 'SEA' }, pdx = { lat: 45.59, lon: -122.6, iata: 'PDX' }, sna = { lat: 33.68, lon: -117.87, iata: 'SNA' };
  const onWay = routeFit({ origin: sea, destination: pdx }, { lat: 46.9, lon: -122.45 });
  assert.equal(onWay.ok, true);
  assert.ok(onWay.frac > 0.2 && onWay.frac < 0.4);
  assert.equal(routeFit({ origin: sna, destination: pdx }, { lat: 47.67, lon: -122.38 }).ok, false);
  assert.equal(routeFit(null, { lat: 47.67, lon: -122.38 }), null);
});
