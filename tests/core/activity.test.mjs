import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActivity, runDetector } from '../../core/activity.mjs';

const DAY = 86400000;
const quiet = { log() {}, warn() {}, error() {} };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bl-activity-'));
function clock(t0 = Date.UTC(2026, 8, 25, 12)) {
  let t = t0;
  const now = () => t;
  now.add = (ms) => { t += ms; };
  return now;
}
const draft = (key, extra = {}) => ({ key, kind: 'bridge', severity: 'notice', title: `Event ${key}`, ...extra });

test('add assigns id and t, defaults source, validates fields', () => {
  const now = clock();
  const a = createActivity({ now, log: quiet });
  const [it] = a.add([draft('k1', { link: 'javascript:alert(1)', lat: 47.6, lon: -122.3, severity: 'bogus' })], { sourceId: 'bridges' });
  assert.equal(typeof it.id, 'string');
  assert.equal(it.t, now());
  assert.equal(it.source, 'bridges');
  assert.equal(it.severity, 'info', 'unknown severity falls back to info');
  assert.equal(it.link, undefined, 'only http(s) links');
  assert.equal(it.lat, 47.6);
  const [it2] = a.add([draft('k2', { t: now() - 1000, source: 'other', link: 'https://example.com/x' })], { sourceId: 'bridges' });
  assert.equal(it2.source, 'other');
  assert.equal(it2.t, now() - 1000);
  assert.equal(it2.link, 'https://example.com/x');
  assert.notEqual(it.id, it2.id);
  assert.deepEqual(a.add([{ key: 'no-title' }, null, 'str']), [], 'drafts without a title are dropped');
});

test('dedupe by key: a key seen in the last 7 days is dropped', () => {
  const now = clock();
  const a = createActivity({ now, log: quiet });
  assert.equal(a.add([draft('bridge:2:up:1')]).length, 1);
  assert.equal(a.add([draft('bridge:2:up:1')]).length, 0, 'duplicate');
  assert.equal(a.add([draft('dup'), draft('dup')]).length, 1, 'duplicate within one batch');
  now.add(6 * DAY);
  assert.equal(a.add([draft('bridge:2:up:1')]).length, 0, 'still within 7 days of the last emission');
  now.add(8 * DAY);
  assert.equal(a.add([draft('bridge:2:up:1')]).length, 1, 'allowed again after 7 quiet days');
  assert.equal(a.size, 3);
});

test('seedOnly (first load) records keys without adding items', () => {
  const a = createActivity({ now: clock(), log: quiet });
  assert.deepEqual(a.add([draft('a'), draft('b')], { seedOnly: true }), []);
  assert.equal(a.size, 0);
  assert.equal(a.add([draft('a'), draft('c')]).length, 1, 'seeded key a stays quiet; c is new');
});

test('a single refresh cannot flood: at most maxPerBatch newest items', () => {
  const now = clock();
  const a = createActivity({ now, log: quiet, maxPerBatch: 5 });
  const drafts = Array.from({ length: 50 }, (_, i) => draft(`n${i}`, { t: now() - i * 1000 }));
  const added = a.add(drafts);
  assert.equal(added.length, 5);
  assert.deepEqual(added.map((x) => x.key), ['n4', 'n3', 'n2', 'n1', 'n0'], 'newest kept, returned oldest first');
});

test('keeps the newest 500, list is newest first with limit and since', () => {
  const now = clock();
  const a = createActivity({ now, log: quiet, maxPerBatch: 1000 });
  const t0 = now();
  a.add(Array.from({ length: 600 }, (_, i) => draft(`k${i}`, { t: t0 + i })));
  assert.equal(a.size, 500);
  const all = a.list({ limit: 1000 });
  assert.equal(all.length, 500);
  assert.equal(all[0].key, 'k599');
  assert.equal(all[499].key, 'k100');
  assert.equal(a.list({ limit: 3 }).length, 3);
  assert.deepEqual(a.list({ since: t0 + 596 }).map((x) => x.key), ['k599', 'k598', 'k597']);
  // An item older than everything kept is not added (and not returned for broadcast).
  assert.deepEqual(a.add([draft('ancient', { t: t0 - DAY })]), []);
});

test('persist and load round trip keeps items and dedupe keys', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'activity.json');
  const now = clock();
  const a = createActivity({ file, now, log: quiet, saveDebounceMs: 10 });
  a.add([draft('x1'), draft('x2', { t: now() - 5000 })], { sourceId: 's' });
  a.flush();
  assert.ok(fs.existsSync(file));
  const b = createActivity({ file, now, log: quiet });
  assert.equal(b.load(), 2);
  assert.deepEqual(b.list(), a.list());
  assert.equal(b.add([draft('x1')]).length, 0, 'dedupe survives a restart');
  fs.writeFileSync(file, 'garbage');
  assert.equal(createActivity({ file, now, log: quiet }).load(), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('debounced save writes once after a burst', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'activity.json');
  const a = createActivity({ file, log: quiet, saveDebounceMs: 60 });
  a.add([draft('d1')]);
  a.add([draft('d2')]);
  assert.equal(fs.existsSync(file), false, 'not written synchronously');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items.length, 2);
  a.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runDetector contains throws, rejections, bad results and hangs', async () => {
  const warnings = [];
  const log = { warn: (m) => warnings.push(m), error() {}, log() {} };
  assert.deepEqual(await runDetector({ id: 'a', detect() { throw new Error('boom'); } }, 1, 2, {}, { log }), []);
  assert.deepEqual(await runDetector({ id: 'b', async detect() { throw new Error('async boom'); } }, 1, 2, {}, { log }), []);
  assert.deepEqual(await runDetector({ id: 'c', detect: () => new Promise(() => {}) }, 1, 2, {}, { log, timeoutMs: 30 }), []);
  assert.deepEqual(await runDetector({ id: 'd', detect: () => undefined }, 1, 2, {}, { log }), []);
  assert.deepEqual(await runDetector({ id: 'e', detect: () => ({ key: 'k', title: 't' }) }, 1, 2, {}, { log }), [{ key: 'k', title: 't' }]);
  assert.deepEqual(await runDetector({ id: 'f' }, 1, 2, {}, { log }), [], 'no detector');
  assert.equal(warnings.length, 3);
});
