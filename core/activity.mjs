// Activity log: typed events emitted by source detectors. Deduped by key (a key seen in the last 7 days is
// dropped), newest 500 kept, persisted to data/activity.json (debounced).
import { readJson, writeJsonAtomic, throttledSaver } from './persist.mjs';

const DAY = 86400000;
export const KINDS = ['bridge', 'fire', 'weather', 'alert', 'transit', 'news', 'social', 'power', 'air', 'quake', 'locks', 'traffic', 'event', 'wildlife', 'aircraft', 'water', 'sky', 'civic'];
export const SEVERITIES = ['info', 'notice', 'warn', 'alert'];

const str = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : '');

/** Newest first; ties keep insertion order (newer insert first). */
const cmp = (a, b) => b.t - a.t;

/**
 * Run a source's detector, containing every failure: a throw, a rejected promise, a non-array result or a
 * detector that never settles (timeoutMs) all yield []. Never throws.
 */
export async function runDetector(src, prev, next, ctx, { log = console, timeoutMs = 5000 } = {}) {
  if (!src || typeof src.detect !== 'function') return [];
  let timer;
  try {
    let out = src.detect(prev, next, ctx);
    if (out && typeof out.then === 'function') {
      out = await Promise.race([out, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs); })]);
    }
    if (out == null) return [];
    return Array.isArray(out) ? out : [out];
  } catch (e) {
    log.warn(`[detect] ${src.id}: ${e && e.message || e}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export function createActivity({
  file = null,
  max = 500,
  dedupeMs = 7 * DAY,
  maxSeen = 20000,
  maxPerBatch = 20,
  saveDebounceMs = 2000,
  now = Date.now,
  log = console,
} = {}) {
  let items = []; // newest first by t
  const seen = new Map(); // key -> last time it was emitted (Map order = least recently emitted first)
  let seq = 0;
  const saver = throttledSaver(() => save(), saveDebounceMs, { name: 'activity', log });

  function pruneSeen(n) {
    for (const [k, at] of seen) {
      if (n - at <= dedupeMs && seen.size <= maxSeen) break;
      seen.delete(k);
    }
  }

  /** Validate and normalize a draft into an activity item (assigns id; defaults t, source, kind, severity). */
  function normalize(d, sourceId, n) {
    if (!d || typeof d !== 'object') return null;
    const title = str(d.title, 200);
    if (!title) return null;
    const source = str(d.source, 60) || sourceId || 'unknown';
    const kind = str(d.kind, 30) || 'civic';
    const severity = SEVERITIES.includes(d.severity) ? d.severity : 'info';
    let t = typeof d.t === 'string' ? Date.parse(d.t) : Number(d.t);
    if (!Number.isFinite(t) || t <= 0) t = n;
    const key = str(d.key, 300) || `${source}:${kind}:${title}`;
    const it = { id: `${n.toString(36)}-${(seq++).toString(36)}`, key, t, source, kind, severity, title };
    const detail = str(d.detail, 1000);
    if (detail) it.detail = detail;
    if (typeof d.link === 'string' && /^https?:\/\//i.test(d.link)) it.link = d.link.slice(0, 1000);
    if (Number.isFinite(d.lat) && Number.isFinite(d.lon)) { it.lat = d.lat; it.lon = d.lon; }
    return it;
  }

  /**
   * Add detector drafts. Returns the items actually added (oldest first, ready to broadcast in order).
   * Drafts whose key was emitted within dedupeMs are dropped (and their key's clock refreshed, so a condition
   * a detector keeps reporting never re-fires). seedOnly records the keys without adding items (first load).
   * At most maxPerBatch items (the newest) are added per call, so one refresh can never flood the log.
   */
  function add(drafts, { sourceId, seedOnly = false } = {}) {
    if (!Array.isArray(drafts)) drafts = drafts ? [drafts] : [];
    const n = now();
    pruneSeen(n);
    let fresh = [];
    let touched = false;
    for (const d of drafts) {
      const it = normalize(d, sourceId, n);
      if (!it) continue;
      const last = seen.get(it.key);
      seen.delete(it.key);
      seen.set(it.key, n);
      touched = true;
      if (seedOnly || (last != null && n - last <= dedupeMs)) continue;
      fresh.push(it);
    }
    if (fresh.length > maxPerBatch) {
      fresh.sort(cmp);
      log.warn(`[activity] ${sourceId || '?'}: ${fresh.length} new items in one refresh; keeping the newest ${maxPerBatch}`);
      fresh = fresh.slice(0, maxPerBatch);
    }
    const added = [];
    for (const it of fresh) {
      // Insert keeping items sorted newest first (after any items with the same t).
      let lo = 0, hi = items.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (items[mid].t >= it.t) lo = mid + 1; else hi = mid; }
      if (lo >= max) continue; // older than everything we keep
      items.splice(lo, 0, it);
      if (items.length > max) items.length = max;
      added.push(it);
    }
    if (touched) saver.mark();
    return added.filter((it) => items.includes(it)).sort((a, b) => a.t - b.t);
  }

  /** Newest first. since: only items with t > since. */
  function list({ limit = 200, since } = {}) {
    limit = Math.max(1, Math.min(max, Math.floor(Number(limit)) || 200));
    const s = Number(since);
    const src = Number.isFinite(s) ? items.filter((it) => it.t > s) : items;
    return src.slice(0, limit);
  }

  function toJSON() {
    pruneSeen(now());
    return { v: 1, savedAt: now(), items, seen: [...seen] };
  }

  function save() {
    if (!file) return false;
    writeJsonAtomic(file, toJSON());
    return true;
  }

  function load(obj = file ? readJson(file, null, log) : null) {
    items = [];
    seen.clear();
    if (!obj || typeof obj !== 'object') return 0;
    const n = now();
    const loaded = [];
    for (const raw of Array.isArray(obj.items) ? obj.items : []) {
      const it = normalize(raw, raw && raw.source, n);
      if (!it) continue;
      if (typeof raw.id === 'string' && raw.id) it.id = raw.id.slice(0, 60);
      loaded.push(it);
    }
    loaded.sort(cmp);
    items = loaded.slice(0, max);
    const entries = (Array.isArray(obj.seen) ? obj.seen : [])
      .filter((e) => Array.isArray(e) && typeof e[0] === 'string' && Number.isFinite(e[1]) && n - e[1] <= dedupeMs)
      .sort((a, b) => a[1] - b[1]);
    for (const [k, at] of entries) seen.set(k, at);
    // Items always count as seen, even if the seen list was lost.
    for (const it of items) if (!seen.has(it.key)) seen.set(it.key, n);
    pruneSeen(n);
    return items.length;
  }

  return {
    add, list, save, load, toJSON, normalize,
    flush: () => saver.flush(),
    stop: () => saver.cancel(),
    get size() { return items.length; },
    get seenSize() { return seen.size; },
  };
}
