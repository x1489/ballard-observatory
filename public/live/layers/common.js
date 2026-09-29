// Shared pieces for the scene's layers: additive "light" blending, glow sprites, silhouettes for ground shadows,
// the altitude colour ramp for flight trails, and small math helpers.
import { offset, toRad } from '../geo.js';

export const D = () => window.deck;

/** deck.gl (luma.gl v9) parameters for additive glows that don't write depth. */
export const ADDITIVE = {
  blend: true, blendColorOperation: 'add', blendColorSrcFactor: 'src-alpha', blendColorDstFactor: 'one',
  blendAlphaOperation: 'add', blendAlphaSrcFactor: 'one', blendAlphaDstFactor: 'one-minus-src-alpha', depthWriteEnabled: false,
};
export const NO_DEPTH_WRITE = { depthWriteEnabled: false };

/** Point `dist` metres from (lon,lat) along compass bearing `deg`. */
export function ahead(lon, lat, deg, dist) {
  const r = toRad(deg);
  return offset(lon, lat, Math.sin(r) * dist, Math.cos(r) * dist);
}

// Top-view silhouettes (nose up) used as flat, sun-cast ground shadows.
const svg = (d, vb = 64) => `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 ${vb} ${vb}"><path fill="#000" d="${d}"/></svg>`)}`;
export const SILHOUETTE = {
  jet: svg('M32 2c1.6 0 2.6 2 2.6 4.6V23l25 14v5l-25-7.2V50l6.4 5v4L32 57l-9 2v-4l6.4-5V34.8L4.4 42v-5l25-14V6.6C29.4 4 30.4 2 32 2z'),
  prop: svg('M32 4c1.4 0 2.3 1.6 2.3 3.6V22h26v6h-26v20h9v5H32h-9.3v-5h9V28h-26v-6h26V7.6C29.7 5.6 30.6 4 32 4z'),
  light: svg('M32 6c1.3 0 2 1.3 2 3v12h24v5H34v18h8v4H22v-4h8V26H6v-5h24V9c0-1.7.7-3 2-3z'),
  heli: svg('M32 1a31 31 0 1 1 0 62 31 31 0 1 1 0-62zm0 4a27 27 0 1 0 0 54 27 27 0 1 0 0-54zm-2 10h4v38h-4z'),
  box: svg('M22 2h20v60H22z'),
};
export const silhouetteFor = (model) => (model === 'b789' || model === 'airplane' || model === 'jet' || model === 'citation2' ? 'jet' : model === 'atr72' ? 'prop' : model === 'bell206' ? 'heli' : 'light');

// Glow sprite (soft radial) for lights, headlight pools and beacons.
function glowSprite() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,.55)'); gr.addColorStop(0.6, 'rgba(255,255,255,.12)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return c.toDataURL();
}
let GLOW = null;
export const glow = () => (GLOW ||= { url: glowSprite(), width: 64, height: 64, mask: true });

/** Flight-trail colour by altitude (feet): amber low, green, cyan, indigo, magenta high. */
const RAMP = [[0, [255, 176, 32]], [3000, [132, 204, 22]], [10000, [34, 211, 238]], [22000, [99, 102, 241]], [36000, [217, 70, 239]]];
export function altColor(ft) {
  if (!(ft > 0)) return RAMP[0][1];
  for (let i = 1; i < RAMP.length; i++) {
    if (ft <= RAMP[i][0]) {
      const [a, ca] = RAMP[i - 1], [b, cb] = RAMP[i], f = (ft - a) / (b - a);
      return ca.map((v, k) => Math.round(v + (cb[k] - v) * f));
    }
  }
  return RAMP[RAMP.length - 1][1];
}
export const hexRGB = (h, a = 255) => { const n = parseInt(String(h || '#888888').slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a]; };

/** Blinking helpers: t in ms. */
export const blink = (t, periodMs, onMs, phase = 0) => ((t + phase) % periodMs) < onMs;
export const pulse = (t, periodMs, phase = 0) => 0.5 - 0.5 * Math.cos((((t + phase) % periodMs) / periodMs) * Math.PI * 2);

/**
 * Sun shadows of vehicles on the ground (what makes them sit on the road instead of hovering): the vehicle's box
 * (length x width x height) projected along the sun onto the ground, plus a tight dark contact patch under it.
 * items: { c: [lon, lat], len, wid, h, heading, a (0..255) }; sun: { azimuth, elevation }.
 */
export function contactShadow(id, items, ground, sun) {
  const deck = D();
  const polys = [];
  const el = Math.max(sun.elevation, 0);
  const reach = el > 3 ? Math.min(6, 1 / Math.tan(toRad(el))) : 0; // shadow length per metre of height
  const sa = toRad(sun.azimuth + 180), se = Math.sin(sa), sn = Math.cos(sa);
  for (const it of items) {
    const hr = toRad(it.heading), fe = Math.sin(hr), fn = Math.cos(hr), re = fn, rn = -fe; // forward, right (east, north)
    const hl = it.len / 2, hw = it.wid / 2, d = reach * it.h;
    const box = [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw]].map(([f, r]) => [f * fe + r * re, f * fn + r * rn]);
    const pts = d ? [...box, ...box.map(([e, n]) => [e + se * d, n + sn * d])] : box;
    const toLL = ([e, n], z) => { const p = offset(it.c[0], it.c[1], e, n); return [p[0], p[1], ground(p[0], p[1]) + z]; };
    if (d) polys.push({ poly: hull(pts).map((q) => toLL(q, 0.3)), a: it.a * 0.55 });
    polys.push({ poly: box.map(([e, n]) => toLL([e * 1.06, n * 1.12], 0.32)), a: it.a * 0.5 });
  }
  return new deck.SolidPolygonLayer({ id, data: polys, getPolygon: (d) => d.poly, extruded: false, _full3d: true,
    getFillColor: (d) => [10, 14, 20, d.a], parameters: { depthWriteEnabled: false } });
}

/** Convex hull of 2D points (monotone chain), counter-clockwise. */
function hull(p) {
  const pts = [...p].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const x = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of pts) { while (lo.length >= 2 && x(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of pts.reverse()) { while (up.length >= 2 && x(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
