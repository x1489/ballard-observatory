// On-demand enrichment for a tapped aircraft (the Flighty-style card): the flight's route from its callsign and the
// airframe (type, registration) from its ICAO address, via adsbdb.com (free community API), and a photo of that
// airframe from planespotters.net (credited, linked). Cached hard: one upstream request per key per day at most.
// Registered owners are deliberately not returned: many are private individuals.
import { get } from '../lib.mjs';

const H = 3600e3;
const CS_RE = /^[A-Z0-9]{2,8}$/;
const HEX_RE = /^[0-9a-f]{6}$/;

function airport(a) {
  if (!a) return null;
  return { iata: a.iata_code || null, icao: a.icao_code || null, name: a.name || null, city: a.municipality || null,
    country: a.country_iso_name || null, lat: Number.isFinite(a.latitude) ? a.latitude : null, lon: Number.isFinite(a.longitude) ? a.longitude : null };
}
export function parseRoute(j) {
  const r = j && j.response && j.response.flightroute;
  if (!r || !r.origin || !r.destination) return null;
  return { callsign: r.callsign || null, iata: r.callsign_iata || null, airline: r.airline ? { name: r.airline.name || null, iata: r.airline.iata || null, icao: r.airline.icao || null, callsign: r.airline.callsign || null } : null,
    origin: airport(r.origin), destination: airport(r.destination) };
}
export function parseAircraft(j) {
  const a = j && j.response && j.response.aircraft;
  if (!a || typeof a !== 'object') return null;
  return { type: a.type || null, icaoType: a.icao_type || null, manufacturer: a.manufacturer || null, registration: a.registration || null,
    country: a.registered_owner_country_name || null, operatorCode: a.registered_owner_operator_flag_code || null };
}
export function parsePhoto(j) {
  const p = j && Array.isArray(j.photos) && j.photos[0];
  if (!p || !p.thumbnail_large || !p.thumbnail_large.src) return null;
  return { src: p.thumbnail_large.src, w: p.thumbnail_large.size && p.thumbnail_large.size.width, h: p.thumbnail_large.size && p.thumbnail_large.size.height,
    link: p.link || null, credit: p.photographer || null, source: 'planespotters.net' };
}

/**
 * cache: { get(key) -> value | undefined (may be async), set(key, value, ttlMs) }. Misses (404s) are cached too.
 * Returns { callsign, hex, route, aircraft, photo, t }.
 */
export async function lookupFlight({ callsign, hex } = {}, cache, fetchJson = (u) => get(u, { timeout: 8000, retries: 0, headers: { Accept: 'application/json' } })) {
  const cs = String(callsign || '').trim().toUpperCase();
  const hx = String(hex || '').trim().toLowerCase().replace(/^~/, '');
  const one = async (key, url, parse, ttl) => {
    const hit = await cache.get(key);
    if (hit !== undefined) return hit;
    let v = null, ttlUse = ttl;
    try { v = parse(await fetchJson(url)); } catch (e) {
      if (e && e.status === 404) v = null; else { ttlUse = 10 * 60e3; v = null; } // transient: retry in 10 minutes
    }
    await cache.set(key, v, v ? ttlUse : Math.min(ttlUse, 6 * H));
    return v;
  };
  const [route, aircraft, photo] = await Promise.all([
    CS_RE.test(cs) ? one(`r:${cs}`, `https://api.adsbdb.com/v0/callsign/${cs}`, parseRoute, 12 * H) : null,
    HEX_RE.test(hx) ? one(`a:${hx}`, `https://api.adsbdb.com/v0/aircraft/${hx}`, parseAircraft, 30 * 24 * H) : null,
    HEX_RE.test(hx) ? one(`p:${hx}`, `https://api.planespotters.net/pub/photos/hex/${hx}`, parsePhoto, 7 * 24 * H) : null,
  ]);
  return { callsign: cs || null, hex: hx || null, route, aircraft, photo, t: Date.now() };
}

/** A small in-memory TTL cache (the local server; the edge uses Durable Object storage). */
export function memoryCache(max = 5000) {
  const m = new Map();
  return {
    get(k) { const e = m.get(k); if (!e) return undefined; if (Date.now() > e.exp) { m.delete(k); return undefined; } return e.v; },
    set(k, v, ttl) { if (m.size >= max) m.delete(m.keys().next().value); m.set(k, { v, exp: Date.now() + ttl }); },
  };
}
