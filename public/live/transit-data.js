// Static King County Metro geography (public/data/transit.json, built by tools/build-geo.mjs): route shapes as
// measured lines, trips -> shape/headsign, stop names and positions, and stop positions along each shape.
import { measure, project } from './geo.js';

export function decodePolyline(str) {
  const pts = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let b, shift = 0, res = 0;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    pts.push([lon / 1e5, lat / 1e5]);
  }
  return pts;
}

export async function loadTransit(url = '/data/transit.json') {
  const j = await fetch(url).then((r) => { if (!r.ok) throw new Error(`transit.json: HTTP ${r.status}`); return r.json(); });
  const lines = new Map(), stopS = new Map();
  const routeById = new Map(j.routes.map((r, i) => [r.id, { ...r, i }]));
  const line = (idx) => {
    if (idx == null || !j.shapes[idx]) return null;
    if (!lines.has(idx)) lines.set(idx, measure(decodePolyline(j.shapes[idx])));
    return lines.get(idx);
  };
  return {
    raw: j,
    route: (id) => routeById.get(id) || null,
    routeAt: (i) => j.routes[i] || null,
    stop: (id) => { const s = j.stops[id]; return s ? { id, name: s[0], lat: s[1], lon: s[2] } : null; },
    line,
    /** { shape, line, headsign, route } for a realtime vehicle (trip id, else route+direction default). */
    tripInfo(tripId, routeId, dir) {
      const t = tripId && j.trips[tripId];
      if (t) return { shape: t[1], line: line(t[1]), headsign: j.headsigns[t[2]] || '', route: j.routes[t[0]], dir: t[3] };
      const r = routeById.get(routeId);
      if (!r) return null;
      const sh = j.defaults[`${r.i}:${dir ?? 0}`] ?? j.defaults[`${r.i}:${dir ? 0 : 1}`];
      return sh == null ? null : { shape: sh, line: line(sh), headsign: '', route: r, dir };
    },
    /** Distance of a stop along a shape (cached). */
    stopAlong(shapeIdx, stopId) {
      const k = `${shapeIdx}:${stopId}`;
      if (stopS.has(k)) return stopS.get(k);
      const L = line(shapeIdx), s = j.stops[stopId];
      const v = L && s ? project(L, s[2], s[1]) : null;
      const out = v && v.d < 60 ? v.s : null;
      stopS.set(k, out);
      return out;
    },
  };
}
