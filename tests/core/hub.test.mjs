// SSE hub: starts a real server (random free port) with fake sources and reads /api/stream with fetch streaming.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createServer } from '../../server.mjs';
import { createHub, frame } from '../../core/hub.mjs';
import { quiet, sleep, tmpDir, fakeSource, openStream, until } from './helpers.mjs';

// Node 18: top-level after() only runs at beforeExit, which an open server prevents; hooks live in a suite.
describe('SSE hub over HTTP', () => {
  let app, dir;
  const fast = fakeSource('fast', 0.3, {
    metrics: (d) => ({ 'fast.n': d.n }),
    detect: (prev, next) => [{ key: `fast:${next.n}`, kind: 'civic', severity: 'info', title: `Fast #${next.n}` }],
  });
  const slow = fakeSource('slow', 3600, { idleTtl: null });

  before(async () => {
    dir = tmpDir('bl-hub-');
    app = await createServer({
      sources: [fast, slow],
      dataDir: dir,
      port: 0,
      log: quiet,
      activeWindowMs: 200,
      hub: { pingMs: 250 },
      scheduler: { tickMs: 20 },
      history: { resolutionMs: 100 }, // so every refresh is a new sample (and a metric event) in this test
    });
    await until(() => fast.calls >= 1 && app.scheduler.entry('fast').fetchedAt);
  });

  after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('stream: headers, retry, hello with source rows, snapshot of every cached source', async () => {
    const s = await openStream(`${app.url}/api/stream`, { 'Accept-Encoding': 'gzip' });
    try {
      assert.equal(s.res.status, 200);
      assert.match(s.res.headers.get('content-type'), /^text\/event-stream/);
      assert.equal(s.res.headers.get('content-encoding'), null, 'SSE is never compressed');
      assert.match(s.res.headers.get('cache-control'), /no-cache/);
      const hello = await s.next('hello');
      assert.equal(s.events[0].event, 'hello', 'hello comes first');
      assert.equal(s.retry, 3000);
      assert.ok(Math.abs(hello.data.now - Date.now()) < 5000);
      const rows = Object.fromEntries(hello.data.sources.map((r) => [r.id, r]));
      assert.deepEqual(Object.keys(rows).sort(), ['fast', 'slow']);
      assert.equal(rows.fast.hasMetrics, true);
      assert.equal(rows.fast.hasDetect, true);
      assert.equal(rows.slow.hasMetrics, false);
      assert.equal(rows.fast.idleTtl, 900);
      assert.equal(rows.slow.idleTtl, null);
      // Snapshot: one 'source' event per cached source, right after hello, shaped like /api/<id>.
      const snap = await s.next('source', (d) => d.id === 'fast');
      assert.deepEqual(Object.keys(snap.data).sort(), ['data', 'error', 'expiresAt', 'fetchedAt', 'id', 'stale', 'title', 'ttl']);
      const api = await (await fetch(`${app.url}/api/fast`)).json();
      assert.equal(api.id, 'fast');
      await s.next('source', (d) => d.id === 'slow');
    } finally {
      await s.close();
    }
  });

  test('stream: a refresh is pushed as a source event, with metric and activity events', async () => {
    const s = await openStream(`${app.url}/api/stream`);
    try {
      const first = await s.next('source', (d) => d.id === 'fast');
      const t0 = Date.now();
      const pushed = await s.next('source', (d) => d.id === 'fast' && d.fetchedAt > first.data.fetchedAt, 3000);
      assert.ok(Date.now() - t0 < 2000, 'a server-side refresh reaches the client well within 2 s');
      assert.equal(pushed.data.error, null);
      assert.ok(pushed.data.data.n > first.data.data.n);
      const metric = await s.next('metric', (d) => d.key === 'fast.n');
      assert.deepEqual(Object.keys(metric.data).sort(), ['key', 't', 'v']);
      const act = await s.next('activity', (d) => d.source === 'fast');
      assert.match(act.data.key, /^fast:\d+$/);
      assert.ok(act.data.id && act.data.t && act.data.title);
    } finally {
      await s.close();
    }
  });

  test('stream: keep-alive ping', async () => {
    const s = await openStream(`${app.url}/api/stream`);
    try {
      const ping = await s.next('ping', () => true, 2000);
      assert.ok(Number.isFinite(ping.data.now));
    } finally {
      await s.close();
    }
  });

  test('stream: an error-state change is pushed, repeats of the same error are not', async () => {
    let fail = false;
    const orig = slow.fetch;
    slow.fetch = async () => { slow.calls++; if (fail) throw new Error('upstream 503'); return { n: slow.calls }; };
    const s = await openStream(`${app.url}/api/stream`);
    try {
      await s.next('hello');
      fail = true;
      await app.scheduler.refresh('slow');
      const ev = await s.next('source', (d) => d.id === 'slow' && d.error === 'upstream 503');
      assert.ok(ev.data.data, 'last good data still included');
      const count = () => s.events.filter((e) => e.event === 'source' && e.data.id === 'slow' && e.data.error).length;
      await app.scheduler.refresh('slow');
      await sleep(50);
      assert.equal(count(), 1, 'same error again: no event');
      fail = false;
      await app.scheduler.refresh('slow');
      await s.next('source', (d) => d.id === 'slow' && d.error === null && d.fetchedAt);
    } finally {
      slow.fetch = orig;
      await s.close();
    }
  });

  test('clients are removed on close; active mode follows clients and requests', async () => {
    await until(() => app.hub.size === 0);
    await sleep(250); // let the 200 ms page-request window lapse
    assert.equal(app.isActive(), false, 'idle with no clients and no recent requests');
    const a = await openStream(`${app.url}/api/stream`);
    const b = await openStream(`${app.url}/api/stream`);
    await a.next('hello');
    await b.next('hello');
    assert.equal(app.hub.size, 2);
    assert.equal(app.isActive(), true);
    await a.close();
    await until(() => app.hub.size === 1);
    await b.close();
    await until(() => app.hub.size === 0);
    await sleep(250);
    assert.equal(app.isActive(), false);
    await fetch(`${app.url}/api/sources`).then((r) => r.arrayBuffer());
    assert.equal(app.isActive(), true, 'a page request makes the server active');
  });
});

test('hub unit: frame format', () => {
  assert.equal(frame('ping', { now: 1 }), 'event: ping\ndata: {"now":1}\n\n');
  assert.equal(frame('source', { s: 'a\nb' }), 'event: source\ndata: {"s":"a\\nb"}\n\n', 'newlines stay escaped on one data line');
  const hub = createHub({ log: quiet });
  assert.equal(hub.broadcast('ping', {}), 0, 'no clients');
  hub.close();
});

test('hub unit: maxClients, broadcast to all, slow clients dropped, close ends streams', async () => {
  const hub = createHub({ maxClients: 2, maxBufferBytes: 512 * 1024, pingMs: 60000, log: quiet });
  const srv = http.createServer((req, res) => hub.connect(req, res, [['hello', { ok: 1 }]]));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  try {
    const a = await openStream(url);
    await a.next('hello');
    // A client that never reads: its socket buffers fill and it gets dropped.
    const stuck = await new Promise((resolve) => http.get(url, (res) => { res.pause(); resolve(res); }));
    await until(() => hub.size === 2);
    const refused = await fetch(url);
    assert.equal(refused.status, 503, 'over maxClients');
    await refused.arrayBuffer();
    assert.equal(hub.broadcast('activity', { id: 'x1' }), 2);
    await a.next('activity', (d) => d.id === 'x1');
    const big = { pad: 'y'.repeat(32 * 1024) };
    for (let i = 0; i < 1000 && hub.size === 2; i++) { hub.broadcast('source', big); await sleep(2); }
    assert.equal(hub.size, 1, 'the non-reading client was dropped');
    stuck.destroy();
    hub.close();
    await until(() => a.ended);
    assert.equal(hub.size, 0);
  } finally {
    hub.close();
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
});
