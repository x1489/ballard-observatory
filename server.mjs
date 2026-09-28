// Ballard Live — local real-time neighborhood dashboard server. Zero dependencies (Node 18+).
// Usage: node server.mjs   (PORT env var optional, default 4177; HOST default 127.0.0.1)
// Tests: import { createServer } from './server.mjs' and start it on any port with custom sources and data dir.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, DATA_DIR, get, discard } from './lib.mjs';
import { loadSources } from './sources/index.mjs';
import { lookupFlight, memoryCache } from './sources/lookup.mjs';
import { createRelay } from './core/relay.mjs';
import { createScheduler, idleTtlOf } from './core/scheduler.mjs';
import { createHub } from './core/hub.mjs';
import { createHistory } from './core/history.mjs';
import { createActivity, runDetector } from './core/activity.mjs';
import { readJson, writeJsonAtomic, throttledSaver } from './core/persist.mjs';
import { createCamStore } from './core/camstore.mjs';
import { createBaseline } from './core/baseline.mjs';
import { MIME, GZIP_MIN_BYTES, sendBody, sendJson, sendText, etagMatches, hash, isCompressible, gzipBuffer } from './core/http.mjs';

export const PUBLIC_DIR = path.join(ROOT, 'public');

/**
 * Build and start a Ballard Live server. Every option is optional:
 *   sources, loadErrors      source definitions (default: loadSources() from sources/index.mjs)
 *   dataDir                  where history.json, activity.json and snapshot.json live (default: data/)
 *   publicDir, port, host    static root; port 0 picks a free port; host defaults to 127.0.0.1
 *   schedule                 run the proactive refresh scheduler (default true)
 *   activeWindowMs           a page request keeps the server in active mode this long (default 2 min)
 *   snapshotDebounceMs       at most one snapshot write per this interval (default 30 s)
 *   maxPrevAgeMs             a restored snapshot older than this is not used as a detector's prev (default 6 h)
 *   scheduler, hub, history, activity   option objects passed to the core factories (see core/*.mjs)
 * Resolves to { server, port, url, scheduler, hub, history, activity, persist(), close(), ... }.
 */
export async function createServer(opts = {}) {
  let { sources, loadErrors } = opts;
  if (!sources) ({ sources, loadErrors } = await loadSources());
  loadErrors = loadErrors || [];
  const {
    dataDir = DATA_DIR,
    port = 0,
    host = '127.0.0.1',
    schedule = true,
    activeWindowMs = 120000,
    snapshotDebounceMs = 30000,
    maxPrevAgeMs = 6 * 3600000,
    log = console,
  } = opts;
  const publicDir = path.resolve(opts.publicDir || PUBLIC_DIR);
  for (const s of sources) {
    if (s.title == null) s.title = s.id;
    if (s.group == null) s.group = 'other';
  }

  let closed = false;
  let lastRequestAt = 0;

  const hub = createHub({ log, ...opts.hub });
  const isActive = () => hub.size > 0 || Date.now() - lastRequestAt < activeWindowMs;
  const history = createHistory({ file: path.join(dataDir, 'history.json'), log, ...opts.history });
  history.load();
  const activity = createActivity({ file: path.join(dataDir, 'activity.json'), log, ...opts.activity });
  activity.load();
  const scheduler = createScheduler({ sources, isActive, onRefresh: afterRefresh, log, ...opts.scheduler });
  const flightCache = memoryCache();
  const relay = createRelay({ scheduler, dataDir, log });
  // Camera time-lapse frames (see core/camstore.mjs) and "usual for this hour" baselines (core/baseline.mjs).
  const camstore = createCamStore({ dir: path.join(dataDir, 'cams'), keep: opts.camKeep ?? 90, fetchImage: fetchCamImage, log });
  camstore.load();
  const baseline = createBaseline({ file: path.join(dataDir, 'baseline.json'), log });
  baseline.load();
  if (!baseline.keys().length) baseline.seed(history.query([], 48).series); // first run: bootstrap from history
  const baselineTimer = setInterval(() => baseline.save(), 10 * 60000);
  baselineTimer.unref();

  // Last good envelope per source: restored now (keeping the original fetchedAt, so `stale` stays truthful),
  // saved at most once per snapshotDebounceMs after refreshes, and on exit.
  const snapFile = path.join(dataDir, 'snapshot.json');
  const snap = readJson(snapFile, null, log);
  const restored = scheduler.restore(snap && snap.sources);
  const snapSaver = throttledSaver(
    () => writeJsonAtomic(snapFile, { v: 1, savedAt: Date.now(), sources: scheduler.snapshot() }),
    snapshotDebounceMs, { name: 'snapshot', log });

  /** Runs after every refresh: snapshot, metrics -> history, 'source' + 'metric' events, detectors -> activity. */
  function afterRefresh(src, e, { ok, prev, prevFetchedAt, restored: wasRestored, errorChanged }) {
    if (closed) return;
    if (!ok) {
      if (errorChanged) hub.broadcast('source', scheduler.envelope(src, e));
      return;
    }
    snapSaver.mark();
    let samples = [];
    if (typeof src.metrics === 'function') {
      try {
        samples = history.appendMany(src.metrics(e.data), e.fetchedAt);
        for (const s of samples) baseline.add(s.key, s.t, s.v);
      } catch (err) {
        log.warn(`[metrics] ${src.id}: ${err && err.message || err}`);
      }
    }
    hub.broadcast('source', scheduler.envelope(src, e));
    for (const s of samples) hub.broadcast('metric', s);
    relay.push(src, e);
    if (src.id === 'cameras' && e.data) camstore.capture(e.data.cameras).catch((err) => log.warn(`[cams] ${err && err.message || err}`));
    if (typeof src.detect !== 'function') return;
    // No prev (first-ever load), or a restored snapshot too old to diff against: detectors get prev = null and
    // anything they return anyway only seeds the dedupe keys, so a restart never floods the activity feed.
    const prevTooOld = wasRestored && prevFetchedAt
      && e.fetchedAt - prevFetchedAt > Math.max(maxPrevAgeMs, 2 * (idleTtlOf(src) ?? src.ttl) * 1000);
    const firstLoad = prev == null || !!prevTooOld;
    const ctx = {
      now: e.fetchedAt,
      sourceId: src.id,
      firstLoad,
      restored: !!wasRestored,
      prevFetchedAt: prevFetchedAt || null,
      history: history.reader,
      data: (id) => { const x = scheduler.cache.get(id); return x ? x.data : null; },
    };
    return runDetector(src, firstLoad ? null : prev, e.data, ctx, { log }).then((drafts) => {
      if (closed) return;
      const added = activity.add(drafts, { sourceId: src.id, seedOnly: firstLoad });
      for (const it of added) hub.broadcast('activity', it);
    });
  }

  // ---------------------------------------------------------------- HTTP
  function sourcesPayload() {
    return { now: Date.now(), loadErrors, sources: scheduler.rows(), clients: hub.size, active: isActive() };
  }

  function stream(req, res) {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end();
    }
    const initial = [['hello', { now: Date.now(), sources: scheduler.rows(), loadErrors }]];
    for (const s of sources) {
      const e = scheduler.entry(s.id);
      if (e.data != null || e.error) initial.push(['source', scheduler.envelope(s, e)]);
    }
    hub.connect(req, res, initial);
    req.on('close', () => { lastRequestAt = Date.now(); });
  }

  async function sourceEnvelope(req, res, id) {
    if (!scheduler.byId.has(id)) return sendJson(req, res, 404, { error: `unknown source '${id}'` });
    const env = await scheduler.get(id);
    if (env.data == null) return sendJson(req, res, 502, env);
    // Changes whenever the payload can: new data (fetchedAt), error state, or the stale flag flipping.
    const etag = `W/"${env.fetchedAt.toString(36)}-${hash(`${env.id}|${env.error || ''}|${env.stale ? 1 : 0}`)}"`;
    const headers = { ETag: etag, 'Cache-Control': 'no-cache' };
    if (etagMatches(req, etag)) {
      res.writeHead(304, { ...headers, Vary: 'Accept-Encoding' });
      return res.end();
    }
    return sendJson(req, res, 200, env, headers);
  }

  const num = (v, d) => { const n = v == null || v === '' ? NaN : Number(v); return Number.isFinite(n) ? n : d; };

  const staticCache = new Map(); // file -> { etag, buf, gz }
  const obsDir = path.resolve(opts.obsDir || process.env.BO_OUT || path.join(ROOT, 'lake', '_out'));
  const OBS_FILES = new Set(['insights.json', 'relations.json', 'interactions.json', 'hotspots.geojson', 'density.geojson', 'series.json',
    'places.json', 'place_index.json', 'catalog.json', 'concordance.json', 'run.json', 'civic.json', 'nearby_quantiles.json']);

  async function serveStatic(req, res, p, root = publicDir) {
    const file = path.normalize(path.join(root, p === '/' ? 'index.html' : p));
    if (!file.startsWith(root + path.sep)) return sendText(req, res, 403, 'forbidden');
    let st;
    try { st = await fs.promises.stat(file); } catch { st = null; }
    if (!st || !st.isFile()) return sendText(req, res, 404, 'not found');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag, 'Last-Modified': st.mtime.toUTCString() };
    if (etagMatches(req, etag)) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache', ...(isCompressible(type) ? { Vary: 'Accept-Encoding' } : {}) });
      return res.end();
    }
    let hit = staticCache.get(file);
    if (!hit || hit.etag !== etag) {
      const buf = await fs.promises.readFile(file);
      hit = { etag, buf, gz: isCompressible(type) && buf.length >= GZIP_MIN_BYTES ? await gzipBuffer(buf) : null };
      if (buf.length <= 4 * 1024 * 1024) {
        staticCache.delete(file);
        staticCache.set(file, hit);
        if (staticCache.size > 300) staticCache.delete(staticCache.keys().next().value);
      }
    }
    return sendBody(req, res, 200, hit.buf, headers, { gz: hit.gz });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    let p;
    try { p = decodeURIComponent(url.pathname); } catch { return sendText(req, res, 400, 'bad request'); }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(req, res, 405, 'method not allowed', { Allow: 'GET, HEAD' });
    lastRequestAt = Date.now();

    if (p === '/api/stream') return stream(req, res);
    if (p === '/api/sources') return sendJson(req, res, 200, sourcesPayload());
    if (p === '/api/live') {
      // Several feeds in one request (the hosted edge offers the same endpoint).
      const ids = (url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
      const envelopes = {};
      await Promise.all(ids.map(async (id) => { const e = await scheduler.get(id); if (e) envelopes[id] = e; }));
      return sendJson(req, res, 200, { now: Date.now(), envelopes });
    }
    if (p === '/api/flight') {
      // Route + airframe + photo for one aircraft (the tracking card); cached.
      const out = await lookupFlight({ callsign: url.searchParams.get('callsign'), hex: url.searchParams.get('hex') }, flightCache);
      return sendJson(req, res, 200, out);
    }
    if (p === '/api/history') {
      const q = url.searchParams;
      const keys = (q.get('keys') || '').split(',').map((k) => k.trim()).filter(Boolean).slice(0, 200);
      const points = Math.floor(num(q.get('points'), 0));
      return sendJson(req, res, 200, history.query(keys, num(q.get('hours'), 24), points >= 2 ? Math.min(points, 5000) : undefined));
    }
    if (p === '/api/activity') {
      const q = url.searchParams;
      return sendJson(req, res, 200, { items: activity.list({ limit: num(q.get('limit'), 200), since: num(q.get('since'), undefined) }) });
    }
    // Platform outputs written by the analytics engines (platform/, `python -m bo engines`).
    if (p.startsWith('/api/obs/')) {
      const name = p.slice('/api/obs/'.length);
      if (!OBS_FILES.has(name) && !/^places\/[0-9a-f]{2}\.json$/.test(name)) return sendText(req, res, 404, 'not found');
      return serveStatic(req, res, `/${name}`, obsDir);
    }
    if (p === '/api/cams') {
      const cams = scheduler.cache.get('cameras');
      const labels = Object.fromEntries(((cams && cams.data && cams.data.cameras) || []).map((c) => [c.id, c.label]));
      return sendJson(req, res, 200, camstore.list(labels));
    }
    if (p === '/api/baseline') {
      const keys = (url.searchParams.get('keys') || '').split(',').map((k) => k.trim()).filter(Boolean).slice(0, 200);
      const cur = (k) => { const l = history.latest(k); return l ? l[1] : null; };
      return sendJson(req, res, 200, baseline.query(keys.length ? keys : baseline.keys(), Date.now(), cur));
    }
    if (p.startsWith('/cam/')) {
      const m = /^\/cam\/([A-Za-z0-9-]{1,32})\/(\d{10,14})\.jpg$/.exec(p);
      const file = m && camstore.file(m[1], m[2]);
      if (!file) return sendText(req, res, 404, 'no such frame');
      let buf;
      try { buf = await fs.promises.readFile(file); } catch { return sendText(req, res, 404, 'no such frame'); }
      return sendBody(req, res, 200, buf, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800, immutable' });
    }
    if (p.startsWith('/api/')) return sourceEnvelope(req, res, p.slice(5));
    if (p === '/img') return proxyImage(req, res, url.searchParams.get('u'));
    if (p === '/pro' || p === '/classic') return serveStatic(req, res, `${p}.html`); // same as the edge's html handling
    return serveStatic(req, res, p);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error(`[http] ${req.method} ${req.url}: ${err && err.stack || err}`);
      if (!res.headersSent) sendJson(req, res, 500, { error: String(err && err.message || err) }).catch(() => {});
      else res.destroy();
    });
  });

  // ---------------------------------------------------------------- lifecycle
  /** Write history, activity and the snapshot now (synchronously). Safe to call from a signal handler. */
  function persist() {
    try { history.save(); } catch (e) { log.error(`[history] save failed: ${e.message}`); }
    try { baseline.save(); } catch (e) { log.error(`[baseline] save failed: ${e.message}`); }
    activity.flush();
    snapSaver.flush();
  }

  async function close() {
    relay.stop();
    if (closed) return;
    scheduler.stop();
    history.stop();
    clearInterval(baselineTimer);
    hub.close();
    persist();
    closed = true;
    activity.stop();
    snapSaver.cancel();
    await new Promise((resolve) => {
      server.close(() => resolve());
      if (server.closeAllConnections) server.closeAllConnections();
    });
  }

  // Keep idle keep-alive sockets longer than any client polls (default 5 s): otherwise a client that polls every
  // ~5 s can reuse a socket just as the server closes it and see a spurious connection reset.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => { server.off('error', onError); resolve(); });
  });
  server.on('error', (err) => log.error(`[http] server error: ${err && err.message || err}`));
  history.start();
  if (schedule) scheduler.start();

  const actualPort = server.address().port;
  return {
    server,
    port: actualPort,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${actualPort}`,
    sources,
    loadErrors,
    restored,
    scheduler,
    hub,
    history,
    activity,
    camstore,
    baseline,
    isActive,
    persist,
    close,
  };
}

// Image proxy for SDOT traffic cameras. Their CloudFront WAF rejects some browsers (e.g. headless Chrome), while
// the server's UA is accepted. Only allow-listed prefixes; short in-memory cache so many tabs share one fetch.
const IMG_ALLOW = ['https://www.seattle.gov/trafficcams/images/'];
const imgCache = new Map(); // url -> { at, type, buf, lastModified }
const IMG_TTL = 60000;
async function proxyImage(req, res, u) {
  if (!u || !IMG_ALLOW.some((pfx) => u.startsWith(pfx)) || /[?#]|\.\./.test(u.slice(u.indexOf('/images/')))) return sendText(req, res, 400, 'bad image url');
  let hit = imgCache.get(u);
  if (!hit || Date.now() - hit.at > IMG_TTL) {
    try {
      const r = await get(u, { as: 'response', timeout: 12000, retries: 0 });
      const type = r.headers.get('content-type') || '';
      if (!r.ok || !type.startsWith('image/')) { await discard(r); throw new Error(`HTTP ${r.status} ${type}`); }
      hit = { at: Date.now(), type, buf: Buffer.from(await r.arrayBuffer()), lastModified: r.headers.get('last-modified') };
      imgCache.set(u, hit);
      if (imgCache.size > 50) imgCache.delete(imgCache.keys().next().value);
    } catch (err) {
      if (!hit) return sendText(req, res, 502, `image fetch failed: ${err.message}`);
    }
  }
  return sendBody(req, res, 200, hit.buf, { 'Content-Type': hit.type, 'Cache-Control': 'private, max-age=60', ...(hit.lastModified ? { 'Last-Modified': hit.lastModified } : {}) });
}

/** Fetch one allow-listed camera still as a Buffer (for the time-lapse store). */
async function fetchCamImage(u) {
  if (!IMG_ALLOW.some((pfx) => String(u).startsWith(pfx))) throw new Error('camera url not allowed');
  const r = await get(u, { as: 'response', timeout: 12000, retries: 0 });
  const type = r.headers.get('content-type') || '';
  if (!r.ok || !type.startsWith('image/')) { await discard(r); throw new Error(`HTTP ${r.status} ${type}`); }
  return Buffer.from(await r.arrayBuffer());
}

// ---------------------------------------------------------------- CLI entry
async function main() {
  // A long-running dashboard should survive a single bad upstream response. Node 18's bundled undici can throw
  // asynchronously from inside fetch internals (e.g. ERR_INVALID_STATE 'Controller is already closed'), where no
  // caller can catch it. Log and keep serving; every source has its own error handling and retry.
  process.on('uncaughtException', (err) => console.error(`[${new Date().toISOString()}] uncaught (continuing):`, err && err.stack || err));
  process.on('unhandledRejection', (err) => console.error(`[${new Date().toISOString()}] unhandled rejection (continuing):`, err && err.stack || err));

  let app;
  try {
    app = await createServer({ port: +process.env.PORT || 4177, host: process.env.HOST || '127.0.0.1' });
  } catch (err) {
    console.error(`Ballard Live failed to start: ${err && err.message || err}`);
    process.exit(1);
  }
  console.log(`Ballard Live → http://localhost:${app.port}  (${app.sources.length} sources${app.restored ? `, ${app.restored} restored from snapshot` : ''})`);
  for (const le of app.loadErrors) console.warn(`  source module failed to load: ${le.file}: ${le.error}`);

  let stopping = false;
  const shutdown = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`${sig}: saving history, activity and snapshot`);
    app.persist();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const isMain = (() => {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) await main();
