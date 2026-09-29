// Bakes the aircraft glTF models (public/models/*.glb, CC BY 4.0, see public/models/README.md) into single
// vertex-coloured meshes (public/models/mesh/<name>.bin, same format as tools/models/vehicles.mjs): every primitive
// merged, material colour times texture colour sampled at each vertex. One aircraft type then draws in one GPU call
// instead of one per part (the 787 model has 23 parts). macOS only (uses `sips` to read the WebP textures).
// Run: node tools/models/bake-aircraft.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/models');
const MODELS = ['b789', 'airplane', 'atr72', 'c172', 'citation2', 'bell206', 'jet', 'floats'];
const TYPE = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
// Models whose textures are baked-in lighting rather than paint: drawn in their plain white paint instead.
const PLAIN = new Set(['c172']);
const COMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function readGlb(file) {
  const b = fs.readFileSync(file);
  const jl = b.readUInt32LE(12);
  const json = JSON.parse(b.slice(20, 20 + jl).toString());
  const binStart = 20 + jl + 8;
  const bin = b.slice(binStart, binStart + b.readUInt32LE(20 + jl));
  const acc = (i) => {
    const a = json.accessors[i], v = json.bufferViews[a.bufferView], T = TYPE[a.componentType], n = COMP[a.type];
    const stride = v.byteStride || n * T.BYTES_PER_ELEMENT, off = (v.byteOffset || 0) + (a.byteOffset || 0);
    const out = new Float64Array(a.count * n);
    const dv = new DataView(bin.buffer, bin.byteOffset + off);
    const get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[a.componentType];
    for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) {
      let x = dv[get](k * stride + c * T.BYTES_PER_ELEMENT, true);
      if (a.normalized) x /= a.componentType === 5121 ? 255 : a.componentType === 5123 ? 65535 : a.componentType === 5120 ? 127 : 32767;
      out[k * n + c] = x;
    }
    return out;
  };
  const image = (i) => { const im = json.images[i], v = json.bufferViews[im.bufferView]; return { mime: im.mimeType, data: bin.slice(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength) }; };
  return { json, acc, image };
}

// ------------------------------------------------------------------ PNG decoding (8-bit RGB/RGBA, non-interlaced)
function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0, depth = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), d = buf.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ct = d[9]; if (d[12]) throw new Error('interlaced png'); }
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || (ct !== 2 && ct !== 6)) throw new Error(`png type ${ct}/${depth}`);
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(w * h * 4), row = w * bpp;
  let prev = Buffer.alloc(row);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (row + 1)], line = Buffer.from(raw.slice(y * (row + 1) + 1, (y + 1) * (row + 1)));
    for (let x = 0; x < row; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      line[x] = (line[x] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255;
    }
    for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) out[(y * w + x) * 4 + k] = k < bpp ? line[x * bpp + k] : 255;
    prev = line;
  }
  return { w, h, px: out };
}
function texture(img) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bake-'));
  const src = path.join(dir, `t.${img.mime.split('/')[1]}`), dst = path.join(dir, 't.png');
  fs.writeFileSync(src, img.data);
  execFileSync('sips', ['-s', 'format', 'png', src, '--out', dst], { stdio: 'ignore' });
  const t = decodePng(fs.readFileSync(dst));
  fs.rmSync(dir, { recursive: true, force: true });
  return t;
}
/** average colour of a small texel neighbourhood (a vertex stands for an area of the texture) */
function sample(t, u, v) {
  u -= Math.floor(u); v -= Math.floor(v);
  const cx = u * (t.w - 1), cy = v * (t.h - 1), r = Math.max(1, Math.round(t.w / 256));
  const acc = [0, 0, 0]; let n = 0;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = Math.min(t.w - 1, Math.max(0, Math.round(cx + dx))), y = Math.min(t.h - 1, Math.max(0, Math.round(cy + dy)));
    const i = (y * t.w + x) * 4; acc[0] += t.px[i]; acc[1] += t.px[i + 1]; acc[2] += t.px[i + 2]; n++;
  }
  return acc.map((c) => c / n / 255);
}

const srgbToLinear = (c) => c ** 2.2, linearToSrgb = (c) => Math.max(0, Math.min(1, c)) ** (1 / 2.2);

function bake(name) {
  const { json, acc, image } = readGlb(path.join(ROOT, `${name}.glb`));
  const texCache = new Map();
  const pos = [], nrm = [], col = [], idx = [];
  const meshesOf = (ni, out = []) => { const n = json.nodes[ni]; if (n.mesh != null) out.push(n.mesh); for (const c of n.children || []) meshesOf(c, out); return out; };
  const meshIds = json.scenes[json.scene || 0].nodes.flatMap((n) => meshesOf(n));
  for (const mi of meshIds) for (const prim of json.meshes[mi].primitives) {
    if (prim.mode != null && prim.mode !== 4) continue;
    const P = acc(prim.attributes.POSITION), N = prim.attributes.NORMAL != null ? acc(prim.attributes.NORMAL) : null;
    const UV = prim.attributes.TEXCOORD_0 != null ? acc(prim.attributes.TEXCOORD_0) : null;
    const I = prim.indices != null ? acc(prim.indices) : Float64Array.from({ length: P.length / 3 }, (_, i) => i);
    const mat = json.materials && prim.material != null ? json.materials[prim.material] : {};
    const pbr = mat.pbrMetallicRoughness || {};
    const factor = PLAIN.has(name) ? [0.86, 0.87, 0.88, 1] : pbr.baseColorFactor || [1, 1, 1, 1];
    let tex = null;
    if (pbr.baseColorTexture && UV && !PLAIN.has(name)) {
      const ti = json.textures[pbr.baseColorTexture.index].source ?? json.textures[pbr.baseColorTexture.index].extensions?.EXT_texture_webp?.source;
      if (!texCache.has(ti)) texCache.set(ti, texture(image(ti)));
      tex = texCache.get(ti);
    }
    const base = pos.length / 3, n = P.length / 3;
    // normals: given, or smooth normals computed from the triangles
    let NN = N;
    if (!NN) {
      NN = new Float64Array(P.length);
      for (let k = 0; k < I.length; k += 3) {
        const [a, b, c] = [I[k], I[k + 1], I[k + 2]];
        const u = [0, 1, 2].map((j) => P[b * 3 + j] - P[a * 3 + j]), v = [0, 1, 2].map((j) => P[c * 3 + j] - P[a * 3 + j]);
        const f = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        for (const q of [a, b, c]) for (let j = 0; j < 3; j++) NN[q * 3 + j] += f[j];
      }
    }
    for (let k = 0; k < n; k++) {
      pos.push(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]);
      const l = Math.hypot(NN[k * 3], NN[k * 3 + 1], NN[k * 3 + 2]) || 1;
      nrm.push(NN[k * 3] / l, NN[k * 3 + 1] / l, NN[k * 3 + 2] / l);
      // baseColorFactor is linear; texture is sRGB: combine in linear, store sRGB (what the mesh layer multiplies)
      const t = tex ? sample(tex, UV[k * 2], UV[k * 2 + 1]).map(srgbToLinear) : [1, 1, 1];
      col.push(...[0, 1, 2].map((j) => Math.round(linearToSrgb(t[j] * factor[j]) * 255)));
    }
    for (const i of I) idx.push(base + i);
  }
  const nV = pos.length / 3;
  const head = Buffer.alloc(12); head.write('BLM1', 0, 'latin1'); head.writeUInt32LE(nV, 4); head.writeUInt32LE(idx.length, 8);
  const c8 = Buffer.alloc(Math.ceil((nV * 3) / 4) * 4); col.forEach((c, i) => { c8[i] = c; });
  const out = Buffer.concat([head, Buffer.from(new Float32Array(pos).buffer), Buffer.from(new Float32Array(nrm).buffer), c8, Buffer.from(new Uint32Array(idx).buffer)]);
  fs.mkdirSync(path.join(ROOT, 'mesh'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'mesh', `${name}.bin`), out);
  console.log(`${name.padEnd(10)} ${String(nV).padStart(6)} verts ${String(idx.length / 3).padStart(6)} tris ${(out.length / 1024).toFixed(0)} KB, textures ${texCache.size}`);
}
for (const m of MODELS) bake(m);
