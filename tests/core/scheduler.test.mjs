import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler, dueAt, isFresh, isStale, expiresAt, idleTtlOf, nextPacificMidnight } from '../../core/scheduler.mjs';
import { fromPacific } from '../../lib.mjs';

const quiet = { log() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake source that counts fetches. opts.fail(n) -> throw on call n; opts.delay ms. */
function fake(id, ttl, opts = {}) {
  const src = {
    id, title: id, ttl, calls: 0,
    async fetch() {
      const n = ++src.calls;
      if (opts.delay) await sleep(opts.delay);
      if (opts.fail && opts.fail(n)) throw new Error(`fail ${n}`);
      return { n };
    },
    ...opts.def,
  };
  return src;
}

test('idleTtl defaults to max(ttl*5, 900); null disables idle refresh', () => {
  assert.equal(idleTtlOf({ ttl: 20 }), 900);
  assert.equal(idleTtlOf({ ttl: 600 }), 3000);
  assert.equal(idleTtlOf({ ttl: 600, idleTtl: 120 }), 120);
  assert.equal(idleTtlOf({ ttl: 600, idleTtl: null }), null);
  assert.equal(idleTtlOf({ ttl: 600, idleTtl: -5 }), 3000, 'invalid values fall back to the default');
});

test('dueAt: ttl when active, idleTtl when idle, background always ttl, errors retry after min(ttl, 60 s)', () => {
  const now = 1_800_000_000_000;
  const e = { fetchedAt: now - 1000, error: null, errorAt: 0 };
  const src = { ttl: 100 };
  assert.equal(dueAt(src, e, { active: true, now }), now - 1000 + 100e3);
  assert.equal(dueAt(src, e, { active: false, now }), now - 1000 + 900e3);
  assert.equal(dueAt({ ...src, background: true }, e, { active: false, now }), now - 1000 + 100e3);
  assert.equal(dueAt({ ...src, idleTtl: null }, e, { active: false, now }), Infinity);
  assert.equal(dueAt(src, { fetchedAt: 0, error: null, errorAt: 0 }, { active: true, now }), 0, 'never loaded: due now');
  const err = { fetchedAt: now - 500e3, error: 'x', errorAt: now - 1000 };
  assert.equal(dueAt(src, err, { active: true, now }), now - 1000 + 60e3);
  assert.equal(dueAt({ ttl: 20 }, err, { active: true, now }), now - 1000 + 20e3);
});

test('daily sources expire at the next Pacific midnight', () => {
  const fetchedAt = fromPacific('2026-09-25 23:50');
  const midnight = fromPacific('2026-09-26 00:00');
  assert.equal(nextPacificMidnight(fetchedAt), midnight);
  const src = { ttl: 3600, daily: true };
  const e = { fetchedAt, error: null, errorAt: 0 };
  assert.equal(dueAt(src, e, { active: true, now: fetchedAt + 1000 }), midnight);
  assert.equal(dueAt(src, e, { active: false, now: fetchedAt + 1000 }), midnight, 'also while idle');
  assert.equal(expiresAt(src, e), midnight);
  assert.equal(isFresh(src, e, midnight - 1000), true);
  assert.equal(isFresh(src, e, midnight + 1000), false);
  assert.equal(isStale(src, e, midnight - 1000), false);
  assert.equal(isStale(src, e, midnight + 1000), true, 'daily data from an earlier Pacific day is stale');
  // Across the fall-back DST change (Nov 1 2026) midnight is still local midnight.
  assert.equal(nextPacificMidnight(fromPacific('2026-10-31 22:00')), fromPacific('2026-11-01 00:00'));
  assert.equal(nextPacificMidnight(fromPacific('2026-11-01 12:00')), fromPacific('2026-11-02 00:00'));
});

test('active mode refreshes every ttl without any requests', async () => {
  const a = fake('a', 0.1);
  const s = createScheduler({ sources: [a], isActive: () => true, tickMs: 10, log: quiet });
  s.start();
  await sleep(560);
  s.stop();
  assert.ok(a.calls >= 4 && a.calls <= 7, `expected ~6 refreshes in 560 ms at ttl 100 ms, got ${a.calls}`);
});

test('idle mode uses idleTtl; background sources keep ttl; idleTtl:null skips', async () => {
  const a = fake('a', 0.05, { def: { idleTtl: 0.25 } });
  const bg = fake('bg', 0.05, { def: { background: true } });
  const off = fake('off', 0.05, { def: { idleTtl: null } });
  let active = false;
  const s = createScheduler({ sources: [a, bg, off], isActive: () => active, tickMs: 10, log: quiet });
  s.start();
  await sleep(600);
  assert.ok(a.calls >= 2 && a.calls <= 4, `idle: ~3 refreshes at idleTtl 250 ms, got ${a.calls}`);
  assert.ok(bg.calls >= 8, `background keeps ttl while idle, got ${bg.calls}`);
  assert.equal(off.calls, 0, 'idleTtl:null never refreshes while idle');
  // A client connects: everything switches to ttl.
  active = true;
  const before = a.calls;
  await sleep(400);
  s.stop();
  assert.ok(a.calls - before >= 4, `active: ttl 50 ms, got ${a.calls - before} in 400 ms`);
  assert.ok(off.calls >= 4, `idleTtl:null source runs when active, got ${off.calls}`);
});

test('stagger: a tick starts at most maxStartsPerTick sources, background first', async () => {
  const srcs = Array.from({ length: 6 }, (_, i) => fake(`s${i}`, 1000));
  const bg = fake('bg', 1000, { def: { background: true } });
  const s = createScheduler({ sources: [...srcs, bg], isActive: () => true, tickMs: 100000, maxStartsPerTick: 2, log: quiet });
  assert.equal(s.tick(), 2);
  await sleep(5);
  assert.equal(bg.calls, 1, 'background source starts in the first tick');
  assert.equal(srcs.reduce((n, x) => n + x.calls, 0), 1);
  assert.equal(s.tick(), 2);
  assert.equal(s.tick(), 2);
  assert.equal(s.tick(), 1);
  assert.equal(s.tick(), 0, 'all loaded; nothing due');
});

test('maxInflight caps concurrent scheduled refreshes', async () => {
  const srcs = Array.from({ length: 5 }, (_, i) => fake(`s${i}`, 1000, { delay: 50 }));
  const s = createScheduler({ sources: srcs, isActive: () => true, maxStartsPerTick: 10, maxInflight: 3, log: quiet });
  assert.equal(s.tick(), 3);
  assert.equal(s.tick(), 0, 'cap reached while three are in flight');
  await sleep(80);
  assert.equal(s.tick(), 2);
});

test('inflight dedupe: concurrent refreshes share one fetch', async () => {
  const a = fake('a', 60, { delay: 30 });
  const s = createScheduler({ sources: [a], log: quiet });
  const [e1, e2] = await Promise.all([s.refresh('a'), s.refresh(a)]);
  assert.equal(a.calls, 1);
  assert.equal(e1, e2);
  assert.deepEqual(s.entry('a').data, { n: 1 });
  await Promise.all([s.get('a'), s.get('a')]);
  assert.equal(a.calls, 1, 'fresh cache is served without a fetch');
});

test('deadline: a hung fetch becomes an error after deadlineMs', async () => {
  const hang = { id: 'hang', title: 'hang', ttl: 60, fetch: () => new Promise(() => {}) };
  const s = createScheduler({ sources: [hang], deadlineMs: 40, log: quiet });
  const t0 = Date.now();
  await s.refresh('hang');
  assert.ok(Date.now() - t0 < 1000);
  assert.match(s.entry('hang').error, /deadline 40ms exceeded/);
  assert.equal(s.entry('hang').inflight, null);
});

test('stale-while-error: last good data is kept and the error flagged; recovery clears it', async () => {
  let fail = false;
  const a = { id: 'a', title: 'A', ttl: 60, calls: 0, async fetch({ prev }) { a.calls++; if (fail) throw new Error('upstream down'); return { v: a.calls, hadPrev: !!prev }; } };
  const events = [];
  const s = createScheduler({ sources: [a], log: quiet, onRefresh: (src, e, info) => events.push({ ok: info.ok, errorChanged: info.errorChanged }) });
  await s.refresh('a');
  fail = true;
  await s.refresh('a');
  const env = s.envelope(a);
  assert.deepEqual(env.data, { v: 1, hadPrev: false });
  assert.equal(env.error, 'upstream down');
  assert.equal(env.stale, false);
  await s.refresh('a'); // same error again
  fail = false;
  await s.refresh('a');
  assert.equal(s.envelope(a).error, null);
  assert.deepEqual(s.envelope(a).data, { v: 4, hadPrev: true });
  assert.deepEqual(events, [
    { ok: true, errorChanged: false },
    { ok: false, errorChanged: true },
    { ok: false, errorChanged: false },
    { ok: true, errorChanged: true },
  ]);
  const row = s.row(a);
  assert.equal(row.ok, 2);
  assert.equal(row.fail, 2);
});

test('error retry: requests are served from cache for min(ttl, 60 s) after a failure, then retried', async () => {
  const a = fake('a', 0.08, { fail: (n) => n === 1 });
  const s = createScheduler({ sources: [a], isActive: () => true, tickMs: 10, log: quiet });
  await s.get('a');
  assert.equal(a.calls, 1);
  assert.ok(s.entry('a').error);
  await s.get('a');
  assert.equal(a.calls, 1, 'within the retry window');
  s.start();
  await sleep(150);
  s.stop();
  assert.ok(a.calls >= 2, 'scheduler retried');
  assert.equal(s.entry('a').error, null);
});

test('fetch returning nothing is an error, not an empty cache', async () => {
  const a = { id: 'a', title: 'a', ttl: 60, fetch: async () => undefined };
  const s = createScheduler({ sources: [a], log: quiet });
  await s.refresh('a');
  assert.equal(s.entry('a').error, 'fetch returned no data');
});

test('a throwing onRefresh hook never breaks the fetch', async () => {
  const a = fake('a', 60);
  const s = createScheduler({ sources: [a], log: quiet, onRefresh: () => { throw new Error('hook bug'); } });
  await s.refresh('a');
  assert.deepEqual(s.entry('a').data, { n: 1 });
  assert.equal(s.entry('a').error, null);
});

test('restore seeds the cache with the original fetchedAt; stale stays truthful; prev is passed to fetch', async () => {
  let seenPrev;
  const a = { id: 'a', title: 'a', ttl: 10, fetch: async ({ prev }) => { seenPrev = prev; return { fresh: true }; } };
  const s = createScheduler({ sources: [a], log: quiet });
  const old = Date.now() - 60000;
  assert.equal(s.restore({ a: { fetchedAt: old, data: { old: true } }, unknown: { fetchedAt: old, data: 1 }, b: null }), 1);
  const env = s.envelope(a);
  assert.equal(env.fetchedAt, old);
  assert.equal(env.stale, true, '60 s old with ttl 10 s is stale');
  assert.equal(s.row(a).restored, true);
  assert.equal(isFresh(a, s.entry('a')), false);
  assert.equal(s.restore({ a: { fetchedAt: Date.now() - 30 * 86400000, data: {} } }), 0, 'too old to restore');
  await s.get('a');
  assert.deepEqual(seenPrev, { old: true });
  assert.equal(s.envelope(a).stale, false);
  assert.equal(s.row(a).restored, false);
  assert.deepEqual(Object.keys(s.snapshot()), ['a']);
});
