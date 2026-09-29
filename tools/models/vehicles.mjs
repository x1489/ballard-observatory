// Detailed King County Metro bus meshes for the live scene, one vertex-coloured triangle mesh per body type, so the
// whole fleet draws in a handful of GPU calls (deck.gl SimpleMeshLayer, instanced). Each body type has two meshes:
//   <type>.bin         everything that looks the same on every bus (yellow lower body, glass, black trim, roof,
//                      wheels, lights, mirrors, bike rack, destination sign, trolley poles)
//   <type>-livery.bin  the upper body band in white, tinted per bus at run time with its livery colour
// New Flyer Xcelsior proportions (XDE40 / XT40, XDE60 / XT60), metres. Convention as the glTF models: +Y up, front
// toward -X, left (street) side +Z, curb side (doors) -Z, origin at ground level under the section's centre.
// Run: node tools/models/vehicles.mjs   (writes public/models/mesh/*.bin; no dependencies)
// File format (little endian): 'BLM1', uint32 vertexCount, uint32 indexCount, float32 positions[3n],
// float32 normals[3n], uint8 colors[3n] (padded to 4 bytes), uint32 indices[m].
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/models/mesh');

const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const shade = (c, f) => c.map((v) => Math.max(0, Math.min(255, Math.round(v * f))));
const C = {
  yellow: rgb('#f2b51c'), white: [255, 255, 255], roof: rgb('#e4e7ea'), glass: rgb('#1a2632'), glassHi: rgb('#2c3d4d'),
  black: rgb('#141517'), trim: rgb('#2a2d31'), tire: rgb('#101010'), hub: rgb('#b9bfc6'), arch: rgb('#08090a'),
  head: rgb('#fff6dc'), amber: rgb('#ffa21a'), tail: rgb('#d1161a'), sign: rgb('#0b0b0c'), led: rgb('#ffb02e'),
  bellows: rgb('#1d1e20'), pole: rgb('#232528'), mirror: rgb('#1b1c1e'), under: rgb('#0e0f10'),
};

class Mesh {
  constructor() { this.pos = []; this.nrm = []; this.col = []; this.idx = []; }
  vert(p, n, c) { this.pos.push(...p); this.nrm.push(...n); this.col.push(...c); return this.pos.length / 3 - 1; }
  /** quad a,b,c,d (counter-clockwise seen from outside), per-vertex normals, one colour */
  quad(a, b, c, d, na, nb, nc, nd, col) {
    const i = this.vert(a, na, col), j = this.vert(b, nb, col), k = this.vert(c, nc, col), l = this.vert(d, nd, col);
    this.idx.push(i, j, k, i, k, l);
  }
  tri(a, b, c, n, col) { const i = this.vert(a, n, col), j = this.vert(b, n, col), k = this.vert(c, n, col); this.idx.push(i, j, k); }
  flat(pts, col) { // planar convex polygon, CCW from outside
    const n = norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
    for (let i = 1; i < pts.length - 1; i++) this.tri(pts[0], pts[i], pts[i + 1], n, col);
  }
  box([x0, y0, z0], [x1, y1, z1], col, skip = '') {
    if (!skip.includes('+x')) this.flat([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], col);
    if (!skip.includes('-x')) this.flat([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], col);
    if (!skip.includes('+y')) this.flat([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], col);
    if (!skip.includes('-y')) this.flat([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], col);
    if (!skip.includes('+z')) this.flat([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], col);
    if (!skip.includes('-z')) this.flat([[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], col);
  }
  /** cylinder from a to b, radius r; optional cap colours */
  cyl(a, b, r, col, seg = 16, capA = null, capB = null) {
    const ax = norm(sub(b, a)), ref = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(ax, ref)), v = cross(ax, u);
    const ring = (c, i) => { const t = (i / seg) * Math.PI * 2; const d = [0, 1, 2].map((k) => u[k] * Math.cos(t) + v[k] * Math.sin(t)); return { p: c.map((q, k) => q + d[k] * r), n: d }; };
    for (let i = 0; i < seg; i++) {
      const p0 = ring(a, i), p1 = ring(a, i + 1), q0 = ring(b, i), q1 = ring(b, i + 1);
      this.quad(p0.p, p1.p, q1.p, q0.p, p0.n, p1.n, q1.n, q0.n, col);
    }
    if (capA) { const pts = Array.from({ length: seg }, (_, i) => ring(a, seg - i).p); this.flat(pts, capA); }
    if (capB) { const pts = Array.from({ length: seg }, (_, i) => ring(b, i).p); this.flat(pts, capB); }
  }
  /** rounded box (superellipse section in y-z, lofted along x with rounded ends) — roof pods, mirrors */
  pod([x0, x1], yBase, h, halfW, col, seg = 12) {
    const sec = (s) => Array.from({ length: seg + 1 }, (_, i) => {
      const t = Math.PI * (i / seg); // 0..pi: from +z over the top to -z
      const cz = Math.cos(t), sy = Math.sin(t);
      const z = Math.sign(cz) * Math.abs(cz) ** 0.45 * halfW * s, y = yBase + (Math.abs(sy) ** 0.45) * h * (0.35 + 0.65 * s);
      return { p: [0, y, z], n: norm([0, Math.abs(sy) ** 0.55 / h, Math.sign(cz) * Math.abs(cz) ** 0.55 / halfW]) };
    });
    const L = x1 - x0, xs = [0, 0.04, 0.12, 0.25, 0.75, 0.88, 0.96, 1], sc = [0.55, 0.8, 0.94, 1, 1, 0.94, 0.8, 0.55];
    const rings = xs.map((f, k) => sec(sc[k]).map((q) => ({ p: [x0 + f * L, q.p[1], q.p[2]], n: q.n })));
    for (let k = 0; k < rings.length - 1; k++) for (let i = 0; i < seg; i++) {
      const a = rings[k][i], b = rings[k][i + 1], c = rings[k + 1][i + 1], d = rings[k + 1][i];
      this.quad(a.p, d.p, c.p, b.p, a.n, d.n, c.n, b.n, col);
    }
    for (const [k, dir] of [[0, -1], [rings.length - 1, 1]]) {
      const r = rings[k]; const n = [dir, 0, 0];
      for (let i = 0; i < seg; i++) (dir < 0 ? this.tri(r[0].p.map((v, j) => (j === 1 ? yBase : v)), r[i + 1].p, r[i].p, n, col) : this.tri(r[0].p.map((v, j) => (j === 1 ? yBase : v)), r[i].p, r[i + 1].p, n, col));
    }
  }
  bin() {
    const n = this.pos.length / 3, m = this.idx.length;
    const head = Buffer.alloc(12); head.write('BLM1', 0, 'latin1'); head.writeUInt32LE(n, 4); head.writeUInt32LE(m, 8);
    const col = Buffer.alloc(Math.ceil((n * 3) / 4) * 4); for (let i = 0; i < this.col.length; i++) col[i] = this.col[i];
    return Buffer.concat([head, Buffer.from(new Float32Array(this.pos).buffer), Buffer.from(new Float32Array(this.nrm).buffer), col, Buffer.from(new Uint32Array(this.idx).buffer)]);
  }
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ------------------------------------------------------------------ the body shell
const W = 2.59 / 2;
// Half cross-section, bottom to roof centre: [y, z]. Extra rows sit on colour boundaries and around the wheel arches.
const PROFILE = [
  [0.30, W - 0.10], [0.34, W - 0.03], [0.42, W], [0.52, W], [0.64, W], [0.76, W], [0.88, W], [1.0, W], [1.06, W], [1.12, W - 0.004],
  [1.7, W - 0.012], [2.34, W - 0.022], [2.40, W - 0.024], [2.62, W - 0.03], [2.78, W - 0.045], [2.9, W - 0.09], [2.99, W - 0.18],
  [3.05, W - 0.32], [3.09, W - 0.55], [3.11, W - 0.9], [3.12, 0],
];
// profile normals (y, z) from neighbouring points; vertical sides stay crisp
const PN = PROFILE.map((p, i) => {
  const a = PROFILE[Math.max(0, i - 1)], b = PROFILE[Math.min(PROFILE.length - 1, i + 1)];
  const dy = b[0] - a[0], dz = b[1] - a[1];
  return norm([0, dz === 0 ? 0 : -dz, dy]).map((v, k) => (k === 0 ? 0 : v)); // outward: (ny, nz) = (-dz, dy)
}).map(([, ny, nz]) => [0, ny, nz]);
PN[0] = [0, -0.6, 0.8];

const YEL = [0.84, 0.9, 0.95, 1].map((f) => shade(C.yellow, f));
const ZONE = { skirt: 0.42, lowerTop: 1.06, rub: 1.12, winTop: 2.34, liveryTop: 2.78 };

/**
 * One body section from x0 (front end) to x1 (rear end). ends: 'cab' | 'rear' | 'joint'. doors: x centres on the
 * curb side (-Z); axles: x of wheel centres; driverWin: the cab has a driver's window; body/livery: target meshes.
 */
function section(body, livery, { x0, x1, front, rear, doors = [], axles = [] }) {
  const R = 0.5; // wheel radius
  const inArch = (x, y) => axles.some((ax) => ((x - ax) / 0.66) ** 2 + ((y - 0.3) / 0.82) ** 2 < 1);
  const inDoor = (x, y, side) => side < 0 && doors.some((dx) => Math.abs(x - dx) < 0.62 && y > 0.36 && y < 2.56);
  const doorGlass = (x, y) => doors.some((dx) => Math.abs(x - dx) < 0.55 && Math.abs(x - dx) > 0.025 && y > 0.5 && y < 2.47);
  // x stations: regular, plus every colour boundary (pillars, doors, arches), rounded ends
  const xs = new Set();
  for (let x = x0; x <= x1 + 1e-6; x += 0.25) xs.add(+x.toFixed(3));
  const pillarsAt = [];
  for (let x = x0 + (front === 'cab' ? 2.0 : 0.9); x < x1 - 0.7; x += 1.42) pillarsAt.push(x);
  for (const p of pillarsAt) { xs.add(+p.toFixed(3)); xs.add(+(p + 0.1).toFixed(3)); }
  for (const d of doors) for (const o of [-0.62, -0.55, -0.025, 0.025, 0.55, 0.62]) xs.add(+(d + o).toFixed(3));
  for (const a of axles) for (let o = -0.66; o <= 0.661; o += 0.066) xs.add(+(a + o).toFixed(3));
  const endRound = [0.03, 0.09, 0.18];
  for (const e of endRound) { xs.add(+(x0 + e).toFixed(3)); xs.add(+(x1 - e).toFixed(3)); }
  const X = [...xs].filter((x) => x >= x0 - 1e-6 && x <= x1 + 1e-6).sort((a, b) => a - b);
  // plan-view rounding at cab/rear ends; joints stay square
  const widthAt = (x) => {
    const df = x - x0, dr = x1 - x;
    let s = 1;
    if (front !== 'joint' && df < 0.2) s = Math.min(s, 0.9 + 0.1 * Math.sqrt(Math.max(0, df) / 0.2));
    if (rear !== 'joint' && dr < 0.2) s = Math.min(s, 0.92 + 0.08 * Math.sqrt(Math.max(0, dr) / 0.2));
    return s;
  };
  // windshield rake: the top of the cab leans back
  const rakeAt = (x, y) => (front === 'cab' && x - x0 < 0.2 && y > 1.0 ? ((y - 1.0) / 2.1) * 0.16 * (1 - (x - x0) / 0.2) : 0);
  const P = (x, j, side) => { const [y, z] = PROFILE[j]; return [x + rakeAt(x, y), y, side * z * widthAt(x)]; };
  const N = (j, side) => [0, PN[j][1], side * PN[j][2]];
  const colorAt = (x, y, side) => {
    if (y < 0.36) return C.under;
    if (inArch(x, y)) return C.arch;
    if (inDoor(x, y, side)) return doorGlass(x, y) ? (y > 1.2 ? C.glass : C.glassHi) : C.black;
    if (y < ZONE.skirt) return C.trim;
    if (y < ZONE.lowerTop) return YEL[Math.min(YEL.length - 1, Math.floor((y - 0.42) / 0.16))];
    if (y < ZONE.rub) return C.black;
    if (y < ZONE.winTop) {
      if (pillarsAt.some((p) => x > p && x < p + 0.1)) return C.black;
      if (front === 'cab' && x < x0 + 1.9 && side < 0 && x > x0 + 0.62) return C.glass; // curb-side front windows
      return y > 2.2 ? C.glassHi : C.glass;
    }
    if (y < ZONE.liveryTop) return 'livery';
    return C.roof;
  };
  // Quads between stations; runs of the same colour along a row merge into one quad (except near the rounded ends,
  // where the shape changes along x).
  const straight = (x) => x - x0 >= 0.2 - 1e-6 && x1 - x >= 0.2 - 1e-6;
  for (const side of [1, -1]) {
    for (let j = 0; j < PROFILE.length - 1; j++) {
      const ym = (PROFILE[j][0] + PROFILE[j + 1][0]) / 2;
      let i = 0;
      while (i < X.length - 1) {
        const c = colorAt((X[i] + X[i + 1]) / 2, ym, side);
        let k = i + 1;
        while (k < X.length - 1 && straight(X[k]) && straight(X[i]) && colorAt((X[k] + X[k + 1]) / 2, ym, side) === c) k++;
        const xa = X[i], xb = X[k];
        const target = c === 'livery' ? livery : body;
        const col = c === 'livery' ? C.white : c;
        const a = P(xa, j, side), b = P(xb, j, side), cc = P(xb, j + 1, side), d = P(xa, j + 1, side);
        if (side > 0) target.quad(a, b, cc, d, N(j, 1), N(j, 1), N(j + 1, 1), N(j + 1, 1), col);
        else target.quad(b, a, d, cc, N(j, -1), N(j, -1), N(j + 1, -1), N(j + 1, -1), col);
        i = k;
      }
    }
  }
  // underside
  body.flat([[x0, 0.3, -W * 0.9], [x1, 0.3, -W * 0.9], [x1, 0.3, W * 0.9], [x0, 0.3, W * 0.9]].map((p) => p).reverse(), C.under);

  // end faces: a grid in (y, t) where t is the fraction of the half-width at that height
  const endFace = (x, dir, kind) => {
    const rows = [...new Set([...PROFILE.map((p) => p[0]), 0.45, 0.6, 0.85, 0.95, 1.3, 2.3, 2.5, 2.56, 2.62, 2.8, 2.84].map((v) => +v.toFixed(3)))].filter((y) => y >= 0.3 && y <= 3.12).sort((a, b) => a - b);
    const zAt = (y) => { for (let j = 0; j < PROFILE.length - 1; j++) { const [ya, za] = PROFILE[j], [yb, zb] = PROFILE[j + 1]; if (y >= ya && y <= yb) return za + (zb - za) * ((y - ya) / (yb - ya || 1)); } return 0; };
    const ts = [-1, -0.92, -0.78, -0.62, -0.42, -0.2, -0.015, 0.015, 0.2, 0.42, 0.62, 0.78, 0.92, 1];
    const w = widthAt(x);
    const colFront = (y, t) => {
      const at = Math.abs(t);
      if (y < 0.45) return C.black;                                                  // bumper
      if (y < 0.95) {
        if (y > 0.6 && y < 0.85 && at > 0.62 && at < 0.92) return at > 0.85 ? C.amber : C.head; // headlamp clusters
        return C.yellow;
      }
      if (y < 2.5) return at < 0.015 ? C.black : (y > 2.25 ? C.glassHi : C.glass);   // windshield, centre post
      if (y < 2.84) return y > 2.56 && y < 2.8 && at < 0.78 ? C.led : C.sign;        // destination sign
      return y < ZONE.liveryTop ? 'livery' : C.roof;
    };
    const colRear = (y, t) => {
      const at = Math.abs(t);
      if (y < 0.45) return C.black;
      if (y < 1.3) {
        if (y > 0.6 && at > 0.78) return y > 1.0 ? C.amber : C.tail;                 // tail light towers
        return y < 0.85 ? shade(C.yellow, 0.85) : C.trim;                             // engine door + grille
      }
      if (y < 2.3) return at < 0.78 ? C.glass : C.black;                              // rear window
      if (y < ZONE.liveryTop) return 'livery';
      return C.roof;
    };
    for (let r = 0; r < rows.length - 1; r++) {
      const ya = rows[r], yb = rows[r + 1];
      for (let k = 0; k < ts.length - 1; k++) {
        const ym = (ya + yb) / 2, tm = (ts[k] + ts[k + 1]) / 2;
        const c = kind === 'cab' ? colFront(ym, tm) : colRear(ym, tm);
        const target = c === 'livery' ? livery : body;
        const col = c === 'livery' ? C.white : c;
        const pt = (y, t) => [x + (kind === 'cab' ? rakeAt(x, y) : 0), y, t * zAt(y) * w];
        const n = kind === 'cab' ? norm([-1, 0.16, 0]) : [1, 0, 0];
        const a = pt(ya, ts[k]), b = pt(ya, ts[k + 1]), cc = pt(yb, ts[k + 1]), d = pt(yb, ts[k]);
        // front face (dir -1) seen from -X: CCW is a, d, cc, b
        if (dir < 0) target.quad(a, d, cc, b, n, n, n, n, col); else target.quad(a, b, cc, d, n, n, n, n, col);
      }
    }
  };
  if (front === 'cab') {
    endFace(x0, -1, 'cab');
    // mirrors on arms, bike rack folded up in front of the bumper, wipers
    for (const s of [1, -1]) {
      body.box([x0 - 0.42, 2.05, s * (W + 0.18) - 0.05], [x0 - 0.3, 2.45, s * (W + 0.18) + 0.05], C.mirror);
      body.cyl([x0 - 0.02, 2.62, s * (W - 0.2)], [x0 - 0.36, 2.5, s * (W + 0.16)], 0.025, C.mirror, 6);
    }
    body.box([x0 - 0.26, 0.42, -0.72], [x0 - 0.06, 1.02, 0.72], C.black, '');
    body.box([x0 - 0.3, 0.48, -0.68], [x0 - 0.26, 0.96, -0.6], C.trim);
    body.box([x0 - 0.3, 0.48, 0.6], [x0 - 0.26, 0.96, 0.68], C.trim);
  } else if (front === 'joint') bellows(body, x0 - 0.46, x0);
  if (rear === 'rear') endFace(x1, 1, 'rear');
  else if (rear === 'joint') bellows(body, x1, x1 + 0.46);

  // wheels: tyres in the arches with silver hubs, inset from the body side
  for (const ax of axles) for (const s of [1, -1]) {
    const zo = s * (W - 0.04), zi = s * (W - 0.34);
    body.cyl([ax, R, zi], [ax, R, zo], R, C.tire, 20, null, null);
    body.cyl([ax, R, zo], [ax, R, zo + s * 0.005], 0.3, C.hub, 16, null, null);
    const disc = Array.from({ length: 16 }, (_, i) => { const t = (i / 16) * Math.PI * 2 * (s > 0 ? 1 : -1); return [ax + Math.cos(t) * 0.3, R + Math.sin(t) * 0.3, zo + s * 0.006]; });
    body.flat(disc, C.hub);
    const tyreFace = Array.from({ length: 20 }, (_, i) => { const t = (i / 20) * Math.PI * 2 * (s > 0 ? 1 : -1); return [ax + Math.cos(t) * R, R + Math.sin(t) * R, zo]; });
    body.flat(tyreFace, C.tire);
  }
}

/** accordion bellows between articulated sections: dark folds */
function bellows(body, xa, xb) {
  const folds = 7;
  for (let i = 0; i < folds; i++) {
    const a = xa + ((xb - xa) * i) / folds, b = xa + ((xb - xa) * (i + 1)) / folds;
    const inset = i % 2 ? 0.1 : 0.02;
    body.box([a, 0.42, -W + inset], [b, 2.98 - inset, W - inset], shade(C.bellows, i % 2 ? 0.7 : 1.1), '-x+x-y');
  }
}

function roofKit(body, pods, trolleyAt = null) {
  for (const [cx, len, h] of pods) body.pod([cx - len / 2, cx + len / 2], 3.08, h, 0.92, shade(C.roof, 0.93));
  if (trolleyAt != null) {
    for (const z of [-0.3, 0.3]) {
      body.box([trolleyAt - 0.35, 3.1, z - 0.12], [trolleyAt + 0.45, 3.32, z + 0.12], C.pole);
      // poles run back and up to the overhead wires (about 5.6 m above the road)
      body.cyl([trolleyAt, 3.28, z], [trolleyAt + 5.7, 5.55, z * 1.25], 0.04, C.pole, 6);
      body.box([trolleyAt + 5.62, 5.5, z * 1.25 - 0.06], [trolleyAt + 5.9, 5.62, z * 1.25 + 0.06], C.black);
    }
  }
}

function build(kind) {
  const body = new Mesh(), livery = new Mesh();
  if (kind === 'bus40' || kind === 'trolley40') {
    const L = 12.2;
    section(body, livery, { x0: -L / 2, x1: L / 2, front: 'cab', rear: 'rear', doors: [-L / 2 + 1.3, 1.0], axles: [-L / 2 + 2.55, L / 2 - 3.1] });
    roofKit(body, kind === 'trolley40' ? [[-2.4, 2.6, 0.32], [3.6, 2.2, 0.3]] : [[-2.3, 3.0, 0.3], [3.3, 2.6, 0.38]], kind === 'trolley40' ? 0.2 : null);
  } else if (kind === 'bus60f' || kind === 'trolley60f') {
    section(body, livery, { x0: -5.5, x1: 5.5, front: 'cab', rear: 'joint', doors: [-4.2, 2.35], axles: [-3.0, 3.35] });
    roofKit(body, [[-1.4, 2.8, 0.32]], kind === 'trolley60f' ? 2.6 : null);
  } else if (kind === 'bus60r') {
    section(body, livery, { x0: -3.65, x1: 3.65, front: 'joint', rear: 'rear', doors: [-2.3], axles: [1.3] });
    roofKit(body, [[1.3, 2.4, 0.4]]);
  }
  return { body, livery };
}

// ------------------------------------------------------------------ drawbridge leaves (hinge at origin, span toward -X)
// Deck top at y = 0: asphalt with lane lines, sidewalks and railings on both sides, steel girders below, the
// counterweight behind the hinge.
function leafMesh({ len, width, lanes, steel, trim }) {
  const m = new Mesh(), W = width / 2;
  const asphalt = rgb('#3d4043'), walk = rgb('#9c9a94'), white = rgb('#e8e8e2'), yellow = rgb('#e2b33b');
  const st = rgb(steel), tr = rgb(trim || steel), rail = rgb('#c4c9ce');
  const walkW = 2.2, road = W - walkW;
  m.box([-len, -0.3, -road], [0, 0, road], asphalt);
  for (const s of [-1, 1]) {
    m.box([-len, -0.3, s > 0 ? road : -W], [0, 0.18, s > 0 ? W : -road], walk);
    // railing: posts and two rails
    const zr = s * (W - 0.12);
    for (let x = -len + 0.6; x < -0.2; x += 2.4) m.box([x, 0.18, zr - 0.06], [x + 0.12, 1.25, zr + 0.06], rail);
    for (const y of [0.62, 1.2]) m.box([-len, y, zr - 0.05], [0, y + 0.07, zr + 0.05], rail);
    // steel side girder (painted), deeper at the hinge
    const plate = [[-len, -0.3, s * W], [0, -0.3, s * W], [0, -3.2, s * W], [-len, -1.1, s * W]];
    m.flat(s > 0 ? [...plate].reverse() : plate, tr); m.flat(s > 0 ? plate : [...plate].reverse(), shade(tr, 0.7));
    m.box([-len, -1.1, s * (W - 0.4) - 0.2], [0, -0.3, s * (W - 0.4) + 0.2], st);
  }
  // lane lines (dashed whites, double yellow in the middle)
  const laneW = (2 * road) / lanes;
  for (let k = 1; k < lanes; k++) {
    const z = -road + k * laneW;
    if (k === lanes / 2) { for (const dz of [-0.12, 0.12]) m.box([-len, 0.005, z + dz - 0.05], [0, 0.02, z + dz + 0.05], yellow); }
    else for (let x = -len + 1; x < -1; x += 9) m.box([x, 0.005, z - 0.07], [x + 3, 0.02, z + 0.07], white);
  }
  // underside stringers and the counterweight tail behind the hinge
  for (let z = -W + 1.5; z < W - 1; z += 2.5) m.box([-len, -1.4, z - 0.25], [0, -0.3, z + 0.25], st);
  m.box([0, -4.8, -W + 0.8], [6.5, -0.6, W - 0.8], shade(st, 0.8));
  m.box([-0.6, -3.4, -W], [0.6, 0, W], shade(tr, 0.9)); // trunnion girder at the hinge
  return m;
}
fs.mkdirSync(OUT, { recursive: true });
let total = 0;
for (const kind of ['bus40', 'trolley40', 'bus60f', 'trolley60f', 'bus60r']) {
  const { body, livery } = build(kind);
  for (const [name, m] of [[kind, body], [`${kind}-livery`, livery]]) {
    if (!m.idx.length) continue;
    const b = m.bin();
    fs.writeFileSync(path.join(OUT, `${name}.bin`), b);
    total += b.length;
    console.log(`${name.padEnd(18)} ${String(m.pos.length / 3).padStart(6)} verts ${String(m.idx.length / 3).padStart(6)} tris`);
  }
}
for (const [name, spec] of [['leaf-ballard', { len: 23, width: 21.4, lanes: 4, steel: '#6f7f7a', trim: '#7d8a86' }], ['leaf-fremont', { len: 37, width: 17, lanes: 4, steel: '#2d6bb0', trim: '#e2742f' }]]) {
  const b = leafMesh(spec).bin(); fs.writeFileSync(path.join(OUT, `${name}.bin`), b); total += b.length;
}
console.log(`total ${(total / 1024).toFixed(0)} KB -> ${path.relative(process.cwd(), OUT)}`);
