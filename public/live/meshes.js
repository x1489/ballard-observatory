// Vertex-coloured vehicle meshes (public/models/mesh/*.bin, built by tools/models/vehicles.mjs), loaded once and
// shared by every layer that draws them. A whole fleet of one body type is then one instanced draw call.
const cache = new Map(); // name -> mesh | null (loading) | false (failed)

function parse(buf) {
  const dv = new DataView(buf);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'BLM1') throw new Error('bad mesh');
  const n = dv.getUint32(4, true), m = dv.getUint32(8, true);
  let off = 12;
  const positions = new Float32Array(buf, off, n * 3); off += n * 12;
  const normals = new Float32Array(buf, off, n * 3); off += n * 12;
  const c8 = new Uint8Array(buf, off, n * 3); off += Math.ceil((n * 3) / 4) * 4;
  const indices = new Uint32Array(buf, off, m);
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < c8.length; i++) colors[i] = c8[i] / 255;
  return { attributes: { positions: { value: positions, size: 3 }, normals: { value: normals, size: 3 }, colors: { value: colors, size: 3 } }, indices: { value: indices, size: 1 } };
}

/** The mesh called `name`, or null while it loads (the caller skips drawing it until then). */
export function mesh(name) {
  const m = cache.get(name);
  if (m) return m;
  if (m === undefined) {
    cache.set(name, null);
    fetch(`/models/mesh/${name}.bin`).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then((b) => cache.set(name, parse(b))).catch(() => cache.set(name, false));
  }
  return null;
}

/** Lighting response of painted vehicle bodies: a clear sun-lit side, a soft specular glint. */
export const PAINT = { ambient: 0.6, diffuse: 0.55, shininess: 40, specularColor: [60, 64, 70] };
