// Relay: this machine pushes the feeds that refuse Cloudflare's shared egress (community ADS-B aggregators rate-limit
// or block Workers; CelesTrak often times out) to the hosted edge, so the hosted app has live aircraft too.
// Enabled by data/edge-push.json (gitignored): { "url": "https://<worker>/api/_push", "token": "<PUSH_TOKEN>" }.
// Aircraft are kept fresh every 12 s while someone is watching the hosted app, every 30 s otherwise.
import fs from 'node:fs';
import path from 'node:path';

export const RELAYED = new Set(['aircraft', 'satellites']);

export function createRelay({ scheduler, dataDir, log = console, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'edge-push.json'), 'utf8')); } catch { cfg = null; }
  if (!cfg || !cfg.url || !cfg.token) return { enabled: false, push() {}, stop() {} };
  let edgeActiveUntil = 0, failures = 0;
  const last = {};

  async function send(id, e) {
    try {
      const r = await fetchImpl(cfg.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({ sources: [{ id, fetchedAt: e.fetchedAt, data: e.data }] }), signal: AbortSignal.timeout(15000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      edgeActiveUntil = j.active ? now() + 90_000 : 0;
      failures = 0;
    } catch (err) {
      if (++failures <= 3 || failures % 50 === 0) log.warn(`[relay] ${id}: ${err && err.message || err}`);
    }
  }
  function push(src, e) {
    if (!src || !RELAYED.has(src.id) || !e || e.data == null) return;
    if (now() - (last[src.id] || 0) < 8000) return;
    last[src.id] = now();
    send(src.id, e);
  }
  const timer = setInterval(() => {
    const e = scheduler.entry('aircraft');
    const want = now() < edgeActiveUntil ? 12_000 : 30_000;
    if (!e.inflight && now() - (e.fetchedAt || 0) >= want) scheduler.refresh('aircraft', 'relay');
    else if (e.data != null && now() - (last.aircraft || 0) >= want) push({ id: 'aircraft' }, e);
    const s = scheduler.entry('satellites');
    if (s.data != null && now() - (last.satellites || 0) > 3 * 3600e3) push({ id: 'satellites' }, s);
  }, 4000);
  if (timer.unref) timer.unref();
  log.info?.(`[relay] pushing ${[...RELAYED].join(', ')} to ${new URL(cfg.url).host}`);
  return { enabled: true, push, stop() { clearInterval(timer); }, get edgeActive() { return now() < edgeActiveUntil; } };
}
