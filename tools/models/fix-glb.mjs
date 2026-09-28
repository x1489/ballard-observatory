// Normalizes third-party aircraft models for deck.gl's PBR shader: removes KHR_materials_ior / KHR_materials_specular
// (the c172 export carries ior = 1000, which renders as a black mirror without an environment map). Idempotent.
// Run: node tools/models/fix-glb.mjs public/models/c172.glb public/models/atr72.glb
import fs from 'node:fs';
const DROP = ['KHR_materials_ior', 'KHR_materials_specular'];
for (const f of process.argv.slice(2)) {
  const b = fs.readFileSync(f);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(`${f}: not a GLB`);
  const jsonLen = b.readUInt32LE(12);
  const j = JSON.parse(b.slice(20, 20 + jsonLen).toString());
  const rest = b.slice(20 + jsonLen); // BIN chunk (header + data)
  let n = 0;
  for (const m of j.materials || []) {
    if (!m.extensions) continue;
    for (const k of DROP) if (m.extensions[k]) { delete m.extensions[k]; n++; }
    if (!Object.keys(m.extensions).length) delete m.extensions;
  }
  for (const key of ['extensionsUsed', 'extensionsRequired']) if (j[key]) { j[key] = j[key].filter((e) => !DROP.includes(e)); if (!j[key].length) delete j[key]; }
  let js = Buffer.from(JSON.stringify(j));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + rest.length, 8);
  head.writeUInt32LE(js.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  fs.writeFileSync(f, Buffer.concat([head, js, rest]));
  console.log(`${f}: removed ${n} material extension(s)`);
}
