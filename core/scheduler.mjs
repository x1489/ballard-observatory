// Source cache + proactive refresh scheduler.
//
// Every source is refreshed on its own: every `ttl` seconds while the dashboard is in use (an SSE client is
// connected, or a page request was seen in the last 2 minutes), every `idleTtl` seconds otherwise
// (default max(ttl*5, 900); null = not while idle). `background` sources always run on `ttl`. `daily` sources
// also expire at the next Pacific midnight. Refreshes are deduped while in flight, bounded by a 45 s deadline,
// keep serving the last good data on error (stale-while-error) and retry after min(ttl, 60 s).
import { pacificDate, fromPacific } from '../lib.mjs';

export const DEFAULT_DEADLINE_MS = 45000;

/** Seconds between refreshes while idle, or null when the source is not refreshed while idle. */
export function idleTtlOf(src) {
  if (src.idleTtl === null) return null;
  if (typeof src.idleTtl === 'number' && Number.isFinite(src.idleTtl) && src.idleTtl > 0) return src.idleTtl;
  return Math.max(src.ttl * 5, 900);
}

/** Epoch ms of the first Pacific midnight after t. */
export const nextPacificMidnight = (t) => fromPacific(pacificDate(1, t));

/** Daily data fetched on an earlier Pacific day than `now`. */
export const dayChanged = (src, e, now = Date.now()) =>
  !!(src.daily && e.fetchedAt && pacificDate(0, e.fetchedAt) !== pacificDate(0, now));

/** When the cached data should be refetched: fetchedAt + ttl, or the next Pacific midnight for daily sources. */
export function expiresAt(src, e) {
  if (!e.fetchedAt) return null;
  const byTtl = e.fetchedAt + src.ttl * 1000;
  return src.daily ? Math.min(byTtl, nextPacificMidnight(e.fetchedAt)) : byTtl;
}

/** Stale = older than 3 x ttl, or daily data from an earlier Pacific day. */
export const isStale = (src, e, now = Date.now()) =>
  !!e.fetchedAt && (now - e.fetchedAt > src.ttl * 1000 * 3 || dayChanged(src, e, now));

/**
 * Freshness for on-demand requests (/api/<id>): fresh within ttl (and the same Pacific day for daily sources).
 * After a failed fetch it counts as fresh for min(ttl, 60 s) so requests don't hammer a failing upstream.
 */
export function isFresh(src, e, now = Date.now()) {
  if (e.error && e.errorAt > e.fetchedAt) return now - e.errorAt < Math.min(src.ttl, 60) * 1000;
  if (!e.fetchedAt || dayChanged(src, e, now)) return false;
  return now - e.fetchedAt < src.ttl * 1000;
}

/** When the scheduler should next refresh this source (epoch ms; 0 = now; Infinity = not in this mode). */
export function dueAt(src, e, { active, now = Date.now() } = {}) {
  const interval = src.background || active ? src.ttl : idleTtlOf(src);
  if (interval == null) return Infinity;
  if (e.error && e.errorAt > e.fetchedAt) return e.errorAt + Math.min(src.ttl, 60) * 1000;
  if (!e.fetchedAt) return 0;
  const due = e.fetchedAt + interval * 1000;
  return src.daily ? Math.min(due, nextPacificMidnight(e.fetchedAt)) : due;
}

export function createScheduler({
  sources,
  isActive = () => true,
  onRefresh = () => {},
  deadlineMs = DEFAULT_DEADLINE_MS,
  tickMs = 250,
  maxStartsPerTick = 2,
  maxInflight = 10,
  now = Date.now,
  log = console,
} = {}) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const cache = new Map(); // id -> entry

  function entry(id) {
    let e = cache.get(id);
    if (!e) {
      e = { data: null, fetchedAt: 0, error: null, errorAt: 0, ms: 0, inflight: null, ok: 0, fail: 0, restored: false };
      cache.set(id, e);
    }
    return e;
  }
  for (const s of sources) entry(s.id);

  const active = () => { try { return !!isActive(); } catch { return true; } };

  /**
   * Refresh one source now (deduped while in flight). Resolves after the cache is updated and onRefresh ran;
   * never rejects. onRefresh(src, e, { ok, prev, prevFetchedAt, restored, errorChanged, reason }).
   */
  function refresh(srcOrId, reason = 'manual') {
    const src = typeof srcOrId === 'string' ? byId.get(srcOrId) : srcOrId;
    if (!src) return Promise.resolve(null);
    const e = entry(src.id);
    if (e.inflight) return e.inflight;
    const started = now();
    const prev = e.data, prevFetchedAt = e.fetchedAt, prevError = e.error, restored = e.restored;
    let deadline;
    e.inflight = (async () => {
      let ok = false;
      try {
        const data = await Promise.race([
          src.fetch({ prev: e.data, fetchedAt: e.fetchedAt }),
          new Promise((_, rej) => { const ms = src.deadlineMs || deadlineMs; deadline = setTimeout(() => rej(new Error(`deadline ${ms}ms exceeded`)), ms); }),
        ]);
        if (data == null) throw new Error('fetch returned no data');
        e.data = data;
        e.fetchedAt = now();
        e.error = null;
        e.restored = false;
        e.ok++;
        ok = true;
      } catch (err) {
        e.error = String(err && err.message || err).slice(0, 500);
        e.errorAt = now();
        e.fail++;
        log.warn(`[${new Date().toISOString()}] ${src.id}: ${e.error}`);
      } finally {
        clearTimeout(deadline);
        e.ms = now() - started;
        e.inflight = null;
      }
      try {
        await onRefresh(src, e, { ok, prev, prevFetchedAt, restored, errorChanged: e.error !== prevError, reason });
      } catch (err) {
        log.error(`[scheduler] after-refresh hook for ${src.id} failed: ${err && err.stack || err}`);
      }
      return e;
    })();
    return e.inflight;
  }

  function envelope(src, e = entry(src.id), t = now()) {
    return {
      id: src.id,
      title: src.title,
      ttl: src.ttl,
      fetchedAt: e.fetchedAt || null,
      expiresAt: expiresAt(src, e),
      stale: isStale(src, e, t),
      error: e.error,
      data: e.data,
    };
  }

  /** The /api/<id> path: cached envelope if fresh, otherwise awaits a refresh. null for unknown ids. */
  async function get(id) {
    const src = byId.get(id);
    if (!src) return null;
    const e = entry(id);
    if (!isFresh(src, e, now())) await refresh(src, 'request');
    return envelope(src, e);
  }

  /** One /api/sources row. */
  function row(s, t = now()) {
    const e = entry(s.id);
    return {
      id: s.id, title: s.title, group: s.group, ttl: s.ttl, idleTtl: idleTtlOf(s), daily: !!s.daily, background: !!s.background,
      fetchedAt: e.fetchedAt || null, expiresAt: expiresAt(s, e), stale: isStale(s, e, t), restored: !!e.restored,
      error: e.error, errorAt: e.errorAt || null, ms: e.ms, ok: e.ok, fail: e.fail,
      hasMetrics: typeof s.metrics === 'function', hasDetect: typeof s.detect === 'function',
    };
  }
  const rows = () => { const t = now(); return sources.map((s) => row(s, t)); };

  // ---------------------------------------------------------------- timer
  let timer = null;
  function tick() {
    const t = now();
    const act = active();
    let inflight = 0;
    const due = [];
    for (const s of sources) {
      const e = entry(s.id);
      if (e.inflight) { inflight++; continue; }
      const d = dueAt(s, e, { active: act, now: t });
      if (d <= t) due.push({ s, d });
    }
    if (!due.length) return 0;
    // Background sources first, then the most overdue. A few starts per tick staggers bursts (startup, or the
    // first browser after a long idle) instead of hitting every upstream in the same instant.
    due.sort((a, b) => (b.s.background ? 1 : 0) - (a.s.background ? 1 : 0) || a.d - b.d);
    let started = 0;
    for (const { s } of due) {
      if (started >= maxStartsPerTick) break;
      if (inflight >= maxInflight && !s.background) continue;
      refresh(s, 'schedule');
      started++;
      inflight++;
    }
    return started;
  }

  function start() {
    if (timer) return;
    tick();
    timer = setInterval(tick, tickMs);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  // ---------------------------------------------------------------- snapshot
  /** Seed the cache from a persisted snapshot { id: { fetchedAt, data } }; keeps the original fetchedAt. */
  function restore(snap, { maxAgeMs = 7 * 86400000 } = {}) {
    if (!snap || typeof snap !== 'object') return 0;
    const t = now();
    let n = 0;
    for (const [id, s] of Object.entries(snap)) {
      if (!byId.has(id) || !s || s.data == null || !Number.isFinite(s.fetchedAt)) continue;
      if (s.fetchedAt > t + 60000 || t - s.fetchedAt > maxAgeMs) continue;
      const e = entry(id);
      if (e.fetchedAt >= s.fetchedAt) continue;
      e.data = s.data;
      e.fetchedAt = s.fetchedAt;
      e.restored = true;
      n++;
    }
    return n;
  }

  /** Last good data per source, for data/snapshot.json. */
  function snapshot() {
    const out = {};
    for (const s of sources) {
      if (s.persist === false) continue; // ephemeral (positions of moving things): worthless after a restart
      const e = entry(s.id);
      if (e.data != null && e.fetchedAt) out[s.id] = { fetchedAt: e.fetchedAt, data: e.data };
    }
    return out;
  }

  return {
    sources, byId, cache, entry, refresh, get, envelope, row, rows, tick, start, stop, restore, snapshot,
    isActive: active,
    source: (id) => byId.get(id) || null,
    get running() { return !!timer; },
  };
}
