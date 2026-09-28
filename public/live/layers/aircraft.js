// Aircraft: every ADS-B target around Ballard as a 3D model of its type, scaled to the real length and wingspan,
// at its real altitude (pressure altitude corrected with the local sea-level pressure), dead-reckoned between
// reports so it flies smoothly, banking into turns. Trails coloured by altitude, navigation lights and strobes and
// landing lights after dark, a sun-cast shadow on the ground in daylight, floats on floatplanes.
import { FlightTrack, KT, FPM, FT } from '../motion.js';
import { aircraftSpec } from '../fleet.js';
import { D, ADDITIVE, ahead, SILHOUETTE, silhouetteFor, glow, altColor, blink } from './common.js';
import { toRad } from '../geo.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const MIN_PX = 26;           // an aircraft is never drawn shorter than this on screen
const T0 = Date.now() / 1000; // trail timestamps are relative to page load (float32 precision)

export function createAircraft() {
  const tracks = new Map(); // hex -> { track, rec, spec, lastSeen }
  const S = { selected: null, hover: null, qnh: null, visible: true, labels: true, trails: true, thermal: false };

  function ingest(data) {
    const now = Date.now();
    for (const a of (data && data.aircraft) || []) {
      if (!isNum(a.lat) || !isNum(a.lon) || !a.hex) continue;
      let o = tracks.get(a.hex);
      if (!o) { o = { track: new FlightTrack(a.hex), spec: null, specKey: null }; tracks.set(a.hex, o); }
      const key = `${a.type}|${a.kind}|${a.category}`;
      if (o.specKey !== key) { o.spec = aircraftSpec(a); o.specKey = key; }
      o.rec = a; o.lastSeen = now;
      o.track.update({
        t: isNum(a.t) ? a.t : now, lon: a.lon, lat: a.lat, alt: a.onGround ? 0 : (isNum(a.altFt) ? a.altFt : 0) * FT,
        gs: (isNum(a.gsKt) ? a.gsKt : 0) * KT, trk: isNum(a.track) ? a.track : null, vr: (isNum(a.vrFpm) ? a.vrFpm : 0) * FPM, onGround: !!a.onGround,
      }, now);
    }
    for (const [k, o] of tracks) if (now - o.lastSeen > 90e3) tracks.delete(k);
  }
  /** Sea-level pressure (hPa) to turn ADS-B pressure altitude into height above sea level. */
  const setQnh = (hpa) => { S.qnh = isNum(hpa) && hpa > 900 && hpa < 1090 ? hpa : null; };
  const qnhOffsetM = () => (S.qnh ? (S.qnh - 1013.25) * 8.23 : 0);

  let frame = [], trailData = [], trailAt = 0;
  function state(o, ctx) {
    const s = o.track.at(ctx.now);
    const g = ctx.ground(s.lon, s.lat);
    const onGround = o.track.fix.onGround;
    const z = onGround ? g + o.spec.height * 0.5 : Math.max(g + 6, s.alt + qnhOffsetM());
    return { s, z, g, agl: z - g };
  }

  function produce(ctx) {
    const deck = D();
    frame = [];
    if (!S.visible) return [];
    const byModel = new Map(), floats = [], lights = [], glows = [], shadows = [], labels = [];
    const rebuildTrails = ctx.now - trailAt > 250;
    const trails = rebuildTrails ? [] : trailData;
    if (rebuildTrails) { trailAt = ctx.now; trailData = trails; }
    const sun = ctx.sun, dayShadow = sun.elevation > 6;
    const shadowLen = dayShadow ? 1 / Math.tan(toRad(sun.elevation)) : 0;
    const t = ctx.now, night = ctx.glow; // 0 day .. 1 night
    for (const [hex, o] of tracks) {
      const { s, z, agl } = state(o, ctx);
      if (s.age > 75) continue;
      o.track.record(t, { lon: s.lon, lat: s.lat, alt: z });
      const boost = Math.max(1, Math.min(80, (MIN_PX * ctx.mpp) / o.spec.len));
      const it = { id: hex, kind: 'aircraft', o, s, z, agl, boost, pos: [s.lon, s.lat, z] };
      frame.push(it);
      if (!byModel.has(o.spec.url)) byModel.set(o.spec.url, []);
      byModel.get(o.spec.url).push(it);
      if (o.spec.floats) floats.push(it);
      // trail (rebuilt 4x a second; the layer animates between rebuilds on its own clock)
      if (rebuildTrails && S.trails && o.track.trail.length > 1) {
        const path = o.track.trail.map((p) => [p[0], p[1], p[2]]), ts = o.track.trail.map((p) => p[3] - T0);
        path.push([s.lon, s.lat, z]); ts.push(t / 1000 - T0);
        trails.push({ path, ts, color: altColor((o.rec.altFt || 0)), sel: hex === S.selected });
      }
      // lights: nav (red port / green starboard / white tail), beacon, strobes, landing lights below 10,000 ft
      const half = (o.spec.span / 2) * boost, tail = (o.spec.len / 2) * boost, top = z + (o.spec.height / 2) * boost;
      const L = ahead(s.lon, s.lat, s.heading - 90, half), R = ahead(s.lon, s.lat, s.heading + 90, half), TL = ahead(s.lon, s.lat, s.heading + 180, tail);
      const litNav = 0.35 + 0.65 * night;
      lights.push({ p: [...L, z], c: [255, 40, 40, 255 * litNav], r: 2.2 }, { p: [...R, z], c: [40, 255, 90, 255 * litNav], r: 2.2 }, { p: [...TL, z], c: [255, 255, 255, 200 * litNav], r: 1.8 });
      const phase = parseInt(hex.slice(-3), 16) || 0;
      if (blink(t, 1100, 110, phase)) { lights.push({ p: [s.lon, s.lat, top], c: [255, 30, 30, 255], r: 3.2 }); glows.push({ p: [s.lon, s.lat, top], c: [255, 30, 30, 170], r: 16 }); }
      if (blink(t, 1300, 60, phase * 3) || blink(t, 1300, 60, phase * 3 + 150)) {
        for (const w of [L, R]) { lights.push({ p: [...w, z], c: [255, 255, 255, 255], r: 3 }); glows.push({ p: [...w, z], c: [220, 235, 255, 200], r: 20 }); }
      }
      if (!o.track.fix.onGround && (o.rec.altFt || 0) < 10000 && night > 0.3) {
        const nose = ahead(s.lon, s.lat, s.heading, (o.spec.len / 2) * boost);
        glows.push({ p: [...nose, z], c: [255, 250, 225, 230 * night], r: 26 });
        lights.push({ p: [...nose, z], c: [255, 255, 240, 255], r: 3.4 });
      }
      // sun-cast shadow on the ground (daytime, fades with height)
      if (dayShadow && agl < 1500) {
        const d = agl * shadowLen;
        const gp = ahead(s.lon, s.lat, sun.azimuth + 180, d);
        const alpha = 0.55 * Math.max(0, 1 - agl / 1500);
        shadows.push({ p: [...gp, ctx.ground(gp[0], gp[1]) + 0.4], icon: silhouetteFor(o.spec.model), size: o.spec.len * boost * 1.02, angle: -s.heading, a: alpha * 255 });
      }
      if (S.labels) labels.push(it);
    }
    const layers = [];
    if (trails.length) {
      layers.push(new deck.TripsLayer({ id: 'ac-trails', data: trails, getPath: (d) => d.path, getTimestamps: (d) => d.ts,
        getColor: (d) => [...d.color, d.sel ? 255 : 190], currentTime: t / 1000 - T0, trailLength: 150, fadeTrail: true,
        widthUnits: 'pixels', getWidth: (d) => (d.sel ? 3.5 : 2), capRounded: true, jointRounded: true, parameters: { depthWriteEnabled: false } }));
    }
    if (shadows.length) {
      layers.push(new deck.IconLayer({ id: 'ac-shadows', data: shadows, billboard: false, sizeUnits: 'meters', getPosition: (d) => d.p,
        getIcon: (d) => ({ url: SILHOUETTE[d.icon], width: 128, height: 128, mask: true }), getSize: (d) => d.size, getAngle: (d) => d.angle,
        getColor: (d) => [8, 12, 18, d.a], parameters: { depthWriteEnabled: false } }));
    }
    for (const [url, arr] of byModel) {
      layers.push(new deck.ScenegraphLayer({ id: `ac-model-${url}`, data: arr, scenegraph: url, pickable: true, _lighting: 'pbr',
        getPosition: (d) => d.pos, getOrientation: (d) => [d.s.pitch, 270 - d.s.heading, 90 - d.s.bank],
        getScale: (d) => d.o.spec.scale.map((v) => v * d.boost), getColor: S.thermal ? [255, 255, 255, 255] : [255, 255, 255, 255],
        updateTriggers: { getPosition: t, getOrientation: t, getScale: t } }));
    }
    if (floats.length) {
      layers.push(new deck.ScenegraphLayer({ id: 'ac-floats', data: floats, scenegraph: '/models/floats.glb', _lighting: 'pbr', getPosition: (d) => d.pos,
        getOrientation: (d) => [d.s.pitch, 270 - d.s.heading, 90 - d.s.bank], getScale: (d) => d.o.spec.scale.map((v) => v * d.boost), updateTriggers: { getPosition: t, getOrientation: t, getScale: t } }));
    }
    if (glows.length) {
      layers.push(new deck.IconLayer({ id: 'ac-glow', data: glows, getPosition: (d) => d.p, getIcon: () => glow(), sizeUnits: 'pixels', getSize: (d) => d.r * 2,
        getColor: (d) => d.c, parameters: ADDITIVE }));
    }
    if (lights.length) {
      layers.push(new deck.ScatterplotLayer({ id: 'ac-lights', data: lights, getPosition: (d) => d.p, radiusUnits: 'pixels', getRadius: (d) => d.r,
        getFillColor: (d) => d.c, parameters: ADDITIVE }));
    }
    if (labels.length && ctx.zoom > 10.5) {
      layers.push(new deck.TextLayer({ id: 'ac-labels', data: labels, getPosition: (d) => d.pos, pickable: true,
        getText: (d) => `${d.o.rec.callsign || d.o.rec.reg || d.id.toUpperCase()}  ${d.o.track.fix.onGround ? 'GND' : Math.round(((d.o.rec.altFt || 0)) / 100) * 100}`,
        getSize: (d) => (d.id === S.selected ? 13 : 11.5), getColor: (d) => (d.id === S.selected ? [255, 255, 255, 255] : [230, 238, 248, 225]),
        getPixelOffset: [0, -22], fontFamily: 'Inter, system-ui, sans-serif', fontWeight: 600, characterSet: 'auto',
        outlineWidth: 3, outlineColor: [6, 10, 16, 210], fontSettings: { sdf: true, fontSize: 48, buffer: 6 },
        parameters: { depthCompare: 'always', depthWriteEnabled: false }, updateTriggers: { getText: Math.floor(t / 1000), getSize: S.selected, getColor: S.selected } }));
    }
    const sel = S.selected && frame.find((f) => f.id === S.selected);
    if (sel) {
      layers.push(new deck.LineLayer({ id: 'ac-stem', data: [sel], getSourcePosition: (d) => [d.s.lon, d.s.lat, d.z - d.agl], getTargetPosition: (d) => d.pos,
        getColor: [120, 200, 255, 160], getWidth: 1.5, widthUnits: 'pixels', parameters: { depthWriteEnabled: false } }));
      layers.push(new deck.ScatterplotLayer({ id: 'ac-ring', data: [sel], getPosition: (d) => [d.s.lon, d.s.lat, d.z - d.agl + 0.5], stroked: true, filled: false,
        radiusUnits: 'pixels', getRadius: 16 + 5 * Math.sin(t / 300), lineWidthUnits: 'pixels', getLineWidth: 2, getLineColor: [120, 200, 255, 220], parameters: { depthWriteEnabled: false } }));
    }
    return layers;
  }

  return {
    ingest, produce, setQnh,
    set(opts) { Object.assign(S, opts); },
    get selected() { return S.selected; },
    select(hex) { S.selected = hex || null; },
    has: (hex) => tracks.has(hex),
    record: (hex) => (tracks.get(hex) || {}).rec || null,
    spec: (hex) => (tracks.get(hex) || {}).spec || null,
    trail: (hex) => (tracks.get(hex) || { track: { trail: [] } }).track.trail,
    /** Current drawn state (lon, lat, alt m, heading, pitch, bank, gs) or null. */
    now(hex) { const f = frame.find((x) => x.id === hex); return f ? { lon: f.s.lon, lat: f.s.lat, alt: f.z, agl: f.agl, heading: f.s.heading, pitch: f.s.pitch, bank: f.s.bank, gs: f.s.gs, vr: f.s.vr, age: f.s.age } : null; },
    list() { return [...tracks.entries()].map(([hex, o]) => ({ hex, rec: o.rec, spec: o.spec, lastSeen: o.lastSeen })); },
    count: () => frame.length,
  };
}
