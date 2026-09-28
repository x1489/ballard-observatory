// Trees: every tree around Ballard from Seattle's 2021 LiDAR inventory (public and private), standing at its real
// position with its measured height and crown radius; conifers as tiered cones, deciduous trees as rounded crowns in
// the colours of the season (fresh green in spring, deep green in summer, turning in October, bare in winter).
// Loaded in ~1 km cells around the camera; one instanced mesh per cell and type, so ~100k trees stay cheap.
import { D } from './common.js';
import { distM } from '../geo.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ------------------------------------------------------------------ meshes (unit crown radius, unit height)
function pushTri(P, N, C, a, b, c, na, nb, nc, col) {
  P.push(...a, ...b, ...c); N.push(...na, ...nb, ...nc); C.push(...col, ...col, ...col);
}
function icosphere() {
  const t = (1 + Math.sqrt(5)) / 2;
  let v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((p) => { const l = Math.hypot(...p); return p.map((x) => x / l); });
  let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const mid = new Map();
  const m = (a, b) => { const k = a < b ? `${a}_${b}` : `${b}_${a}`; if (!mid.has(k)) { const p = v[a].map((x, i) => (x + v[b][i]) / 2); const l = Math.hypot(...p); v.push(p.map((x) => x / l)); mid.set(k, v.length - 1); } return mid.get(k); };
  f = f.flatMap(([a, b, c]) => { const ab = m(a, b), bc = m(b, c), ca = m(c, a); return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]; });
  // lumpy, like a real crown (deterministic per vertex)
  v = v.map((p, i) => { const k = 1 + 0.13 * Math.sin(i * 12.9898) * Math.cos(i * 78.233); return p.map((x) => x * k); });
  return { v, f };
}
function trunk(P, N, C, r, h, col) {
  const seg = 5;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p00 = [Math.cos(a0) * r, Math.sin(a0) * r, 0], p10 = [Math.cos(a1) * r, Math.sin(a1) * r, 0];
    const p01 = [p00[0], p00[1], h], p11 = [p10[0], p10[1], h];
    const n0 = [Math.cos(a0), Math.sin(a0), 0], n1 = [Math.cos(a1), Math.sin(a1), 0];
    pushTri(P, N, C, p00, p10, p11, n0, n1, n1, col); pushTri(P, N, C, p00, p11, p01, n0, n1, n0, col);
  }
}
function deciduousMesh() {
  const P = [], N = [], C = [];
  trunk(P, N, C, 0.07, 0.45, [0.42, 0.34, 0.26]);
  const { v, f } = icosphere();
  const place = (p) => [p[0] * 1.05, p[1] * 1.05, 0.6 + p[2] * 0.4];
  for (const [a, b, c] of f) pushTri(P, N, C, place(v[a]), place(v[b]), place(v[c]), v[a], v[b], v[c], [1, 1, 1]);
  return mesh(P, N, C);
}
function coniferMesh() {
  const P = [], N = [], C = [];
  trunk(P, N, C, 0.06, 0.25, [0.36, 0.28, 0.22]);
  const seg = 9;
  for (const [z0, z1, r] of [[0.1, 0.72, 1.0], [0.4, 1.0, 0.68]]) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const b0 = [Math.cos(a0) * r, Math.sin(a0) * r, z0], b1 = [Math.cos(a1) * r, Math.sin(a1) * r, z0], apex = [0, 0, z1];
      const slope = r / (z1 - z0);
      const n = (a) => { const l = Math.hypot(1, slope); return [Math.cos(a) / l, Math.sin(a) / l, slope / l]; };
      pushTri(P, N, C, b0, b1, apex, n(a0), n(a1), n((a0 + a1) / 2), [1, 1, 1]);
      pushTri(P, N, C, b1, b0, [0, 0, z0], [0, 0, -1], [0, 0, -1], [0, 0, -1], [0.8, 0.8, 0.8]);
    }
  }
  return mesh(P, N, C);
}
function mesh(P, N, C) {
  return { positions: { value: new Float32Array(P), size: 3 }, normals: { value: new Float32Array(N), size: 3 }, colors: { value: new Float32Array(C), size: 3 } };
}

// ------------------------------------------------------------------ seasonal colour
function dayOfYear(t = Date.now()) { const d = new Date(t); return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000); }
const pick = (arr, h) => arr[h % arr.length];
/** RGB for a deciduous crown on this day of the year; hash (0-255) varies the individual tree. */
export function deciduousColor(doy, hash) {
  const u = hash / 255;
  if (doy >= 326 || doy < 74) return pick([[98, 90, 82], [92, 86, 80], [106, 96, 86]], hash); // bare (late Nov - mid Mar)
  if (doy < 121) return u < 0.05 ? [206, 168, 178] : u < 0.08 ? [214, 210, 200] : pick([[104, 132, 68], [96, 124, 64], [112, 138, 74]], hash); // spring (blossom)
  if (doy < 244) return pick([[68, 90, 50], [76, 98, 56], [62, 84, 46], [84, 104, 60]], hash); // summer
  const f = Math.max(0, Math.min(1, (doy - 258) / 60)); // turning starts mid-September, complete by mid-November
  if (u > f ** 1.5) return pick([[70, 92, 52], [80, 100, 58], [66, 86, 48]], hash);
  return pick([[150, 128, 64], [158, 110, 56], [138, 86, 52], [118, 72, 50], [126, 106, 70], [164, 138, 72]], hash);
}
const CONIFER = [[40, 60, 42], [46, 66, 46], [36, 54, 38], [52, 70, 50]];

export function createTrees() {
  const S = { index: null, cells: new Map(), loading: new Set(), visible: true, lastKey: '', active: [], meshes: null, doy: dayOfYear() };
  const budget = matchMedia('(pointer: coarse)').matches || innerWidth < 760 ? 26000 : 80000;

  async function loadIndex() {
    if (S.index) return S.index;
    S.index = await fetch('/data/trees/index.json').then((r) => r.json());
    return S.index;
  }
  async function loadCell(c) {
    if (S.cells.has(c.id) || S.loading.has(c.id)) return;
    S.loading.add(c.id);
    try {
      const buf = await fetch(`/data/trees/${c.id}.bin`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); });
      const dv = new DataView(buf), n = buf.byteLength / 12;
      const parts = [{ type: 0, idx: [] }, { type: 1, idx: [] }];
      for (let i = 0; i < n; i++) parts[dv.getUint8(i * 12 + 10) ? 1 : 0].idx.push(i);
      const out = parts.map(({ type, idx }) => {
        const m = idx.length, pos = new Float32Array(m * 3), scl = new Float32Array(m * 3), col = new Uint8Array(m * 4), yaw = new Float32Array(m);
        idx.forEach((i, k) => {
          const o = i * 12;
          pos[k * 3] = dv.getUint16(o, true) * 0.02; pos[k * 3 + 1] = dv.getUint16(o + 2, true) * 0.02; pos[k * 3 + 2] = dv.getInt16(o + 4, true) / 10;
          const h = dv.getUint16(o + 6, true) / 10, r = dv.getUint16(o + 8, true) / 10, hash = dv.getUint8(o + 11);
          const bare = type === 0 && (S.doy >= 326 || S.doy < 74);
          scl[k * 3] = r * (bare ? 0.8 : 1); scl[k * 3 + 1] = r * (bare ? 0.8 : 1); scl[k * 3 + 2] = h;
          const c3 = type ? pick(CONIFER, hash) : deciduousColor(S.doy, hash);
          col.set([c3[0], c3[1], c3[2], 255], k * 4);
          yaw[k] = (hash / 255) * 360;
        });
        return { type, n: m, pos, scl, col, yaw };
      });
      S.cells.set(c.id, { meta: c, parts: out, at: Date.now() });
      S.lastKey = ''; // re-plan with the new cell
    } catch (e) { console.warn('[trees]', c.id, e.message); } finally { S.loading.delete(c.id); }
  }
  /** Choose the cells to show for the camera: nearest first, within a zoom-dependent radius and an instance budget. */
  function plan(ctx) {
    if (!S.index) return [];
    const zoom = ctx.zoom;
    if (zoom < 14.6 || ctx.quality >= 3) return [];
    const budgetNow = ctx.quality >= 2 ? budget / 2 : budget;
    const radius = zoom >= 17 ? 900 : zoom >= 16 ? 1400 : zoom >= 15.3 ? 2000 : 2600;
    const cx = ctx.center.lng, cy = ctx.center.lat;
    const cand = S.index.cells.map((c) => ({ c, d: distM(cx, cy, (c.w + c.e) / 2, (c.s + c.n) / 2) })).filter((x) => x.d < radius + 600).sort((a, b) => a.d - b.d);
    const chosen = [];
    let total = 0;
    for (const { c } of cand) { if (total + c.count > budgetNow && chosen.length) break; chosen.push(c); total += c.count; }
    return chosen;
  }
  function produce(ctx) {
    const deck = D();
    if (!S.visible) return [];
    if (!S.index) { loadIndex().catch(() => {}); return []; }
    if (!S.meshes) S.meshes = [deciduousMesh(), coniferMesh()];
    const key = `${Math.round(ctx.center.lng * 400)}:${Math.round(ctx.center.lat * 400)}:${Math.floor(ctx.zoom * 2)}:${ctx.quality}`;
    if (key !== S.lastKey) {
      S.lastKey = key;
      S.active = plan(ctx);
      for (const c of S.active) loadCell(c);
      // forget cells far away
      if (S.cells.size > 40) for (const [id, cell] of S.cells) if (!S.active.includes(cell.meta) && Date.now() - cell.at > 60e3) S.cells.delete(id);
    }
    const layers = [];
    for (const meta of S.active) {
      const cell = S.cells.get(meta.id);
      if (!cell) continue;
      for (const p of cell.parts) {
        if (!p.n) continue;
        layers.push(new deck.SimpleMeshLayer({
          id: `trees-${meta.id}-${p.type}`, data: { length: p.n }, mesh: S.meshes[p.type],
          coordinateSystem: deck.COORDINATE_SYSTEM.METER_OFFSETS, coordinateOrigin: [meta.w, meta.s, 0],
          getPosition: (_, { index }) => [p.pos[index * 3], p.pos[index * 3 + 1], p.pos[index * 3 + 2]],
          getScale: (_, { index }) => [p.scl[index * 3], p.scl[index * 3 + 1], p.scl[index * 3 + 2]],
          getOrientation: (_, { index }) => [0, p.yaw[index], 0],
          getColor: (_, { index }) => [p.col[index * 4], p.col[index * 4 + 1], p.col[index * 4 + 2], 255],
          material: { ambient: 0.5, diffuse: 0.55, shininess: 4, specularColor: [12, 14, 12] },
          pickable: false,
        }));
      }
    }
    return layers;
  }
  return { produce, set(o) { Object.assign(S, o); }, stats: () => ({ cells: S.cells.size, active: S.active.length, trees: S.active.reduce((a, c) => a + (S.cells.has(c.id) ? c.count : 0), 0) }) };
}
