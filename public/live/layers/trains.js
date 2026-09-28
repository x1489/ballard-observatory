// Trains: Amtrak Cascades and the Empire Builder on the BNSF line along Ballard's shore, drawn as a locomotive and
// cars that follow the track around curves, moving at the reported speed between Amtrak's position updates.
import { PathTrack } from '../motion.js';
import { measure } from '../geo.js';
import { trainConsist } from '../fleet.js';
import { D, ADDITIVE, ahead, glow } from './common.js';
import { decodePolyline } from '../transit-data.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const MPH = 0.44704;
const MIN_PX = 10;

export function createTrains(railJson) {
  const pts = decodePolyline(railJson.line);
  const north = measure(pts), south = measure([...pts].reverse());
  const trains = new Map();
  const S = { selected: null, visible: true };

  function ingest(data) {
    const now = Date.now();
    for (const tr of (data && data.trains) || []) {
      if (!isNum(tr.lat) || !isNum(tr.lon)) continue;
      const nb = tr.pass ? tr.pass.northbound : /^N/.test(tr.heading || '');
      let o = trains.get(tr.id);
      if (!o || o.nb !== nb) { o = { nb, track: new PathTrack(tr.id, nb ? north : south, { defaultSpeed: 15, maxSpeed: 36, lookaheadS: 150 }) }; trains.set(tr.id, o); }
      o.rec = tr; o.lastSeen = now; o.consist = trainConsist(tr.route);
      o.track.update({ t: isNum(tr.updated) ? Math.min(tr.updated, now) : now, lon: tr.lon, lat: tr.lat, speed: isNum(tr.speedMph) ? tr.speedMph * MPH : null }, now);
    }
    const live = new Set(((data && data.trains) || []).map((t) => t.id));
    for (const [k, o] of trains) if (!live.has(k) && now - o.lastSeen > 3 * 60e3) trains.delete(k);
  }

  let frame = [];
  function produce(ctx) {
    const deck = D();
    frame = [];
    if (!S.visible) return [];
    const byModel = new Map(), lights = [], glows = [];
    const t = ctx.now, night = ctx.glow;
    for (const [id, o] of trains) {
      if (o.track.offRoute || !o.track.fix || o.track.fix.d > 400) continue; // not on the Ballard stretch
      const head = o.track.at(t, 0);
      const c = o.consist;
      const boost = Math.max(1, Math.min(12, (MIN_PX * ctx.mpp) / c.carLen));
      const cars = [];
      let off = 0;
      const nLoco = c.locos || 1;
      for (let i = 0; i < nLoco + c.cars; i++) {
        const len = (i < nLoco ? c.locoLen : c.carLen) * boost;
        const at = o.track.behind(head.s, off + len / 2, 0);
        cars.push({ url: `/models/${i < nLoco ? c.loco : c.car}.glb`, lon: at.lon, lat: at.lat, heading: at.heading });
        off += len + 0.8 * boost;
      }
      const it = { id, kind: 'train', o, head, boost };
      frame.push(it);
      for (const car of cars) {
        const z = Math.max(ctx.ground(car.lon, car.lat), 1.5);
        const d = { ...it, pos: [car.lon, car.lat, z], heading: car.heading };
        if (!byModel.has(car.url)) byModel.set(car.url, []);
        byModel.get(car.url).push(d);
      }
      // headlight + ditch lights, and a beam on the track ahead after dark
      const nose = ahead(head.lon, head.lat, head.heading, 0.5 * boost);
      const z0 = Math.max(ctx.ground(head.lon, head.lat), 1.5);
      const lit = 0.4 + 0.6 * night;
      lights.push({ p: [...nose, z0 + 3.6 * boost], c: [255, 250, 230, 255 * lit], r: 2.4 });
      for (const side of [-1, 1]) lights.push({ p: [...ahead(nose[0], nose[1], head.heading + 90 * side, 1.1 * boost), z0 + 1.4 * boost], c: [255, 245, 220, 255 * lit], r: 2 });
      if (night > 0.2) glows.push({ p: [...ahead(head.lon, head.lat, head.heading, 30 * boost), z0 + 0.5], c: [255, 240, 210, 150 * night], r: 40 });
    }
    const layers = [];
    for (const [url, arr] of byModel) {
      layers.push(new deck.ScenegraphLayer({ id: `train-${url}`, data: arr, scenegraph: url, pickable: true, _lighting: 'pbr',
        getPosition: (d) => d.pos, getOrientation: (d) => [0, 270 - d.heading, 90], getScale: (d) => [d.boost, d.boost, d.boost],
        updateTriggers: { getPosition: t, getOrientation: t, getScale: t } }));
    }
    if (glows.length) layers.push(new deck.IconLayer({ id: 'train-beam', data: glows, getPosition: (d) => d.p, getIcon: () => glow(), sizeUnits: 'pixels', getSize: (d) => d.r * 2, getColor: (d) => d.c, parameters: ADDITIVE }));
    if (lights.length) layers.push(new deck.ScatterplotLayer({ id: 'train-lights', data: lights, getPosition: (d) => d.p, radiusUnits: 'pixels', getRadius: (d) => d.r, getFillColor: (d) => d.c, parameters: ADDITIVE }));
    return layers;
  }

  return {
    ingest, produce,
    set(opts) { Object.assign(S, opts); },
    select(id) { S.selected = id || null; },
    get: (id) => trains.get(id) || null,
    now(id) { const f = frame.find((x) => x.id === id); return f ? { lon: f.head.lon, lat: f.head.lat, alt: 0, heading: f.head.heading } : null; },
    list: () => [...trains.entries()].map(([id, o]) => ({ id, ...o })),
    count: () => frame.length,
  };
}
