// Bus stops (King County Metro GTFS) as small markers when zoomed in; tap one for its live arrivals board.
import { D } from './common.js';

export function createStops(transit) {
  const all = Object.entries(transit.raw.stops || {}).map(([id, s]) => ({ id, kind: 'stop', name: s[0], lat: s[1], lon: s[2] }));
  const S = { visible: true, selected: null };
  let cache = { key: '', data: [] };
  function produce(ctx) {
    if (!S.visible || ctx.zoom < 16.2) return [];
    const key = `${Math.round(ctx.center.lng * 200)}:${Math.round(ctx.center.lat * 200)}`;
    if (key !== cache.key) {
      const dLat = 0.012, dLon = 0.018;
      cache = { key, data: all.filter((s) => Math.abs(s.lat - ctx.center.lat) < dLat && Math.abs(s.lon - ctx.center.lng) < dLon) };
    }
    const data = cache.data.map((s) => ({ ...s, z: ctx.ground(s.lon, s.lat) + 0.6 }));
    return [new (D().ScatterplotLayer)({ id: 'stops', data, pickable: true, getPosition: (d) => [d.lon, d.lat, d.z], radiusUnits: 'pixels',
      getRadius: (d) => (d.id === S.selected ? 7 : 4.5), getFillColor: (d) => (d.id === S.selected ? [255, 176, 32, 255] : [240, 244, 248, 235]),
      stroked: true, getLineColor: [20, 40, 70, 230], lineWidthUnits: 'pixels', getLineWidth: 1.5, parameters: { depthCompare: 'always' },
      updateTriggers: { getRadius: S.selected, getFillColor: S.selected } })];
  }
  return {
    produce, all: () => all,
    get: (id) => all.find((s) => s.id === id) || null,
    select(id) { S.selected = id || null; },
    set(o) { Object.assign(S, o); },
  };
}
