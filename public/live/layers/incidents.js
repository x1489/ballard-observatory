// 911 fire and medical dispatches (Seattle Fire real-time) and SDOT traffic incidents as beacons on the ground:
// a light column, expanding rings, and flashing emergency lights while a call is active; fading over two hours.
import { D, ADDITIVE, glow, blink } from './common.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export function incidentCategory(type) {
  const t = String(type || '');
  if (/aid|medic|triaged|low acuity|mci|overdose/i.test(t)) return 'medical';
  if (/fire|smoke|rubbish|brush|explosion|hazmat|burn/i.test(t) && !/alarm/i.test(t)) return 'fire';
  if (/motor vehicle|mvi|collision|vehicle|car /i.test(t)) return 'collision';
  if (/alarm/i.test(t)) return 'alarm';
  if (/rescue|water|marine|boat/i.test(t)) return 'rescue';
  return 'other';
}
export const CAT_COLOR = { fire: [255, 96, 48], medical: [70, 160, 255], collision: [255, 190, 60], alarm: [255, 150, 80], rescue: [60, 220, 220], other: [200, 170, 255], traffic: [255, 200, 70] };

export function createIncidents() {
  let items = [];
  const S = { visible: true, selected: null, hours: 2 };
  function ingest(fire, traffic) {
    const now = Date.now();
    const out = [];
    for (const x of (fire && fire.incidents) || []) {
      if (!isNum(x.lat) || !isNum(x.lon) || !isNum(x.t)) continue;
      const ageH = (now - x.t) / 3600e3;
      if (!x.active && ageH > S.hours) continue;
      out.push({ id: `sfd-${x.id}`, kind: 'incident', src: 'fire', rec: x, cat: incidentCategory(x.type), lon: x.lon, lat: x.lat, t: x.t, active: !!x.active, label: x.type });
    }
    for (const x of (traffic && traffic.incidents) || []) {
      if (!isNum(x.lat) || !isNum(x.lon)) continue;
      out.push({ id: `sdot-${x.id}`, kind: 'incident', src: 'traffic', rec: x, cat: 'traffic', lon: x.lon, lat: x.lat, t: x.t || x.start || now, active: true, label: x.type || x.description || 'Traffic incident' });
    }
    items = out;
  }
  function produce(ctx) {
    const deck = D();
    if (!S.visible || !items.length) return [];
    const t = ctx.now, rings = [], cols = [], flashes = [], labels = [];
    for (const it of items) {
      const z = ctx.ground(it.lon, it.lat);
      const fade = it.active ? 1 : Math.max(0.25, 1 - (t - it.t) / (S.hours * 3600e3));
      const c = CAT_COLOR[it.cat] || CAT_COLOR.other;
      const phase = (it.lon * 1e6) % 2000;
      const k = ((t + phase) % 2200) / 2200;
      if (it.active || fade > 0.5) rings.push({ p: [it.lon, it.lat, z + 0.3], r: 6 + k * 44, c: [...c, 220 * (1 - k) * fade] });
      cols.push({ a: [it.lon, it.lat, z], b: [it.lon, it.lat, z + (it.active ? 70 : 35)], c: [...c, 200 * fade] });
      if (it.active) {
        const red = blink(t, 700, 350, phase), alt = it.cat === 'traffic' ? [255, 200, 60] : red ? [255, 30, 30] : it.cat === 'medical' ? [255, 255, 255] : [255, 255, 255];
        flashes.push({ p: [it.lon, it.lat, z + 3], c: [...alt, 200], r: 30 + 8 * Math.sin(t / 90) });
      }
      if (ctx.zoom > 14.2) labels.push({ ...it, p: [it.lon, it.lat, z + (it.active ? 72 : 37)] });
    }
    const layers = [
      new deck.LineLayer({ id: 'inc-cols', data: cols, getSourcePosition: (d) => d.a, getTargetPosition: (d) => d.b, getColor: (d) => d.c, getWidth: 3, widthUnits: 'pixels', parameters: ADDITIVE }),
      new deck.ScatterplotLayer({ id: 'inc-rings', data: rings, getPosition: (d) => d.p, stroked: true, filled: false, radiusUnits: 'pixels', getRadius: (d) => d.r,
        lineWidthUnits: 'pixels', getLineWidth: 2, getLineColor: (d) => d.c, parameters: ADDITIVE, updateTriggers: { getRadius: t, getLineColor: t } }),
      new deck.IconLayer({ id: 'inc-flash', data: flashes, getPosition: (d) => d.p, getIcon: () => glow(), sizeUnits: 'pixels', getSize: (d) => d.r * 2, getColor: (d) => d.c, parameters: ADDITIVE }),
      new deck.ScatterplotLayer({ id: 'inc-pick', data: items, pickable: true, getPosition: (d) => [d.lon, d.lat, ctx.ground(d.lon, d.lat) + 2], radiusUnits: 'pixels', getRadius: 12,
        getFillColor: (d) => [...(CAT_COLOR[d.cat] || CAT_COLOR.other), d.active ? 255 : 150], stroked: true, getLineColor: [255, 255, 255, 230], lineWidthUnits: 'pixels', getLineWidth: (d) => (d.active ? 2 : 1) }),
    ];
    if (labels.length) {
      layers.push(new deck.TextLayer({ id: 'inc-labels', data: labels, getPosition: (d) => d.p, getText: (d) => String(d.label || '').slice(0, 34), getSize: 11,
        getColor: [255, 255, 255, 235], getPixelOffset: [0, -10], fontFamily: 'Inter, system-ui, sans-serif', fontWeight: 600, characterSet: 'auto',
        outlineWidth: 3, outlineColor: [8, 10, 14, 220], fontSettings: { sdf: true, fontSize: 48, buffer: 6 }, parameters: { depthCompare: 'always', depthWriteEnabled: false } }));
    }
    return layers;
  }
  return {
    ingest, produce,
    set(opts) { Object.assign(S, opts); },
    list: () => items,
    get: (id) => items.find((x) => x.id === id) || null,
    now(id) { const x = items.find((i) => i.id === id); return x ? { lon: x.lon, lat: x.lat, alt: 0, heading: 0 } : null; },
    count: () => items.filter((x) => x.active).length,
  };
}
