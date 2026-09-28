// Cloudflare Worker entry for the Ballard Observatory.
//   /api/obs/*   analytics outputs, proxied from the open data lake on Hugging Face (edge-cached)
//   /img         SDOT traffic-camera stills (allow-listed), proxied and cached briefly
//   /api/stream  not offered at the edge (clients poll /api/<feed>; responds 503 so EventSource clients fall back)
//   /api/*       the live API, answered by the Hub Durable Object (short edge cache)
//   /api/_push   authenticated POST from the observatory's relay for feeds that block Cloudflare egress
//   everything else: the console's static assets
export { Hub } from './hub.mjs';

const IMG_ALLOW = ['https://www.seattle.gov/trafficcams/images/'];
const OBS_OK = /^(insights\.json|relations\.json|interactions\.json|hotspots\.geojson|density\.geojson|series\.json|places\.json|place_index\.json|catalog\.json|concordance\.json|run\.json|civic\.json|nearby_quantiles\.json|places\/[0-9a-f]{2}\.json)$/;

async function cached(request, ctx, ttl, produce) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  let res = await produce();
  if (!res.ok) return res;
  res = new Response(res.body, res);
  res.headers.set('Cache-Control', `public, max-age=${ttl}`);
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    // A relay (the observatory's own always-on machine) pushes feeds that refuse Cloudflare's shared egress.
    if (p === '/api/_push') {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { Allow: 'POST' } });
      if (!env.PUSH_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.PUSH_TOKEN}`) return new Response('unauthorized', { status: 401 });
      if (Number(request.headers.get('Content-Length') || 0) > 2_000_000) return new Response('too large', { status: 413 });
      return env.HUB.get(env.HUB.idFromName('ballard')).fetch(request);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });

    if (p.startsWith('/api/obs/')) {
      const name = p.slice('/api/obs/'.length);
      if (!OBS_OK.test(name)) return new Response('not found', { status: 404 });
      return cached(request, ctx, 600, async () => {
        const r = await fetch(`${env.OBS_BASE}/${name}`, { cf: { cacheTtl: 600, cacheEverything: true } });
        if (!r.ok) return new Response(`upstream ${r.status}`, { status: 502 });
        const type = name.endsWith('.geojson') ? 'application/geo+json; charset=utf-8' : 'application/json; charset=utf-8';
        return new Response(r.body, { headers: { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' } });
      });
    }
    if (p === '/img') {
      const u = url.searchParams.get('u') || '';
      if (!IMG_ALLOW.some((a) => u.startsWith(a))) return new Response('forbidden', { status: 403 });
      return cached(request, ctx, 60, async () => {
        const r = await fetch(u, { headers: { 'User-Agent': 'BallardObservatory/1.0 (+public dashboard)', Referer: 'https://www.seattle.gov/' } });
        if (!r.ok || !/^image\//.test(r.headers.get('Content-Type') || '')) return new Response('camera unavailable', { status: 502 });
        return new Response(r.body, { headers: { 'Content-Type': r.headers.get('Content-Type') } });
      });
    }
    if (p === '/api/stream') return new Response('Live push is not offered on the edge deployment; poll /api/<feed>.', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    if (p.startsWith('/api/')) {
      const stub = env.HUB.get(env.HUB.idFromName('ballard'));
      if (p === '/api/sources' || p === '/api/activity' || p.startsWith('/api/history')) return stub.fetch(request);
      if (p === '/api/flight') return cached(request, ctx, 1800, () => stub.fetch(request));
      return cached(request, ctx, 8, () => stub.fetch(request));
    }
    return env.ASSETS.fetch(request);
  },

  // A cron heartbeat: makes sure the Hub's alarm chain is alive even if nobody visits.
  async scheduled(event, env, ctx) {
    const stub = env.HUB.get(env.HUB.idFromName('ballard'));
    ctx.waitUntil(stub.fetch('https://hub.internal/api/_tick'));
  },
};
