// Data access for the console. Platform outputs (insights, hotspots, series, places, catalog) come from
// /api/obs/<file>; live feeds come from /api/<source> and the /api/stream server-sent events.
const cache = new Map();

async function getJSON(url, { ttl = 60_000, force = false } = {}) {
  const hit = cache.get(url);
  if (!force && hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = fetch(url, { headers: { Accept: 'application/json' } }).then(async (r) => {
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  });
  cache.set(url, { at: Date.now(), promise });
  promise.catch(() => cache.delete(url));
  return promise;
}

export const obs = (name, opts) => getJSON(`/api/obs/${name}`, { ttl: 300_000, ...opts });
export const live = async (id, opts) => {
  const env = await getJSON(`/api/${id}`, { ttl: 10_000, ...opts });
  return env && env.data !== undefined ? env : { data: null };
};
export const sources = (opts) => getJSON('/api/sources', { ttl: 30_000, ...opts });

/** Several live feeds in one request: { id: envelope }. Also primes live(id). */
export async function liveMany(ids) {
  const j = await getJSON(`/api/live?ids=${ids.join(',')}`, { ttl: 10_000 });
  const out = {};
  for (const id of ids) {
    const env = (j.envelopes || {})[id] || { data: null };
    out[id] = env;
    cache.set(`/api/${id}`, { at: Date.now(), promise: Promise.resolve(env) });
  }
  return out;
}

// Live stream: one EventSource shared by all views. Subscribers get (event, data).
const subs = new Set();
let es = null;
export function subscribe(fn) {
  subs.add(fn);
  if (!es && 'EventSource' in window) {
    es = new EventSource('/api/stream');
    for (const ev of ['source', 'activity', 'metric', 'hello']) {
      es.addEventListener(ev, (e) => {
        let data = null;
        try { data = JSON.parse(e.data); } catch { return; }
        if (ev === 'source' && data && data.id) cache.delete(`/api/${data.id}`);
        for (const s of subs) { try { s(ev, data); } catch (err) { console.error(err); } }
      });
    }
    es.onerror = () => { for (const s of subs) { try { s('error', null); } catch { /* ignore */ } } };
  }
  return () => subs.delete(fn);
}
