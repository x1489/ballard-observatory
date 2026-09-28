// The real-time layer on Cloudflare: one Durable Object ("Hub") runs every live source on an alarm-driven
// scheduler, keeps the latest envelope per source, the activity log and 48 h of metric history in its SQLite
// storage, and answers the live API. Designed for the Workers Free plan:
//   - at most MAX_PER_ALARM sources refresh per alarm (external subrequests are capped at 50 per invocation)
//   - sources slow to their idle rate when nobody has asked for data in the last ACTIVE_MS
//   - storage writes are batched and change-only (well under the 100k rows/day limit)
import { DurableObject } from 'cloudflare:workers';
import { loadSources } from './gen/sources/index.mjs';
import { dueAt, isStale, isFresh, expiresAt, idleTtlOf } from './gen/core/scheduler.mjs';
import { createActivity, runDetector } from './gen/core/activity.mjs';
import { createHistory } from './gen/core/history.mjs';
import { __state, __stateDirty } from './gen/lib.mjs';
import { lookupFlight } from './gen/sources/lookup.mjs';
import { Push, TOPICS } from './push.mjs';

const MAX_PER_ALARM = 6;
const ACTIVE_MS = 10 * 60e3;
const HISTORY_PERSIST_MS = 10 * 60e3;
const FETCH_TIMEOUT_MS = 25_000;
const MAX_PREV_AGE_MS = 6 * 3600e3;

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ...headers } });

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.inflight = new Map();
    this.pushedAt = new Map(); // source id -> last relay push
    this.push = new Push(ctx.storage, env);
    this.dirty = new Set();
    this.lastHistoryPersist = 0;
    this.histPersisted = new Map(); // key -> last t persisted
    ctx.blockConcurrencyWhile(() => this.init());
  }

  async init() {
    const { sources, loadErrors } = await loadSources();
    this.sources = sources;
    this.loadErrors = loadErrors;
    this.byId = new Map(sources.map((s) => [s.id, s]));
    this.entries = new Map();
    const st = this.ctx.storage;
    for (const [k, v] of await st.list({ prefix: 'e:' })) this.entries.set(k.slice(2), { ...v, restored: true });
    for (const [k, v] of await st.list({ prefix: 's:' })) __state.set(k.slice(2), v);
    const meta = await st.get(['activity', 'lastRequest', 'startedAt']);
    this.activity = createActivity({ max: 500, log: console });
    this.activity.load(meta.get('activity') || null);
    this.history = createHistory({ log: console });
    const series = {};
    for (const [k, v] of await st.list({ prefix: 'h:' })) { series[k.slice(2)] = v; this.histPersisted.set(k.slice(2), v.length ? v[v.length - 1][0] : 0); }
    this.history.load({ series });
    this.lastRequest = meta.get('lastRequest') || 0;
    this.startedAt = meta.get('startedAt') || Date.now();
    if (!meta.get('startedAt')) await st.put('startedAt', this.startedAt);
    if (!(await st.getAlarm())) await st.setAlarm(Date.now() + 500);
  }

  active(now = Date.now()) { return now - this.lastRequest < ACTIVE_MS; }

  entry(id) { let e = this.entries.get(id); if (!e) { e = { data: null, fetchedAt: null, error: null, errorAt: null, ms: null, ok: 0, fail: 0 }; this.entries.set(id, e); } return e; }

  envelope(src, e = this.entry(src.id), t = Date.now()) {
    return { id: src.id, title: src.title, ttl: src.ttl, fetchedAt: e.fetchedAt || null, expiresAt: expiresAt(src, e), stale: isStale(src, e, t), error: e.error, data: e.data };
  }

  row(s, t = Date.now()) {
    const e = this.entry(s.id);
    return { id: s.id, title: s.title, group: s.group, ttl: s.ttl, idleTtl: idleTtlOf(s), daily: !!s.daily, background: !!s.background,
      fetchedAt: e.fetchedAt || null, expiresAt: expiresAt(s, e), stale: isStale(s, e, t), restored: !!e.restored, error: e.error,
      errorAt: e.errorAt || null, ms: e.ms, ok: e.ok || 0, fail: e.fail || 0, hasMetrics: typeof s.metrics === 'function', hasDetect: typeof s.detect === 'function' };
  }

  /** Store fresh data for a source (fetched here or pushed by the relay): metrics, detectors, persistence. */
  async accept(src, data, fetchedAt, ms = null) {
    const e = this.entry(src.id);
    const prev = e.data, prevFetchedAt = e.fetchedAt, restored = !!e.restored;
    const ne = { data, fetchedAt, error: null, errorAt: null, ms, ok: (e.ok || 0) + 1, fail: e.fail || 0 };
    this.entries.set(src.id, ne);
    this.dirty.add(src.id);
    try { await this.push.observe(src.id, restored ? null : prev, data); } catch (err) { console.warn('[push] observe', err && err.message); }
    if (typeof src.metrics === 'function') {
      try { this.history.appendMany(src.metrics(data), ne.fetchedAt); } catch (err) { console.warn(`[metrics] ${src.id}: ${err && err.message}`); }
    }
    if (typeof src.detect === 'function') {
      const prevTooOld = restored && prevFetchedAt && ne.fetchedAt - prevFetchedAt > Math.max(MAX_PREV_AGE_MS, 2 * (idleTtlOf(src) ?? src.ttl) * 1000);
      const firstLoad = prev == null || !!prevTooOld;
      const ctx = { now: ne.fetchedAt, sourceId: src.id, firstLoad, restored, prevFetchedAt: prevFetchedAt || null,
        history: this.history.reader, data: (id) => (this.entries.get(id) || {}).data ?? null };
      const drafts = await runDetector(src, firstLoad ? null : prev, data, ctx, { timeoutMs: 5000 });
      if (drafts.length) { this.activity.add(drafts, { sourceId: src.id, seedOnly: firstLoad }); this.activityDirty = true; }
    }
  }

  /** A relay pushed this source recently enough that fetching it here (and being refused) is pointless. */
  relayed(src, now = Date.now()) {
    const t = this.pushedAt.get(src.id);
    return !!t && now - t < Math.max(60_000, 3 * (src.ttl || 15) * 1000);
  }

  refresh(src) {
    if (this.inflight.has(src.id)) return this.inflight.get(src.id);
    if (this.relayed(src)) return Promise.resolve();
    const p = (async () => {
      const e = this.entry(src.id);
      const prev = e.data, prevFetchedAt = e.fetchedAt;
      const t0 = Date.now();
      try {
        const data = await withTimeout(Promise.resolve(src.fetch({ prev, fetchedAt: prevFetchedAt })), src.deadlineMs || FETCH_TIMEOUT_MS, src.id);
        await this.accept(src, data, Date.now(), Date.now() - t0);
      } catch (err) {
        this.entries.set(src.id, { ...e, restored: false, error: String((err && err.message) || err).slice(0, 300), errorAt: Date.now(), ms: Date.now() - t0, fail: (e.fail || 0) + 1 });
        this.dirty.add(src.id);
      }
    })().finally(() => this.inflight.delete(src.id));
    this.inflight.set(src.id, p);
    return p;
  }

  async persist(force = false) {
    const st = this.ctx.storage;
    const puts = {};
    for (const id of this.dirty) {
      if ((this.byId.get(id) || {}).persist === false) continue; // ephemeral positions: not worth a storage row
      const { restored, ...e } = this.entries.get(id) || {}; puts[`e:${id}`] = e;
    }
    this.dirty.clear();
    if (this.activityDirty) { puts.activity = this.activity.toJSON(); this.activityDirty = false; }
    if (__stateDirty.v) { for (const [k, v] of __state) puts[`s:${k}`] = v; __stateDirty.v = false; }
    const now = Date.now();
    if (force || now - this.lastHistoryPersist > HISTORY_PERSIST_MS) {
      const snap = this.history.toJSON().series;
      for (const [k, arr] of Object.entries(snap)) {
        const last = arr.length ? arr[arr.length - 1][0] : 0;
        if (this.histPersisted.get(k) !== last) { puts[`h:${k}`] = arr; this.histPersisted.set(k, last); }
      }
      this.lastHistoryPersist = now;
    }
    const keys = Object.keys(puts);
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = Object.fromEntries(keys.slice(i, i + 100).map((k) => [k, puts[k]]));
      await st.put(chunk);
    }
  }

  async alarm() {
    const now = Date.now();
    const active = this.active(now);
    const due = [];
    for (const s of this.sources) {
      if (this.inflight.has(s.id) || this.relayed(s, now)) continue;
      const d = dueAt(s, this.entry(s.id), { active, now });
      if (d <= now) due.push([d, s]);
    }
    due.sort((a, b) => (b[1].background ? 1 : 0) - (a[1].background ? 1 : 0) || a[0] - b[0]);
    const batch = due.slice(0, MAX_PER_ALARM).map(([, s]) => s);
    await Promise.allSettled(batch.map((s) => this.refresh(s)));
    if (this.push.pending()) { try { await this.push.drain(); } catch (err) { console.warn('[push] drain', err && err.message); } }
    try { await this.persist(); } catch (err) { console.error('[persist]', err && err.message); }
    const t = Date.now();
    let next = t + 5 * 60e3;
    for (const s of this.sources) if (!this.relayed(s, t)) next = Math.min(next, dueAt(s, this.entry(s.id), { active: this.active(t), now: t }));
    const floor = due.length > batch.length || this.push.pending() ? 250 : 1500;
    await this.ctx.storage.setAlarm(Math.max(t + floor, next));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/^\/api\//, '');
    const now = Date.now();
    const user = p !== '_tick' && p !== '_push';
    if (user && now - this.lastRequest > 60_000) { this.lastRequest = now; this.ctx.storage.put('lastRequest', now); } else if (user) this.lastRequest = now;
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(now + 500);
    if (p === '_tick') return json({ ok: true, alarm: await this.ctx.storage.getAlarm() });
    if (p === '_push' && request.method === 'POST') {
      // Feeds that refuse Cloudflare's shared egress (community ADS-B aggregators, CelesTrak) arrive from the relay.
      const PUSHABLE = new Set(['aircraft', 'satellites']);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const took = [];
      for (const it of (body && body.sources) || []) {
        const src = this.byId.get(it && it.id);
        if (!src || !PUSHABLE.has(src.id) || it.data == null || !Number.isFinite(it.fetchedAt)) continue;
        if (it.fetchedAt > now + 60_000 || now - it.fetchedAt > 10 * 60e3) continue; // clock skew or stale
        const e = this.entry(src.id);
        this.pushedAt.set(src.id, now);
        if (e.fetchedAt && it.fetchedAt <= e.fetchedAt) continue;
        await this.accept(src, it.data, it.fetchedAt);
        took.push(src.id);
      }
      this.ctx.waitUntil(this.persist().catch(() => {}));
      return json({ ok: true, took, active: now - this.lastRequest < ACTIVE_MS && this.lastRequest > 0 });
    }
    if (p === 'push/key') {
      const v = this.push.vapid();
      return v ? json({ publicKey: v.publicKey, topics: TOPICS }) : json({ error: 'alerts not configured' }, 404);
    }
    if ((p === 'push/subscribe' || p === 'push/status' || p === 'push/test') && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (p === 'push/status') return json(await this.push.status(body && body.endpoint));
      if (p === 'push/test') { const r = await this.push.test(body && body.endpoint); return json(r, r.status || 200); }
      const r = await this.push.subscribe(body);
      return json(r, r.status || 200);
    }
    if (p === 'sources') return json({ now, loadErrors: this.loadErrors, sources: this.sources.map((s) => this.row(s, now)), clients: 0, active: this.active(now), edge: true, startedAt: this.startedAt });
    if (p === 'activity') {
      const limit = Number(url.searchParams.get('limit')) || 200;
      const since = url.searchParams.get('since');
      return json({ items: this.activity.list({ limit, since: since == null ? undefined : Number(since) }) });
    }
    if (p === 'history') {
      const keys = (url.searchParams.get('keys') || '').split(',').map((k) => k.trim()).filter(Boolean).slice(0, 200);
      const hours = Number(url.searchParams.get('hours')) || 24;
      const points = Math.floor(Number(url.searchParams.get('points')) || 0);
      return json(this.history.query(keys, hours, points >= 2 ? Math.min(points, 5000) : undefined));
    }
    if (p === 'live') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter((id) => this.byId.has(id)).slice(0, 20);
      const out = {};
      for (const id of ids) out[id] = this.envelope(this.byId.get(id));
      return json({ now, envelopes: out });
    }
    if (p === 'flight') {
      // Aircraft enrichment for the tracking card; cached in this object's storage (one row per new key).
      const st = this.ctx.storage;
      const cache = {
        get: async (k) => { const e = await st.get(`lk:${k}`); return e && e.exp > Date.now() ? e.v : undefined; },
        set: async (k, v, ttl) => { await st.put(`lk:${k}`, { v, exp: Date.now() + ttl }); },
      };
      return json(await lookupFlight({ callsign: url.searchParams.get('callsign'), hex: url.searchParams.get('hex') }, cache));
    }
    if (p === 'cams') return json({ cameras: [] });
    if (p === 'baseline') return json({ now, baselines: {} });
    const src = this.byId.get(p);
    if (!src) return json({ error: 'not found' }, 404);
    const e = this.entry(src.id);
    if (!e.fetchedAt || !isFresh(src, e, now)) {
      // on-demand refresh (bounded wait) so a first visitor never sees an empty feed
      try { await withTimeout(this.refresh(src), 12_000, src.id); } catch { /* serve what we have */ }
      this.ctx.waitUntil(this.persist().catch(() => {}));
    }
    return json(this.envelope(src));
  }
}
