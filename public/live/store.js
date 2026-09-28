// Live data for the scene. Two batched polls (moving things every 10 s, everything else every 60 s) through
// /api/live; pauses while the tab is hidden and slows down when nobody has touched the page for a while, which
// keeps the free-tier edge well inside its daily request budget. Platform outputs come from /api/obs/<file>.
const FAST = ['aircraft', 'buses', 'trains', 'bridges'];
const SLOW = ['weather', 'fire911', 'radar', 'lockages', 'alerts', 'transit', 'purpleair', 'tides', 'traffic', 'cameras', 'quakes', 'bridge-odds', 'westpoint', 'incidents', 'bridge-history'];
const IDLE_AFTER = 12 * 60e3;

export function createStore() {
  const data = {}, meta = {}, subs = new Set();
  let lastInput = Date.now(), timers = {}, errors = 0, online = true;
  const obsCache = new Map();

  const emit = (ids) => { for (const fn of subs) { try { fn(ids, data); } catch (e) { console.error(e); } } };
  async function poll(ids) {
    try {
      const r = await fetch(`/api/live?ids=${ids.join(',')}`, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const got = [];
      for (const id of ids) {
        const env = (j.envelopes || {})[id];
        if (!env) continue;
        meta[id] = { fetchedAt: env.fetchedAt, stale: env.stale, error: env.error, received: Date.now() };
        if (env.data != null) { data[id] = env.data; got.push(id); }
      }
      errors = 0; online = true;
      if (got.length) emit(got);
    } catch (e) {
      errors++; online = errors < 3;
      if (!online) emit([]);
    }
  }
  function schedule(name, ids, base) {
    clearTimeout(timers[name]);
    const idle = Date.now() - lastInput > IDLE_AFTER;
    const backoff = Math.min(8, 2 ** Math.max(0, errors - 1));
    const ms = base * (idle ? 3 : 1) * backoff;
    timers[name] = setTimeout(async () => {
      if (!document.hidden) await poll(ids);
      schedule(name, ids, base);
    }, ms);
  }
  const touch = () => { lastInput = Date.now(); };
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(ev, touch, { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(FAST); poll(SLOW); } });

  return {
    data, meta,
    get: (id) => data[id] ?? null,
    online: () => online,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    async start() {
      await Promise.all([poll(FAST), poll(SLOW)]);
      schedule('fast', FAST, 10_000);
      schedule('slow', SLOW, 60_000);
    },
    refreshNow: () => Promise.all([poll(FAST), poll(SLOW)]),
    obs(name, ttl = 300_000) {
      const hit = obsCache.get(name);
      if (hit && Date.now() - hit.at < ttl) return hit.p;
      const p = fetch(`/api/obs/${name}`).then((r) => { if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`); return r.json(); });
      obsCache.set(name, { at: Date.now(), p });
      p.catch(() => obsCache.delete(name));
      return p;
    },
    async json(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); },
  };
}
