// Time-series store for source metrics: one ascending [[t, v], ...] array per key, at most one sample per
// calendar minute per key, 48 h retention, a cap on the number of keys, persisted to data/history.json.
import { readJson, writeJsonAtomic } from './persist.mjs';

const MIN = 60000;
const HOUR = 3600000;
export const KEY_RE = /^[A-Za-z0-9_][\w.:-]{0,99}$/;

/** Numbers only (booleans become 0/1); everything else, including NaN/Infinity, is rejected with null. */
function normValue(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.round(v * 1e4) / 1e4;
}

/** Index of the first sample with t >= cutoff (binary search). */
function lowerBound(arr, cutoff) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][0] < cutoff) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Thin to at most n points: the last sample of each of n equal-count buckets (always keeps the newest). */
function thin(arr, n) {
  if (!(n >= 2) || arr.length <= n) return arr;
  const out = [];
  const step = arr.length / n;
  for (let i = 1; i <= n; i++) out.push(arr[Math.min(arr.length - 1, Math.round(i * step) - 1)]);
  return out;
}

export function createHistory({
  file = null,
  retentionMs = 48 * HOUR,
  resolutionMs = MIN,
  maxKeys = 256,
  saveEveryMs = 5 * MIN,
  now = Date.now,
  log = console,
} = {}) {
  const series = new Map(); // key -> [[t, v], ...] ascending by t
  const maxPoints = Math.ceil(retentionMs / resolutionMs) + 2;
  const refusedKeys = new Set();
  let dirty = false;
  let timer = null;

  const bucket = (t) => Math.floor(t / resolutionMs);

  function prune(arr, cutoff) {
    const i = lowerBound(arr, cutoff);
    if (i) arr.splice(0, i);
    if (arr.length > maxPoints) arr.splice(0, arr.length - maxPoints);
  }

  /**
   * Record one value. Returns { key, t, v } when this starts a new sample (a new minute for the key), or null
   * when it only updated the current minute's sample in place or was rejected (bad key, non-number, out of order).
   */
  function append(key, value, t = now()) {
    if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
    const v = normValue(value);
    t = Number(t);
    if (v == null || !Number.isFinite(t)) return null;
    let arr = series.get(key);
    if (!arr) {
      if (series.size >= maxKeys) {
        if (!refusedKeys.has(key) && refusedKeys.size < 50) { refusedKeys.add(key); log.warn(`[history] key limit (${maxKeys}) reached; ignoring '${key}'`); }
        return null;
      }
      arr = [];
      series.set(key, arr);
    }
    const last = arr[arr.length - 1];
    if (last && t < last[0]) return null; // out of order
    dirty = true;
    if (last && bucket(t) === bucket(last[0])) { last[0] = t; last[1] = v; return null; }
    arr.push([t, v]);
    prune(arr, now() - retentionMs);
    return { key, t, v };
  }

  /** Record every numeric entry of a metrics object ({ 'weather.tempF': 54.1, ... }). Returns the new samples. */
  function appendMany(obj, t = now()) {
    const out = [];
    if (!obj || typeof obj !== 'object') return out;
    for (const [k, v] of Object.entries(obj)) {
      const s = append(k, v, t);
      if (s) out.push(s);
    }
    return out;
  }

  /** Samples for one key over the last `hours` (copies). */
  function get(key, hours = retentionMs / HOUR, points) {
    const arr = series.get(key);
    if (!arr) return [];
    const h = Math.max(0, Math.min(Number(hours) || 0, retentionMs / HOUR));
    const from = lowerBound(arr, now() - h * HOUR);
    return thin(arr.slice(from), points).map((p) => [p[0], p[1]]);
  }

  /** { series: { key: [[t, v], ...] }, keys: [all known keys] }. keys empty/omitted = every key. */
  function query(keys, hours = 24, points) {
    const want = Array.isArray(keys) && keys.length ? keys : [...series.keys()];
    const out = {};
    for (const k of want) out[k] = get(k, hours, points);
    return { series: out, keys: [...series.keys()].sort() };
  }

  const latest = (key) => { const arr = series.get(key); const p = arr && arr[arr.length - 1]; return p ? [p[0], p[1]] : null; };

  /** The sample nearest to time t, if one lies within toleranceMs of it; else null. */
  function at(key, t, toleranceMs = 15 * MIN) {
    const arr = series.get(key);
    if (!arr || !arr.length) return null;
    const i = lowerBound(arr, t);
    let best = null;
    for (const j of [i - 1, i]) {
      const p = arr[j];
      if (p && Math.abs(p[0] - t) <= toleranceMs && (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t))) best = p;
    }
    return best ? [best[0], best[1]] : null;
  }

  function pruneAll() {
    const cutoff = now() - retentionMs;
    for (const [k, arr] of series) {
      prune(arr, cutoff);
      if (!arr.length) series.delete(k);
    }
  }

  function toJSON() {
    pruneAll();
    return { v: 1, savedAt: now(), resolutionMs, series: Object.fromEntries(series) };
  }

  /** Write the file (atomically) if anything changed since the last save, or always with force. */
  function save(force = false) {
    if (!file || (!dirty && !force)) return false;
    writeJsonAtomic(file, toJSON());
    dirty = false;
    return true;
  }

  /** Load from the file (or a given object): validates, sorts, drops expired samples, keeps 1 per minute. */
  function load(obj = file ? readJson(file, null, log) : null) {
    series.clear();
    if (!obj || typeof obj !== 'object' || !obj.series || typeof obj.series !== 'object') return 0;
    const cutoff = now() - retentionMs;
    let n = 0;
    for (const [k, raw] of Object.entries(obj.series)) {
      if (!KEY_RE.test(k) || !Array.isArray(raw) || series.size >= maxKeys) continue;
      const pts = raw.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] >= cutoff)
        .map((p) => [p[0], p[1]]).sort((a, b) => a[0] - b[0]);
      const arr = [];
      for (const p of pts) {
        const last = arr[arr.length - 1];
        if (last && bucket(last[0]) === bucket(p[0])) arr[arr.length - 1] = p; else arr.push(p);
      }
      if (arr.length > maxPoints) arr.splice(0, arr.length - maxPoints);
      if (arr.length) { series.set(k, arr); n += arr.length; }
    }
    dirty = false;
    return n;
  }

  function start() {
    if (timer || !file) return;
    timer = setInterval(() => {
      try { save(); } catch (e) { log.error(`[history] save failed: ${e.message}`); }
    }, saveEveryMs);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  /** Read-only view handed to detectors as ctx.history. */
  const reader = Object.freeze({ get, latest, at, keys: () => [...series.keys()].sort() });

  return {
    append, appendMany, get, query, latest, at, save, load, start, stop, reader, toJSON,
    keys: () => [...series.keys()].sort(),
    get size() { let n = 0; for (const a of series.values()) n += a.length; return n; },
    get dirty() { return dirty; },
  };
}
