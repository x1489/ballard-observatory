// Drawbridges: when SDOT reports the Ballard or Fremont Bridge up, its two bascule leaves rise in 3D (at the pace of
// the real machinery) and the deck in the aerial photo gives way to open water; they come down when SDOT says so.
// Also the deck profile, so buses crossing the Ballard Bridge ride on the bridge rather than the water.
import { D, ahead } from './common.js';
import { distM, bearing, angDiff, toRad } from '../geo.js';

const RAISED = 74;      // degrees at full opening
const RATE = 1.15;      // degrees per second (a bascule takes about a minute to open)

export function createBridges(geo, ground) {
  const B = geo.bridges.map((b) => ({ ...b, angle: 0, target: 0, up: false, since: null, seen: false }));
  let last = 0;
  const S = { visible: true, selected: null };

  function ingest(data) {
    for (const lb of (data && data.bridges) || []) {
      const b = B.find((x) => x.id === lb.id || x.name === lb.name);
      if (!b) continue;
      b.up = !!lb.up; b.since = lb.since || null; b.target = b.up ? RAISED : 0;
      if (!b.seen) { b.angle = b.target; b.seen = true; } // no animation on first load
    }
  }
  const centerZ = (b) => ground(b.center[0], b.center[1]);

  /** Deck elevation (m) if (lon,lat) is on a bridge deck corridor, else null. */
  function deckZ(lon, lat) {
    for (const b of B) {
      const d = b.deck; if (!d) continue;
      const L = distM(d.from[0], d.from[1], d.to[0], d.to[1]);
      const brg = bearing(d.from[0], d.from[1], d.to[0], d.to[1]);
      const r = distM(d.from[0], d.from[1], lon, lat), br = bearing(d.from[0], d.from[1], lon, lat);
      const along = r * Math.cos(toRad(angDiff(brg, br))), across = Math.abs(r * Math.sin(toRad(angDiff(brg, br))));
      if (across > d.corridorM || along < 0 || along > L) continue;
      const cAlong = distM(d.from[0], d.from[1], b.center[0], b.center[1]);
      const top = centerZ(b) + b.clearanceM + 1.6;
      const gEnd = along < cAlong ? ground(d.from[0], d.from[1]) : ground(d.to[0], d.to[1]);
      const span = along < cAlong ? cAlong : L - cAlong;
      const off = Math.abs(along - cAlong), plateau = b.leafLen * 1.6;
      const f = off <= plateau ? 1 : Math.max(0, 1 - (off - plateau) / Math.max(1, span - plateau));
      return gEnd + (top - gEnd) * f;
    }
    return null;
  }

  function produce(ctx) {
    const deck = D();
    const dt = last ? Math.min(0.25, (ctx.ts - last) / 1000) : 0;
    last = ctx.ts;
    const leaves = new Map(), water = [];
    for (const b of B) {
      if (b.angle !== b.target) b.angle = b.angle < b.target ? Math.min(b.target, b.angle + RATE * dt) : Math.max(b.target, b.angle - RATE * dt);
      if (!S.visible || b.angle < 0.3) continue;
      const zc = centerZ(b), z = zc + b.clearanceM + 1.6;
      for (const [dir, h] of [[b.axis + 180, b.axis], [b.axis, b.axis + 180]]) {
        const hinge = ahead(b.center[0], b.center[1], dir, b.leafLen);
        const url = `/models/${b.model}.glb`;
        if (!leaves.has(url)) leaves.set(url, []);
        leaves.get(url).push({ id: b.name, kind: 'bridge', b, pos: [...hinge, z], heading: h, angle: b.angle });
      }
      if (b.angle > 6) {
        const hw = b.width / 2 + 1.5, hl = b.leafLen;
        const c = (a, d1, d2) => ahead(...ahead(b.center[0], b.center[1], b.axis, a * hl), b.axis + 90, d2 * hw);
        water.push({ b, poly: [c(-1, 0, -1), c(1, 0, -1), c(1, 0, 1), c(-1, 0, 1)].map((p) => [...p, zc + 0.35]), a: Math.min(1, (b.angle - 6) / 20) });
      }
    }
    const layers = [];
    if (water.length) {
      const L = ctx.look;
      layers.push(new deck.SolidPolygonLayer({ id: 'bridge-water', data: water, getPolygon: (d) => d.poly, extruded: false,
        getFillColor: (d) => [L.night ? 12 : 44, L.night ? 20 : 62, L.night ? 26 : 66, 245 * d.a], parameters: { depthWriteEnabled: false } }));
    }
    for (const [url, arr] of leaves) {
      layers.push(new deck.ScenegraphLayer({ id: `bridge-${url}`, data: arr, scenegraph: url, pickable: true, _lighting: 'pbr',
        getPosition: (d) => d.pos, getOrientation: (d) => [d.angle, 270 - d.heading, 90], updateTriggers: { getOrientation: ctx.now } }));
    }
    return layers;
  }

  return {
    ingest, produce, deckZ,
    set(opts) { Object.assign(S, opts); },
    list: () => B,
    get: (name) => B.find((b) => b.name === name) || null,
    now(name) { const b = B.find((x) => x.name === name); return b ? { lon: b.center[0], lat: b.center[1], alt: 0, heading: b.axis } : null; },
  };
}
