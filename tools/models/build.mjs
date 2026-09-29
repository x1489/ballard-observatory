// Builds the procedural 3D models the live scene uses for things no suitable openly licensed model exists for:
// King County Metro buses (40 ft, 60 ft articulated front and rear sections, trolleybuses with poles) in Metro's
// liveries, Amtrak locomotives and cars, floats for floatplanes, and drawbridge leaves. Real dimensions, in metres.
//
// Convention (shared with the aircraft models in public/models): glTF +Y up, nose/front toward -X, origin at the
// centre of the footprint at ground level (vehicles) or at the hinge (bridge leaves). Port/left side is +Z.
// Run: node tools/models/build.mjs   (writes public/models/*.glb; no dependencies)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/models');

// ------------------------------------------------------------------ vector helpers
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lin = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => (c / 255) ** 2.2); };

// ------------------------------------------------------------------ mesh builder
export class Model {
  constructor(name) { this.name = name; this.mats = new Map(); this.parts = new Map(); }
  mat(name, { color = '#ffffff', metallic = 0, roughness = 0.6, emissive = null, alpha = 1 } = {}) {
    this.mats.set(name, { color, metallic, roughness, emissive, alpha });
    return name;
  }
  part(m) {
    if (!this.mats.has(m)) throw new Error(`${this.name}: unknown material ${m}`);
    if (!this.parts.has(m)) this.parts.set(m, { pos: [], nrm: [], idx: [] });
    return this.parts.get(m);
  }
  poly(m, pts, n = null) { // planar convex polygon, counter-clockwise seen from outside
    const p = this.part(m);
    const nn = n || norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
    const base = p.pos.length / 3;
    for (const v of pts) { p.pos.push(...v); p.nrm.push(...nn); }
    for (let i = 1; i < pts.length - 1; i++) p.idx.push(base, base + i, base + i + 1);
  }
  box(m, [x0, y0, z0], [x1, y1, z1], { skip = '' } = {}) {
    if (!skip.includes('+x')) this.poly(m, [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]);
    if (!skip.includes('-x')) this.poly(m, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]);
    if (!skip.includes('+y')) this.poly(m, [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]);
    if (!skip.includes('-y')) this.poly(m, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
    if (!skip.includes('+z')) this.poly(m, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
    if (!skip.includes('-z')) this.poly(m, [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]);
  }
  /** A side-profile polygon (x,y; convex, counter-clockwise seen from +z) extruded across z0..z1. */
  prism(m, prof, z0, z1, { sideMat = m } = {}) {
    this.poly(sideMat, prof.map(([x, y]) => [x, y, z1]));
    this.poly(sideMat, [...prof].reverse().map(([x, y]) => [x, y, z0]));
    for (let i = 0; i < prof.length; i++) {
      const [ax, ay] = prof[i], [bx, by] = prof[(i + 1) % prof.length];
      this.poly(m, [[ax, ay, z0], [bx, by, z0], [bx, by, z1], [ax, ay, z1]].reverse());
    }
  }
  /** Cylinder between points a and b (any direction). */
  cyl(m, a, b, r, seg = 14, caps = true) {
    const ax = norm(sub(b, a));
    const ref = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(ax, ref)), v = cross(ax, u);
    const p = this.part(m);
    const ring = (c) => Array.from({ length: seg }, (_, i) => { const t = (i / seg) * Math.PI * 2; const d = [u[0] * Math.cos(t) + v[0] * Math.sin(t), u[1] * Math.cos(t) + v[1] * Math.sin(t), u[2] * Math.cos(t) + v[2] * Math.sin(t)]; return { pt: [c[0] + d[0] * r, c[1] + d[1] * r, c[2] + d[2] * r], n: d }; });
    const ra = ring(a), rb = ring(b);
    const base = p.pos.length / 3;
    for (const q of [...ra, ...rb]) { p.pos.push(...q.pt); p.nrm.push(...q.n); }
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      p.idx.push(base + i, base + seg + i, base + seg + j, base + i, base + seg + j, base + j);
    }
    if (caps) {
      this.poly(m, [...ra].reverse().map((q) => q.pt), ax.map((x) => -x));
      this.poly(m, rb.map((q) => q.pt), ax);
    }
  }
  /** A streamlined body along x: stations [x, halfWidth(z), halfHeight(y), centreY], elliptical sections. */
  loft(m, stations, seg = 16, cz = 0) {
    const p = this.part(m);
    const rings = stations.map(([x, rz, ry, cy]) => Array.from({ length: seg }, (_, i) => {
      const t = (i / seg) * Math.PI * 2;
      return { pt: [x, cy + Math.sin(t) * ry, cz + Math.cos(t) * rz], n: norm([0, Math.sin(t) / Math.max(ry, 1e-3), Math.cos(t) / Math.max(rz, 1e-3)]) };
    }));
    for (let s = 0; s < rings.length - 1; s++) {
      const base = p.pos.length / 3;
      for (const q of [...rings[s], ...rings[s + 1]]) { p.pos.push(...q.pt); p.nrm.push(...q.n); }
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        p.idx.push(base + i, base + j, base + seg + j, base + i, base + seg + j, base + seg + i);
      }
    }
  }
  glb() {
    const bufs = [], views = [], accessors = [], meshPrims = [], materials = [];
    let off = 0;
    const push = (typed, target) => {
      const b = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
      const pad = (4 - (b.length % 4)) % 4;
      bufs.push(b, Buffer.alloc(pad));
      views.push({ buffer: 0, byteOffset: off, byteLength: b.length, target });
      off += b.length + pad;
      return views.length - 1;
    };
    const matIndex = new Map();
    for (const [name, m] of this.mats) {
      if (!this.parts.has(name)) continue;
      const mat = { name, pbrMetallicRoughness: { baseColorFactor: [...lin(m.color), m.alpha], metallicFactor: m.metallic, roughnessFactor: m.roughness }, doubleSided: true };
      if (m.emissive) mat.emissiveFactor = lin(m.emissive);
      if (m.alpha < 1) mat.alphaMode = 'BLEND';
      matIndex.set(name, materials.length);
      materials.push(mat);
    }
    for (const [name, p] of this.parts) {
      const pos = new Float32Array(p.pos), nrm = new Float32Array(p.nrm);
      const idx = pos.length / 3 > 65535 ? new Uint32Array(p.idx) : new Uint16Array(p.idx);
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], pos[i + k]); mx[k] = Math.max(mx[k], pos[i + k]); }
      const vp = push(pos, 34962), vn = push(nrm, 34962), vi = push(idx, 34963);
      accessors.push({ bufferView: vp, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: mn, max: mx });
      accessors.push({ bufferView: vn, componentType: 5126, count: nrm.length / 3, type: 'VEC3' });
      accessors.push({ bufferView: vi, componentType: idx instanceof Uint32Array ? 5125 : 5123, count: idx.length, type: 'SCALAR' });
      const a = accessors.length - 3;
      meshPrims.push({ attributes: { POSITION: a, NORMAL: a + 1 }, indices: a + 2, material: matIndex.get(name) });
    }
    const bin = Buffer.concat(bufs);
    const json = {
      asset: { version: '2.0', generator: 'ballard-observatory tools/models/build.mjs' },
      scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: this.name, mesh: 0 }], meshes: [{ name: this.name, primitives: meshPrims }],
      materials, accessors, bufferViews: views, buffers: [{ byteLength: bin.length }],
    };
    let js = Buffer.from(JSON.stringify(json));
    js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
    const ch = (buf, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(buf.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, buf]); };
    return Buffer.concat([header, ch(js, 0x4e4f534a), ch(bin, 0x004e4942)]);
  }
}

// ------------------------------------------------------------------ King County Metro buses
// Livery (King County Metro fleet, Wikipedia): regular buses yellow on the lower half with teal, blue or green on
// top; red for RapidRide; purple for electric trolleybuses.
const KCM = { yellow: '#f0b81c', teal: '#157f86', blue: '#1d4f9a', green: '#3c8a3f', red: '#cf2a27', purple: '#5f3a8c' };

function busMaterials(M, top) {
  M.mat('lower', { color: KCM.yellow, roughness: 0.42, metallic: 0.05 });
  M.mat('top', { color: top, roughness: 0.4, metallic: 0.05 });
  M.mat('roof', { color: '#d8dce0', roughness: 0.55 });
  M.mat('glass', { color: '#0d1319', roughness: 0.08, metallic: 0.35 });
  M.mat('trim', { color: '#26292d', roughness: 0.7 });
  M.mat('tire', { color: '#141414', roughness: 0.9 });
  M.mat('hub', { color: '#9aa1a8', roughness: 0.35, metallic: 0.6 });
  M.mat('sign', { color: '#402a00', emissive: '#ffb020', roughness: 0.5 });
  M.mat('head', { color: '#fffbe8', emissive: '#fff4d6', roughness: 0.2 });
  M.mat('tail', { color: '#5a0000', emissive: '#ff2a1a', roughness: 0.3 });
  M.mat('pole', { color: '#1f2124', roughness: 0.6, metallic: 0.4 });
  M.mat('bellows', { color: '#191a1c', roughness: 0.95 });
}

/**
 * One bus body section from x0 (front) to x1 (rear). front/rear: 'cab' (windshield, lights, sign), 'rear'
 * (engine end, tail lights), 'joint' (articulation). Doors (on the curb side, -Z) at the given x centres.
 */
function busSection(M, { x0, x1, front, rear, doors = [], axles = [], pods = [] }) {
  const W = 2.59 / 2, yB = 0.32, yL = 1.12, yG = 2.38, yT = 3.02;
  M.box('lower', [x0, yB, -W], [x1, yL, W], { skip: '-y' });
  M.box('glass', [x0 + 0.02, yL, -W + 0.015], [x1 - 0.02, yG, W - 0.015], { skip: '-y+y' });
  M.box('top', [x0, yG, -W], [x1, yT - 0.08, W], { skip: '-y' });
  // rounded roof edge + roof
  M.prism('roof', [[x0 + 0.05, yT - 0.08], [x1 - 0.05, yT - 0.08], [x1 - 0.1, yT], [x0 + 0.1, yT]].reverse().map(([x, y]) => [x, y]).reverse(), -W + 0.06, W - 0.06);
  // window pillars on both sides
  for (let x = x0 + 1.0; x < x1 - 0.6; x += 1.45) {
    for (const s of [-1, 1]) M.box('top', [x, yL, s > 0 ? W - 0.02 : -W - 0.005], [x + 0.12, yG, s > 0 ? W + 0.005 : -W + 0.02]);
  }
  for (const dx of doors) {
    M.box('glass', [dx - 0.62, yB + 0.02, -W - 0.012], [dx + 0.62, yG - 0.05, -W + 0.01]);
    M.box('trim', [dx - 0.66, yB + 0.02, -W - 0.014], [dx - 0.6, yG - 0.02, -W + 0.01]);
    M.box('trim', [dx + 0.6, yB + 0.02, -W - 0.014], [dx + 0.66, yG - 0.02, -W + 0.01]);
  }
  for (const ax of axles) {
    for (const s of [-1, 1]) {
      const z0 = s * (W - 0.02), z1 = s * (W - 0.32);
      M.cyl('tire', [ax, 0.5, z0], [ax, 0.5, z1], 0.5, 18);
      M.cyl('hub', [ax, 0.5, z0 + s * 0.012], [ax, 0.5, z0 - s * 0.02], 0.26, 12);
      M.box('trim', [ax - 0.62, yB, s > 0 ? W - 0.01 : -W - 0.004], [ax + 0.62, yB + 0.08, s > 0 ? W + 0.004 : -W + 0.01]);
    }
  }
  for (const [cx, len, h] of pods) M.box('roof', [cx - len / 2, yT, -0.85], [cx + len / 2, yT + h, 0.85]);
  if (front === 'cab') {
    const x = x0 - 0.012;
    M.poly('glass', [[x, 0.95, W - 0.08], [x, 0.95, -W + 0.08], [x, 2.72, -W + 0.08], [x, 2.72, W - 0.08]]);
    M.poly('sign', [[x - 0.004, 2.5, W - 0.25], [x - 0.004, 2.5, -W + 0.25], [x - 0.004, 2.74, -W + 0.25], [x - 0.004, 2.74, W - 0.25]]);
    M.box('trim', [x0 - 0.08, yB, -W + 0.02], [x0 + 0.02, 0.62, W - 0.02]);
    for (const s of [-1, 1]) M.box('head', [x0 - 0.03, 0.66, s > 0 ? W - 0.42 : -W + 0.12], [x0 + 0.01, 0.84, s > 0 ? W - 0.12 : -W + 0.42]);
  }
  if (rear === 'rear') {
    const x = x1 + 0.012;
    M.poly('glass', [[x, 1.3, -W + 0.2], [x, 1.3, W - 0.2], [x, 2.3, W - 0.2], [x, 2.3, -W + 0.2]]);
    M.box('trim', [x1 - 0.02, yB, -W + 0.02], [x1 + 0.08, 0.62, W - 0.02]);
    for (const s of [-1, 1]) M.box('tail', [x1 - 0.01, 0.7, s > 0 ? W - 0.34 : -W + 0.08], [x1 + 0.03, 1.1, s > 0 ? W - 0.08 : -W + 0.34]);
  }
  if (front === 'joint') M.box('bellows', [x0 - 0.46, 0.4, -W + 0.05], [x0 + 0.02, 2.95, W - 0.05]);
  if (rear === 'joint') M.box('bellows', [x1 - 0.02, 0.4, -W + 0.05], [x1 + 0.46, 2.95, W - 0.05]);
}

function poles(M, xBase, yRoof = 3.05) {
  for (const z of [-0.32, 0.32]) {
    M.box('pole', [xBase - 0.25, yRoof, z - 0.1], [xBase + 0.35, yRoof + 0.18, z + 0.1]);
    M.cyl('pole', [xBase, yRoof + 0.15, z], [xBase + 5.9, yRoof + 2.5, z], 0.035, 6, false);
  }
}

function bus40(top, { trolley = false } = {}) {
  const M = new Model(trolley ? 'trolley40' : 'bus40');
  busMaterials(M, top);
  const L = 12.2;
  busSection(M, { x0: -L / 2, x1: L / 2, front: 'cab', rear: 'rear', doors: [-L / 2 + 1.35, 0.9], axles: [-L / 2 + 2.45, L / 2 - 3.05],
    pods: trolley ? [[-1.8, 2.4, 0.34], [2.6, 2.2, 0.3]] : [[-2.2, 3.2, 0.3], [3.4, 2.4, 0.36]] });
  if (trolley) poles(M, 0.6);
  return M;
}
/** Articulated bus, front section: 11.0 m, nose at -5.5, joint (bellows half) behind +5.5. */
function bus60front(top, { trolley = false } = {}) {
  const M = new Model('bus60-front');
  busMaterials(M, top);
  busSection(M, { x0: -5.5, x1: 5.5, front: 'cab', rear: 'joint', doors: [-4.15, 2.3], axles: [-3.05, 3.3], pods: [[-1.2, 3.0, 0.32]] });
  if (trolley) poles(M, 3.4);
  return M;
}
/** Articulated bus, rear section: 7.3 m, joint at -3.65, rear at +3.65. */
function bus60rear(top) {
  const M = new Model('bus60-rear');
  busMaterials(M, top);
  busSection(M, { x0: -3.65, x1: 3.65, front: 'joint', rear: 'rear', doors: [-2.4], axles: [1.25], pods: [[1.2, 2.4, 0.36]] });
  return M;
}

// ------------------------------------------------------------------ Amtrak (Cascades and long-distance)
function trainMaterials(M, liv) {
  M.mat('body', { color: liv.body, roughness: 0.38, metallic: liv.metal || 0.1 });
  M.mat('band', { color: liv.band, roughness: 0.4 });
  M.mat('stripe', { color: liv.stripe, roughness: 0.4 });
  M.mat('roof', { color: liv.roof, roughness: 0.55, metallic: 0.2 });
  M.mat('glass', { color: '#0c1116', roughness: 0.08, metallic: 0.35 });
  M.mat('truck', { color: '#1c1d1f', roughness: 0.85 });
  M.mat('head', { color: '#fffbe8', emissive: '#fff4d6', roughness: 0.2 });
  M.mat('tail', { color: '#5a0000', emissive: '#ff2a1a', roughness: 0.3 });
}
const LIV = {
  cascades: { body: '#e9e0c9', band: '#2f5b41', stripe: '#6b4a30', roof: '#b9b3a5' },
  amtrak: { body: '#c7ccd2', band: '#1d3557', stripe: '#c8102e', roof: '#9aa0a6', metal: 0.55 },
};
function locomotive(liv) {
  const M = new Model('locomotive');
  trainMaterials(M, liv);
  const L = 21.6, W = 3.1 / 2, y0 = 1.0, H = 4.25;
  // side profile: sloped cab nose at -X
  M.prism('body', [[-L / 2, y0], [L / 2, y0], [L / 2, H - 0.2], [L / 2 - 0.3, H], [-L / 2 + 2.3, H], [-L / 2 + 0.6, 2.6], [-L / 2, 2.1]], -W, W);
  M.box('band', [-L / 2 + 0.02, y0 + 0.05, -W - 0.01], [L / 2 - 0.02, 1.9, W + 0.01], { skip: '-x+x' });
  M.box('stripe', [-L / 2 + 0.3, 1.9, -W - 0.012], [L / 2 - 0.02, 2.08, W + 0.012], { skip: '-x+x' });
  // windshield on the slope
  M.poly('glass', [[-L / 2 + 0.66, 2.72, W - 0.18], [-L / 2 + 0.66, 2.72, -W + 0.18], [-L / 2 + 1.95, 3.9, -W + 0.2], [-L / 2 + 1.95, 3.9, W - 0.2]].map(([x, y, z]) => [x - 0.03, y, z]));
  for (const s of [-1, 1]) M.box('glass', [-L / 2 + 2.2, 2.7, s > 0 ? W - 0.01 : -W - 0.01], [-L / 2 + 3.6, 3.55, s > 0 ? W + 0.01 : -W + 0.01]);
  M.box('roof', [-L / 2 + 5, H, -0.9], [L / 2 - 1.5, H + 0.25, 0.9]);
  for (const cx of [-L / 2 + 4.2, L / 2 - 4.2]) M.box('truck', [cx - 1.6, 0.25, -W + 0.1], [cx + 1.6, 1.0, W - 0.1]);
  M.box('truck', [-L / 2 + 5.8, 0.55, -W + 0.25], [L / 2 - 5.8, 1.0, W - 0.25]);
  for (const s of [-1, 1]) M.box('head', [-L / 2 - 0.02, 1.35, s * 0.9 - 0.18], [-L / 2 + 0.02, 1.6, s * 0.9 + 0.18]);
  return M;
}
function coach(liv, { bilevel = false } = {}) {
  const M = new Model(bilevel ? 'superliner' : 'coach');
  trainMaterials(M, liv);
  const L = 25.9, W = 3.05 / 2, y0 = 1.05, H = bilevel ? 4.9 : 4.1;
  M.prism('body', [[-L / 2, y0], [L / 2, y0], [L / 2, H - 0.25], [L / 2 - 0.2, H], [-L / 2 + 0.2, H], [-L / 2, H - 0.25]], -W, W);
  const rows = bilevel ? [[1.75, 2.45], [3.3, 4.05]] : [[2.05, 3.0]];
  for (const [a, b] of rows) M.box('glass', [-L / 2 + 1.2, a, -W - 0.012], [L / 2 - 1.2, b, W + 0.012], { skip: '-x+x' });
  for (let x = -L / 2 + 2.4; x < L / 2 - 1.3; x += 1.9) for (const [a, b] of rows) M.box('body', [x, a - 0.01, -W - 0.016], [x + 0.14, b + 0.01, W + 0.016], { skip: '-x+x-y+y' });
  M.box('band', [-L / 2 + 0.02, y0 + 0.02, -W - 0.01], [L / 2 - 0.02, bilevel ? 1.55 : 1.85, W + 0.01], { skip: '-x+x' });
  M.box('stripe', [-L / 2 + 0.02, bilevel ? 1.55 : 1.85, -W - 0.011], [L / 2 - 0.02, bilevel ? 1.68 : 1.97, W + 0.011], { skip: '-x+x' });
  M.box('roof', [-L / 2 + 0.3, H - 0.02, -W + 0.2], [L / 2 - 0.3, H + 0.06, W - 0.2]);
  for (const cx of [-L / 2 + 3.2, L / 2 - 3.2]) M.box('truck', [cx - 1.4, 0.25, -W + 0.15], [cx + 1.4, y0, W - 0.15]);
  return M;
}

// ------------------------------------------------------------------ floatplane floats (paired with the c172 model)
function floats() {
  // Sized for the c172 model (8.2 m long, centred): scaled with the aircraft at run time.
  const M = new Model('floats');
  M.mat('float', { color: '#d9dde1', roughness: 0.35, metallic: 0.55 });
  M.mat('strut', { color: '#3a3d41', roughness: 0.5, metallic: 0.4 });
  const yC = -1.75;
  for (const z of [-1.28, 1.28]) {
    M.loft('float', [[-3.9, 0.05, 0.05, yC + 0.05], [-3.5, 0.3, 0.28, yC + 0.02], [-2.6, 0.38, 0.38, yC], [0.4, 0.38, 0.36, yC], [2.6, 0.26, 0.2, yC + 0.08], [3.4, 0.08, 0.06, yC + 0.16]], 14, z);
    M.cyl('strut', [-1.4, yC + 0.3, z], [-0.9, -1.0, z * 0.45], 0.045, 6, false);
    M.cyl('strut', [0.9, yC + 0.3, z], [0.9, -1.0, z * 0.45], 0.045, 6, false);
  }
  return M;
}

// ------------------------------------------------------------------ drawbridge leaves (hinge at origin, span toward -X)
function leaf({ len, width, deck = '#4a4d51', steel = '#6f777f', trim = null, truss = false }) {
  const M = new Model('leaf');
  M.mat('deck', { color: deck, roughness: 0.9 });
  M.mat('steel', { color: steel, roughness: 0.55, metallic: 0.45 });
  M.mat('trim', { color: trim || steel, roughness: 0.5, metallic: 0.35 });
  M.mat('rail', { color: '#b8bec5', roughness: 0.5, metallic: 0.5 });
  const W = width / 2;
  M.box('deck', [-len, -0.25, -W], [0, 0.05, W]);
  M.box('steel', [-len, -1.9, -W + 0.3], [0, -0.25, W - 0.3]);
  for (const s of [-1, 1]) {
    M.box('trim', [-len, -1.9, s * W - (s > 0 ? 0.35 : -0.05)], [0, 0.3, s * W + (s > 0 ? 0.05 : -0.35)].map((v, i) => (i === 2 ? v : v)));
    M.box('rail', [-len, 0.05, s > 0 ? W - 0.12 : -W + 0.02], [0, 1.1, s > 0 ? W - 0.02 : -W + 0.12]);
    if (truss) for (let x = -len + 2; x < -1; x += 4) M.box('trim', [x, 0.3, s > 0 ? W - 0.3 : -W], [x + 0.35, 3.2, s > 0 ? W : -W + 0.3]);
  }
  // counterweight tail below/behind the hinge
  M.box('steel', [0, -4.5, -W + 0.8], [6, -0.6, W - 0.8]);
  return M;
}

// ------------------------------------------------------------------ write
// Buses and drawbridge leaves are built as vertex-coloured meshes by tools/models/vehicles.mjs.
const models = {
  'loco-cascades': locomotive(LIV.cascades), 'coach-cascades': coach(LIV.cascades),
  'loco-amtrak': locomotive(LIV.amtrak), 'superliner': coach(LIV.amtrak, { bilevel: true }),
  floats: floats(),
};
fs.mkdirSync(OUT, { recursive: true });
let total = 0;
for (const [name, M] of Object.entries(models)) {
  const b = M.glb();
  fs.writeFileSync(path.join(OUT, `${name}.glb`), b);
  total += b.length;
}
console.log(`models: ${Object.keys(models).length} written to ${path.relative(process.cwd(), OUT)} (${(total / 1024).toFixed(0)} KB)`);
