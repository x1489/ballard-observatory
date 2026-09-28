// Generate the PWA icons (public/icons/*.png + icon.svg): a teal rounded square with a white sun and wave,
// matching the favicon. Zero dependencies (a tiny supersampled rasterizer + PNG encoder).
// Usage: node tools/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });
const TEAL = [15, 118, 110], WHITE = [255, 255, 255];

/** Coverage of the mark at (x, y) in unit coordinates [0,1]; `scale` shrinks the mark toward the center. */
function shape(x, y, { rounded, scale }) {
  // background: rounded square (or full bleed)
  let bg = 1;
  if (rounded) {
    const r = 0.22, cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r);
    bg = Math.hypot(x - cx, y - cy) <= r ? 1 : 0;
  }
  // mark coordinates (scaled around the center)
  const mx = 0.5 + (x - 0.5) / scale, my = 0.5 + (y - 0.5) / scale;
  const sun = Math.hypot(mx - 0.5, my - 0.36) <= 0.105;
  let wave = false;
  if (mx >= 0.14 && mx <= 0.86) {
    const k = 2 * Math.PI * 2.5;
    const wy = 0.66 + 0.045 * Math.sin(k * (mx - 0.14));
    const slope = 0.045 * k * Math.cos(k * (mx - 0.14));
    wave = Math.abs(my - wy) <= 0.042 * Math.sqrt(1 + slope * slope);
  }
  // round caps at both ends of the wave
  for (const ex of [0.14, 0.86]) {
    const k = 2 * Math.PI * 2.5, ey = 0.66 + 0.045 * Math.sin(k * (ex - 0.14));
    if (Math.hypot(mx - ex, my - ey) <= 0.042) wave = true;
  }
  return { bg, mark: sun || wave };
}

function render(size, opts) {
  const ss = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxx = 0; pxx < size; pxx++) {
      let a = 0, m = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const s = shape((pxx + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, opts);
        a += s.bg; if (s.bg && s.mark) m++;
      }
      const n = ss * ss, cov = a / n, mk = a ? m / a : 0;
      const i = (py * size + pxx) * 4;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(TEAL[c] * (1 - mk) + WHITE[c] * mk);
      px[i + 3] = Math.round(255 * cov);
    }
  }
  return px;
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

for (const [name, size, opts] of [
  ['icon-192.png', 192, { rounded: true, scale: 1 }],
  ['icon-512.png', 512, { rounded: true, scale: 1 }],
  ['maskable-512.png', 512, { rounded: false, scale: 0.72 }], // mark inside the maskable safe zone
  ['apple-touch-icon.png', 180, { rounded: false, scale: 0.86 }],
]) {
  fs.writeFileSync(path.join(OUT, name), png(size, render(size, opts)));
  console.log('wrote', name);
}
fs.writeFileSync(path.join(OUT, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0f766e"/><path d="M5 21c3 0 3-2 6-2s3 2 6 2 3-2 6-2 3 2 4 2" stroke="white" stroke-width="2.4" fill="none" stroke-linecap="round"/><circle cx="16" cy="11" r="3.2" fill="white"/></svg>\n`);
console.log('wrote icon.svg');
