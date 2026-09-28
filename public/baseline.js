// "Usual for this hour": a small client cache of the server's baselines (/api/baseline, see core/baseline.mjs),
// which learn each metric's typical value per hour of the day, and per hour of the week once two or more weeks
// are recorded. usualOf(key) returns { usual, p25, p75, n, basis } or null (not learned yet), and quietly refreshes
// the cache when it is older than 10 minutes; onBaselines(fn) is called after a refresh that changed anything.
// Compare a live value with insight.vsUsual(u, value, now, opts).
const FRESH = 10 * 60e3;
const st = { at: 0, data: {}, inflight: null, supported: true, listeners: new Set() };

function refresh() {
  if (!st.supported || st.inflight || Date.now() - st.at < FRESH) return;
  st.inflight = fetch('/api/baseline', { cache: 'no-store' })
    .then((r) => { if (r.status === 404) { st.supported = false; return null; } return r.ok ? r.json() : null; })
    .then((j) => {
      st.at = Date.now();
      if (!j || !j.baselines || typeof j.baselines !== 'object') return;
      const changed = JSON.stringify(j.baselines) !== JSON.stringify(st.data);
      st.data = j.baselines;
      if (changed) for (const fn of st.listeners) { try { fn(); } catch (err) { console.error('baselines', err); } }
    })
    .catch(() => { st.at = Date.now() - FRESH + 2 * 60e3; }) // offline: try again in ~2 minutes
    .finally(() => { st.inflight = null; });
}

/** The learned baseline for a metric key at the current hour, or null. */
export function usualOf(key) {
  refresh();
  return st.data[key] || null;
}

/** Call fn after baselines change (e.g. to re-render). */
export function onBaselines(fn) { st.listeners.add(fn); refresh(); }

/** How many metrics have a baseline for this hour (0 while the dashboard is still learning). */
export const learnedCount = () => Object.keys(st.data).length;
