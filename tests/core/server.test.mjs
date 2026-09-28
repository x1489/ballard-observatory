// Server pipeline: metrics -> history, detectors -> activity (first-load and restart safety, contained failures),
// snapshot persistence and restore across a restart.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../../server.mjs';
import { quiet, tmpDir, sleep } from './helpers.mjs';

/** A source whose value we control, with metrics and a detector that reports every change of `v`. */
function counter(id = 'ctr', extra = {}) {
  const src = {
    id, title: 'Counter', ttl: 3600, v: 0, calls: 0, ctxs: [],
    async fetch() { src.calls++; return { v: src.v }; },
    metrics: (d) => ({ [`${id}.v`]: d.v }),
    detect(prev, next, ctx) {
      src.ctxs.push({ prev, ctx: { ...ctx, history: !!ctx.history } });
      // A careless detector: it reports the current value even when prev is null.
      return [{ key: `${id}:v:${next.v}`, kind: 'civic', severity: 'notice', title: `v is ${next.v}` }];
    },
    ...extra,
  };
  return src;
}

describe('server pipeline', () => {
  test('first-ever load never adds activity; later changes do; duplicates are dropped', async () => {
    const dir = tmpDir('bl-srv-');
    const c = counter();
    const app = await createServer({ sources: [c], dataDir: dir, port: 0, log: quiet, schedule: false });
    try {
      await app.scheduler.refresh('ctr');
      assert.equal(c.ctxs.length, 1);
      assert.equal(c.ctxs[0].prev, null);
      assert.equal(c.ctxs[0].ctx.firstLoad, true);
      assert.equal(c.ctxs[0].ctx.sourceId, 'ctr');
      assert.equal(c.ctxs[0].ctx.history, true);
      assert.equal(app.activity.size, 0, 'first load: nothing added');
      c.v = 1;
      await app.scheduler.refresh('ctr');
      assert.equal(c.ctxs[1].ctx.firstLoad, false);
      assert.deepEqual(c.ctxs[1].prev, { v: 0 });
      assert.deepEqual(app.activity.list().map((x) => x.title), ['v is 1']);
      await app.scheduler.refresh('ctr'); // same value -> same key
      assert.equal(app.activity.size, 1);
      c.v = 0;
      await app.scheduler.refresh('ctr');
      assert.equal(app.activity.size, 1, 'v:0 was seeded on the first load, so it stays quiet');
      assert.deepEqual(app.history.latest('ctr.v')?.[1], 0);
      const items = await (await fetch(`${app.url}/api/activity`)).json();
      assert.equal(items.items[0].source, 'ctr');
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a throwing detector or metrics function never breaks the fetch', async () => {
    const dir = tmpDir('bl-srv-');
    const bad = counter('bad', {
      detect() { throw new Error('detector bug'); },
      metrics() { throw new Error('metrics bug'); },
    });
    const good = counter('good');
    const app = await createServer({ sources: [bad, good], dataDir: dir, port: 0, log: quiet, schedule: false });
    try {
      await app.scheduler.refresh('bad');
      bad.v = 5;
      await app.scheduler.refresh('bad');
      const env = await (await fetch(`${app.url}/api/bad`)).json();
      assert.deepEqual(env.data, { v: 5 });
      assert.equal(env.error, null);
      assert.equal(app.activity.size, 0);
      await app.scheduler.refresh('good');
      good.v = 2;
      await app.scheduler.refresh('good');
      assert.equal(app.activity.size, 1, 'other sources are unaffected');
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('snapshot, history and activity persist on close and restore on start', async () => {
    const dir = tmpDir('bl-srv-');
    const c1 = counter();
    const app1 = await createServer({ sources: [c1], dataDir: dir, port: 0, log: quiet, schedule: false });
    await app1.scheduler.refresh('ctr');
    c1.v = 7;
    await app1.scheduler.refresh('ctr');
    const fetchedAt = app1.scheduler.entry('ctr').fetchedAt;
    await app1.close();
    for (const f of ['snapshot.json', 'history.json', 'activity.json']) assert.ok(fs.existsSync(path.join(dir, f)), f);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'atomic writes leave no temp files');

    // Restart with a source whose fetch hangs: the page still gets the restored data instantly.
    const c2 = counter();
    let release;
    c2.fetch = () => new Promise((r) => { release = () => r({ v: 8 }); });
    const app2 = await createServer({ sources: [c2], dataDir: dir, port: 0, log: quiet, schedule: false });
    try {
      assert.equal(app2.restored, 1);
      const row = (await (await fetch(`${app2.url}/api/sources`)).json()).sources[0];
      assert.equal(row.fetchedAt, fetchedAt, 'original fetchedAt kept');
      assert.equal(row.restored, true);
      assert.equal(row.stale, false, 'recent snapshot is not stale');
      assert.deepEqual(app2.scheduler.envelope(c2).data, { v: 7 });
      assert.equal(app2.activity.size, 1);
      assert.equal(app2.history.latest('ctr.v')[1], 7);
      // The next refresh diffs against the restored data: a real change is detected, and no flood.
      const p = app2.scheduler.refresh('ctr');
      await sleep(10);
      release();
      await p;
      const last = c2.ctxs.at(-1);
      assert.deepEqual(last.prev, { v: 7 });
      assert.equal(last.ctx.firstLoad, false);
      assert.equal(last.ctx.restored, true);
      assert.equal(last.ctx.prevFetchedAt, fetchedAt);
      assert.deepEqual(app2.activity.list().map((x) => x.title), ['v is 8', 'v is 7']);
    } finally {
      await app2.close();
    }

    // A snapshot too old to diff against: the detector gets prev = null and its output only seeds dedupe keys.
    const snap = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'));
    snap.sources.ctr.fetchedAt = Date.now() - 3 * 86400000;
    snap.sources.ctr.data = { v: 100 };
    fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(snap));
    const c3 = counter();
    c3.v = 101;
    const app3 = await createServer({ sources: [c3], dataDir: dir, port: 0, log: quiet, schedule: false });
    try {
      const env = await (await fetch(`${app3.url}/api/sources`)).json();
      assert.equal(env.sources[0].stale, true, '3-day-old restored data is flagged stale');
      await app3.scheduler.refresh('ctr');
      assert.equal(c3.ctxs[0].prev, null);
      assert.equal(c3.ctxs[0].ctx.firstLoad, true);
      assert.equal(app3.activity.size, 2, 'nothing added after a long outage');
    } finally {
      await app3.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the snapshot is written (debounced) while running', async () => {
    const dir = tmpDir('bl-srv-');
    const c = counter();
    const app = await createServer({ sources: [c], dataDir: dir, port: 0, log: quiet, schedule: false, snapshotDebounceMs: 50 });
    try {
      await app.scheduler.refresh('ctr');
      assert.equal(fs.existsSync(path.join(dir, 'snapshot.json')), false);
      await sleep(120);
      const snap = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'));
      assert.deepEqual(snap.sources.ctr.data, { v: 0 });
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the scheduler refreshes proactively with no requests at all', async () => {
    const dir = tmpDir('bl-srv-');
    const c = counter('auto', { ttl: 0.1, idleTtl: 0.1 });
    const app = await createServer({ sources: [c], dataDir: dir, port: 0, log: quiet, scheduler: { tickMs: 10 } });
    try {
      await sleep(450);
      assert.ok(c.calls >= 3, `refreshed ${c.calls} times without any client`);
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
