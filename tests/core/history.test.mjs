import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHistory } from '../../core/history.mjs';

const MIN = 60000, HOUR = 3600000;
const quiet = { log() {}, warn() {}, error() {} };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bl-history-'));

/** A controllable clock. */
function clock(t0 = Date.UTC(2026, 8, 25, 12, 0, 0)) {
  let t = t0;
  const now = () => t;
  now.set = (v) => { t = v; };
  now.add = (ms) => { t += ms; };
  return now;
}

test('append records numbers and returns new samples', () => {
  const now = clock();
  const h = createHistory({ now, log: quiet });
  assert.deepEqual(h.append('weather.tempF', 54.1), { key: 'weather.tempF', t: now(), v: 54.1 });
  assert.deepEqual(h.latest('weather.tempF'), [now(), 54.1]);
  assert.equal(h.append('bridges.ballardUp', true).v, 1, 'booleans become 0/1');
  assert.equal(h.append('x', NaN), null);
  assert.equal(h.append('x', null), null);
  assert.equal(h.append('x', '12'), null, 'strings are not numbers');
  assert.equal(h.append('bad key with spaces', 1), null);
  assert.deepEqual(h.keys(), ['bridges.ballardUp', 'weather.tempF']);
});

test('at most one sample per minute per key (the latest value wins)', () => {
  const now = clock(Date.UTC(2026, 8, 25, 12, 0, 5));
  const h = createHistory({ now, log: quiet });
  assert.ok(h.append('k', 1));
  now.add(20000);
  assert.equal(h.append('k', 2), null, 'same minute: updated in place, no new sample');
  now.add(20000);
  assert.equal(h.append('k', 3), null);
  assert.deepEqual(h.get('k'), [[now(), 3]]);
  now.add(20000); // next minute
  assert.ok(h.append('k', 4));
  assert.equal(h.get('k').length, 2);
  // Out-of-order samples are ignored.
  assert.equal(h.append('k', 9, now() - 5 * MIN), null);
  assert.equal(h.get('k').length, 2);
});

test('appendMany samples a metrics object', () => {
  const now = clock();
  const h = createHistory({ now, log: quiet });
  const out = h.appendMany({ 'a.b': 1, 'c.d': 2.5, bad: 'x', 'e.f': null });
  assert.deepEqual(out.map((s) => s.key).sort(), ['a.b', 'c.d']);
  assert.deepEqual(h.appendMany(null), []);
});

test('retention drops samples older than 48 h; memory is bounded', () => {
  const now = clock();
  const h = createHistory({ now, log: quiet, maxKeys: 3 });
  for (let i = 0; i < 50 * 60; i++) { h.append('k', i); now.add(MIN); } // 50 hours of minutes
  const s = h.get('k', 48);
  assert.ok(s.length <= 48 * 60 + 2, `kept ${s.length}`);
  assert.ok(s[0][0] >= now() - 48 * HOUR - MIN);
  assert.equal(h.query(['k'], 1).series.k.length, 60, '1 h window');
  // Key cap
  h.append('k2', 1); h.append('k3', 1);
  assert.equal(h.append('k4', 1), null);
  assert.equal(h.keys().length, 3);
});

test('query: series for requested keys, all known keys, hours clamp, points thinning', () => {
  const now = clock();
  const h = createHistory({ now, log: quiet });
  for (let i = 0; i < 120; i++) { h.append('a', i); h.append('b', -i); now.add(MIN); }
  const q = h.query(['a', 'zzz'], 24);
  assert.deepEqual(Object.keys(q.series), ['a', 'zzz']);
  assert.equal(q.series.a.length, 120);
  assert.deepEqual(q.series.zzz, []);
  assert.deepEqual(q.keys, ['a', 'b']);
  assert.deepEqual(Object.keys(h.query([], 24).series).sort(), ['a', 'b'], 'no keys = every key');
  const thin = h.query(['a'], 24, 10).series.a;
  assert.equal(thin.length, 10);
  assert.equal(thin[9][1], 119, 'thinning keeps the newest sample');
  assert.equal(h.query(['a'], 1000).series.a.length, 120, 'hours clamps to retention');
});

test('at() finds the nearest sample within tolerance', () => {
  const now = clock();
  const h = createHistory({ now, log: quiet });
  const t0 = now();
  for (let i = 0; i < 90; i++) { h.append('k', i); now.add(MIN); }
  assert.equal(h.at('k', t0 + 30 * MIN)[1], 30);
  assert.equal(h.at('k', t0 - 60 * MIN), null, 'outside tolerance');
  assert.equal(h.at('nope', t0), null);
  assert.ok(Object.isFrozen(h.reader));
  assert.equal(typeof h.reader.append, 'undefined', 'reader is read-only');
});

test('persist and load round trip (atomic write, retention and bucketing on load)', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.json');
  const now = clock();
  const h = createHistory({ file, now, log: quiet });
  for (let i = 0; i < 30; i++) { h.append('weather.tempF', 50 + i / 10); h.append('lime.near', i); now.add(MIN); }
  assert.equal(h.save(), true);
  assert.equal(h.save(), false, 'nothing changed since the last save');
  assert.ok(fs.existsSync(file));
  assert.deepEqual(fs.readdirSync(dir), ['history.json'], 'no temp files left behind');

  const h2 = createHistory({ file, now, log: quiet });
  assert.equal(h2.load(), 60);
  assert.deepEqual(h2.query(['weather.tempF', 'lime.near']), h.query(['weather.tempF', 'lime.near']));

  // Expired samples and duplicate minutes in the file are cleaned up on load.
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.series.old = [[now() - 50 * HOUR, 1]];
  raw.series.dup = [[now() - 2 * MIN, 1], [now() - 2 * MIN + 1000, 2], ['x', 3]];
  fs.writeFileSync(file, JSON.stringify(raw));
  const h3 = createHistory({ file, now, log: quiet });
  h3.load();
  assert.deepEqual(h3.get('old'), []);
  assert.deepEqual(h3.get('dup').map((p) => p[1]), [2]);

  // Corrupt or missing files start empty instead of throwing.
  fs.writeFileSync(file, '{not json');
  assert.equal(createHistory({ file, now, log: quiet }).load(), 0);
  assert.equal(createHistory({ file: path.join(dir, 'missing.json'), now, log: quiet }).load(), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('periodic save runs on its interval', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.json');
  const h = createHistory({ file, saveEveryMs: 50, log: quiet });
  h.start();
  h.append('k', 1);
  await new Promise((r) => setTimeout(r, 150));
  h.stop();
  assert.ok(fs.existsSync(file));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).series.k.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
