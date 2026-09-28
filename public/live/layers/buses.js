// Buses: every King County Metro bus around Ballard as a 3D bus of its real type (40 ft, 60 ft articulated with a
// rear section that follows the curve, trolleybus with poles) in Metro's livery, driving its route in the right-hand
// lane. Position reports (every ~30 s) are turned into motion toward the predicted times at the next stops, so buses
// slow into stops and pull away rather than jumping. Headlights, tail lights and destination signs after dark.
import { PathTrack } from '../motion.js';
import { busSpec, ARTIC_GAP } from '../fleet.js';
import { D, ADDITIVE, ahead, glow, hexRGB } from './common.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const MIN_PX = 16;
const LANE = 1.9; // metres right of the route line (Metro shapes follow street centrelines)

export function createBuses(transit, { deckZ = () => null } = {}) {
  const buses = new Map(); // id -> { track, rec, info, spec, lastSeen }
  const S = { selected: null, visible: true, labels: true, replay: null };
  const replayInfo = new Map(); // id -> { trip, info, spec }
  function replayEntries() {
    return S.replay.map((v) => {
      let c = replayInfo.get(v.id);
      if (!c || c.trip !== v.trip) {
        const info = transit.tripInfo(v.trip, v.route, null);
        c = { trip: v.trip, info, spec: busSpec(v.id, info && info.route ? info.route.short : v.route) };
        replayInfo.set(v.id, c);
      }
      return [v.id, { track: null, rec: { ...v, next: [] }, info: c.info, route: c.info && c.info.route, spec: c.spec, lastSeen: Date.now() }];
    });
  }

  function ingest(data) {
    const now = Date.now();
    for (const v of (data && data.vehicles) || []) {
      if (!isNum(v.lat) || !isNum(v.lon)) continue;
      const info = transit.tripInfo(v.trip, v.route, v.dir);
      let o = buses.get(v.id);
      if (!o) { o = { track: null, rec: null, info: null, spec: null }; buses.set(v.id, o); }
      o.rec = v; o.lastSeen = now;
      if (info && (!o.info || o.info.shape !== info.shape)) {
        o.track = info.line ? new PathTrack(v.id, info.line, { defaultSpeed: 5.5, maxSpeed: 20, lookaheadS: 100 }) : null;
      }
      o.info = info;
      const routeName = info && info.route ? info.route.short : v.route;
      o.spec = busSpec(v.id, routeName);
      o.route = info && info.route;
      if (o.track) {
        const plan = [];
        for (const [stopId, , tMs] of v.next || []) {
          const s = transit.stopAlong(info.shape, stopId);
          if (s != null && isNum(tMs)) plan.push([tMs, s]);
        }
        plan.sort((a, b) => a[0] - b[0]);
        o.track.update({ t: isNum(v.t) ? v.t : now, lon: v.lon, lat: v.lat, plan }, now);
      }
    }
    for (const [k, o] of buses) if (now - o.lastSeen > 5 * 60e3) buses.delete(k);
  }

  let frame = [];
  function produce(ctx) {
    const deck = D();
    frame = [];
    if (!S.visible) return [];
    const byModel = new Map(), lights = [], glows = [], labels = [];
    const t = ctx.now, night = ctx.glow;
    const add = (url, it) => { if (!byModel.has(url)) byModel.set(url, []); byModel.get(url).push(it); };
    for (const [id, o] of (S.replay ? replayEntries() : buses)) {
      let p;
      if (o.track && o.track.fix) p = o.track.at(t, LANE);
      else p = { lon: o.rec.lon, lat: o.rec.lat, heading: o.rec.bearing ?? 0, moving: false };
      if (!p) continue;
      const boost = Math.max(1, Math.min(25, (MIN_PX * ctx.mpp) / o.spec.length));
      const zAt = (lon, lat) => { const b = deckZ(lon, lat); const g = ctx.ground(lon, lat); return b != null ? Math.max(b, g) : g; };
      const z = zAt(p.lon, p.lat);
      const it = { id, kind: 'bus', o, p, z, boost, pos: [p.lon, p.lat, z], heading: p.heading };
      frame.push(it);
      add(`/models/${o.spec.front}.glb`, it);
      let rear = null;
      if (o.spec.rear) {
        let rp;
        if (o.track && o.track.fix && !p.offRoute) rp = o.track.behind(p.s, ARTIC_GAP * boost, LANE);
        else { const q = ahead(p.lon, p.lat, p.heading + 180, ARTIC_GAP * boost); rp = { lon: q[0], lat: q[1], heading: p.heading }; }
        rear = { ...it, pos: [rp.lon, rp.lat, zAt(rp.lon, rp.lat)], heading: rp.heading };
        add(`/models/${o.spec.rear}.glb`, rear);
      }
      // lights: headlights (+ a pool on the road ahead at night), tail lights
      const halfFront = (o.spec.artic ? 5.5 : o.spec.length / 2) * boost;
      const front = ahead(p.lon, p.lat, p.heading, halfFront);
      const back = rear ? ahead(rear.pos[0], rear.pos[1], rear.heading + 180, 3.65 * boost) : ahead(p.lon, p.lat, p.heading + 180, halfFront);
      const bh = rear ? rear.heading : p.heading;
      if (night > 0.15) {
        for (const side of [-1, 1]) {
          const hl = ahead(front[0], front[1], p.heading + 90 * side, 0.9 * boost);
          lights.push({ p: [...hl, z + 0.8 * boost], c: [255, 246, 220, 255 * night], r: 1.8 });
          const tl = ahead(back[0], back[1], bh + 90 * side, 0.95 * boost);
          lights.push({ p: [...tl, z + 0.9 * boost], c: [255, 40, 30, 230 * night], r: 1.6 });
        }
        const pool = ahead(front[0], front[1], p.heading, 9 * boost);
        glows.push({ p: [...pool, z + 0.3], c: [255, 236, 200, 120 * night], r: 26 });
      }
      if (S.labels) labels.push(it);
    }
    const layers = [];
    for (const [url, arr] of byModel) {
      layers.push(new deck.ScenegraphLayer({ id: `bus-${url}`, data: arr, scenegraph: url, pickable: true, _lighting: 'pbr',
        getPosition: (d) => d.pos, getOrientation: (d) => [0, 270 - d.heading, 90], getScale: (d) => [d.boost, d.boost, d.boost],
        updateTriggers: { getPosition: t, getOrientation: t, getScale: t } }));
    }
    if (glows.length) layers.push(new deck.IconLayer({ id: 'bus-pools', data: glows, getPosition: (d) => d.p, getIcon: () => glow(), sizeUnits: 'pixels', getSize: (d) => d.r * 2, getColor: (d) => d.c, parameters: ADDITIVE }));
    if (lights.length) layers.push(new deck.ScatterplotLayer({ id: 'bus-lights', data: lights, getPosition: (d) => d.p, radiusUnits: 'pixels', getRadius: (d) => d.r, getFillColor: (d) => d.c, parameters: ADDITIVE }));
    if (labels.length && ctx.zoom > 13.2) {
      layers.push(new deck.TextLayer({ id: 'bus-labels', data: labels, getPosition: (d) => [d.pos[0], d.pos[1], d.z + 3.6 * d.boost], pickable: true,
        getText: (d) => (d.o.route ? d.o.route.short : '?').replace(' Line', ''), getSize: (d) => (d.id === S.selected ? 13 : 11),
        getColor: [255, 255, 255, 255], background: true, getBackgroundColor: (d) => hexRGB(d.o.spec.color, 235), backgroundPadding: [5, 2, 5, 2],
        getPixelOffset: [0, -8], fontFamily: 'Inter, system-ui, sans-serif', fontWeight: 700, characterSet: 'auto',
        parameters: { depthCompare: 'always', depthWriteEnabled: false }, updateTriggers: { getSize: S.selected } }));
    }
    const sel = S.selected && frame.find((f) => f.id === S.selected);
    if (sel) {
      layers.push(new deck.ScatterplotLayer({ id: 'bus-ring', data: [sel], getPosition: (d) => [d.pos[0], d.pos[1], d.z + 0.3], stroked: true, filled: false,
        radiusUnits: 'pixels', getRadius: 22 + 5 * Math.sin(t / 300), lineWidthUnits: 'pixels', getLineWidth: 2, getLineColor: [255, 200, 90, 230], parameters: { depthWriteEnabled: false } }));
    }
    return layers;
  }

  return {
    ingest, produce,
    set(opts) { Object.assign(S, opts); },
    select(id) { S.selected = id || null; },
    setReplay(list) { S.replay = list || null; },
    get selected() { return S.selected; },
    has: (id) => buses.has(id),
    get: (id) => buses.get(id) || null,
    now(id) { const f = frame.find((x) => x.id === id); return f ? { lon: f.p.lon, lat: f.p.lat, alt: f.z, heading: f.heading, moving: f.p.moving, s: f.p.s } : null; },
    list() { return [...buses.entries()].map(([id, o]) => ({ id, ...o })); },
    count: () => frame.length,
  };
}
