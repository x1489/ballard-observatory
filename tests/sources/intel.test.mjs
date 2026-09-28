// Tests for sources/intel.mjs: metrics are finite numbers with valid keys, detectors never flood on the first
// load, produce stable keys, and fire on the transitions they are meant to catch.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { INTEL, hysteresis, _resetMachines, hash, slug } from '../../sources/intel.mjs';

const NOW = Date.UTC(2026, 8, 25, 22, 0); // Fri 2026-09-25 3:00 pm PDT
const KEY_RE = /^[A-Za-z0-9_][\w.:-]{0,99}$/;
const ctx = (extra = {}) => ({ now: NOW, history: { get: () => [] }, ...extra });
const run = (id, prev, next, c = ctx()) => INTEL[id].detect(prev, next, c);

function checkItems(items) {
  for (const it of items) {
    assert.equal(typeof it.key, 'string');
    assert.ok(it.key.length > 0 && it.key.length < 200, it.key);
    assert.ok(['info', 'notice', 'warn', 'alert'].includes(it.severity), it.severity);
    assert.equal(typeof it.title, 'string');
    assert.ok(it.title.length > 0);
    assert.ok(!/undefined|NaN|null/.test(it.title), it.title);
    if (it.link !== undefined) assert.match(it.link, /^https?:\/\//);
    if (it.lat !== undefined) assert.ok(Number.isFinite(it.lat));
  }
  return items;
}

beforeEach(() => _resetMachines());

describe('helpers', () => {
  it('hash is stable and short', () => {
    assert.equal(hash('https://example.com/a'), hash('https://example.com/a'));
    assert.notEqual(hash('a'), hash('b'));
    assert.match(hash('x'.repeat(5000)), /^[0-9a-z]{1,7}$/);
  });
  it('slug makes metric-safe keys', () => {
    assert.equal(slug('AURORA BR'), 'aurora_br');
    assert.equal(slug('I-5/DENNY'), 'i_5_denny');
    assert.match(`traffic.1991.${slug('LW QN ANN')}`, KEY_RE);
  });
  it('hysteresis switches on at `on`, off below `off`, and not in between', () => {
    assert.equal(hysteresis('h', 0, 4, 5, 3), null);
    assert.equal(hysteresis('h', 4, 5, 5, 3), 'on');
    assert.equal(hysteresis('h', 5, 4, 5, 3), null); // still on: no flap
    assert.equal(hysteresis('h', 4, 6, 5, 3), null);
    assert.equal(hysteresis('h', 6, 2.9, 5, 3), 'off');
    assert.equal(hysteresis('h', 2.9, 4.9, 5, 3), null);
  });
  it('hysteresis rebuilds state from prev after a restart (no event if already above)', () => {
    assert.equal(hysteresis('r', 7, 8, 5, 3), null);
  });
});

describe('every detector: no flood on first load, nothing on identical data', () => {
  const samples = {
    bridges: { bridges: [{ id: 2, name: 'Ballard', lat: 47.66, lon: -122.376, up: false, since: null, sinceKnown: false }], log: [] },
    fire911: { incidents: [{ id: 'F1', type: 'Aid Response', address: '2014 NW 57TH ST', t: NOW - 60e3, active: true }] },
    alerts: { alerts: [{ id: 'a1', event: 'Wind Advisory', severity: 'Moderate', headline: 'h' }] },
    news: { items: [{ source: 'My Ballard', title: 'x', link: 'https://www.myballard.com/x', t: NOW - 60e3, ballard: true }] },
  };
  for (const [id, def] of Object.entries(INTEL)) {
    if (!def.detect) continue;
    it(`${id}`, () => {
      const d = samples[id] || {};
      assert.deepEqual(def.detect(null, d, ctx()), []);
      assert.deepEqual(def.detect(d, null, ctx()), []);
      if (id !== 'tides' && id !== 'events') assert.deepEqual(def.detect(d, d, ctx()), []);
      assert.doesNotThrow(() => def.detect({ junk: 1 }, { junk: 2, alerts: 'x', incidents: 5 }, ctx()));
    });
  }
});

describe('metrics', () => {
  it('all keys are valid and values finite (or null)', () => {
    const data = {
      weather: { current: { tempF: 55.2, feelsF: 53, windMph: 7, gustMph: 12, humidity: 80, pressureHpa: 1012, cloud: 90 }, hourly: [{ pop: 40 }] },
      stations: { medianTempF: 54 }, westpoint: { windKt: 12, gustKt: null, peakGustKt: 18 }, kp: { kp: 3.3 },
      airnow: { observed: [{ param: 'PM2.5', aqi: 30 }, { param: 'OZONE', aqi: 12 }] }, purpleair: { medianAqi: 20, medianPm25: 4.1, count: 19 },
      tides: { latest: { ft: 7.2, anomalyFt: 0.4 } }, lake: { ft: 20.15, outflowCfs: 220 },
      lockages: { today: { total: 30, up: 14, down: 16, commercial: 9 }, queued: 1 },
      bridges: { bridges: [{ name: 'Ballard', up: true }, { name: 'Fremont', up: false }] },
      cso: { overflowing: 0, recent: 2 },
      vehicles: { vehicles: [{ route: 'D Line', deviationSec: 240 }, { route: 'D Line', deviationSec: 120 }, { route: '44', deviationSec: -60 }] },
      traffic: { sites: [{ id: '1991', links: [{ name: 'DOWNTOWN', minutes: 16 }, { name: 'AURORA BR', minutes: 7 }] }] },
      lime: { near: { total: 200, scooters: 120, ebikes: 80 }, inBbox: 650 },
      fire911: { incidents: [{}, {}], activeCount: 1, activeKnown: true },
      outages: { ballard: [], citywide: { customers: 397 } },
    };
    for (const [id, d] of Object.entries(data)) {
      const m = INTEL[id].metrics(d);
      for (const [k, v] of Object.entries(m)) {
        assert.match(k, KEY_RE, `${id}: ${k}`);
        if (v !== null) assert.ok(Number.isFinite(v), `${id}: ${k}=${v}`);
      }
    }
    assert.equal(INTEL.vehicles.metrics(data.vehicles)['transit.delay.D'], 3);
    assert.equal(INTEL.vehicles.metrics(data.vehicles)['transit.delay.44'], -1);
    assert.equal(INTEL.vehicles.metrics(data.vehicles)['transit.delay.40'], null);
    assert.equal(INTEL.westpoint.metrics(data.westpoint)['westpoint.gustKt'], 18);
    assert.equal(INTEL.bridges.metrics(data.bridges)['bridges.ballardUp'], 1);
    assert.equal(INTEL.traffic.metrics(data.traffic)['traffic.downtown1991'], 16);
    assert.equal(INTEL.traffic.metrics(data.traffic)['traffic.1991.aurora_br'], 7);
    assert.equal(INTEL.fire911.metrics({ incidents: [], activeKnown: false, activeCount: null })['fire911.active'], null);
  });
});

describe('detectors fire on transitions', () => {
  it('bridge up then down, with stable keys', () => {
    const down = { bridges: [{ id: 2, name: 'Ballard', lat: 47.66, lon: -122.376, up: false, sinceKnown: false }], log: [] };
    const up = { bridges: [{ id: 2, name: 'Ballard', lat: 47.66, lon: -122.376, up: true, since: NOW - 30e3, sinceKnown: true }], log: [] };
    const a = checkItems(run('bridges', down, up));
    assert.equal(a.length, 1);
    assert.equal(a[0].title, 'Ballard Bridge is UP');
    assert.equal(a[0].severity, 'notice');
    assert.deepEqual(run('bridges', down, up).map((x) => x.key), a.map((x) => x.key));
    const back = { bridges: [{ ...up.bridges[0], up: false, since: NOW + 240e3 }], log: [{ bridge: 'Ballard', upAt: NOW - 30e3, downAt: NOW + 240e3, minutes: 5 }] };
    const b = checkItems(run('bridges', up, back));
    assert.equal(b.length, 1);
    assert.match(b[0].title, /back down/);
    assert.match(b[0].detail, /5 min/);
  });

  it('new 911 incidents only, recent only, severity by type', () => {
    const prev = { incidents: [{ id: 'F1', type: 'Aid Response', address: 'x', t: NOW - 600e3 }] };
    const next = { incidents: [
      { id: 'F3', type: 'Fire in Building', address: '1521 NW 54TH ST', t: NOW - 60e3, lat: 47.66, lon: -122.38, units: 'E18 L8' },
      { id: 'F2', type: 'MVI - Motor Vehicle Incident', address: '15TH AVE NW / NW MARKET ST', t: NOW - 120e3 },
      { id: 'F0', type: 'Aid Response', address: 'old', t: NOW - 5 * 3600e3 },
      ...prev.incidents,
    ] };
    const items = checkItems(run('fire911', prev, next));
    assert.deepEqual(items.map((x) => x.key), ['fire:F3', 'fire:F2']);
    assert.equal(items[0].severity, 'warn');
    assert.equal(items[1].severity, 'notice');
    assert.match(items[0].title, /1521 NW 54th St/);
    assert.equal(run('fire911', prev, { incidents: [{ id: 'F9', type: 'Auto Fire Alarm', address: 'a', t: NOW }] })[0].severity, 'info');
  });

  it('weather: rain starting within the hour, once per episode', () => {
    const prev = { current: {}, rainStartsAt: null };
    const next = { current: {}, rainStartsAt: NOW + 40 * 60e3 };
    const a = checkItems(run('weather', prev, next));
    assert.equal(a.length, 1);
    assert.match(a[0].title, /^Rain starting around 3:40 pm$/);
    assert.equal(run('weather', prev, { current: {}, rainStartsAt: NOW + 3 * 3600e3 }).length, 0);
  });

  it('transit delay episodes use hysteresis', () => {
    const v = (dev, n = 3) => ({ vehicles: Array.from({ length: n }, () => ({ route: 'D Line', deviationSec: dev * 60 })) });
    assert.equal(run('vehicles', v(2), v(4)).length, 0);
    const on = checkItems(run('vehicles', v(4), v(6)));
    assert.equal(on.length, 1);
    assert.match(on[0].title, /D Line running about 6 min late/);
    assert.equal(run('vehicles', v(6), v(4)).length, 0); // between the bands: no flap
    const off = run('vehicles', v(4), v(2));
    assert.equal(off.length, 1);
    assert.match(off[0].title, /back near schedule/);
    assert.equal(run('vehicles', v(2), v(9, 1)).length, 0); // a single bus is not a trend
  });

  it('alerts: new and ended', () => {
    const a = { id: 'urn:1', event: 'Wind Advisory', severity: 'Moderate', headline: 'Wind Advisory until 5 PM' };
    const n = checkItems(run('alerts', { alerts: [] }, { alerts: [a] }));
    assert.equal(n[0].severity, 'notice');
    const e = checkItems(run('alerts', { alerts: [a] }, { alerts: [] }));
    assert.match(e[0].title, /ended/);
  });

  it('news: only new Ballard items from the last day', () => {
    const old = { title: 'o', link: 'https://x/o', t: NOW - 3600e3, ballard: true, source: 'My Ballard' };
    const next = { items: [
      { title: 'New Ballard thing', link: 'https://x/n', t: NOW - 60e3, ballard: true, source: 'My Ballard' },
      { title: 'City thing', link: 'https://x/c', t: NOW - 60e3, ballard: false, source: 'Seattle Times' },
      { title: 'Ancient', link: 'https://x/a', t: NOW - 3 * 86400e3, ballard: true, source: 'KOMO' },
      old,
    ] };
    const items = checkItems(run('news', { items: [old] }, next));
    assert.deepEqual(items.map((x) => x.title), ['New Ballard thing']);
    assert.equal(items[0].severity, 'notice');
  });

  it('quakes: near or felt-size only', () => {
    const q = (id, mag, distKm) => ({ id, mag, distKm, place: 'somewhere', t: NOW, lat: 47, lon: -122, url: 'https://earthquake.usgs.gov/x' });
    const items = checkItems(run('quakes', { recent: [], notable: [] }, { recent: [q('a', 1.2, 20), q('b', 1.8, 30), q('c', 2.0, 200)], notable: [q('d', 4.2, 250)] }));
    assert.deepEqual(items.map((x) => x.key).sort(), ['quake:b', 'quake:d']);
    assert.equal(items.find((x) => x.key === 'quake:d').severity, 'warn');
  });

  it('outages: new and restored', () => {
    const o = { id: 7, customers: 12, cause: 'Tree', start: NOW, lat: 47.67, lon: -122.38 };
    assert.equal(checkItems(run('outages', { ballard: [] }, { ballard: [o] }))[0].severity, 'warn');
    assert.match(run('outages', { ballard: [o] }, { ballard: [] })[0].title, /restored/);
  });

  it('cso: overflow on and off', () => {
    const s = (status) => ({ sites: [{ tag: 'BALL', name: 'King County CSO: Ballard', status, t: NOW, lat: 47.66, lon: -122.38 }] });
    assert.equal(checkItems(run('cso', s('none'), s('overflowing')))[0].severity, 'warn');
    assert.match(run('cso', s('overflowing'), s('recent'))[0].title, /stopped/);
    assert.equal(run('cso', s('none'), s('recent')).length, 0);
  });

  it('purpleair: AQI bands with hysteresis', () => {
    const p = (a) => ({ medianAqi: a });
    assert.equal(run('purpleair', p(30), p(55)).length, 0);
    assert.match(run('purpleair', p(55), p(65))[0].title, /Moderate/);
    assert.equal(run('purpleair', p(65), p(50)).length, 0);
    assert.equal(run('purpleair', p(50), p(110))[0].severity, 'warn');
  });

  it('lockages: named commercial vessels and queues', () => {
    const v = (name, commercial, arrival = NOW - 60e3) => ({ name, commercial, arrival, direction: 'up' });
    const items = checkItems(run('lockages', { recent: [], queued: 0 }, { recent: [v('WASP', true), v('RECREATIONAL VESSEL', false), v('COMM OTHER', true)], queued: 3 }));
    assert.deepEqual(items.map((x) => x.title), ['Wasp heading into the lake', '3 vessels waiting at the Locks']);
  });

  it('kp thresholds', () => {
    assert.equal(run('kp', { kp: 4.3 }, { kp: 5.3 })[0].severity, 'notice');
    assert.equal(run('kp', { kp: 5.3 }, { kp: 5.7 }).length, 0);
  });

  it('events starting within the hour', () => {
    const e = (id, start, extra = {}) => ({ id, title: `Event ${id}`, start, allDay: false, canceled: false, url: 'https://www.visitballard.com/e', ...extra });
    const next = { events: [e('a', NOW + 30 * 60e3), e('b', NOW + 3 * 3600e3), e('c', NOW + 10 * 60e3, { canceled: true }), e('d', NOW - 60e3)] };
    const items = checkItems(run('events', { events: [] }, next));
    assert.deepEqual(items.map((x) => x.key), ['event:a:soon']);
    assert.match(items[0].title, /^Starting 3:30 pm: Event a$/);
  });

  it('tides: minus tide today, once per day', () => {
    const next = { hilo: [{ t: NOW + 3600e3, ft: -1.2, type: 'L' }, { t: NOW + 7 * 3600e3, ft: 11.1, type: 'H' }], latest: {} };
    const items = checkItems(run('tides', { hilo: [], latest: {} }, next));
    assert.equal(items.length, 1);
    assert.equal(items[0].key, 'tide:minus:2026-09-25');
    assert.match(items[0].title, /-1\.2 ft at 4:00 pm/);
  });

  it('traffic: slow drive needs history and uses hysteresis', () => {
    const series = Array.from({ length: 120 }, (_, i) => [NOW - (120 - i) * 60e3, 16]);
    const c = ctx({ history: { get: () => series } });
    const s = (m) => ({ sites: [{ id: '1991', name: '15th Ave NW & NW 61st St', links: [{ name: 'DOWNTOWN', minutes: m }] }] });
    assert.equal(run('traffic', s(16), s(30), ctx()).length, 0); // no history yet
    const items = checkItems(run('traffic', s(16), s(30), c));
    assert.equal(items.length, 1);
    assert.match(items[0].detail, /16 min/);
    assert.equal(run('traffic', s(30), s(24), c).length, 0);
  });
});
