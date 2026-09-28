// Builds the static geography the live scene moves things along (public/data/):
//   transit.json  King County Metro routes that serve Ballard: route shapes (clipped to the area, simplified,
//                 Google-polyline encoded), trip -> shape/headsign, stops with names. From Metro's GTFS feed.
//   rail.json     the BNSF mainline through Ballard (Amtrak Cascades, Empire Builder, Sounder), from the US DOT
//                 National Transportation Atlas (North American Rail Network lines, public domain).
//   bridges.json  drawbridge leaves (hinge, heading, length, width, clearance) from OpenStreetMap + SDOT figures.
// Usage:
//   node tools/build-geo.mjs transit [google_transit.zip]   (downloads Metro's feed when no path is given)
//   node tools/build-geo.mjs rail [narn.geojson]            (downloads the NTAD rail lines around Ballard when no path)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCSVObjects } from '../lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'data');
fs.mkdirSync(OUT, { recursive: true });

// Ballard and the approaches buses and trains arrive from.
const AREA = { s: 47.630, n: 47.718, w: -122.44, e: -122.318 }; // = sources/tracks.mjs BUS_AREA
const CLIP = { s: AREA.s - 0.012, n: AREA.n + 0.012, w: AREA.w - 0.016, e: AREA.e + 0.016 };
const inBox = (b, lat, lon) => lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e;

// ------------------------------------------------------------------ polyline helpers
const R = 6371008.8, RAD = Math.PI / 180;
function xy(p, lat0) { return [p[0] * RAD * R * Math.cos(lat0 * RAD), p[1] * RAD * R]; }
/** Douglas-Peucker on [lon,lat] points with a tolerance in metres. */
export function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const lat0 = pts[0][1], P = pts.map((p) => xy(p, lat0));
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let md = -1, mi = -1;
    const [ax, ay] = P[a], [bx, by] = P[b], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = P[i];
      let f = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0; f = Math.max(0, Math.min(1, f));
      const d = Math.hypot(px - (ax + f * dx), py - (ay + f * dy));
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
/** Google encoded polyline, precision 5 (points are [lon,lat]). */
export function encodePolyline(pts) {
  let out = '', plat = 0, plon = 0;
  const enc = (v) => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [lon, lat] of pts) {
    const la = Math.round(lat * 1e5), lo = Math.round(lon * 1e5);
    out += enc(la - plat) + enc(lo - plon); plat = la; plon = lo;
  }
  return out;
}

// ------------------------------------------------------------------ transit (GTFS)
function transit(zip) {
  if (!zip) {
    zip = path.join(os.tmpdir(), 'kcm_google_transit.zip');
    execFileSync('curl', ['-sSfL', '-m', '300', '-o', zip, 'https://metro.kingcounty.gov/GTFS/google_transit.zip']);
  }
  const read = (name) => parseCSVObjects(execFileSync('unzip', ['-p', zip, name], { maxBuffer: 1 << 28 }).toString('utf8'));
  const feed = read('feed_info.txt')[0] || {};
  const routes = new Map(read('routes.txt').map((r) => [r.route_id, r]));
  // shapes: sorted points
  const shapes = new Map();
  for (const r of read('shapes.txt')) {
    let s = shapes.get(r.shape_id);
    if (!s) shapes.set(r.shape_id, s = []);
    s.push([+r.shape_pt_sequence, +r.shape_pt_lon, +r.shape_pt_lat]);
  }
  for (const s of shapes.values()) s.sort((a, b) => a[0] - b[0]);
  const trips = read('trips.txt');
  // shapes and routes that pass through the area
  const shapeInArea = new Set();
  for (const [id, s] of shapes) if (s.some(([, lon, lat]) => inBox(AREA, lat, lon))) shapeInArea.add(id);
  const routeIds = new Set(trips.filter((t) => shapeInArea.has(t.shape_id)).map((t) => t.route_id));
  const shapeIds = [...new Set(trips.filter((t) => routeIds.has(t.route_id) && shapeInArea.has(t.shape_id)).map((t) => t.shape_id))];
  // clip each shape to the contiguous stretch inside CLIP, simplify, encode; dedupe identical geometry
  const shapeOut = [], shapeIndex = new Map(), byGeom = new Map();
  for (const id of shapeIds) {
    const s = shapes.get(id);
    let a = s.findIndex(([, lon, lat]) => inBox(CLIP, lat, lon));
    let b = s.length - 1 - [...s].reverse().findIndex(([, lon, lat]) => inBox(CLIP, lat, lon));
    if (a < 0) continue;
    a = Math.max(0, a - 1); b = Math.min(s.length - 1, b + 1);
    const pts = simplify(s.slice(a, b + 1).map(([, lon, lat]) => [lon, lat]), 1.5);
    const enc = encodePolyline(pts);
    if (!byGeom.has(enc)) { byGeom.set(enc, shapeOut.length); shapeOut.push(enc); }
    shapeIndex.set(id, byGeom.get(enc));
  }
  const routeList = [...routeIds].sort();
  const rIndex = new Map(routeList.map((id, i) => [id, i]));
  const heads = [], hIndex = new Map();
  const tripOut = {};
  for (const t of trips) {
    if (!rIndex.has(t.route_id) || !shapeIndex.has(t.shape_id)) continue;
    const h = t.trip_headsign || '';
    if (!hIndex.has(h)) { hIndex.set(h, heads.length); heads.push(h); }
    tripOut[t.trip_id] = [rIndex.get(t.route_id), shapeIndex.get(t.shape_id), hIndex.get(h), +t.direction_id || 0];
  }
  // default shape per route+direction (most trips) for trips missing from this feed version
  const counts = new Map();
  for (const [rt, sh, , dir] of Object.values(tripOut)) { const k = `${rt}:${dir}:${sh}`; counts.set(k, (counts.get(k) || 0) + 1); }
  const defaults = {};
  for (const [k, n] of counts) { const [rt, dir, sh] = k.split(':'); const key = `${rt}:${dir}`; if (!defaults[key] || n > defaults[key][1]) defaults[key] = [+sh, n]; }
  const stops = {};
  for (const s of read('stops.txt')) {
    const lat = +s.stop_lat, lon = +s.stop_lon;
    if (inBox(CLIP, lat, lon)) stops[s.stop_id] = [s.stop_name, Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6];
  }
  const out = {
    generated: new Date().toISOString(), source: 'King County Metro GTFS', feedVersion: feed.feed_version || null,
    feedStart: feed.feed_start_date || null, feedEnd: feed.feed_end_date || null, area: AREA,
    routes: routeList.map((id) => { const r = routes.get(id) || {}; return { id, short: r.route_short_name || id, name: r.route_desc || r.route_long_name || '', color: r.route_color ? `#${r.route_color}` : null, agency: r.agency_id || null }; }),
    shapes: shapeOut, headsigns: heads, trips: tripOut,
    defaults: Object.fromEntries(Object.entries(defaults).map(([k, [sh]]) => [k, sh])), stops,
  };
  const file = path.join(OUT, 'transit.json');
  fs.writeFileSync(file, JSON.stringify(out));
  console.log(`transit.json: ${routeList.length} routes, ${shapeOut.length} shapes, ${Object.keys(tripOut).length} trips, ${Object.keys(stops).length} stops, ${(fs.statSync(file).size / 1024).toFixed(0)} KB (feed ${feed.feed_version})`);
}

// ------------------------------------------------------------------ rail
function chains(ways) {
  // merge ways sharing endpoints into chains of [lon,lat]
  const segs = ways.map((w) => w.geometry.map((g) => [g.lon, g.lat]));
  const key = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
  const out = [];
  const used = new Set();
  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    let line = segs[i].slice();
    let grown = true;
    while (grown) {
      grown = false;
      for (let j = 0; j < segs.length; j++) {
        if (used.has(j)) continue;
        const s = segs[j];
        if (key(s[0]) === key(line[line.length - 1])) line = line.concat(s.slice(1));
        else if (key(s[s.length - 1]) === key(line[line.length - 1])) line = line.concat(s.slice(0, -1).reverse());
        else if (key(s[s.length - 1]) === key(line[0])) line = s.slice(0, -1).concat(line);
        else if (key(s[0]) === key(line[0])) line = s.slice(1).reverse().concat(line);
        else continue;
        used.add(j); grown = true;
      }
    }
    out.push(line);
  }
  return out;
}
const lenM = (line) => { let d = 0; for (let i = 1; i < line.length; i++) { const [a, b] = [line[i - 1], line[i]]; d += Math.hypot((b[0] - a[0]) * RAD * R * Math.cos(a[1] * RAD), (b[1] - a[1]) * RAD * R); } return d; };

const NARN = 'https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_North_American_Rail_Network_Lines/FeatureServer/0/query'
  + '?where=1%3D1&geometry=-122.425,47.62,-122.355,47.745&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&outSR=4326&f=geojson';
function rail(file) {
  const j = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : JSON.parse(execFileSync('curl', ['-sSfL', '-m', '120', NARN]).toString('utf8'));
  // BNSF Scenic Subdivision mainline segments (NET = M), as "ways" of lon/lat points
  const main = j.features.filter((f) => f.properties.SUBDIV === 'SCENIC' && f.properties.NET === 'M' && f.geometry && f.geometry.type === 'LineString')
    .map((f) => ({ geometry: f.geometry.coordinates.map(([lon, lat]) => ({ lon, lat })) }));
  const cs = chains(main).map((c) => ({ c, len: lenM(c) })).sort((a, b) => b.len - a.len);
  if (!cs.length) throw new Error('no mainline rail found');
  let line = cs[0].c;
  if (line[0][1] > line[line.length - 1][1]) line = line.reverse(); // south -> north
  line = simplify(line, 1.0);
  const out = { generated: new Date().toISOString(), source: 'US DOT BTS National Transportation Atlas Database: North American Rail Network Lines (public domain)',
    name: 'BNSF Scenic Subdivision (Seattle - Everett)', lengthM: Math.round(lenM(line)), line: encodePolyline(line) };
  fs.writeFileSync(path.join(OUT, 'rail.json'), JSON.stringify(out));
  console.log(`rail.json: ${line.length} points, ${(out.lengthM / 1000).toFixed(1)} km (from ${main.length} segments, ${cs.length} chains; longest chains ${cs.slice(0, 4).map((x) => (x.len / 1000).toFixed(1)).join(', ')} km)`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'transit') transit(arg);
else if (cmd === 'rail') rail(arg);
else { console.error('usage: node tools/build-geo.mjs transit [zip] | rail [narn.geojson]'); process.exit(2); }
