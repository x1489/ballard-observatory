// What's above Ballard: satellites propagated with SGP4 (satellite.js) from CelesTrak element sets, when they're
// sunlit against a dark sky (visible to the eye), upcoming visible passes, and look angles for anything with a
// position (aircraft, the Sun, the Moon). Observer: Market St, or the device's location when shared.
import { sunRaDec, sunPosition, moonPosition, BALLARD } from './sun.js';
import { enu } from './geo.js';

const RAD = Math.PI / 180, RE = 6371;
const S = () => window.satellite;

export function createSky() {
  let sats = [], loadedAt = 0, observer = { lat: BALLARD.lat, lon: BALLARD.lon, h: 0.02 };
  async function load(force = false) {
    if (!force && sats.length && Date.now() - loadedAt < 3600e3) return sats;
    const r = await fetch('/api/satellites');
    if (!r.ok) throw new Error(`satellites: HTTP ${r.status}`);
    const env = await r.json();
    const list = (env.data && env.data.sats) || [];
    sats = list.map((s) => { try { return { ...s, rec: S().twoline2satrec(s.l1, s.l2), iss: /ISS \(ZARYA\)/.test(s.name), css: /CSS \(TIANHE\)/.test(s.name) }; } catch { return null; } })
      .filter((s) => s && s.rec && !s.rec.error);
    // de-duplicate modules docked to the stations (same orbit): keep the named station
    const seen = new Set();
    sats = sats.filter((s) => { const k = `${s.l2.slice(8, 33)}`; if (seen.has(k)) return false; seen.add(k); return true; });
    if (sats.length) loadedAt = Date.now(); // an empty answer (the edge still fetching) is retried next time
    return sats;
  }
  const obsGd = () => ({ longitude: observer.lon * RAD, latitude: observer.lat * RAD, height: observer.h });

  function sunEci(t) {
    const { ra, dec } = sunRaDec(t);
    return [Math.cos(dec * RAD) * Math.cos(ra * RAD), Math.cos(dec * RAD) * Math.sin(ra * RAD), Math.sin(dec * RAD)];
  }
  /** Position of one satellite at t: { az, el, range, lat, lon, altKm, sunlit, speedKmh } or null. */
  function at(sat, t = Date.now()) {
    const date = new Date(t);
    const pv = S().propagate(sat.rec, date);
    if (!pv || !pv.position || typeof pv.position === 'boolean') return null;
    const gmst = S().gstime(date);
    const look = S().ecfToLookAngles(obsGd(), S().eciToEcf(pv.position, gmst));
    const gd = S().eciToGeodetic(pv.position, gmst);
    const p = pv.position, s = sunEci(t);
    const dot = p.x * s[0] + p.y * s[1] + p.z * s[2];
    const perp = Math.hypot(p.x - dot * s[0], p.y - dot * s[1], p.z - dot * s[2]);
    const sunlit = dot > 0 || perp > RE;
    const v = pv.velocity;
    return { az: ((look.azimuth / RAD) + 360) % 360, el: look.elevation / RAD, range: look.rangeSat, lat: gd.latitude / RAD, lon: S().degreesLong(gd.longitude),
      altKm: gd.height, sunlit, speedKmh: v ? Math.hypot(v.x, v.y, v.z) * 3600 : null };
  }
  /** Everything currently above the horizon, brightest-first-ish (stations first). */
  function overhead(t = Date.now(), minEl = 0) {
    const dark = sunPosition(t, observer.lat, observer.lon).elevation < -6;
    const out = [];
    for (const s of sats) {
      const p = at(s, t);
      if (p && p.el > minEl) out.push({ sat: s, ...p, visible: dark && p.sunlit });
    }
    return out.sort((a, b) => (b.sat.iss - a.sat.iss) || (b.sat.css - a.sat.css) || b.el - a.el);
  }
  /** Passes of one satellite above minEl in the next `hours`: [{ rise, max, set, maxEl, visible, riseAz, setAz }]. */
  function passes(sat, from = Date.now(), hours = 36, minEl = 10) {
    const out = [];
    let cur = null;
    const step = 20e3;
    for (let t = from; t < from + hours * 3600e3; t += step) {
      const p = at(sat, t);
      if (!p) continue;
      if (p.el > minEl) {
        if (!cur) cur = { rise: t, riseAz: p.az, max: t, maxEl: p.el, visible: false, set: t, setAz: p.az };
        if (p.el > cur.maxEl) { cur.maxEl = p.el; cur.max = t; cur.maxAz = p.az; }
        cur.set = t; cur.setAz = p.az;
        if (p.sunlit && sunPosition(t, observer.lat, observer.lon).elevation < -6) cur.visible = true;
      } else if (cur) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out;
  }
  /** Look angles from the observer to a point with an altitude in metres (aircraft). */
  function lookAt(lon, lat, altM) {
    const [e, n] = enu(observer.lon, observer.lat, lon, lat);
    const d = Math.hypot(e, n);
    const up = altM - observer.h * 1000 - (d * d) / (2 * 6371000); // Earth curvature drop
    return { az: ((Math.atan2(e, n) / RAD) + 360) % 360, el: Math.atan2(up, d) / RAD, dist: Math.hypot(d, up) };
  }
  return {
    load, at, overhead, passes, lookAt,
    sun: (t = Date.now()) => sunPosition(t, observer.lat, observer.lon),
    moon: (t = Date.now()) => moonPosition(t, observer.lat, observer.lon),
    iss: () => sats.find((s) => s.iss) || null,
    find: (id) => sats.find((s) => String(s.id) === String(id)) || null,
    list: () => sats,
    setObserver(lat, lon) { observer = { lat, lon, h: 0.02 }; },
    get observer() { return observer; },
  };
}
