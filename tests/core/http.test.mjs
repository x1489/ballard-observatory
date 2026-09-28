// HTTP layer: ETag/304 on /api/<id>, gzip negotiation, static files, the JSON endpoints.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createServer } from '../../server.mjs';
import { acceptsGzip, etagMatches, isCompressible } from '../../core/http.mjs';
import { quiet, tmpDir, fakeSource, rawGet } from './helpers.mjs';

describe('HTTP: ETag, gzip, endpoints', () => {
  let app, dir, pub;
  const big = fakeSource('big', 3600, { padBytes: 5000, metrics: (d) => ({ 'big.n': d.n }) });
  const tiny = { id: 'tiny', title: 'Tiny', ttl: 3600, fetch: async () => ({ ok: 1 }) };
  const broken = { id: 'broken', title: 'Broken', ttl: 3600, fetch: async () => { throw new Error('always fails'); } };

  before(async () => {
    dir = tmpDir('bl-http-');
    pub = tmpDir('bl-pub-');
    fs.writeFileSync(path.join(pub, 'index.html'), `<!doctype html><title>t</title>${'<p>hello</p>'.repeat(300)}`);
    fs.writeFileSync(path.join(pub, 'app.js'), `console.log(${JSON.stringify('x'.repeat(3000))});`);
    fs.writeFileSync(path.join(pub, 'pic.png'), Buffer.alloc(4000, 7));
    fs.writeFileSync(path.join(pub, 'manifest.webmanifest'), JSON.stringify({ name: 'x'.repeat(2000) }));
    app = await createServer({ sources: [big, tiny, broken], dataDir: dir, publicDir: pub, port: 0, log: quiet, schedule: false });
  });
  after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(pub, { recursive: true, force: true });
  });

  test('/api/<id>: ETag, 304 on If-None-Match, new ETag after a refresh', async () => {
    const r1 = await rawGet(`${app.url}/api/big`);
    assert.equal(r1.status, 200);
    const etag = r1.headers.etag;
    assert.match(etag, /^W\/"[a-z0-9]+-[a-z0-9]+"$/);
    assert.equal(r1.headers['cache-control'], 'no-cache');
    const env = JSON.parse(r1.body);
    assert.equal(env.id, 'big');
    assert.equal(big.calls, 1);

    const r2 = await rawGet(`${app.url}/api/big`, { 'If-None-Match': etag });
    assert.equal(r2.status, 304);
    assert.equal(r2.body.length, 0);
    assert.equal(r2.headers.etag, etag);
    assert.equal(big.calls, 1, 'fresh cache: no refetch');
    assert.equal((await rawGet(`${app.url}/api/big`, { 'If-None-Match': `"nope", ${etag}` })).status, 304, 'ETag lists');
    assert.equal((await rawGet(`${app.url}/api/big`, { 'If-None-Match': '"nope"' })).status, 200);

    await new Promise((r) => setTimeout(r, 5));
    await app.scheduler.refresh('big');
    const r3 = await rawGet(`${app.url}/api/big`, { 'If-None-Match': etag });
    assert.equal(r3.status, 200, 'data changed');
    assert.notEqual(r3.headers.etag, etag);
  });

  test('/api/<id>: ETag changes with the error state', async () => {
    const r1 = await rawGet(`${app.url}/api/tiny`);
    const orig = tiny.fetch;
    tiny.fetch = async () => { throw new Error('temporarily down'); };
    await app.scheduler.refresh('tiny');
    tiny.fetch = orig;
    const r2 = await rawGet(`${app.url}/api/tiny`, { 'If-None-Match': r1.headers.etag });
    assert.equal(r2.status, 200);
    assert.equal(JSON.parse(r2.body).error, 'temporarily down');
    assert.equal(r2.headers['content-encoding'], undefined, 'small bodies are not compressed');
  });

  test('/api/<id>: 502 without data, 404 for unknown ids', async () => {
    const r = await rawGet(`${app.url}/api/broken`);
    assert.equal(r.status, 502);
    assert.equal(r.headers.etag, undefined);
    assert.equal(JSON.parse(r.body).error, 'always fails');
    assert.equal((await rawGet(`${app.url}/api/nope`)).status, 404);
  });

  test('gzip: JSON when accepted, identity otherwise', async () => {
    const gz = await rawGet(`${app.url}/api/big`, { 'Accept-Encoding': 'gzip, deflate, br' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gz.headers.vary, 'Accept-Encoding');
    assert.equal(Number(gz.headers['content-length']), gz.body.length);
    const plain = await rawGet(`${app.url}/api/big`);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.ok(gz.body.length < plain.body.length / 3);
    assert.deepEqual(JSON.parse(zlib.gunzipSync(gz.body)), JSON.parse(plain.body));
    assert.equal((await rawGet(`${app.url}/api/big`, { 'Accept-Encoding': 'gzip;q=0' })).headers['content-encoding'], undefined);
    const src = await rawGet(`${app.url}/api/sources`, { 'Accept-Encoding': 'gzip' });
    assert.ok(src.body.length < 1024 && src.headers['content-encoding'] === undefined, 'bodies under 1 KB are sent as is');
    assert.equal(src.headers.vary, 'Accept-Encoding');
  });

  test('static: gzip for text, never for images; ETag/304; traversal blocked', async () => {
    const html = await rawGet(`${app.url}/`, { 'Accept-Encoding': 'gzip' });
    assert.equal(html.status, 200);
    assert.match(html.headers['content-type'], /^text\/html/);
    assert.equal(html.headers['content-encoding'], 'gzip');
    assert.match(zlib.gunzipSync(html.body).toString(), /<p>hello<\/p>/);
    const js = await rawGet(`${app.url}/app.js`, { 'Accept-Encoding': 'gzip' });
    assert.equal(js.headers['content-encoding'], 'gzip');
    assert.match(js.headers['content-type'], /^text\/javascript/);
    const man = await rawGet(`${app.url}/manifest.webmanifest`, { 'Accept-Encoding': 'gzip' });
    assert.match(man.headers['content-type'], /^application\/manifest\+json/);
    assert.equal(man.headers['content-encoding'], 'gzip');
    const png = await rawGet(`${app.url}/pic.png`, { 'Accept-Encoding': 'gzip' });
    assert.equal(png.headers['content-type'], 'image/png');
    assert.equal(png.headers['content-encoding'], undefined);
    assert.equal(png.body.length, 4000);
    const again = await rawGet(`${app.url}/app.js`, { 'If-None-Match': js.headers.etag });
    assert.equal(again.status, 304);
    fs.writeFileSync(path.join(pub, 'app.js'), 'console.log("changed and longer than before");');
    const changed = await rawGet(`${app.url}/app.js`, { 'If-None-Match': js.headers.etag });
    assert.equal(changed.status, 200);
    assert.match(changed.body.toString(), /changed/);
    assert.equal((await rawGet(`${app.url}/missing.js`)).status, 404);
    assert.notEqual((await rawGet(`${app.url}/%2e%2e/%2e%2e/etc/passwd`)).status, 200);
    assert.notEqual((await rawGet(`${app.url}/..%2f..%2fserver.mjs`)).status, 200);
  });

  test('/api/sources rows carry idleTtl, hasMetrics, hasDetect', async () => {
    const d = JSON.parse((await rawGet(`${app.url}/api/sources`)).body);
    assert.ok(Array.isArray(d.loadErrors));
    const row = d.sources.find((s) => s.id === 'big');
    for (const k of ['id', 'title', 'group', 'ttl', 'idleTtl', 'daily', 'fetchedAt', 'expiresAt', 'error', 'errorAt', 'ms', 'ok', 'fail', 'hasMetrics', 'hasDetect']) assert.ok(k in row, k);
    assert.equal(row.idleTtl, 18000);
    assert.equal(row.hasMetrics, true);
    assert.equal(row.hasDetect, false);
  });

  test('/api/history and /api/activity shapes', async () => {
    const h = JSON.parse((await rawGet(`${app.url}/api/history?keys=big.n,nope&hours=24`)).body);
    assert.deepEqual(Object.keys(h).sort(), ['keys', 'series']);
    assert.ok(h.series['big.n'].length >= 1);
    assert.deepEqual(h.series.nope, []);
    assert.ok(h.keys.includes('big.n'));
    const a = JSON.parse((await rawGet(`${app.url}/api/activity?limit=5&since=0`)).body);
    assert.deepEqual(a, { items: [] });
  });

  test('non-GET methods are refused', async () => {
    const r = await fetch(`${app.url}/api/big`, { method: 'POST' });
    assert.equal(r.status, 405);
    await r.arrayBuffer();
  });
});

test('http helpers', () => {
  const req = (ae) => ({ headers: ae == null ? {} : { 'accept-encoding': ae } });
  assert.equal(acceptsGzip(req('gzip')), true);
  assert.equal(acceptsGzip(req('br, gzip;q=0.5')), true);
  assert.equal(acceptsGzip(req('gzip;q=0')), false);
  assert.equal(acceptsGzip(req('gzip;q=0, *')), false, 'explicit gzip;q=0 wins over *');
  assert.equal(acceptsGzip(req('*')), true);
  assert.equal(acceptsGzip(req('identity')), false);
  assert.equal(acceptsGzip(req(null)), false);
  const inm = (v) => ({ headers: { 'if-none-match': v } });
  assert.equal(etagMatches(inm('W/"a"'), 'W/"a"'), true);
  assert.equal(etagMatches(inm('"a"'), 'W/"a"'), true, 'weak comparison');
  assert.equal(etagMatches(inm('*'), 'W/"a"'), true);
  assert.equal(etagMatches(inm('"b"'), 'W/"a"'), false);
  assert.equal(isCompressible('text/event-stream'), false);
  assert.equal(isCompressible('image/png'), false);
  assert.equal(isCompressible('image/svg+xml'), true);
  assert.equal(isCompressible('application/json; charset=utf-8'), true);
});
