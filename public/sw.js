// Ballard Live service worker: an offline shell plus the last good copy of each data response.
// - Page code (HTML/JS/CSS/manifest): network first, so updates apply on the next load; the cache is the offline fallback.
// - /api/* (except the stream): network first; the last 200 response per URL is kept, and served when the server is
//   unreachable (the page's own freshness labels then show how old it is). Clients get {type:'bl-offline'|'bl-online'}.
// - /api/stream, /img (camera stills) and /cam/* (immutable time-lapse frames; the HTTP cache keeps them) are never
//   intercepted, so stories never fill the offline cache with images.
// - Leaflet (unpkg) and Google Fonts: cache first.
const VERSION = 'v3-2';
const SHELL = `bl-shell-${VERSION}`, DATA = `bl-data-${VERSION}`, CDN = `bl-cdn-${VERSION}`;
const PRECACHE = [
  '/', '/style.css', '/core.css', '/app.js', '/core.js', '/cards.js', '/map.js', '/util.js', '/glance.js', '/headsup.js', '/health.js',
  '/features/index.js', '/features/activity.js', '/features/activity.css', '/features/summary.js', '/features/summary.css',
  '/features/notify.js', '/features/notify.css', '/features/prefs.js', '/features/prefs.css', '/features/kiosk.js', '/features/kiosk.css',
  '/features/shortcuts.js', '/features/shortcuts.css', '/features/trends.js', '/features/extra-cards.js',
  '/icons.js', '/insight.js', '/baseline.js', '/features/hero.js', '/features/hero.css', '/features/ask.js', '/features/ask.css',
  '/features/stories.js', '/features/stories.css', '/features/foryou.js', '/features/foryou.css',
  '/features/replay.js', '/features/replay.css', '/features/share.js', '/features/share.css',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.all(PRECACHE.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (![SHELL, DATA, CDN].includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

let offline = false;
async function tell(type, extra = {}) {
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type, ...extra });
}

async function apiFirst(req) {
  const cache = await caches.open(DATA);
  try {
    const res = await fetch(req);
    if (res.status === 200) cache.put(req, res.clone()).catch(() => {});
    if (offline) { offline = false; tell('bl-online'); }
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) {
      if (!offline) { offline = true; tell('bl-offline', { savedAt: Date.parse(hit.headers.get('date') || '') || null }); }
      return hit;
    }
    throw err;
  }
}

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.status === 200 && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = (await cache.match(req)) || (await cache.match(req, { ignoreSearch: true }));
    if (hit) return hit;
    if (req.mode === 'navigate') { const home = await cache.match('/'); if (home) return home; }
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CDN);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone()).catch(() => {});
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname === '/api/stream' || url.pathname === '/img' || url.pathname === '/sw.js' || url.pathname.startsWith('/cam/')) return;
    e.respondWith(url.pathname.startsWith('/api/') ? apiFirst(req) : networkFirst(req));
    return;
  }
  if (/^(unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(url.hostname)) e.respondWith(cacheFirst(req));
});
