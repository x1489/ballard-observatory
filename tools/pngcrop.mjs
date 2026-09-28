// Crop a PNG (8-bit RGB/RGBA, non-interlaced; what Chrome screenshots produce). Zero dependencies.
// Usage: node tools/pngcrop.mjs in.png out.png <y> <height> [<x> <width>]
import fs from 'node:fs';
import zlib from 'node:zlib';

const [inp, out, y0s, hs, x0s, ws] = process.argv.slice(2);
const buf = fs.readFileSync(inp);
let pos = 8, width, height, bitDepth, colorType, interlace;
const idat = [];
while (pos < buf.length) {
  const len = buf.readUInt32BE(pos);
  const type = buf.toString('ascii', pos + 4, pos + 8);
  const data = buf.subarray(pos + 8, pos + 8 + len);
  if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
  else if (type === 'IDAT') idat.push(data);
  else if (type === 'IEND') break;
  pos += 12 + len;
}
if (bitDepth !== 8 || interlace || ![2, 6].includes(colorType)) throw new Error(`unsupported PNG (depth ${bitDepth}, color ${colorType}, interlace ${interlace})`);
const bpp = colorType === 6 ? 4 : 3;
const raw = zlib.inflateSync(Buffer.concat(idat));
const stride = width * bpp;
const px = Buffer.alloc(height * stride);
for (let r = 0; r < height; r++) {
  const f = raw[r * (stride + 1)];
  const line = raw.subarray(r * (stride + 1) + 1, (r + 1) * (stride + 1));
  const cur = px.subarray(r * stride, (r + 1) * stride);
  const prev = r ? px.subarray((r - 1) * stride, r * stride) : Buffer.alloc(stride);
  for (let i = 0; i < stride; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
    let v = line[i];
    if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
    else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
    cur[i] = v & 255;
  }
}
const y0 = Math.max(0, +y0s || 0), h = Math.min(height - y0, +hs || height);
const x0 = Math.max(0, +x0s || 0), w = Math.min(width - x0, +ws || width);
const outRaw = Buffer.alloc(h * (w * bpp + 1));
for (let r = 0; r < h; r++) {
  outRaw[r * (w * bpp + 1)] = 0;
  px.copy(outRaw, r * (w * bpp + 1) + 1, (y0 + r) * stride + x0 * bpp, (y0 + r) * stride + (x0 + w) * bpp);
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = colorType;
fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(outRaw)), chunk('IEND', Buffer.alloc(0))]));
console.log(`${out}: ${w}x${h} from ${width}x${height}`);
