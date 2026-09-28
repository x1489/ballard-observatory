// Visible passes of a satellite over a point (the ISS over Ballard): SGP4 via satellite.js (MIT, vendored as
// sources/satellite.mjs), "visible" meaning sunlit while the observer's sky is dark (sun below -6°) and at least 10°
// above the horizon. Runs in Node and in Cloudflare Workers.
import { twoline2satrec, propagate, gstime, eciToEcf, ecfToLookAngles } from './satellite.mjs';

const RAD = Math.PI / 180, RE = 6371;
const days = (t) => t / 86400000 + 2440587.5 - 2451545.0;
function sunRaDec(t) {
  const d = days(t);
  const g = ((357.529 + 0.98560028 * d) % 360) * RAD, q = (280.459 + 0.98564736 * d) % 360;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD, e = (23.439 - 0.00000036 * d) * RAD;
  return { ra: Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec: Math.asin(Math.sin(e) * Math.sin(L)) };
}
export function sunElevation(t, lat, lon) {
  const { ra, dec } = sunRaDec(t);
  const ha = (((280.46061837 + 360.98564736629 * days(t)) % 360) * RAD) + lon * RAD - ra, la = lat * RAD;
  return Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha)) / RAD;
}
const compass = (az) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((az % 360) + 360) % 360) / 45) % 8];

/** Visible passes in the next `hours`: [{ rise, set, max, maxEl, riseDir, setDir, maxDir }] (times in ms). */
export function visiblePasses({ l1, l2 }, { lat, lon, heightKm = 0.02 }, from = Date.now(), hours = 48, minEl = 10, stepMs = 20e3) {
  const rec = twoline2satrec(l1, l2);
  const obs = { longitude: lon * RAD, latitude: lat * RAD, height: heightKm };
  const out = [];
  let cur = null;
  for (let t = from; t < from + hours * 3600e3; t += stepMs) {
    const date = new Date(t);
    const pv = propagate(rec, date);
    if (!pv || !pv.position || typeof pv.position === 'boolean') continue;
    const look = ecfToLookAngles(obs, eciToEcf(pv.position, gstime(date)));
    const el = look.elevation / RAD, az = ((look.azimuth / RAD) + 360) % 360;
    if (el > minEl) {
      const s = sunRaDec(t), p = pv.position;
      const sx = Math.cos(s.dec) * Math.cos(s.ra), sy = Math.cos(s.dec) * Math.sin(s.ra), sz = Math.sin(s.dec);
      const dot = p.x * sx + p.y * sy + p.z * sz;
      const sunlit = dot > 0 || Math.hypot(p.x - dot * sx, p.y - dot * sy, p.z - dot * sz) > RE;
      const visible = sunlit && sunElevation(t, lat, lon) < -6;
      if (!cur) cur = { rise: t, riseAz: az, max: t, maxEl: el, maxAz: az, set: t, setAz: az, visible: false };
      if (el > cur.maxEl) { cur.maxEl = el; cur.max = t; cur.maxAz = az; }
      cur.set = t; cur.setAz = az;
      if (visible) cur.visible = true;
    } else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.filter((p) => p.visible).map((p) => ({ rise: p.rise, set: p.set, max: p.max, maxEl: Math.round(p.maxEl), riseDir: compass(p.riseAz), setDir: compass(p.setAz), maxDir: compass(p.maxAz) }));
}
