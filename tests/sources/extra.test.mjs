// Tests for sources/extra.mjs: aircraft normalization/kinds/detectors, iNaturalist wildlife, and bridge-odds math
// including the 33 CFR 117.1051 rush-hour rule and federal holidays.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import extra, { _test as T } from '../../sources/extra.mjs';
import { fromPacific } from '../../lib.mjs';

const NOW = Date.UTC(2026, 8, 25, 22, 0); // Fri 3:00 pm PDT

const rec = (o) => ({ hex: 'a1b2c3', flight: 'ASA123  ', r: 'N123AS', t: 'B39M', alt_baro: 3200, gs: 210.4, track: 180.2, baro_rate: -640, squawk: '1200', category: 'A3', lat: 47.67, lon: -122.38, seen_pos: 1.2, seen: 0.5, ...o });

describe('aircraft', () => {
  it('normalizes a readsb record', () => {
    const a = T.normalizeAircraft(rec(), NOW);
    assert.equal(a.hex, 'a1b2c3');
    assert.equal(a.callsign, 'ASA123');
    assert.equal(a.operator, 'Alaska Airlines');
    assert.equal(a.kind, 'airliner');
    assert.equal(a.altFt, 3200);
    assert.equal(a.onGround, false);
    assert.equal(a.emergency, null);
    assert.ok(a.distKm < 1);
    assert.equal(a.t, NOW - 1200);
  });
  it('handles ground, stale, emergency, kinds', () => {
    assert.equal(T.normalizeAircraft(rec({ alt_baro: 'ground' }), NOW).onGround, true);
    assert.equal(T.normalizeAircraft(rec({ seen_pos: 120 }), NOW), null);
    assert.equal(T.normalizeAircraft(rec({ lat: undefined }), NOW), null);
    assert.equal(T.normalizeAircraft(rec({ squawk: '7700' }), NOW).emergency, 'general emergency');
    assert.equal(T.normalizeAircraft(rec({ emergency: 'lifeguard' }), NOW).emergency, 'lifeguard');
    assert.equal(T.normalizeAircraft(rec({ flight: 'N12345', t: 'EC35', category: 'A7' }), NOW).kind, 'helicopter');
    assert.equal(T.normalizeAircraft(rec({ flight: 'N67676', t: 'DHC2', category: 'A1' }), NOW).kind, 'seaplane');
    assert.equal(T.normalizeAircraft(rec({ flight: 'N12345', t: 'C172', category: 'A1' }), NOW).kind, 'light');
    assert.equal(T.normalizeAircraft(rec({ flight: 'RCH871', t: 'C17', category: 'A5', dbFlags: 1 }), NOW).kind, 'military');
  });
  it('builds the source payload from both providers', () => {
    const lol = T.buildAircraft({ now: NOW, ac: [rec(), rec({ hex: 'b', alt_baro: 'ground', lat: 47.668, lon: -122.3847 }), rec({ hex: 'c', lat: 47.75 })] }, 'adsb.lol');
    assert.equal(lol.count, 3);
    assert.equal(lol.airborne, 2);
    assert.equal(lol.nearest.hex, 'a1b2c3');
    assert.equal(lol.aircraft[0].hex, 'b'); // sorted by distance
    const fi = T.buildAircraft({ now: NOW / 1000, aircraft: [rec()] }, 'adsb.fi');
    assert.equal(fi.t, NOW);
    assert.equal(fi.count, 1);
  });
  it('detects new emergencies and low overflights, not seaplanes, not twice', () => {
    const base = T.buildAircraft({ now: NOW, ac: [rec()] }, 'x');
    const em = T.buildAircraft({ now: NOW, ac: [rec({ squawk: '7700' })] }, 'x');
    const items = T.aircraftDetect(base, em, { now: NOW });
    assert.equal(items.length, 1);
    assert.equal(items[0].severity, 'alert');
    assert.deepEqual(T.aircraftDetect(em, em, { now: NOW }), []);
    const low = T.buildAircraft({ now: NOW, ac: [rec({ hex: 'h1', flight: 'N911KC', t: 'EC45', category: 'A7', alt_baro: 700 })] }, 'x');
    const li = T.aircraftDetect(base, low, { now: NOW });
    assert.equal(li.length, 1);
    assert.match(li[0].title, /^Helicopter low over Ballard: N911KC at 700 ft$/);
    const sea = T.buildAircraft({ now: NOW, ac: [rec({ hex: 's1', flight: 'N1234K', t: 'DHC2', category: 'A1', alt_baro: 800 })] }, 'x');
    assert.deepEqual(T.aircraftDetect(base, sea, { now: NOW }), []);
    assert.deepEqual(T.aircraftDetect(null, em, { now: NOW }), []);
  });
  it('metrics', () => {
    const src = extra.find((s) => s.id === 'aircraft');
    assert.deepEqual(src.metrics({ count: 5, airborne: 4 }), { 'aircraft.count': 5, 'aircraft.airborne': 4 });
  });
});

describe('wildlife', () => {
  const obs = (id, extra = {}) => ({
    id, observed_on: '2026-09-25', time_observed_at: '2026-09-25T12:42:12-07:00', created_at: new Date(NOW - 3600e3).toISOString(),
    taxon: { name: 'Phoca vitulina', preferred_common_name: 'Harbor Seal', iconic_taxon_name: 'Mammalia', rank: 'species' },
    photos: [{ url: 'https://inaturalist-open-data.s3.amazonaws.com/photos/1/square.jpg', attribution: '(c) someone' }],
    geojson: { coordinates: [-122.397, 47.6655] }, place_guess: 'Ballard Locks, Seattle, WA, US', uri: `https://www.inaturalist.org/observations/${id}`,
    user: { login: 'naturalist' }, quality_grade: 'research', ...extra,
  });
  it('normalizes observations', () => {
    const o = T.normalizeObservation(obs(1));
    assert.equal(o.t, Date.parse('2026-09-25T12:42:12-07:00'));
    assert.equal(o.photo, 'https://inaturalist-open-data.s3.amazonaws.com/photos/1/medium.jpg');
    assert.equal(o.lat, 47.6655);
    assert.equal(o.taxon.common, 'Harbor Seal');
    assert.equal(T.normalizeObservation({ id: 2 }), null);
    const dateOnly = T.normalizeObservation(obs(3, { time_observed_at: null, geojson: null, location: '47.66,-122.38' }));
    assert.equal(dateOnly.t, fromPacific('2026-09-25'));
    assert.equal(dateOnly.timeKnown, false);
    assert.equal(dateOnly.lon, -122.38);
  });
  it('builds counts', () => {
    const w = T.buildWildlife({ total_results: 10, results: [obs(1), obs(2)] }, { total_results: 7 }, { results: [{ taxon: { name: 'Aves' }, count: 4 }] });
    assert.equal(w.counts.total, 10);
    assert.equal(w.counts.species, 7);
    assert.equal(w.counts.byIconic.Aves, 4);
    assert.equal(w.observations.length, 2);
  });
  it('detects notable new sightings only', () => {
    const prev = T.buildWildlife({ results: [obs(1)] });
    const sparrow = obs(5, { taxon: { name: 'Passer domesticus', preferred_common_name: 'House Sparrow', iconic_taxon_name: 'Aves' }, quality_grade: 'needs_id' });
    const squirrel = obs(6, { taxon: { name: 'Sciurus carolinensis', preferred_common_name: 'Eastern Gray Squirrel', iconic_taxon_name: 'Mammalia' }, quality_grade: 'needs_id' });
    const next = T.buildWildlife({ results: [obs(1), obs(4), sparrow, squirrel] });
    const items = T.wildlifeDetect(prev, next, { now: NOW });
    assert.deepEqual(items.map((x) => x.key), ['inat:4']);
    assert.equal(items[0].severity, 'notice');
    assert.match(items[0].title, /^Harbor Seal spotted near Ballard Locks$/);
    assert.deepEqual(T.wildlifeDetect(null, next, { now: NOW }), []);
  });
});

describe('bridge odds', () => {
  it('federal holidays with observed dates', () => {
    const h26 = T.federalHolidays(2026);
    assert.equal(h26['2026-09-07'], 'Labor Day');
    assert.equal(h26['2026-10-12'], 'Columbus Day');
    assert.equal(h26['2026-11-26'], 'Thanksgiving Day');
    assert.equal(h26['2026-07-03'], 'Independence Day'); // Jul 4 2026 is a Saturday
    assert.equal(h26['2026-06-19'], 'Juneteenth');
    assert.equal(T.federalHolidays(2021)['2021-12-31'], "New Year's Day"); // Jan 1 2022 is a Saturday
  });
  it('rush-hour rule (33 CFR 117.1051(d)(2)) with holiday exemptions but not Columbus Day', () => {
    const at = (s) => T.restrictionAt(Date.parse(s));
    assert.equal(at('2026-09-28T07:00:00-07:00').rush, true);
    assert.equal(at('2026-09-28T08:59:00-07:00').rush, true);
    assert.equal(at('2026-09-28T09:00:00-07:00').rush, false);
    assert.equal(at('2026-09-28T16:30:00-07:00').rush, true);
    assert.equal(at('2026-09-28T18:00:00-07:00').rush, false);
    assert.equal(at('2026-09-26T08:00:00-07:00').rush, false); // Saturday
    assert.equal(at('2026-09-07T08:00:00-07:00').rush, false); // Labor Day
    assert.equal(at('2026-10-12T17:00:00-07:00').rush, true); // Columbus Day is not exempt
    assert.equal(at('2026-09-28T23:30:00-07:00').night, true);
    assert.equal(at('2026-12-01T08:00:00-08:00').rush, true); // PST
  });
  it('next restriction change', () => {
    const fri3pm = Date.parse('2026-09-25T15:00:00-07:00');
    const n = T.nextRestrictionChange(fri3pm);
    assert.equal(n.at, Date.parse('2026-09-25T16:00:00-07:00'));
    assert.equal(n.starts, true);
    const fri5pm = T.nextRestrictionChange(Date.parse('2026-09-25T17:00:00-07:00'));
    assert.equal(fri5pm.at, Date.parse('2026-09-25T18:00:00-07:00'));
    assert.equal(fri5pm.starts, false);
    const sat = T.nextRestrictionChange(Date.parse('2026-09-26T12:00:00-07:00'));
    assert.equal(sat.at, Date.parse('2026-09-28T07:00:00-07:00'));
  });
  it('merges sensor events and computes per-hour averages', () => {
    const t = (s) => Date.parse(s);
    const merged = T.mergeOpenings([
      { open: t('2026-09-19T10:00:00-07:00'), close: t('2026-09-19T10:03:00-07:00') },
      { open: t('2026-09-19T10:04:00-07:00'), close: t('2026-09-19T10:06:00-07:00') }, // same opening
      { open: t('2026-09-19T14:10:00-07:00'), close: t('2026-09-19T14:15:00-07:00') },
    ]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].minutes, 6);
    // Two Saturdays in the window, one opening at 10:xx on one of them: 0.5 per Saturday 10 am.
    const start = t('2026-09-12T00:00:00-07:00');
    const newest = { open: t('2026-09-21T09:00:00-07:00'), close: t('2026-09-21T09:04:00-07:00') };
    const odds = T.buildOdds([...merged, newest], t('2026-09-26T09:50:00-07:00'), start);
    const sat10 = odds.hourly.find((h) => h.dow === 6 && h.hour === 10);
    assert.equal(sat10.avgOpenings, 0.5);
    assert.equal(sat10.avgMinutes, 6);
    assert.equal(odds.hourly.length, 168);
    assert.ok(odds.now.chanceNext30Min > 0 && odds.now.chanceNext30Min < 1);
    assert.equal(odds.now.restricted, false);
  });
});
