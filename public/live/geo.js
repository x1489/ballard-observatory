// Geodesy for a neighborhood-scale scene: local east/north metres around a point, bearings, and polylines measured
// in metres (project a fix onto a route, walk along it). Pure functions; also used by the Node tests.
export const R = 6371008.8;
const RAD = Math.PI / 180;
export const toRad = (d) => d * RAD;
export const toDeg = (r) => r / RAD;
export const wrap360 = (d) => ((d % 360) + 360) % 360;
/** Signed smallest difference b - a in degrees (-180..180]. */
export const angDiff = (a, b) => { const d = wrap360(b - a); return d > 180 ? d - 360 : d; };

/** Metres per degree of latitude / longitude at a latitude. */
export const mPerDegLat = () => (Math.PI * R) / 180;
export const mPerDegLon = (lat) => ((Math.PI * R) / 180) * Math.cos(lat * RAD);

/** Move a point by east/north metres (flat-earth; fine below ~50 km). */
export function offset(lon, lat, east, north) {
  return [lon + east / mPerDegLon(lat), lat + north / mPerDegLat()];
}
/** East/north metres from a to b. */
export function enu(lon0, lat0, lon1, lat1) {
  return [(lon1 - lon0) * mPerDegLon((lat0 + lat1) / 2), (lat1 - lat0) * mPerDegLat()];
}
export function distM(lon0, lat0, lon1, lat1) {
  const p1 = lat0 * RAD, p2 = lat1 * RAD, dp = p2 - p1, dl = (lon1 - lon0) * RAD;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
/** Initial great-circle bearing a -> b, degrees clockwise from north. */
export function bearing(lon0, lat0, lon1, lat1) {
  const p1 = lat0 * RAD, p2 = lat1 * RAD, dl = (lon1 - lon0) * RAD;
  return wrap360(toDeg(Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl))));
}
/** Point at a fraction along the great circle a -> b. */
export function gcInterp(lon0, lat0, lon1, lat1, f) {
  const p1 = lat0 * RAD, l1 = lon0 * RAD, p2 = lat1 * RAD, l2 = lon1 * RAD;
  const d = distM(lon0, lat0, lon1, lat1) / R;
  if (d < 1e-9) return [lon0, lat0];
  const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
  const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
  const z = A * Math.sin(p1) + B * Math.sin(p2);
  return [toDeg(Math.atan2(y, x)), toDeg(Math.atan2(z, Math.hypot(x, y)))];
}
/** Web Mercator ground resolution (metres per CSS pixel) at a zoom and latitude, 512-px tiles (MapLibre). */
export const metersPerPixel = (zoom, lat) => (40075016.686 * Math.cos(lat * RAD)) / (512 * 2 ** zoom);

// ------------------------------------------------------------------ polylines in metres
/**
 * Prepare a polyline [[lon,lat],...] for measuring: cumulative distance (m) and per-segment bearings.
 * Returns { pts, cum, len, brg }.
 */
export function measure(pts) {
  const cum = [0], brg = [];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + distM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
    brg.push(bearing(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  }
  if (!brg.length) brg.push(0);
  return { pts, cum, len: cum[cum.length - 1], brg };
}
function segIndex(line, s) {
  const { cum } = line;
  if (s <= 0) return 0;
  if (s >= line.len) return Math.max(0, cum.length - 2);
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  return lo;
}
/** Position, heading at distance s along the line; lateral offset in metres to the right of travel. */
export function along(line, s, lateral = 0) {
  const i = segIndex(line, s);
  const a = line.pts[i], b = line.pts[Math.min(i + 1, line.pts.length - 1)];
  const segLen = line.cum[i + 1] - line.cum[i] || 1;
  const f = Math.max(0, Math.min(1, (s - line.cum[i]) / segLen));
  let lon = a[0] + (b[0] - a[0]) * f, lat = a[1] + (b[1] - a[1]) * f;
  // Smooth the heading across vertices: blend with the neighbouring segment near each end.
  let h = line.brg[i] ?? 0;
  const edge = 6; // metres
  const toEnd = segLen - (s - line.cum[i]), fromStart = s - line.cum[i];
  if (toEnd < edge && i + 1 < line.brg.length) h = wrap360(h + angDiff(h, line.brg[i + 1]) * (0.5 * (1 - toEnd / edge)));
  else if (fromStart < edge && i > 0) h = wrap360(h + angDiff(h, line.brg[i - 1]) * (0.5 * (1 - fromStart / edge)));
  if (lateral) {
    const r = toRad(h + 90);
    [lon, lat] = offset(lon, lat, Math.sin(r) * lateral, Math.cos(r) * lateral);
  }
  return { lon, lat, heading: h };
}
/**
 * Nearest point on the line to (lon,lat): { s, d } with s the distance along (m) and d the perpendicular distance (m).
 * Optionally restricted to [sMin, sMax] so a vehicle can't jump to the other side of a loop.
 */
export function project(line, lon, lat, sMin = -Infinity, sMax = Infinity) {
  let best = { s: 0, d: Infinity };
  const kx = mPerDegLon(lat), ky = mPerDegLat();
  for (let i = 0; i < line.pts.length - 1; i++) {
    if (line.cum[i + 1] < sMin || line.cum[i] > sMax) continue;
    const a = line.pts[i], b = line.pts[i + 1];
    const ax = (a[0] - lon) * kx, ay = (a[1] - lat) * ky, bx = (b[0] - lon) * kx, by = (b[1] - lat) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let f = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0;
    f = Math.max(0, Math.min(1, f));
    const px = ax + dx * f, py = ay + dy * f;
    const d = Math.hypot(px, py);
    if (d < best.d) best = { s: line.cum[i] + f * (line.cum[i + 1] - line.cum[i]), d };
  }
  return best;
}
