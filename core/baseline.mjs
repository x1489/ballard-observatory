// Baselines: hourly rollups of every metric over the last 4 weeks, answering "what's usual for right now?".
// Fed from the same samples as the history store (and seeded from it at startup). Persisted to baseline.json.
//   add(key, t, v)                       one sample
//   usual(key, now) -> { usual, p25, p75, n, basis: 'hour-of-week' | 'hour-of-day' } | null
//   query(keys, now) -> { now, baselines: { key: { ...usual(), current?, ratio? } } }
import { pacificParts } from '../lib.mjs';
import { readJson, writeJsonAtomic } from './persist.mjs';

const HOUR = 3600e3;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export function createBaseline({ file = null, retentionMs = 28 * 24 * HOUR, maxKeys = 300, log = console } = {}) {
  const buckets = new Map(); // key -> Map(hourStart -> [sum, count])
  let dirty = false;

  function add(key, t, v) {
    if (!isNum(t) || !isNum(v) || typeof key !== 'string') return;
    let m = buckets.get(key);
    if (!m) { if (buckets.size >= maxKeys) return; m = new Map(); buckets.set(key, m); }
    const h = Math.floor(t / HOUR) * HOUR;
    const b = m.get(h);
    if (b) { b[0] += v; b[1] += 1; } else m.set(h, [v, 1]);
    dirty = true;
  }

  function prune(now = Date.now()) {
    const cut = now - retentionMs;
    for (const m of buckets.values()) for (const h of m.keys()) if (h < cut) m.delete(h);
  }

  function usual(key, now = Date.now()) {
    const m = buckets.get(key);
    if (!m) return null;
    const p = pacificParts(now);
    const thisHour = Math.floor(now / HOUR) * HOUR;
    const sameWeek = [], sameDay = [];
    for (const [h, [s, n]] of m) {
      if (h >= thisHour - HOUR) continue; // only completed hours, not the one we're in
      const q = pacificParts(h + HOUR / 2);
      if (q.hh !== p.hh) continue;
      const mean = s / n;
      sameDay.push(mean);
      if (q.weekday === p.weekday) sameWeek.push(mean);
    }
    const use = sameWeek.length >= 2 ? sameWeek : sameDay;
    if (!use.length) return null;
    const sorted = use.slice().sort((a, b) => a - b);
    return { usual: quantile(sorted, 0.5), p25: quantile(sorted, 0.25), p75: quantile(sorted, 0.75), n: use.length, basis: use === sameWeek ? 'hour-of-week' : 'hour-of-day' };
  }

  function query(keys, now = Date.now(), current = () => null) {
    const out = {};
    for (const k of keys) {
      const u = usual(k, now);
      if (!u) continue;
      const cur = current(k);
      out[k] = { ...u, ...(isNum(cur) ? { current: cur, ratio: u.usual ? cur / u.usual : null } : {}) };
    }
    return { now, baselines: out };
  }

  function seed(series) { // { key: [[t, v], ...] } from the history store
    for (const [k, arr] of Object.entries(series || {})) for (const [t, v] of arr) add(k, t, v);
  }

  function load() {
    if (!file) return;
    const j = readJson(file, null, log);
    if (!j || !j.b) return;
    for (const [k, rows] of Object.entries(j.b)) {
      const m = new Map();
      for (const [h, s, n] of rows) if (isNum(h) && isNum(s) && isNum(n) && n > 0) m.set(h, [s, n]);
      if (m.size) buckets.set(k, m);
    }
    prune();
  }

  function save() {
    if (!file || !dirty) return;
    prune();
    const b = {};
    for (const [k, m] of buckets) b[k] = [...m.entries()].map(([h, [s, n]]) => [h, Math.round(s * 1000) / 1000, n]);
    try { writeJsonAtomic(file, { v: 1, savedAt: Date.now(), b }); dirty = false; } catch (err) { log.warn(`[baseline] save failed: ${err && err.message || err}`); }
  }

  return { add, usual, query, seed, load, save, prune, keys: () => [...buckets.keys()], _buckets: buckets };
}
