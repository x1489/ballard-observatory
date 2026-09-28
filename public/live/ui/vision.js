// Sensor looks for the god's-eye view: natural, night vision (green phosphor with grain), thermal (ironbow false
// colour; vehicles glow hot) and high-contrast mono; plus a targeting HUD that bracket-tracks moving things and prints
// the camera's telemetry. Implemented as SVG colour filters on the map canvas and a 2D overlay (cheap on phones).
import { num, compass } from '../fmt.js';

const FILTERS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <filter id="f-thermal" color-interpolation-filters="sRGB">
    <feColorMatrix type="matrix" values="0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0 0 0 1 0"/>
    <feComponentTransfer><feFuncR type="table" tableValues="0.02 0.18 0.5 0.82 0.97 1 1"/><feFuncG type="table" tableValues="0 0 0.04 0.22 0.52 0.82 1"/><feFuncB type="table" tableValues="0.08 0.42 0.58 0.32 0.06 0.1 0.92"/></feComponentTransfer>
  </filter>
  <filter id="f-nvg" color-interpolation-filters="sRGB">
    <feColorMatrix type="matrix" values="0.05 0.1 0.02 0 0  0.36 0.7 0.14 0 0.03  0.05 0.1 0.02 0 0  0 0 0 1 0"/>
    <feComponentTransfer><feFuncG type="gamma" amplitude="1.25" exponent="0.72" offset="0"/><feFuncR type="gamma" amplitude="1.3" exponent="0.8" offset="0"/></feComponentTransfer>
  </filter>
</svg>`;
export const MODES = [
  { id: 'natural', label: 'Natural', desc: 'Real colour, real sun' },
  { id: 'nvg', label: 'Night vision', desc: 'Green phosphor, image intensified' },
  { id: 'thermal', label: 'Thermal', desc: 'Ironbow false colour; engines run hot' },
  { id: 'mono', label: 'Mono', desc: 'High-contrast black and white' },
];

export function createVision(app) {
  document.body.insertAdjacentHTML('beforeend', FILTERS);
  const cv = document.createElement('canvas');
  cv.className = 'vision-layer';
  document.body.appendChild(cv);
  const g = cv.getContext('2d');
  let mode = 'natural', hud = false, noise = null, raf = 0;
  const canvasEl = () => app.scene.map.getCanvasContainer();

  function makeNoise() {
    const n = document.createElement('canvas'); n.width = n.height = 256;
    const x = n.getContext('2d'), im = x.createImageData(256, 256);
    for (let i = 0; i < im.data.length; i += 4) { const v = Math.random() * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 26; }
    x.putImageData(im, 0, 0);
    return n;
  }
  function set(m) {
    mode = MODES.some((x) => x.id === m) ? m : 'natural';
    const f = mode === 'thermal' ? 'url(#f-thermal) contrast(1.08)' : mode === 'nvg' ? 'url(#f-nvg) contrast(1.25) brightness(1.15)' : mode === 'mono' ? 'grayscale(1) contrast(1.35) brightness(1.04)' : '';
    canvasEl().style.filter = f;
    app.layers.air.set({ thermal: mode === 'thermal' });
    document.body.dataset.vision = mode;
    if (mode !== 'natural' && !noise) noise = makeNoise();
    loop();
  }
  function resize() { const d = Math.min(devicePixelRatio || 1, 2); cv.width = innerWidth * d; cv.height = innerHeight * d; g.setTransform(d, 0, 0, d, 0, 0); }
  addEventListener('resize', resize); resize();

  function bracket(x, y, s, col) {
    const k = s * 0.35;
    g.strokeStyle = col; g.lineWidth = 1.5;
    g.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { g.moveTo(x + sx * s, y + sy * (s - k)); g.lineTo(x + sx * s, y + sy * s); g.lineTo(x + sx * (s - k), y + sy * s); }
    g.stroke();
  }
  function draw() {
    const W = innerWidth, H = innerHeight;
    g.clearRect(0, 0, W, H);
    const t = performance.now();
    if (mode !== 'natural') {
      if (noise) { g.save(); g.globalAlpha = mode === 'nvg' ? 0.9 : 0.5; const ox = (t * 0.37) % 256, oy = (t * 0.61) % 256; g.translate(-ox, -oy); g.fillStyle = g.createPattern(noise, 'repeat'); g.fillRect(0, 0, W + 256, H + 256); g.restore(); }
      if (mode === 'nvg') { g.fillStyle = 'rgba(0,0,0,.07)'; for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1); }
      const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.72);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, mode === 'nvg' ? 'rgba(0,0,0,.72)' : 'rgba(0,0,0,.45)');
      g.fillStyle = vg; g.fillRect(0, 0, W, H);
    }
    if (hud || mode !== 'natural') {
      const col = mode === 'nvg' ? 'rgba(170,255,170,.9)' : mode === 'thermal' ? 'rgba(255,240,200,.9)' : 'rgba(160,230,255,.9)';
      g.font = '600 11px "JetBrains Mono", ui-monospace, monospace';
      g.fillStyle = col;
      for (const c of app.contacts()) {
        const [x, y] = app.scene.project(c.lon, c.lat, c.alt || 0);
        if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
        const s = c.kind === 'aircraft' ? 16 : 11;
        bracket(x, y, s, c.selected ? '#ffffff' : col);
        g.fillText(c.label, x + s + 5, y - s + 9);
        if (c.sub) { g.globalAlpha = 0.75; g.fillText(c.sub, x + s + 5, y - s + 22); g.globalAlpha = 1; }
      }
      // telemetry corners
      const m = app.scene.map, cen = m.getCenter();
      const lines = [`LAT ${cen.lat.toFixed(5)}  LON ${cen.lng.toFixed(5)}`, `HDG ${num(m.getBearing() < 0 ? m.getBearing() + 360 : m.getBearing())}° ${compass(m.getBearing())}  PITCH ${num(m.getPitch())}°  Z ${m.getZoom().toFixed(1)}`,
        `${new Date().toISOString().slice(11, 19)}Z  SUN ${num(app.scene.sun().elevation, 1)}°`];
      g.textAlign = 'left';
      lines.forEach((l, i) => g.fillText(l, 18, H - 120 + i * 15));
      g.textAlign = 'right';
      const cnt = app.counts();
      const rx = W - (document.body.classList.contains('sheet-open') ? 480 : 84);
      [`AIR ${cnt.air}`, `BUS ${cnt.bus}`, `RAIL ${cnt.train}`, `911 ${cnt.calls}`, `MODE ${mode.toUpperCase()}`].forEach((l, i) => g.fillText(l, rx, 96 + i * 15));
      g.textAlign = 'left';
      g.strokeStyle = col; g.globalAlpha = 0.5; g.beginPath(); g.moveTo(W / 2 - 14, H / 2); g.lineTo(W / 2 - 4, H / 2); g.moveTo(W / 2 + 4, H / 2); g.lineTo(W / 2 + 14, H / 2);
      g.moveTo(W / 2, H / 2 - 14); g.lineTo(W / 2, H / 2 - 4); g.moveTo(W / 2, H / 2 + 4); g.lineTo(W / 2, H / 2 + 14); g.stroke(); g.globalAlpha = 1;
    }
  }
  function loop() {
    cancelAnimationFrame(raf);
    if (mode === 'natural' && !hud) { g.clearRect(0, 0, cv.width, cv.height); return; }
    const step = () => { draw(); raf = requestAnimationFrame(step); };
    step();
  }
  return { set, get mode() { return mode; }, hud(on) { hud = !!on; loop(); }, get hudOn() { return hud; } };
}
