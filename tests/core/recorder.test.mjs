// Rewind: the recorder's hour records and the app's interpolation of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addSample, pacificHour } from '../../core/recorder.mjs';
import { statesAt, bracket } from '../../public/live/replay.js';

const T0 = Date.parse('2026-09-28T17:00:00Z'); // 10:00 am PDT

test('pacific hour keys', () => {
  assert.deepEqual(pacificHour(T0), { date: '2026-09-28', hour: 10 });
  assert.deepEqual(pacificHour(Date.parse('2026-12-01T07:30:00Z')), { date: '2026-11-30', hour: 23 });
});

test('recorded samples interpolate smoothly and stop at holes', () => {
  const rec = { v: 1, t0: T0, aircraft: {}, buses: {}, trains: {} };
  addSample(rec, T0, { aircraft: { aircraft: [{ hex: 'a1', callsign: 'ASA1', type: 'B738', lat: 47.60, lon: -122.40, altFt: 3000, track: 0, gsKt: 200 }] },
    buses: { vehicles: [{ id: '4312', route: '100224', trip: 't', lat: 47.668, lon: -122.39, delay: 60 }] }, trains: { trains: [] } });
  addSample(rec, T0 + 30e3, { aircraft: { aircraft: [{ hex: 'a1', callsign: 'ASA1', type: 'B738', lat: 47.62, lon: -122.40, altFt: 3600, track: 10, gsKt: 210 }] },
    buses: { vehicles: [{ id: '4312', route: '100224', trip: 't', lat: 47.668, lon: -122.38, delay: 60 }] }, trains: { trains: [] } });
  const mid = statesAt(rec, T0 + 15e3);
  assert.equal(mid.aircraft.length, 1);
  assert.ok(Math.abs(mid.aircraft[0].lat - 47.61) < 1e-4);
  assert.ok(Math.abs(mid.aircraft[0].altFt - 3300) < 1);
  assert.ok(mid.aircraft[0].vrFpm > 1000, 'climbing 600 ft in 30 s');
  assert.equal(mid.buses.length, 1);
  assert.ok(Math.abs(mid.buses[0].bearing - 90) < 1, 'heading east from the two samples');
  assert.equal(statesAt(rec, T0 + 10 * 60e3).aircraft.length, 0, 'nothing invented long after the last sample');
  assert.equal(bracket([[0], [300]], 150), null, 'a 5-minute hole is not bridged');
});
