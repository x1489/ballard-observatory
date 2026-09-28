// group `weather` parsers (sources/weather.mjs _test) on real fixtures, with a fixed clock.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { _test as W } from '../../sources/weather.mjs';
import { NOW, MIN, HOUR, fixtureJson, fixtureText, ok, fail, assertContract, hygiene, knownDeviation } from './_helpers.mjs';
import * as S from './_schemas.mjs';

const Z = (s) => Date.parse(s);
const clone = (o) => JSON.parse(JSON.stringify(o));

describe('weather (Open-Meteo)', () => {
  const d = fixtureJson('weather/open-meteo.json');
  const out = W.parseWeather(d, NOW);

  test('meets the contract', () => assertContract(out, S.weather));
  test('local times convert with utc_offset_seconds (-7 h, PDT)', () => {
    assert.equal(d.utc_offset_seconds, -25200);
    assert.equal(d.current.time, '2026-09-25T18:30');
    assert.equal(out.current.t, Z('2026-09-26T01:30:00Z'));
    assert.equal(out.hourly[0].t, Z('2026-09-26T01:00:00Z')); // the current hour (18:00 PDT)
    assert.equal(out.daily[0].date, '2026-09-25');
    assert.equal(out.daily[0].t, Z('2026-09-25T07:00:00Z')); // Pacific midnight
    assert.equal(out.daily[0].sunrise, Z('2026-09-25T14:00:00Z')); // '07:00' local
    assert.equal(out.daily[0].sunset, Z('2026-09-26T02:00:00Z')); // '19:00' local
    assert.equal(out.nowcast[0].t, Z('2026-09-26T01:30:00Z'));
  });
  test('exact current values and unit conversions', () => {
    assert.deepEqual(out.current, {
      t: Z('2026-09-26T01:30:00Z'), tempF: 53.3, feelsF: 50.2, humidity: 90, precipIn: 0, code: 2, cloud: 51, windMph: 7.7,
      gustMph: 12.3, windDir: 98, isDay: true, visMi: Math.round((d.current.visibility / 5280) * 10) / 10, uv: 0.3, pressureHpa: 1015.7,
    });
  });
  test('24 consecutive hourly rows, 7 days, 12 nowcast slots 15 min apart', () => {
    assert.equal(out.hourly.length, 24);
    out.hourly.forEach((h, i) => i && assert.equal(h.t - out.hourly[i - 1].t, HOUR));
    assert.equal(out.daily.length, 7);
    assert.deepEqual(out.daily.map((x) => x.date), ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
    assert.equal(out.nowcast.length, 12);
    out.nowcast.forEach((s, i) => i && assert.equal(s.t - out.nowcast[i - 1].t, 15 * MIN));
  });
  test('dry nowcast: no rain start/end', () => {
    assert.equal(out.rainStartsAt, null);
    assert.equal(out.rainEndsAt, null);
  });
  test('rain starting later: rainStartsAt = first wet slot', () => {
    const x = clone(d);
    x.minutely_15.precipitation = [0, 0, 0, 0.001, 0.02, 0.03, 0, 0, 0, 0, 0, 0]; // 0.001 is not > the threshold
    const o = W.parseWeather(x, NOW);
    assert.equal(o.rainStartsAt, Z('2026-09-26T02:30:00Z')); // slot 4 = 19:30 PDT
    assert.equal(o.rainEndsAt, null);
  });
  test('raining now: rainEndsAt = first dry slot', () => {
    const x = clone(d);
    x.minutely_15.precipitation = [0.01, 0.02, 0.005, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const o = W.parseWeather(x, NOW);
    assert.equal(o.rainStartsAt, null);
    assert.equal(o.rainEndsAt, Z('2026-09-26T02:15:00Z'));
  });
  test('an hour later the past hour and past nowcast slots drop out', () => {
    const o = W.parseWeather(d, NOW + HOUR);
    assert.equal(o.hourly[0].t, Z('2026-09-26T02:00:00Z'));
    assert.equal(o.nowcast[0].t, Z('2026-09-26T02:30:00Z'));
    assert.equal(o.nowcast.length, 8);
  });
  test('missing utc_offset_seconds falls back to Pacific wall-clock (same instants in PDT)', () => {
    const x = clone(d);
    delete x.utc_offset_seconds;
    assert.deepEqual(W.parseWeather(x, NOW), out);
  });
  test('no minutely_15 block: warning, rain logic uses current precip', () => {
    const x = clone(d);
    delete x.minutely_15;
    const o = W.parseWeather(x, NOW);
    assert.deepEqual(o.nowcast, []);
    assert.deepEqual(o.warnings, ['Open-Meteo returned no minutely_15 nowcast']);
    assertContract(o, S.weather);
  });
  test('upstream error object and empty payload throw', () => {
    assert.throws(() => W.parseWeather({ error: true, reason: 'Parameter x invalid' }, NOW), /Open-Meteo: Parameter x invalid/);
    assert.throws(() => W.parseWeather({}, NOW), /no current or hourly data/);
  });
  test('missing single values become null, not NaN or undefined', () => {
    const x = clone(d);
    x.current.temperature_2m = null;
    delete x.current.visibility;
    x.hourly.uv_index = [];
    const o = W.parseWeather(x, NOW);
    assert.equal(o.current.tempF, null);
    assert.equal(o.current.visMi, null);
    assert.equal(o.hourly[3].uv, null);
    assert.deepEqual(hygiene(o), []);
  });
});

describe('nws-forecast', () => {
  const d = fixtureJson('weather/nws-forecast.json');
  const out = W.parseNwsForecast(d, NOW);
  test('meets the contract', () => assertContract(out, S.nwsForecast));
  test('first period, ISO offsets converted', () => {
    assert.equal(out.periods.length, 8);
    assert.deepEqual(out.periods[0], {
      name: 'Tonight', start: Z('2026-09-26T01:00:00Z'), end: Z('2026-09-26T13:00:00Z'), isDay: false, tempF: 49, pop: 14,
      wind: '3 to 12 mph', windDir: 'S', short: 'Mostly Clear',
      detail: 'Mostly clear, with a low around 49. South wind 3 to 12 mph. New rainfall amounts less than a tenth of an inch possible.',
      icon: 'https://api.weather.gov/icons/land/night/few?size=medium',
    });
    assert.equal(out.updated, Z(d.properties.updateTime));
  });
  test('periods that already ended are dropped (stale NWS cache)', () => {
    const o = W.parseNwsForecast(d, Z('2026-09-26T13:00:00Z')); // Tonight's end
    assert.equal(o.periods[0].name, d.properties.periods[1].name);
  });
  test('all periods over, or no periods: throws', () => {
    assert.throws(() => W.parseNwsForecast(d, Z('2026-12-01T00:00:00Z')), /no current periods/);
    assert.throws(() => W.parseNwsForecast({ properties: { periods: [] } }, NOW), /no current periods/);
    assert.throws(() => W.parseNwsForecast({}, NOW), /no current periods/);
  });
  test('Celsius temperatures are converted', () => {
    const x = clone(d);
    x.properties.periods[0].temperature = 10;
    x.properties.periods[0].temperatureUnit = 'C';
    assert.equal(W.parseNwsForecast(x, NOW).periods[0].tempF, 50);
  });
});

describe('alerts (NWS)', () => {
  const zone = fixtureJson('weather/nws-alerts.json');
  test('real Small Craft Advisory for PZZ135 only: marine, times converted', () => {
    const out = W.parseAlerts(zone);
    assertContract(out, S.alerts);
    assert.equal(out.alerts.length, 1);
    const a = out.alerts[0];
    assert.equal(a.event, 'Small Craft Advisory');
    assert.equal(a.marine, true);
    assert.equal(a.severity, 'Minor');
    assert.equal(a.onset, Z('2026-09-25T21:03:00Z'));
    assert.equal(a.ends, Z('2026-09-26T06:00:00Z'));
    assert.equal(a.expires, Z('2026-09-26T05:15:00Z'));
    assert.match(a.description, /^\* WHAT\.\.\.Southwest winds 15 to 25 kt\.\n\n\* WHERE\.\.\.Puget Sound/);
  });
  test('statewide fixture: land alerts are not marine; sorted by severity then onset', () => {
    const out = W.parseAlerts(fixtureJson('weather/nws-alerts-wa.json'));
    assertContract(out, S.alerts);
    assert.ok(out.alerts.length >= 1);
    for (const a of out.alerts) assert.equal(a.marine, false);
    const rank = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 };
    out.alerts.forEach((a, i) => {
      if (!i) return;
      const p = out.alerts[i - 1];
      assert.ok((rank[p.severity] ?? 4) < (rank[a.severity] ?? 4) || ((rank[p.severity] ?? 4) === (rank[a.severity] ?? 4) && (p.onset ?? 0) <= (a.onset ?? 0)));
    });
  });
  test('drops superseded, cancelled, non-Actual and duplicate messages', () => {
    const base = zone.features[0];
    const mk = (id, props = {}) => ({ ...clone(base), id, properties: { ...clone(base.properties), id, references: [], ...props } });
    const d = {
      features: [
        mk('old'), mk('new', { references: [{ identifier: 'old' }] }), mk('new'),
        mk('cancel', { messageType: 'Cancel' }), mk('test', { status: 'Test' }),
        mk('severe', { severity: 'Severe', onset: '2026-09-26T00:00:00-07:00' }),
      ],
    };
    assert.deepEqual(W.parseAlerts(d).alerts.map((a) => a.id), ['severe', 'new']);
  });
  test('mixed land + marine UGC list is not marine; empty feed is an empty list', () => {
    const x = clone(zone);
    x.features[0].properties.geocode.UGC = ['PZZ135', 'WAZ315'];
    assert.equal(W.parseAlerts(x).alerts[0].marine, false);
    assert.deepEqual(W.parseAlerts({ features: [] }), { alerts: [] });
    assert.deepEqual(W.parseAlerts({}), { alerts: [] });
  });
  test('an alert without a description or area: only the known "" deviation (open issue for B1)', (t) => {
    const x = clone(zone);
    delete x.features[0].properties.description;
    delete x.features[0].properties.areaDesc;
    knownDeviation(t, hygiene(W.parseAlerts(x)), [/\.alerts\[0\]\.(description|area): ""$/]);
  });
});

describe('stations (CWOP via NWS)', () => {
  const COORDS = {
    AW337: { lat: 47.67433, lon: -122.40133 }, E7826: { lat: 47.66933, lon: -122.41 },
    F8372: { lat: 47.69717, lon: -122.37517 }, AS437: { lat: 47.65167, lon: -122.40533 },
  };
  const rows = (now) => W.STATION_IDS.map((id) => ok(W.buildStation(id, COORDS[id], fixtureJson(`weather/nws-obs-${id}.json`), now)));

  test('meets the contract; sorted by distance; Ballard-only median', () => {
    const out = W.summarizeStations(rows(NOW));
    assertContract(out, S.stations);
    assert.deepEqual(out.stations.map((s) => s.id), ['AW337', 'E7826', 'AS437', 'F8372']);
    assert.deepEqual(out.stations.map((s) => s.inBallard), [true, true, false, false]); // Magnolia hill, Crown Hill
    assert.equal(out.medianTempF, 55);
    assert.equal(out.medianOf, 2);
  });
  test('SI -> imperial and observation time', () => {
    const aw = W.buildStation('AW337', COORDS.AW337, fixtureJson('weather/nws-obs-AW337.json'), NOW);
    assert.equal(aw.t, Z('2026-09-26T01:17:00Z'));
    assert.equal(aw.tempF, 55);
    assert.equal(aw.humidity, 94);
    assert.equal(aw.distKm, 1.39);
    assert.equal(aw.stale, false);
  });
  test('older than 90 min is stale; with no fresh station the median is null', () => {
    const out = W.summarizeStations(rows(NOW + 2 * HOUR));
    assert.ok(out.stations.every((s) => s.stale));
    assert.equal(out.medianTempF, null);
    assert.equal(out.medianOf, 0);
  });
  test('falls back to all fresh stations when no in-Ballard one is fresh', () => {
    const r = rows(NOW);
    for (const x of r) if (x.value.inBallard) x.value.stale = true;
    const out = W.summarizeStations(r);
    assert.equal(out.medianOf, 2);
    assert.equal(out.medianTempF, 54);
  });
  test('one station failing is a warning; all failing throws', () => {
    const r = rows(NOW);
    r[1] = fail('HTTP 500 from api.weather.gov');
    const out = W.summarizeStations(r);
    assert.equal(out.stations.length, 3);
    assert.deepEqual(out.warnings, ['E7826: HTTP 500 from api.weather.gov']);
    assert.throws(() => W.summarizeStations(W.STATION_IDS.map(() => fail('down'))), /all stations failed/);
  });
  test('without known coords, the observation geometry is used', () => {
    const obs = fixtureJson('weather/nws-obs-F8372.json');
    const s = W.buildStation('F8372', null, obs, NOW);
    assert.equal(s.lon, obs.geometry.coordinates[0]);
    assert.equal(s.lat, obs.geometry.coordinates[1]);
  });
  test('quality-controlled-bad values and missing values are null', () => {
    const obs = clone(fixtureJson('weather/nws-obs-AW337.json'));
    obs.properties.temperature.qualityControl = 'X';
    obs.properties.windSpeed = { value: null };
    const s = W.buildStation('AW337', COORDS.AW337, obs, NOW);
    assert.equal(s.tempF, null);
    assert.equal(s.windMph, null);
  });
});

describe('westpoint (NDBC WPOW1)', () => {
  const cwText = fixtureText('weather/ndbc-WPOW1.cwind');
  const txText = fixtureText('weather/ndbc-WPOW1.txt');
  const cw = W.parseNdbc(cwText), tx = W.parseNdbc(txText);

  test('parseNdbc: UTC rows newest first, the truncated Range tail is dropped', () => {
    assert.ok(!cwText.endsWith('\n'));
    const complete = cwText.split('\n').filter((l) => l && !l.startsWith('#')).length - 1;
    assert.equal(cw.length, complete);
    assert.equal(cw[0].t, Z('2026-09-26T01:00:00Z'));
    assert.equal(tx[0].t, Z('2026-09-26T01:00:00Z'));
    cw.forEach((r, i) => i && assert.ok(r.t < cw[i - 1].t));
    assert.throws(() => W.parseNdbc('<html>503 Service Unavailable</html>\n'), /no header/);
  });
  test('meets the contract with exact values', () => {
    const out = W.buildWestpoint(ok(cw), ok(tx));
    assertContract(out, S.westpoint);
    assert.equal(out.t, Z('2026-09-26T01:00:00Z'));
    assert.equal(out.windDir, 93);
    assert.equal(out.windKt, 8); // 4.1 m/s
    assert.equal(out.gustKt, 12.1); // .txt GST 6.2 m/s at the same time
    assert.equal(out.peakGustKt, 15.9); // .cwind hourly peak 8.2 m/s
    assert.equal(out.peakGustT, Z('2026-09-26T00:32:00Z')); // GTIME 0032
    assert.equal(out.pressureHpa, 1016.4);
    assert.equal(out.pressureTendencyHpa, 3.5);
    assert.equal(out.airTempF, 56.1); // 13.4 C
    assert.equal(out.history.length, 24);
    assert.equal(out.history.at(-1).t, Z('2026-09-26T01:00:00Z'));
    out.history.forEach((h, i) => i && assert.ok(h.t > out.history[i - 1].t)); // oldest first
  });
  test('peak gust GTIME on the 00:00 row belongs to the previous UTC day', () => {
    const lines = cwText.split('\n');
    const i = lines.findIndex((l) => l.startsWith('2026 09 26 00 00'));
    const rolled = W.parseNdbc([...lines.slice(0, 2), ...lines.slice(i, i + 6)].join('\n') + '\n');
    const out = W.buildWestpoint(ok(rolled), ok([]));
    assert.equal(out.t, Z('2026-09-26T00:00:00Z'));
    assert.equal(out.peakGustT, Z('2026-09-25T23:47:00Z')); // GTIME 2347, not 2026-09-26 23:47
    assert.equal(out.gustKt, null); // no .txt row at that time: never the hour-old peak
  });
  test('.cwind down: wind from .txt with a warning; both down: throws', () => {
    const out = W.buildWestpoint(fail('HTTP 404 from www.ndbc.noaa.gov'), ok(tx));
    assert.equal(out.t, Z('2026-09-26T01:00:00Z'));
    assert.equal(out.windKt, 8.9); // .txt WSPD 4.6 m/s
    assert.equal(out.peakGustKt, null);
    assert.deepEqual(out.warnings, ['.cwind: HTTP 404 from www.ndbc.noaa.gov']);
    assertContract(out, S.westpoint);
    assert.throws(() => W.buildWestpoint(fail('x'), fail('y')), /WPOW1: no data/);
  });
  test("'MM' and 99.0 / 999 / 9999 sentinels become null", () => {
    const text = '#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE\n'
      + '2026 09 26 01 00 999 99.0 MM MM MM MM MM 9999.0 MM MM MM MM MM MM\n';
    const out = W.buildWestpoint(ok([]), ok(W.parseNdbc(text)));
    assert.equal(out.windDir, null);
    assert.equal(out.windKt, null);
    assert.equal(out.pressureHpa, null);
    assert.equal(out.airTempF, null);
    assert.deepEqual(hygiene(out), []);
  });
});

describe('marine (PZZ135)', () => {
  const out = W.parseMarine(fixtureText('weather/pzz135.txt'));
  test('meets the contract with exact values', () => {
    assertContract(out, S.marine);
    assert.equal(out.issued, '203 PM PDT Fri Sep 25 2026');
    assert.equal(out.issuedT, Z('2026-09-25T21:03:00Z'));
    assert.equal(out.expires, Z('2026-09-26T10:15:00Z'));
    assert.deepEqual(out.headlines, ['SMALL CRAFT ADVISORY IN EFFECT UNTIL 11 PM PDT THIS EVENING']);
    assert.deepEqual(out.periods.map((p) => p.name), ['TONIGHT', 'SAT', 'SAT NIGHT', 'SUN', 'SUN NIGHT', 'MON', 'MON NIGHT', 'TUE', 'TUE NIGHT', 'WED', 'WED NIGHT']);
    assert.equal(out.periods[0].text, 'SW wind 15 to 25 kt, easing to 10 to 15 kt after midnight. Waves 2 to 4 ft subsiding to 2 ft or less.');
    assert.equal(out.periods[6].text, 'S wind 10 to 15 kt, rising to 15 to 20 kt after midnight. Waves around 2 ft or less. A chance of rain after midnight.');
  });
  test('parseIssued: PDT/PST, 12 AM/PM, bad input', () => {
    assert.equal(W.parseIssued('203 PM PDT Fri Sep 25 2026'), Z('2026-09-25T21:03:00Z'));
    assert.equal(W.parseIssued('945 AM PST Mon Jan 5 2026'), Z('2026-01-05T17:45:00Z'));
    assert.equal(W.parseIssued('1200 AM PST Mon Jan 5 2026'), Z('2026-01-05T08:00:00Z'));
    assert.equal(W.parseIssued('1215 PM PDT Fri Sep 25 2026'), Z('2026-09-25T19:15:00Z'));
    assert.equal(W.parseIssued('garbage'), null);
    assert.equal(W.parseIssued(null), null);
  });
  test('multi-line and back-to-back headlines; no headline', () => {
    const t = fixtureText('weather/pzz135.txt').replace('...SMALL CRAFT ADVISORY IN EFFECT UNTIL 11 PM PDT THIS EVENING...',
      '...GALE WARNING IN EFFECT FROM\nLATE TONIGHT THROUGH SATURDAY...\n...SMALL CRAFT ADVISORY REMAINS IN EFFECT...');
    assert.deepEqual(W.parseMarine(t).headlines, ['GALE WARNING IN EFFECT FROM LATE TONIGHT THROUGH SATURDAY', 'SMALL CRAFT ADVISORY REMAINS IN EFFECT']);
    const none = fixtureText('weather/pzz135.txt').replace(/\.\.\.SMALL CRAFT[^\n]*\n/, '');
    assert.deepEqual(W.parseMarine(none).headlines, []);
  });
  test('an HTML error page throws', () => {
    assert.throws(() => W.parseMarine('<html><body><h1>404 Not Found</h1></body></html>'), /no forecast periods/);
  });
});

describe('afd (Area Forecast Discussion)', () => {
  const d = fixtureJson('weather/afd.json');
  test('meets the contract; synopsis whitespace-normalized; short term capped', () => {
    const out = W.parseAfd(d);
    assertContract(out, S.afd);
    assert.equal(out.issued, Z('2026-09-25T21:28:00Z'));
    assert.match(out.synopsis, /^The strong low pressure system is making its way into the Cascades\. /);
    assert.doesNotMatch(out.synopsis, /\n|\s{2}|&&/);
    assert.ok(out.shortTerm.length <= 1500);
    assert.equal(out.warnings, undefined);
  });
  test('no .SYNOPSIS: falls back to another section with a warning', () => {
    const x = clone(d);
    x.productText = x.productText.replace('.SYNOPSIS...', '.UPDATE...');
    const out = W.parseAfd(x);
    assert.ok(out.synopsis.length > 20);
    assert.deepEqual(out.warnings, ['AFD has no .SYNOPSIS section; used the first discussion section']);
  });
  test('empty or unrecognizable product throws', () => {
    assert.throws(() => W.parseAfd({ productText: '' }), /empty productText/);
    assert.throws(() => W.parseAfd({ productText: '<html>error</html>' }), /no \.SYNOPSIS section/);
  });
  test('afdSection drops trailing forecaster tags', () => {
    const text = '.SYNOPSIS...Rain today.\nMore rain.\n\nJBB\n&&\n';
    assert.deepEqual(W.afdSection(text, 'SYNOPSIS'), ['Rain today. More rain.']);
  });
});

describe('sky (USNO)', () => {
  const today = fixtureJson('weather/usno-rstt-2026-09-25.json').properties.data;
  const tmr = fixtureJson('weather/usno-rstt-2026-09-26.json').properties.data;
  const ph = fixtureJson('weather/usno-phases-2026-09-25.json');
  const out = W.buildSky('2026-09-25', '2026-09-26', [ok(today), ok(tmr), ok(ph)], NOW);

  test('meets the contract; Pacific wall-clock times on the right date', () => {
    assertContract(out, S.sky);
    assert.deepEqual(out.sun, {
      civilDawn: Z('2026-09-25T13:30:00Z'), rise: Z('2026-09-25T14:01:00Z'), noon: Z('2026-09-25T20:01:00Z'),
      set: Z('2026-09-26T02:01:00Z'), civilDusk: Z('2026-09-26T02:31:00Z'),
    });
    assert.deepEqual(out.moon, { rise: Z('2026-09-26T01:29:00Z'), set: Z('2026-09-25T12:51:00Z'), phase: 'Waxing Gibbous', illum: 99 });
    assert.deepEqual(out.tomorrowSun, { rise: Z('2026-09-26T14:02:00Z'), set: Z('2026-09-27T01:59:00Z') });
  });
  test('next phase comes from the phases API (UT)', () => {
    assert.deepEqual(out.nextPhase, { phase: 'Full Moon', t: Z('2026-09-26T16:49:00Z') });
    const later = W.buildSky('2026-09-25', '2026-09-26', [ok(today), ok(tmr), ok(ph)], Z('2026-09-26T17:00:00Z'));
    assert.deepEqual(later.nextPhase, { phase: 'Last Quarter', t: Z('2026-10-03T13:25:00Z') });
  });
  test('phases API down: falls back to closestphase (Pacific), the same instant', () => {
    const o = W.buildSky('2026-09-25', '2026-09-26', [ok(today), ok(tmr), fail('HTTP 503')], NOW);
    assert.deepEqual(o.nextPhase, { phase: 'Full Moon', t: Z('2026-09-26T16:49:00Z') });
    assert.deepEqual(o.warnings, ['moon phases: HTTP 503']);
  });
  test('tomorrow down: nulls + warning; today down: throws', () => {
    const o = W.buildSky('2026-09-25', '2026-09-26', [ok(today), fail('timeout'), ok(ph)], NOW);
    assert.deepEqual(o.tomorrowSun, { rise: null, set: null });
    assert.deepEqual(o.warnings, ['tomorrow: timeout']);
    assertContract(o, S.sky);
    assert.throws(() => W.buildSky('2026-09-25', '2026-09-26', [fail('USNO down'), ok(tmr), ok(ph)], NOW), /USNO down/);
  });
  test('usnoTime: missing phenomenon is null', () => {
    assert.equal(W.usnoTime('2026-09-25', today.moondata, 'Upper Transit'), null);
    assert.equal(W.usnoTime('2026-09-25', undefined, 'Rise'), null);
    assert.equal(W.usnoTime('2026-09-25', today.sundata, 'Rise'), Z('2026-09-25T14:01:00Z'));
  });
});

describe('kp (SWPC)', () => {
  const m1 = fixtureJson('weather/swpc-kp-1m.json');
  const h3 = fixtureJson('weather/swpc-kp-3h.json');
  test('meets the contract with exact values', () => {
    const out = W.buildKp(ok(m1), ok(h3));
    assertContract(out, S.kp);
    assert.deepEqual({ t: out.t, kp: out.kp, kpIndex: out.kpIndex }, { t: Z('2026-09-26T01:36:00Z'), kp: 2.33, kpIndex: 2 });
    assert.equal(out.recent.length, 8);
    assert.deepEqual(out.recent.at(-1), { t: Z('2026-09-25T21:00:00Z'), kp: 3.67 });
    out.recent.forEach((r, i) => i && assert.equal(r.t - out.recent[i - 1].t, 3 * HOUR));
  });
  test('holds the previous period estimate for the first 30 min of a new 3-hour period', () => {
    const row = (iso, kp) => ({ time_tag: iso.slice(0, 19), kp_index: Math.round(kp), estimated_kp: kp, kp: `${Math.round(kp)}` });
    const prev = [row('2026-09-26T02:58:00Z', 2.67), row('2026-09-26T02:59:00Z', 2.67)];
    const early = W.buildKp(ok([...prev, row('2026-09-26T03:00:00Z', 0), row('2026-09-26T03:05:00Z', 0.33)]), ok(h3));
    assert.equal(early.kp, 2.67);
    assert.equal(early.t, Z('2026-09-26T02:59:00Z'));
    const later = W.buildKp(ok([...prev, row('2026-09-26T03:31:00Z', 0.33)]), ok(h3));
    assert.equal(later.kp, 0.33);
  });
  test('legacy array-of-arrays 3-hour format', () => {
    const legacy = [['time_tag', 'Kp', 'a_running', 'station_count'], ...h3.map((r) => [r.time_tag.replace('T', ' ') + '.000', String(r.Kp), '9', '8'])];
    assert.deepEqual(W.buildKp(ok(m1), ok(legacy)).recent, W.buildKp(ok(m1), ok(h3)).recent);
  });
  test('1-minute feed down: last official value with a warning; both down: throws', () => {
    const o = W.buildKp(fail('HTTP 502'), ok(h3));
    assert.deepEqual({ t: o.t, kp: o.kp, kpIndex: o.kpIndex }, { t: Z('2026-09-25T21:00:00Z'), kp: 3.67, kpIndex: 4 });
    assert.deepEqual(o.warnings, ['1-minute Kp: HTTP 502']);
    assert.throws(() => W.buildKp(fail('a'), fail('b')), /SWPC Kp unavailable/);
    assert.throws(() => W.buildKp(ok('<html>'), ok({})), /SWPC Kp unavailable/);
  });
});

describe('radar (IEM)', () => {
  test('meets the contract: 11 frames oldest first', () => {
    const out = W.parseRadar(fixtureJson('weather/iem-n0q.json'));
    assertContract(out, S.radar);
    assert.equal(out.valid, Z('2026-09-26T01:40:00Z'));
    assert.deepEqual(out.frames.map((f) => f.label), ['-50m', '-45m', '-40m', '-35m', '-30m', '-25m', '-20m', '-15m', '-10m', '-5m', 'now']);
    assert.equal(out.frames[0].tileUrl, 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913-m50m/{z}/{x}/{y}.png');
    assert.equal(out.frames.at(-1).tileUrl, out.tileUrl);
  });
  test('missing meta.valid throws', () => {
    assert.throws(() => W.parseRadar({}), /no meta\.valid/);
    assert.throws(() => W.parseRadar(null), /no meta\.valid/);
  });
});

describe('airnow', () => {
  const text = fixtureText('weather/airnow-reportingarea.dat');
  const lines = W.airnowLines(text);
  test('airnowLines keeps only Seattle-Bellevue-Kent Valley; an HTML page throws', () => {
    assert.equal(lines.length, 12);
    assert.ok(lines.every((l) => l.includes('|Seattle-Bellevue-Kent Valley|WA|')));
    assert.throws(() => W.airnowLines('<html><body>Access Denied</body></html>'), /no Seattle-Bellevue-Kent Valley lines/);
  });
  test('meets the contract; observations at 18:00 PDT, primary first', () => {
    const out = W.buildAirnow(lines, NOW);
    assertContract(out, S.airnow);
    assert.deepEqual(out.observed.map((o) => [o.param, o.aqi, o.primary]), [['PM2.5', 27, true], ['OZONE', 25, false], ['PM10', 4, false]]);
    assert.ok(out.observed.every((o) => o.t === Z('2026-09-26T01:00:00Z') && o.category === 'Good'));
    assert.deepEqual(out.forecast.map((f) => f.date), ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']);
    assert.match(out.discussion, /^For Fri-Mon \(Sep 25-28\)/);
  });
  test("midnight rollover: today's forecast drops at Pacific midnight, not UTC midnight", () => {
    assert.equal(W.buildAirnow(lines, Z('2026-09-26T06:59:59Z')).forecast[0].date, '2026-09-25');
    assert.equal(W.buildAirnow(lines, Z('2026-09-26T07:00:00Z')).forecast[0].date, '2026-09-26');
  });
  test('PST observation rows are 8 h behind UTC', () => {
    const pst = lines.map((l) => l.replace('09/25/26|09/25/26|18:00|PDT', '01/15/27|01/15/27|10:00|PST'));
    const o = W.buildAirnow(pst, Z('2027-01-15T19:00:00Z')).observed;
    assert.equal(o[0].t, Z('2027-01-15T18:00:00Z'));
  });
  test('a newer issue of the same forecast date wins', () => {
    const newer = lines.filter((l) => l.includes('|F|')).map((l) => l.replace(/^09\/25\/26/, '09/26/26').replace('|PM2.5|28|Good|', '|PM2.5|61|Moderate|'));
    const f = W.buildAirnow([...lines, ...newer], NOW).forecast;
    assert.equal(f.find((x) => x.date === '2026-09-26').aqi, 61);
  });
});

describe('purpleair', () => {
  const csv = fixtureText('weather/purpleair-pas.csv');
  const rows = W.parsePurpleAir(csv);
  test('parsePurpleAir keeps only bbox rows; utc_ts +0000 parsed', () => {
    assert.equal(rows.length, 22); // 27 data rows, 5 of them just outside the bbox
    assert.ok(rows.every((r) => r.t === Z('2026-09-26T01:00:00Z')));
    assert.deepEqual(rows[0], { id: 2069, lat: 47.666977, lon: -122.39336, t: Z('2026-09-26T01:00:00Z'), pm25: 1.1 });
  });
  test('meets the contract; medians; AQI from nowcast PM2.5', () => {
    const out = W.buildPurpleair(rows, NOW);
    assertContract(out, S.purpleair);
    assert.equal(out.count, 22);
    assert.equal(out.medianAqi, 3);
    assert.equal(out.medianPm25, 0.4);
    assert.equal(out.t, Z('2026-09-26T01:00:00Z'));
    assert.deepEqual(out.sensors.find((s) => s.id === 154957), { id: 154957, lat: 47.669895, lon: -122.40851, t: Z('2026-09-26T01:00:00Z'), pm25: 3.5, aqi: 19 });
    out.sensors.forEach((s, i) => i && assert.ok(s.id > out.sensors[i - 1].id));
  });
  test('sensors older than 3 h are dropped, with a warning when none remain', () => {
    const out = W.buildPurpleair(rows, NOW + 4 * HOUR);
    assert.equal(out.count, 0);
    assert.equal(out.medianAqi, null);
    assert.equal(out.t, null);
    assert.deepEqual(out.warnings, ['all 22 Ballard sensors are older than 3h']);
    assertContract(out, S.purpleair);
  });
  test('implausible PM values are dropped; epa_pm25 backs up a missing nowcast', () => {
    const head = csv.slice(0, csv.indexOf('\n'));
    const extra = [
      '1,47.67,-122.38,2026-09-26 01:00:00+0000,5.0,,America/Los_Angeles,0.1',
      '2,47.67,-122.38,2026-09-26 01:00:00+0000,1500,1500,America/Los_Angeles,0.1',
      '3,47.67,-122.38,2026-09-26 01:00:00+0000,-3,-3,America/Los_Angeles,0.1',
      '4,47.67,-122.38,,2,2,America/Los_Angeles,0.1',
    ];
    const out = W.buildPurpleair(W.parsePurpleAir([head, ...extra].join('\n')), NOW);
    assert.deepEqual(out.sensors.map((s) => [s.id, s.pm25]), [[1, 5]]);
  });
  test('an HTML error page instead of CSV throws', () => {
    assert.throws(() => W.parsePurpleAir('<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>'), /unexpected CSV header/);
  });
});
