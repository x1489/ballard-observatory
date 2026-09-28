// Builds public/data/trees/: every tree in and around Ballard from the City of Seattle's 2021 LiDAR tree inventory
// (TreeCentroids_2021_Seattle: location, 98th-percentile height, crown radius, coniferous/deciduous; public and
// private trees alike), with the ground elevation under each trunk sampled from the same terrain tiles the map uses
// (Mapzen/AWS terrarium z15), packed into ~1 km cells the app loads as you move around.
//   node tools/build-trees.mjs
// Record (12 bytes, little-endian): u16 east, u16 north (0.02 m from the cell's SW corner), i16 ground (dm),
// u16 height (dm), u16 crown radius (dm), u8 type (0 deciduous, 1 coniferous), u8 hash (0-255, for variety).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'data', 'trees');
const AREA = { s: 47.640, n: 47.705, w: -122.425, e: -122.340 };
const CELL = { dlat: 0.0075, dlon: 0.011 };        // ~830 m x 830 m
const SVC = 'https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/TreeCentroids_2021_Seattle/FeatureServer/0/query';
const FT = 0.3048006096012192;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'BallardObservatory/1.0 (tools/build-trees.mjs)' }, signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { if (i >= tries) throw e; await sleep(1500 * (i + 1)); }
  }
}

// ------------------------------------------------------------------ minimal PNG decoder (8-bit RGB/RGBA, non-interlaced)
function decodePNG(buf) {
  let p = 8, w = 0, h = 0, ctype = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG'); ctype = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const bpp = ctype === 6 ? 4 : ctype === 2 ? 3 : (() => { throw new Error(`PNG colour type ${ctype}`); })();
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const o = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[o + x - bpp] : 0, b = y ? out[o - stride + x] : 0, c = x >= bpp && y ? out[o - stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[o + x] = v & 255;
    }
  }
  return { w, h, bpp, px: out };
}

// ------------------------------------------------------------------ terrain sampler (terrarium z15, bilinear)
const Z = 15;
const tiles = new Map();
const lon2x = (lon) => ((lon + 180) / 360) * 2 ** Z;
const lat2y = (lat) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** Z; };
async function tile(x, y) {
  const k = `${x}/${y}`;
  if (!tiles.has(k)) {
    const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`);
    if (!r.ok) throw new Error(`terrarium ${k}: HTTP ${r.status}`);
    tiles.set(k, decodePNG(Buffer.from(await r.arrayBuffer())));
  }
  return tiles.get(k);
}
function elev(t, px, py) {
  const i = (Math.min(255, Math.max(0, py)) * 256 + Math.min(255, Math.max(0, px))) * t.bpp;
  return t.px[i] * 256 + t.px[i + 1] + t.px[i + 2] / 256 - 32768;
}
async function ground(lon, lat) {
  const fx = lon2x(lon), fy = lat2y(lat);
  const tx = Math.floor(fx), ty = Math.floor(fy), t = await tile(tx, ty);
  const px = (fx - tx) * 256 - 0.5, py = (fy - ty) * 256 - 0.5;
  const x0 = Math.floor(px), y0 = Math.floor(py), ax = px - x0, ay = py - y0;
  return elev(t, x0, y0) * (1 - ax) * (1 - ay) + elev(t, x0 + 1, y0) * ax * (1 - ay) + elev(t, x0, y0 + 1) * (1 - ax) * ay + elev(t, x0 + 1, y0 + 1) * ax * ay;
}

// ------------------------------------------------------------------ fetch the inventory
const env = `${AREA.w},${AREA.s},${AREA.e},${AREA.n}`;
const base = `${SVC}?where=1%3D1&geometry=${env}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=Hgt_Q98,Radius,Type&outSR=4326&orderByFields=OBJECTID&f=json`;
const trees = [];
for (let off = 0; ; off += 2000) {
  const j = await json(`${base}&resultOffset=${off}&resultRecordCount=2000`);
  for (const f of j.features || []) {
    const a = f.attributes, g = f.geometry;
    if (!g || !Number.isFinite(g.x) || !Number.isFinite(a.Hgt_Q98)) continue;
    const h = a.Hgt_Q98 * FT, r = (a.Radius || 0) * FT;
    if (h < 2 || h > 70 || r < 0.5 || r > 20) continue; // lidar artefacts (cranes, masts) and shrubs
    trees.push({ lon: g.x, lat: g.y, h, r, t: /conif/i.test(a.Type || '') ? 1 : 0 });
  }
  process.stdout.write(`\r  fetched ${trees.length} trees`);
  if (!j.exceededTransferLimit && (j.features || []).length < 2000) break;
}
console.log();

// ------------------------------------------------------------------ cells
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const cells = new Map();
for (const t of trees) {
  const i = Math.floor((t.lat - AREA.s) / CELL.dlat), jx = Math.floor((t.lon - AREA.w) / CELL.dlon);
  const k = `${i}_${jx}`;
  if (!cells.has(k)) cells.set(k, { i, j: jx, list: [] });
  cells.get(k).list.push(t);
}
const mLat = 111132.92, index = [];
let bytes = 0, n = 0;
for (const c of cells.values()) {
  const s = AREA.s + c.i * CELL.dlat, w = AREA.w + c.j * CELL.dlon;
  const mLon = 111319.49 * Math.cos(((s + CELL.dlat / 2) * Math.PI) / 180);
  const buf = Buffer.alloc(c.list.length * 12);
  let k = 0;
  for (const t of c.list) {
    const e = (t.lon - w) * mLon, nn = (t.lat - s) * mLat;
    const z = await ground(t.lon, t.lat);
    const hash = (Math.floor(t.lon * 1e6) * 73856093 ^ Math.floor(t.lat * 1e6) * 19349663) >>> 0;
    buf.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(e / 0.02))), k);
    buf.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(nn / 0.02))), k + 2);
    buf.writeInt16LE(Math.round(z * 10), k + 4);
    buf.writeUInt16LE(Math.round(t.h * 10), k + 6);
    buf.writeUInt16LE(Math.round(t.r * 10), k + 8);
    buf.writeUInt8(t.t, k + 10);
    buf.writeUInt8(hash & 255, k + 11);
    k += 12;
  }
  fs.writeFileSync(path.join(OUT, `${c.i}_${c.j}.bin`), buf);
  index.push({ id: `${c.i}_${c.j}`, s: +s.toFixed(6), w: +w.toFixed(6), n: +(s + CELL.dlat).toFixed(6), e: +(w + CELL.dlon).toFixed(6), count: c.list.length, mLon: +mLon.toFixed(3) });
  bytes += buf.length; n += c.list.length;
}
index.sort((a, b) => a.id.localeCompare(b.id));
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({
  generated: new Date().toISOString(), source: 'City of Seattle, TreeCentroids_2021_Seattle (LiDAR tree inventory, 2021); ground: Mapzen terrain tiles (AWS Open Data)',
  area: AREA, cell: CELL, mLat, record: 'u16 east, u16 north (0.02 m from SW corner), i16 ground dm, u16 height dm, u16 radius dm, u8 type (1 = coniferous), u8 hash', cells: index,
}));
console.log(`trees: ${n} in ${index.length} cells, ${(bytes / 1048576).toFixed(2)} MB (${tiles.size} terrain tiles)`);
