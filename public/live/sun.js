// The real sky over Ballard: sun and moon positions (NOAA / Meeus low-precision, ~0.5°), and the look of the scene
// at the current solar elevation (sky colors, aerial-photo exposure, building and model lighting, night lights).
const RAD = Math.PI / 180;
export const BALLARD = { lat: 47.6687, lon: -122.3847 };

function days(t) { return t / 86400000 + 2440587.5 - 2451545.0; }
function gmstDeg(d) { return (280.46061837 + 360.98564736629 * d) % 360; }
function altAz(raDeg, decDeg, t, lat, lon) {
  const ha = (gmstDeg(days(t)) + lon - raDeg) * RAD, dec = decDeg * RAD, la = lat * RAD;
  const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha));
  return { elevation: el / RAD, azimuth: ((az / RAD) + 360) % 360 };
}

/** Sun right ascension/declination (degrees). */
export function sunRaDec(t = Date.now()) {
  const d = days(t);
  const g = ((357.529 + 0.98560028 * d) % 360) * RAD;
  const q = (280.459 + 0.98564736 * d) % 360;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  return { ra: ((Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / RAD) + 360) % 360, dec: Math.asin(Math.sin(e) * Math.sin(L)) / RAD };
}
export function sunPosition(t = Date.now(), lat = BALLARD.lat, lon = BALLARD.lon) {
  const { ra, dec } = sunRaDec(t);
  return altAz(ra, dec, t, lat, lon);
}
/** Moon position (low precision) and illuminated fraction. */
export function moonPosition(t = Date.now(), lat = BALLARD.lat, lon = BALLARD.lon) {
  const d = days(t);
  const L = (218.316 + 13.176396 * d) % 360, M = (134.963 + 13.064993 * d) % 360, F = (93.272 + 13.22935 * d) % 360;
  const lam = (L + 6.289 * Math.sin(M * RAD)) * RAD, beta = 5.128 * Math.sin(F * RAD) * RAD, e = 23.4397 * RAD;
  const ra = Math.atan2(Math.sin(lam) * Math.cos(e) - Math.tan(beta) * Math.sin(e), Math.cos(lam)) / RAD;
  const dec = Math.asin(Math.sin(beta) * Math.cos(e) + Math.cos(beta) * Math.sin(e) * Math.sin(lam)) / RAD;
  const pos = altAz((ra + 360) % 360, dec, t, lat, lon);
  const s = sunRaDec(t);
  const phaseAngle = Math.acos(Math.max(-1, Math.min(1, Math.sin(s.dec * RAD) * Math.sin(dec * RAD) + Math.cos(s.dec * RAD) * Math.cos(dec * RAD) * Math.cos((s.ra - ra) * RAD))));
  return { ...pos, illumination: (1 - Math.cos(phaseAngle)) / 2 };
}
/** Next time (ms) the sun crosses `elevation` going down (set) or up (rise), searching up to 30 hours. */
export function nextSunCrossing(t = Date.now(), elevation = -0.833, rising = false) {
  let prev = sunPosition(t).elevation;
  for (let k = 1; k <= 30 * 12; k++) {
    const tt = t + k * 300000;
    const e = sunPosition(tt).elevation;
    if (rising ? prev < elevation && e >= elevation : prev > elevation && e <= elevation) {
      let a = tt - 300000, b = tt;
      for (let i = 0; i < 20; i++) { const m = (a + b) / 2; const em = sunPosition(m).elevation; if (rising ? em < elevation : em > elevation) a = m; else b = m; }
      return (a + b) / 2;
    }
    prev = e;
  }
  return null;
}

const mix = (a, b, f) => a + (b - a) * f;
const hex = (c) => { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const toHex = (rgb) => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const mixC = (a, b, f) => toHex(hex(a).map((v, i) => mix(v, hex(b)[i], f)));

// Key frames by solar elevation (degrees): the scene's grading at each.
const KEYS = [
  { el: -18, sky: '#03060d', horizon: '#0b1222', fog: '#070b16', bright: 0.16, sat: -0.55, contrast: 0.12, bldg: '#1b202b', light: '#8ea4ff', li: 0.18, amb: 0.34, sunI: 0.0, glow: 1 },
  { el: -8, sky: '#0b1430', horizon: '#26345e', fog: '#141c34', bright: 0.24, sat: -0.45, contrast: 0.1, bldg: '#232a38', light: '#9fb0ff', li: 0.2, amb: 0.4, sunI: 0.0, glow: 0.95 },
  { el: -3, sky: '#28406e', horizon: '#c9776a', fog: '#4c4a62', bright: 0.46, sat: -0.2, contrast: 0.06, bldg: '#5b5a66', light: '#ffab8a', li: 0.26, amb: 0.62, sunI: 0.2, glow: 0.55 },
  { el: 2, sky: '#4f7fb6', horizon: '#f2b98f', fog: '#e0c7b5', bright: 0.78, sat: 0.02, contrast: 0.04, bldg: '#c3b3a1', light: '#ffc79a', li: 0.36, amb: 0.8, sunI: 1.1, glow: 0.12 },
  { el: 10, sky: '#5d93cf', horizon: '#dcd6cf', fog: '#e3e4e4', bright: 0.93, sat: 0.06, contrast: 0.04, bldg: '#cdc9c2', light: '#ffe6cc', li: 0.42, amb: 0.92, sunI: 1.6, glow: 0 },
  { el: 30, sky: '#6aa4dc', horizon: '#d6e6f4', fog: '#e4ebf2', bright: 1.0, sat: 0.08, contrast: 0.05, bldg: '#cfcdc8', light: '#ffffff', li: 0.45, amb: 1.0, sunI: 1.9, glow: 0 },
];
/** The grading at a solar elevation, interpolated between key frames. `cloud` (0..1) dims and flattens it. */
export function lookAt(elevation, cloud = 0) {
  let i = 0;
  while (i < KEYS.length - 2 && elevation > KEYS[i + 1].el) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const f = Math.max(0, Math.min(1, (elevation - a.el) / (b.el - a.el)));
  const o = {};
  for (const k of Object.keys(a)) o[k] = typeof a[k] === 'string' ? mixC(a[k], b[k], f) : mix(a[k], b[k], f);
  if (cloud > 0 && elevation > -3) {
    const c = Math.min(1, cloud) * 0.6;
    o.sunI *= 1 - c; o.sat -= 0.12 * c; o.bright *= 1 - 0.12 * c;
    o.sky = mixC(o.sky, '#9aa6b2', c); o.horizon = mixC(o.horizon, '#b8c0c8', c); o.fog = mixC(o.fog, '#c5ccd3', c);
  }
  o.night = elevation < -4;
  return o;
}
export const rgb = hex;
