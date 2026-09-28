// The hero: "Living Ballard", a canvas scene drawn entirely from live data, the Moments spotlight carousel beside it,
// and the Dynamic-Island-style live pill in the header.
//   Sky color & sun/moon/stars: real astronomy (insight.sunPosition / moonPosition) · Clouds: cloud cover + wind ·
//   Rain / fog: current conditions · Olympics on the horizon · Near water + beach: the real tide height ·
//   Ballard Bridge leaves: raised when the bridge is really up (cars queue) · Sailboats heel with West Point wind ·
//   Lights crossing the sky: the aircraft overhead · Aurora curtains when Kp >= 5 at night.
import { sunPosition, moonPosition, moments, liveActivities, suggestions } from '../insight.js';
import { icon } from '../icons.js';
import { usualOf, onBaselines } from '../baseline.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const hexc = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * clamp(t, 0, 1)));
const rgba = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
// Seeded PRNG so the skyline, stars and clouds are stable between reloads.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

const SKY = [ // sun elevation -> [zenith, horizon]
  [-18, '#040816', '#0a1228'], [-10, '#081230', '#1a2d55'], [-5, '#14264f', '#5a4a6e'], [-1, '#2a3f73', '#e0826a'],
  [3, '#3d6aa8', '#f4ab6b'], [10, '#3f7fc4', '#bcd9ee'], [25, '#2f78c8', '#a9d3f2'], [70, '#2a6fc2', '#9fcdf2'],
].map(([e, a, b]) => [e, hexc(a), hexc(b)]);
function skyColors(el) {
  if (el <= SKY[0][0]) return [SKY[0][1], SKY[0][2]];
  for (let i = 1; i < SKY.length; i++) {
    if (el <= SKY[i][0]) {
      const t = (el - SKY[i - 1][0]) / (SKY[i][0] - SKY[i - 1][0]);
      return [mix(SKY[i - 1][1], SKY[i][1], t), mix(SKY[i - 1][2], SKY[i][2], t)];
    }
  }
  return [SKY[SKY.length - 1][1], SKY[SKY.length - 1][2]];
}

export default function init(api) {
  const u = api.util;
  const { esc, isNum, r0, r1, time, reducedMotion } = u;

  // ================================================================ DOM
  const hero = document.createElement('section');
  hero.id = 'hero';
  hero.className = 'hero';
  hero.setAttribute('aria-label', 'Ballard right now');
  hero.innerHTML = `
    <div class="hero-scene">
      <canvas aria-hidden="true"></canvas>
      <div class="hero-ov">
        <div class="hero-place"><span class="hero-where">Ballard</span> · <span class="hero-when"></span></div>
        <div class="hero-temp" data-live-key="hero-temp">–</div>
        <div class="hero-cond"></div>
        <div class="hero-facts"></div>
      </div>
      <div class="hero-btns"><button type="button" class="hero-btn hero-share" title="Share Ballard right now" aria-label="Share Ballard right now">${icon('share', { size: 16 })}</button>
      <button type="button" class="hero-btn hero-info" aria-expanded="false" aria-controls="hero-legend" title="What am I looking at?" aria-label="What am I looking at?">${icon('info', { size: 16 })}</button></div>
      <div class="hero-legend" id="hero-legend" hidden>
        <b>This scene is drawn from live data</b>
        <ul><li>Sky, sun, moon and stars: their real positions over Ballard right now</li><li>Clouds: real cloud cover, drifting with the wind</li>
        <li>Rain and fog: current conditions</li><li>The water at the piling and the beach: today's actual tide height</li>
        <li>The Ballard Bridge: raised when it's really up</li><li>Sailboats: heel with the wind at West Point</li>
        <li>Lights crossing the sky: the aircraft overhead right now</li></ul>
      </div>
    </div>
    <div class="hero-moments" aria-roledescription="carousel" aria-label="Moments">
      <div class="hm-head"><span class="hm-title">${icon('sparkle', { size: 15 })} Moments</span>
        <span class="hm-nav"><button type="button" class="hm-btn" data-hm="prev" aria-label="Previous moment">${icon('left', { size: 16 })}</button><button type="button" class="hm-btn" data-hm="next" aria-label="Next moment">${icon('right', { size: 16 })}</button></span></div>
      <div class="hm-track" tabindex="0"></div>
      <div class="hm-dots" role="tablist" aria-label="Choose a moment"></div>
      <div class="hm-ask">
        <button type="button" class="hm-askbox" data-ask="">${icon('search', { size: 16 })}<span>Ask Ballard anything…</span><kbd>⌘K</kbd></button>
        <div class="hm-chips"></div>
      </div>
    </div>`;
  const main = document.querySelector('main');
  const glance = document.getElementById('glance');
  main.insertBefore(hero, glance || main.firstChild);
  const summaryLine = document.getElementById('summary-line');
  if (summaryLine) hero.after(summaryLine);

  const canvas = hero.querySelector('canvas');
  let ctx = canvas.getContext('2d');
  const scene = hero.querySelector('.hero-scene');
  hero.querySelector('.hero-share').addEventListener('click', () => api.emit('share:open'));
  const infoBtn = hero.querySelector('.hero-info');
  const legend = hero.querySelector('#hero-legend');
  infoBtn.addEventListener('click', () => { legend.hidden = !legend.hidden; infoBtn.setAttribute('aria-expanded', String(!legend.hidden)); });

  // ================================================================ scene state (derived from data)
  const st = {
    el: 10, az: 180, moon: null, cloud: 30, windMph: 5, windDir: 270, rain: 0, visMi: 10, kp: 0,
    tideFt: 5, tideTrend: '', bridgeUp: false, leaf: 0, westKt: 5, planes: [],
  };
  let W = 0, H = 0, dpr = 1;
  const R = rng(7);
  // The Olympics: layered octaves plus a few sharp summits (a nod to Mt Constance / The Brothers / Olympus).
  const ridge = Array.from({ length: 220 }, (_, i) => {
    const x = i / 219;
    let v = 0.42 + Math.sin(x * 7.3 + 0.4) * 0.16 + Math.sin(x * 17.9 + 1.7) * 0.09 + Math.abs(Math.sin(x * 41.3 + 0.2)) * 0.07 + R() * 0.035;
    for (const [c, h, wdt] of [[0.18, 0.34, 0.035], [0.43, 0.42, 0.03], [0.61, 0.3, 0.04], [0.83, 0.38, 0.03]]) v += h * Math.max(0, 1 - Math.abs(x - c) / wdt) ** 1.6;
    return clamp(v * (0.35 + 0.65 * Math.sin(clamp(x, 0, 1) * Math.PI) ** 0.35), 0.05, 1.25);
  });
  const stars = Array.from({ length: 140 }, () => ({ x: R(), y: R() * 0.62, r: R() * 1.1 + 0.3, p: R() * TAU, s: 0.6 + R() * 1.6 }));
  const clouds = Array.from({ length: 16 }, (_, i) => {
    const puffs = Array.from({ length: 5 + Math.floor(R() * 4) }, () => ({ dx: (R() - 0.5) * 1.6, dy: (R() - 0.5) * 0.35, r: 0.28 + R() * 0.32 }));
    return { x: R(), y: 0.08 + R() * 0.38, s: 0.6 + R() * 0.9, puffs, order: i };
  });
  const rain = Array.from({ length: 260 }, () => ({ x: R(), y: R(), l: 0.6 + R() * 0.8, v: 0.7 + R() * 0.6 }));
  const gulls = Array.from({ length: 3 }, (_, i) => ({ x: R(), y: 0.25 + R() * 0.2, v: 0.004 + R() * 0.004, p: R() * TAU, i }));
  const cars = Array.from({ length: 9 }, (_, i) => ({ x: R(), lane: i % 2, v: 0.05 + R() * 0.03, c: ['#f8fafc', '#fca5a5', '#fde68a', '#93c5fd', '#a7f3d0'][i % 5] }));
  const boats = [{ x: 0.52, y: 0.035, s: 1 }, { x: 0.6, y: 0.05, s: 0.8 }, { x: 0.86, y: 0.03, s: 1.1 }];

  function readData(now) {
    const D = api.D;
    const sp = sunPosition(now);
    st.el = sp.elevation; st.az = sp.azimuth;
    st.moon = moonPosition(D('sky'), now);
    const w = D('weather');
    if (w && w.current) {
      const c = w.current;
      st.cloud = isNum(c.cloud) ? c.cloud : 30;
      st.windMph = isNum(c.windMph) ? c.windMph : 5;
      st.windDir = isNum(c.windDir) ? c.windDir : 270;
      st.visMi = isNum(c.visMi) ? c.visMi : 10;
      const nc = (w.nowcast || [])[0];
      const inten = Math.max(c.precipIn || 0, nc ? (nc.precipIn || 0) * 4 : 0);
      const wetCode = (c.code >= 51 && c.code <= 67) || (c.code >= 80 && c.code <= 82) || c.code >= 95;
      st.rain = wetCode || inten > 0.001 ? clamp(0.25 + inten * 25, 0.25, 1) : 0;
    }
    const kp = D('kp');
    st.kp = kp && isNum(kp.kp) ? kp.kp : 0;
    const td = D('tides');
    if (td && api.cards.tideAt) { const t = api.cards.tideAt(td, now); if (isNum(t.ft)) { st.tideFt = t.ft; st.tideTrend = t.trend; } }
    const b = D('bridges');
    const bb = b && (b.bridges || []).find((x) => /ballard/i.test(x.name));
    st.bridgeUp = !!(bb && bb.up);
    const wp = D('westpoint');
    st.westKt = wp && isNum(wp.windKt) ? wp.windKt : st.windMph * 0.87;
    const ac = D('aircraft');
    const list = ((ac && ac.aircraft) || []).filter((x) => !x.onGround && isNum(x.altFt)).slice(0, 7);
    const keep = new Map(st.planes.map((p) => [p.hex, p]));
    st.planes = list.map((x, i) => {
      const p = keep.get(x.hex) || { hex: x.hex, x: 0.1 + ((i * 0.37) % 0.8), blink: R() * TAU };
      p.alt = x.altFt;
      p.dir = isNum(x.track) ? (x.track > 180 ? 1 : -1) : 1; // westbound drifts right (we face west)
      p.v = clamp((x.gsKt || 120) / 5200, 0.008, 0.05);
      p.heli = x.kind === 'helicopter';
      return p;
    });
  }

  // ================================================================ drawing
  function resize() {
    const r = scene.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(200, Math.round(r.width)); H = Math.max(160, Math.round(r.height));
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(tMs) {
    const t = tMs / 1000;
    const hz = H * 0.64; // horizon
    const [zen, hor] = skyColors(st.el);
    const night = clamp((-st.el - 2) / 10, 0, 1);
    const over = clamp(st.cloud / 100, 0, 1) * 0.75 + st.rain * 0.2;
    const greyTop = night > 0.5 ? [22, 26, 34] : [128, 140, 154];
    const greyHor = night > 0.5 ? [34, 38, 48] : [178, 186, 194];
    const top = mix(zen, greyTop, over), low = mix(hor, greyHor, over);

    // sky
    const g = ctx.createLinearGradient(0, 0, 0, hz);
    g.addColorStop(0, rgba(top)); g.addColorStop(1, rgba(low));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, hz + 1);

    // stars + aurora
    if (night > 0.05) {
      const vis = night * (1 - clamp(st.cloud / 100, 0, 1) * 0.9);
      for (const s of stars) {
        const a = vis * (0.45 + 0.55 * Math.sin(t * s.s + s.p) ** 2);
        if (a < 0.03) continue;
        ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
        ctx.beginPath(); ctx.arc(s.x * W, s.y * hz, s.r, 0, TAU); ctx.fill();
      }
      if (st.kp >= 5) {
        for (let i = 0; i < 5; i++) {
          const x = W * (0.05 + i * 0.08) + Math.sin(t * 0.3 + i) * 12;
          const ag = ctx.createLinearGradient(0, hz * 0.05, 0, hz * 0.7);
          ag.addColorStop(0, 'rgba(120,255,170,0)'); ag.addColorStop(0.5, `rgba(90,240,160,${0.12 * vis + 0.05})`); ag.addColorStop(1, 'rgba(90,240,160,0)');
          ctx.fillStyle = ag;
          ctx.beginPath(); ctx.ellipse(x, hz * 0.38, 18 + i * 3, hz * 0.34, Math.sin(t * 0.2 + i) * 0.15, 0, TAU); ctx.fill();
        }
      }
    }

    // sun (we face west: east = left, west = right)
    const skyX = (az) => clamp((az - 60) / 240, -0.1, 1.1) * W;
    const skyY = (el) => hz - clamp(el / 62, -0.1, 1) * hz * 0.9;
    if (st.el > -4) {
      const x = skyX(st.az), y = skyY(st.el);
      const warm = clamp(1 - st.el / 14, 0, 1);
      const core = mix([255, 246, 214], [255, 176, 96], warm);
      const glow = ctx.createRadialGradient(x, y, 2, x, y, 70 + warm * 50);
      glow.addColorStop(0, rgba(core, 0.55 * (1 - over * 0.7))); glow.addColorStop(1, rgba(core, 0));
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, 120, 0, TAU); ctx.fill();
      ctx.fillStyle = rgba(core, 1 - over * 0.8); ctx.beginPath(); ctx.arc(x, y, 11 + warm * 3, 0, TAU); ctx.fill();
    }
    // moon with its real phase
    const m = st.moon;
    if (m && m.up && m.elevation > -2) {
      const x = skyX(m.azimuth), y = skyY(m.elevation), r = 10;
      const mg = ctx.createRadialGradient(x, y, 1, x, y, 45);
      mg.addColorStop(0, `rgba(230,236,255,${0.28 * (1 - over * 0.6)})`); mg.addColorStop(1, 'rgba(230,236,255,0)');
      ctx.fillStyle = mg; ctx.beginPath(); ctx.arc(x, y, 45, 0, TAU); ctx.fill();
      ctx.save();
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.clip();
      ctx.fillStyle = `rgba(242,244,255,${0.95 - over * 0.5})`; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
      // shadow: a disc offset toward the dark side by 2r x (lit fraction); waxing = lit on the right (northern hemisphere)
      if (m.illum < 0.98) {
        const off = 2 * r * m.illum;
        ctx.fillStyle = rgba(top, 0.93);
        ctx.beginPath(); ctx.arc(x + (m.waxing ? -off : off), y, r, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }

    // clouds
    const nClouds = Math.round(clamp(st.cloud, 0, 100) / 100 * clouds.length);
    const cc = night > 0.5 ? mix([70, 78, 96], [40, 44, 56], over) : mix(st.el < 6 ? [255, 214, 196] : [250, 251, 253], [150, 160, 172], over * 0.9);
    const drift = (st.windDir > 180 && st.windDir < 360 ? -1 : 1) * (0.004 + st.windMph / 2400);
    for (let i = 0; i < nClouds; i++) {
      const c = clouds[i];
      const cx = (((c.x + drift * t) % 1.4) + 1.4) % 1.4 - 0.2;
      const size = hz * 0.12 * c.s;
      const alpha = 0.8 + over * 0.15;
      for (const p of c.puffs) {
        const px = cx * W + p.dx * size, py = c.y * hz + p.dy * size, rr = p.r * size * 1.25;
        const pg = ctx.createRadialGradient(px, py - rr * 0.25, rr * 0.1, px, py, rr);
        pg.addColorStop(0, rgba(mix(cc, [255, 255, 255], 0.25), alpha)); pg.addColorStop(0.6, rgba(cc, alpha * 0.85)); pg.addColorStop(1, rgba(cc, 0));
        ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(px, py, rr, 0, TAU); ctx.fill();
      }
    }

    // aircraft lights
    for (const p of st.planes) {
      p.x += p.v * p.dir / 30;
      if (p.x > 1.05) p.x = -0.05; if (p.x < -0.05) p.x = 1.05;
      const y = hz - clamp(p.alt / 12000, 0.04, 1) * hz * 0.85;
      const x = p.x * W;
      ctx.fillStyle = night > 0.3 ? 'rgba(255,255,255,.9)' : 'rgba(30,41,59,.75)';
      if (p.heli) { ctx.fillRect(x - 3, y - 1, 6, 2.2); ctx.fillRect(x - 5, y - 3.5, 10, 1); }
      else { ctx.beginPath(); ctx.moveTo(x - 5 * p.dir, y); ctx.lineTo(x + 5 * p.dir, y); ctx.lineTo(x - 2 * p.dir, y - 2.5); ctx.closePath(); ctx.fill(); ctx.fillRect(x - 5 * p.dir, y - 0.6, 10 * p.dir, 1.2); }
      if (Math.sin(t * 4 + p.blink) > 0.6) { ctx.fillStyle = 'rgba(255,60,60,.95)'; ctx.beginPath(); ctx.arc(x, y + 1.5, 1.3, 0, TAU); ctx.fill(); }
    }

    // gulls in daylight
    if (night < 0.3 && st.rain < 0.5) {
      ctx.strokeStyle = 'rgba(40,48,60,.55)'; ctx.lineWidth = 1.2;
      for (const gl of gulls) {
        gl.x = (gl.x + gl.v / 30) % 1.1;
        const x = gl.x * W, y = gl.y * hz + Math.sin(t * 0.7 + gl.p) * 4, f = Math.sin(t * 5 + gl.p) * 2.5;
        ctx.beginPath(); ctx.moveTo(x - 6, y - f); ctx.quadraticCurveTo(x - 3, y - 3, x, y); ctx.quadraticCurveTo(x + 3, y - 3, x + 6, y - f); ctx.stroke();
      }
    }

    // the Olympics
    // atmospheric haze: the range fades into the sky color, more so under cloud and at night
    const mcol = mix(mix(low, night > 0.5 ? [8, 12, 24] : [62, 78, 104], 0.62 + night * 0.25), low, over * 0.45);
    const snow = mix(mcol, night > 0.5 ? [150, 160, 182] : [246, 248, 252], (0.85 - over * 0.45) * (1 - night * 0.45));
    const mx0 = W * 0.3, Hm = H * 0.2;
    const px0 = (i) => mx0 + (i / (ridge.length - 1)) * (W - mx0);
    ctx.fillStyle = rgba(mcol);
    ctx.beginPath(); ctx.moveTo(mx0, hz); ridge.forEach((v, i) => ctx.lineTo(px0(i), hz - v * Hm)); ctx.lineTo(W, hz); ctx.closePath(); ctx.fill();
    // snowcaps on the high peaks
    ctx.fillStyle = rgba(snow, 0.92);
    ctx.beginPath();
    let on = false;
    ridge.forEach((v, i) => {
      const depth = (v - 0.62) * Hm * 0.55;
      if (depth > 0.5) { if (!on) { ctx.moveTo(px0(i), hz - v * Hm); on = true; } else ctx.lineTo(px0(i), hz - v * Hm); }
      else if (on) { for (let j = i - 1; j >= 0 && (ridge[j] - 0.62) * Hm * 0.55 > 0.5; j--) ctx.lineTo(px0(j), hz - ridge[j] * Hm + (ridge[j] - 0.62) * Hm * 0.55 * (0.7 + 0.3 * Math.sin(j * 1.7))); ctx.closePath(); on = false; }
    });
    ctx.fill();
    // a second, nearer and darker foothill layer for depth
    const fcol = mix(mcol, night > 0.5 ? [4, 6, 12] : [40, 58, 72], 0.45);
    ctx.fillStyle = rgba(fcol);
    ctx.beginPath(); ctx.moveTo(W * 0.4, hz);
    for (let i = 0; i <= 60; i++) { const x = i / 60; ctx.lineTo(W * 0.4 + x * W * 0.6, hz - (0.12 + Math.sin(x * 11 + 0.8) * 0.04 + Math.sin(x * 29) * 0.02) * Hm * (0.4 + 0.6 * Math.sin(x * Math.PI))); }
    ctx.lineTo(W, hz); ctx.closePath(); ctx.fill();

    // far water (Puget Sound) with sun/moon glitter
    const wTop = mix(low, [30, 60, 90], 0.45 + night * 0.3), wLow = mix(top, [10, 30, 50], 0.55);
    const wg = ctx.createLinearGradient(0, hz, 0, H);
    wg.addColorStop(0, rgba(wTop)); wg.addColorStop(1, rgba(wLow));
    ctx.fillStyle = wg; ctx.fillRect(0, hz, W, H - hz);
    const glintX = st.el > -3 ? skyX(st.az) : m && m.up ? skyX(m.azimuth) : null;
    if (glintX != null) {
      for (let i = 0; i < 14; i++) {
        const y = hz + 3 + i * 4.5;
        const w = (10 + i * 3) * (0.6 + 0.4 * Math.sin(t * 2 + i));
        ctx.fillStyle = `rgba(255,236,200,${(0.35 - i * 0.02) * (1 - over * 0.8)})`;
        ctx.fillRect(glintX - w / 2 + Math.sin(t + i) * 3, y, w, 1.4);
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 1;
    for (let i = 0; i < 18; i++) { const y = hz + 6 + ((i * 13.7) % (H - hz - 8)); const x = ((i * 97.3 + t * 12) % (W + 60)) - 30; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 22, y); ctx.stroke(); }

    // sailboats (heel with the wind)
    const heel = clamp(st.westKt / 26, 0, 1) * 0.35;
    for (const [i, b] of boats.entries()) {
      const x = b.x * W, y = hz + H * b.y + Math.sin(t * 1.3 + i) * 1.2, s = b.s * H * 0.06;
      ctx.save(); ctx.translate(x, y); ctx.rotate(heel * (i % 2 ? 1 : 0.8));
      ctx.fillStyle = night > 0.5 ? 'rgba(200,210,225,.5)' : 'rgba(250,250,252,.92)';
      ctx.beginPath(); ctx.moveTo(0, -s); ctx.lineTo(0, -2); ctx.lineTo(s * 0.55, -2); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(30,35,45,.7)'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -s * 1.05); ctx.stroke();
      ctx.fillStyle = 'rgba(30,35,45,.8)'; ctx.fillRect(-s * 0.3, -2, s * 0.8, 2.5);
      ctx.restore();
    }

    // beach (Golden Gardens), then the near water at the real tide height
    const tideN = clamp((st.tideFt + 2) / 15, 0, 1);
    const yT = H * (0.985 - 0.2 * tideN);
    ctx.fillStyle = night > 0.5 ? 'rgba(90,82,70,.9)' : 'rgba(214,196,160,.95)';
    ctx.beginPath(); ctx.moveTo(W * 0.56, H); ctx.lineTo(W * 0.66, H * 0.83); ctx.quadraticCurveTo(W * 0.85, H * 0.77, W, H * 0.76); ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
    const ng = ctx.createLinearGradient(0, yT, 0, H);
    const nw = mix(wTop, [18, 76, 88], 0.4);
    ng.addColorStop(0, rgba(nw, 0.92)); ng.addColorStop(1, rgba(mix(nw, [6, 30, 40], 0.5), 0.96));
    ctx.fillStyle = ng;
    ctx.beginPath(); ctx.moveTo(0, yT);
    for (let x = 0; x <= W; x += 16) ctx.lineTo(x, yT + Math.sin(x / 38 + t * 1.6) * 1.6);
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); for (let x = W * 0.6; x <= W; x += 8) ctx.lineTo(x, yT + Math.sin(x / 20 + t * 2.2) * 1.4); ctx.stroke();

    // tide piling with a scale
    const px = W * 0.47, pTop = H * 0.7, pBot = H;
    ctx.fillStyle = night > 0.5 ? 'rgba(60,50,40,.95)' : 'rgba(96,72,48,.95)';
    ctx.fillRect(px - 4, pTop, 8, pBot - pTop);
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    for (let f = 0; f <= 12; f += 2) { const y = H * (0.985 - 0.2 * clamp((f + 2) / 15, 0, 1)); ctx.fillRect(px + 4, y, f % 4 ? 3 : 6, 1); }

    // the Ballard Bridge (bascule leaves rise when it is really up)
    const target = st.bridgeUp ? 1 : 0;
    st.leaf += (target - st.leaf) * (reducedMotion() ? 1 : 0.03);
    const deckY = H * 0.58, x1 = W * 0.12, x2 = W * 0.31, xc = (x1 + x2) / 2;
    const k = clamp(H / 400, 0.8, 2); // bridge detail scales with the canvas (hero ≈ 1, share card ≈ 1.9)
    const sil = night > 0.5 ? 'rgba(14,18,28,.96)' : 'rgba(34,44,60,.92)';
    const rail = night > 0.5 ? 'rgba(40,48,64,.9)' : 'rgba(60,72,92,.85)';
    ctx.fillStyle = sil; ctx.strokeStyle = sil;
    // approach spans on slim columns, with a railing
    const dk = 5 * k;
    ctx.fillRect(0, deckY, x1 - 2, dk); ctx.fillRect(x2 + 2, deckY, W * 0.42 - x2, dk);
    for (const x of [W * 0.035, W * 0.075, x2 + (W * 0.42 - x2) * 0.5]) ctx.fillRect(x - 2 * k, deckY + dk, 4 * k, H - deckY);
    ctx.strokeStyle = rail; ctx.lineWidth = k;
    ctx.beginPath(); ctx.moveTo(0, deckY - 3 * k); ctx.lineTo(x1 - 2, deckY - 3 * k); ctx.moveTo(x2 + 2, deckY - 3 * k); ctx.lineTo(W * 0.42, deckY - 3 * k); ctx.stroke();
    // bascule piers with tender houses (little roofs)
    ctx.fillStyle = sil;
    for (const x of [x1, x2]) {
      ctx.fillRect(x - 9 * k, deckY, 18 * k, H - deckY);
      ctx.fillRect(x - 7 * k, deckY - 14 * k, 14 * k, 12 * k);
      ctx.beginPath(); ctx.moveTo(x - 9 * k, deckY - 14 * k); ctx.lineTo(x, deckY - 21 * k); ctx.lineTo(x + 9 * k, deckY - 14 * k); ctx.closePath(); ctx.fill();
      ctx.fillStyle = night > 0.3 ? 'rgba(253,224,130,.95)' : 'rgba(200,215,230,.7)';
      ctx.fillRect(x - 3 * k, deckY - 11 * k, 6 * k, 4 * k);
      ctx.fillStyle = sil;
    }
    // the leaves: a girder with a counterweight, rotating about the pier
    const ang = st.leaf * 1.22, leafLen = xc - x1 - 3;
    for (const [px2, dir] of [[x1, 1], [x2, -1]]) {
      ctx.save(); ctx.translate(px2, deckY + 2 * k); ctx.rotate(-dir * ang);
      ctx.fillStyle = sil; ctx.fillRect(dir > 0 ? 0 : -leafLen, -2.5 * k, leafLen, dk);
      ctx.strokeStyle = rail; ctx.lineWidth = k;
      ctx.beginPath(); ctx.moveTo(0, -5 * k); ctx.lineTo(dir * leafLen, -5 * k); ctx.stroke();
      for (let j = 1; j < 6; j++) { ctx.beginPath(); ctx.moveTo(dir * leafLen * j / 6, -5 * k); ctx.lineTo(dir * leafLen * (j - 0.5) / 6, 0); ctx.stroke(); }
      ctx.fillRect(dir > 0 ? -12 * k : 4 * k, -k, 8 * k, 7 * k); // counterweight
      ctx.restore();
    }
    if (night > 0.3) { ctx.fillStyle = 'rgba(253,224,130,.9)'; for (let x = 6; x < W * 0.42; x += 22 * k) if (x < x1 - 4 || x > x2 + 4) ctx.fillRect(x, deckY - 3 * k, 2 * k, 2 * k); }
    // traffic: flows when down, queues at the gates when up
    for (const c of cars) {
      if (st.leaf < 0.05) c.x = (c.x + (c.lane ? -1 : 1) * c.v / 30 + 1) % 1;
      else { const stop = c.lane ? (x2 + 8 * k) / (W * 0.42) : (x1 - 8 * k) / (W * 0.42); if (c.lane ? c.x > stop : c.x < stop) c.x = Math.max(c.lane ? stop : 0, Math.min(c.lane ? 1 : stop, c.x + (c.lane ? -1 : 1) * c.v / 30)); }
      const cxp = c.x * W * 0.42;
      if (st.leaf > 0.05 && cxp > x1 - 2 && cxp < x2 + 2) continue;
      ctx.fillStyle = night > 0.3 ? (c.lane ? 'rgba(255,90,90,.95)' : 'rgba(255,245,200,.95)') : c.c;
      ctx.fillRect(cxp - 2.5 * k, deckY - 2.2 * k + c.lane * 0.5 * k, 5 * k, 2.2 * k);
    }
    if (st.leaf > 0.1 && Math.sin(t * 5) > 0) { ctx.fillStyle = 'rgba(255,40,40,.95)'; for (const x of [x1 - 10 * k, x2 + 10 * k]) { ctx.beginPath(); ctx.arc(x, deckY - 8 * k, 2.2 * k, 0, TAU); ctx.fill(); } }

    // rain and fog
    if (st.rain > 0) {
      const n = Math.round(rain.length * st.rain);
      const slant = (st.windDir > 180 && st.windDir < 360 ? -1 : 1) * clamp(st.windMph / 30, 0, 0.6);
      ctx.strokeStyle = `rgba(200,215,235,${0.25 + st.rain * 0.3})`; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const d = rain[i];
        const y = ((d.y + t * d.v * 0.9) % 1) * H, x = ((d.x + slant * (y / H) * 0.1) % 1) * W, l = 8 + d.l * 8;
        ctx.moveTo(x, y); ctx.lineTo(x + slant * l, y + l);
      }
      ctx.stroke();
    }
    if (st.visMi < 3) { ctx.fillStyle = `rgba(215,222,230,${(0.45 * (1 - st.visMi / 3)).toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
  }

  // Render the scene onto another canvas at any size (used by Share). Synchronous: emit('hero:render', { canvas, w, h }).
  api.on('hero:render', (req) => {
    if (!req || !req.canvas) return;
    const saved = [ctx, W, H];
    try {
      ctx = req.canvas.getContext('2d');
      W = req.w; H = req.h;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      readData(Date.now());
      draw(performance.now());
      req.done = true;
    } finally {
      [ctx, W, H] = saved;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  });

  // ================================================================ loop (30 fps while visible)
  let raf = 0, last = 0, visible = true;
  function loop(ts) {
    raf = 0;
    if (ts - last >= 33) { last = ts; draw(ts); }
    if (visible && document.visibilityState === 'visible' && !reducedMotion()) raf = requestAnimationFrame(loop);
  }
  function kick() { if (!raf && visible && document.visibilityState === 'visible') { if (reducedMotion()) draw(performance.now()); else raf = requestAnimationFrame(loop); } }
  new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); kick(); }).observe(scene);
  document.addEventListener('visibilitychange', kick);
  new ResizeObserver(() => { resize(); draw(performance.now()); }).observe(scene);

  // ================================================================ overlay text
  const $h = (s) => hero.querySelector(s);
  function overlay(now) {
    const D = api.D;
    const w = D('weather');
    $h('.hero-when').textContent = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long', hour: 'numeric', minute: '2-digit' }).format(now).replace(' AM', ' am').replace(' PM', ' pm');
    if (w && w.current) {
      const c = w.current, d0 = (w.daily || [])[0] || {};
      const tempEl = $h('.hero-temp');
      const txt = `${r0(c.tempF)}°`;
      if (tempEl.textContent !== txt) { if (tempEl.textContent !== '–') u.flash(tempEl); tempEl.textContent = txt; }
      $h('.hero-cond').textContent = `${u.wxText(c.code)} · feels ${r0(c.feelsF)}° · H${r0(d0.hiF)} L${r0(d0.loF)}`;
    }
    const facts = [];
    const td = D('tides');
    if (td && api.cards.nextTides) { const n = api.cards.nextTides(td, now)[0]; facts.push(`${icon('tide', { size: 14 })} ${r1(st.tideFt)} ft ${st.tideTrend === 'rising' ? '↑' : st.tideTrend === 'falling' ? '↓' : ''}${n ? ` · ${n.type === 'H' ? 'high' : 'low'} ${time(n.t)}` : ''}`); }
    const sky = D('sky');
    if (sky && sky.sun) { const { rise, set } = sky.sun; const up = now > rise && now < set; facts.push(`${icon(up ? 'sunset' : 'sunrise', { size: 14 })} ${up ? `sunset ${time(set)}` : `sunrise ${time(now < rise ? rise : sky.tomorrowSun && sky.tomorrowSun.rise)}`}`); }
    const pa = D('purpleair');
    if (pa && isNum(pa.medianAqi)) facts.push(`${icon('air', { size: 14 })} air ${esc(u.aqiInfo(pa.medianAqi).short || u.aqiInfo(pa.medianAqi).label).toLowerCase()}`);
    if (st.bridgeUp) facts.unshift(`<span class="hero-warn">${icon('bridge', { size: 14 })} Ballard Bridge up</span>`);
    api.setHTML($h('.hero-facts'), facts.map((f) => `<span>${f}</span>`).join(''));
  }

  // ================================================================ Moments carousel
  const track = $h('.hm-track'), dots = $h('.hm-dots');
  let ms = [], idx = 0, rotTimer = 0, pausedUntil = 0;
  const series = (k, h) => (api.history.cached ? api.history.cached(k, h) : null);
  function momentHTML(m, i) {
    const img = m.image && /^https:\/\/[\w.-]+\/[\w/.%~-]+$/.test(m.image) ? `<img class="hm-img" src="${esc(m.image)}" alt="" loading="lazy">` : '';
    const target = m.link ? `href="${u.href(m.link)}" target="_blank" rel="noopener"` : `href="${esc(m.href || '#')}"`;
    return `<a class="hm-card tone-${esc(m.tone || 'ok')}" ${target} role="group" aria-roledescription="moment" aria-label="${i + 1} of ${ms.length}: ${esc(m.title)}" data-i="${i}">
      <span class="hm-ico">${icon(m.icon || 'sparkle', { size: 20 })}</span>
      <span class="hm-body"><span class="hm-kicker">${esc(m.kicker || '')}</span><span class="hm-t">${esc(m.title)}</span><span class="hm-b">${esc(m.body || '')}</span></span>${img}</a>`;
  }
  function renderMoments() {
    const now = Date.now();
    const next = moments(api.D, now, { series, baseline: usualOf, favorites: String(api.ui['prefs.buses'] || '').split(',').filter(Boolean) }).slice(0, 8);
    const sig = next.map((m) => `${m.id}|${m.title}|${m.body}`).join('§');
    if (sig === track.dataset.sig) return;
    track.dataset.sig = sig;
    const curId = ms[idx] && ms[idx].id;
    ms = next;
    idx = Math.max(0, ms.findIndex((m) => m.id === curId));
    if (!ms.length) {
      api.setHTML(track, `<div class="hm-empty">${icon('sparkle', { size: 18 })} Quiet right now. Moments appear here for clear sunsets, minus tides, salmon runs, the market, events tonight, bridge openings and more.</div>`);
      api.setHTML(dots, '');
      return;
    }
    api.setHTML(track, ms.map(momentHTML).join(''));
    requestAnimationFrame(edge);
    api.setHTML(dots, ms.map((m, i) => `<button type="button" role="tab" class="hm-dot" data-go="${i}" aria-label="${esc(m.title)}" aria-selected="${i === idx}"></button>`).join(''));
    go(idx, false);
  }
  function go(i, smooth = true) {
    if (!ms.length) return;
    idx = (i + ms.length) % ms.length;
    const card = track.children[idx];
    if (card) track.scrollTo({ left: card.offsetLeft - track.offsetLeft, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
    [...dots.children].forEach((d, j) => d.setAttribute('aria-selected', String(j === idx)));
  }
  hero.querySelector('[data-hm="prev"]').addEventListener('click', () => { pausedUntil = Date.now() + 20000; go(idx - 1); });
  hero.querySelector('[data-hm="next"]').addEventListener('click', () => { pausedUntil = Date.now() + 20000; go(idx + 1); });
  dots.addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) { pausedUntil = Date.now() + 20000; go(+b.dataset.go); } });
  const momentsEl = $h('.hero-moments');
  for (const ev of ['mouseenter', 'focusin', 'touchstart']) momentsEl.addEventListener(ev, () => { pausedUntil = Date.now() + 15000; }, { passive: true });
  // In the vertical list (wide screens), fade the bottom edge while there is more to scroll to.
  const edge = () => track.classList.toggle('more', track.scrollHeight - track.scrollTop - track.clientHeight > 6);
  new ResizeObserver(edge).observe(track);
  track.addEventListener('scroll', () => {
    edge();
    const cards = [...track.children];
    const i = cards.findIndex((c) => Math.abs(c.offsetLeft - track.offsetLeft - track.scrollLeft) < c.offsetWidth / 2);
    if (i >= 0 && i !== idx) { idx = i; [...dots.children].forEach((d, j) => d.setAttribute('aria-selected', String(j === idx))); }
  }, { passive: true });
  const vertical = () => getComputedStyle(track).flexDirection === 'column';
  rotTimer = setInterval(() => { if (Date.now() > pausedUntil && document.visibilityState === 'visible' && !reducedMotion() && ms.length > 1 && !vertical()) go(idx + 1); }, 8000);
  // Ask Ballard entry point + suggested questions for right now
  const chips = $h('.hm-chips');
  const renderChips = () => api.setHTML(chips, suggestions(api.D, Date.now()).slice(0, 4).map((q) => `<button type="button" class="hm-chip" data-ask="${esc(q)}">${esc(q)}</button>`).join(''));
  $h('.hm-ask').addEventListener('click', (e) => { const b = e.target.closest('[data-ask]'); if (b) api.emit('ask:open', b.dataset.ask || ''); });
  void rotTimer;

  // ================================================================ Dynamic Island (header)
  const island = document.createElement('button');
  island.type = 'button';
  island.id = 'island';
  island.className = 'island';
  island.hidden = true;
  island.innerHTML = '<span class="is-ico"></span><span class="is-text"></span><span class="is-timer"></span><span class="is-more"></span>';
  const bar = document.querySelector('.topbar');
  const nav = bar && bar.querySelector('.jump');
  if (bar) bar.insertBefore(island, nav || bar.querySelector('.topbar-right'));
  let acts = [], aIdx = 0, aAt = 0, expanded = false;
  const fmtTimer = (tm, now) => {
    const ms2 = tm.since ? now - tm.since : tm.until - now;
    if (ms2 < 0) return tm.until ? 'now' : '';
    const s = Math.floor(ms2 / 1000), h = Math.floor(s / 3600), m2 = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m2).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m2}:${String(sec).padStart(2, '0')}`;
  };
  function paintIsland(now) {
    const a = acts[aIdx];
    if (!a) { island.hidden = true; return; }
    island.hidden = false;
    island.dataset.tone = a.tone || 'info';
    island.classList.toggle('expanded', expanded);
    island.querySelector('.is-ico').innerHTML = icon(a.icon || 'sparkle', { size: 15 });
    const txt = expanded && a.detail ? `${a.text} · ${a.detail}` : a.text;
    const te = island.querySelector('.is-text');
    if (te.textContent !== txt) te.textContent = txt;
    island.querySelector('.is-timer').textContent = a.timer ? fmtTimer(a.timer, now) : '';
    island.querySelector('.is-more').textContent = acts.length > 1 ? `${aIdx + 1}/${acts.length}` : '';
    island.title = `${a.text}${a.detail ? ` — ${a.detail}` : ''}${acts.length > 1 ? ` (${acts.length} live items; click to open, or wait for the next)` : ''}`;
    island.setAttribute('aria-label', `Live: ${island.title}`);
  }
  function refreshIsland(now = Date.now()) {
    const next = liveActivities(api.D, now, { favorites: String(api.ui['prefs.buses'] || '').split(',').filter(Boolean), activity: api.activity.items() }).slice(0, 5);
    const curId = acts[aIdx] && acts[aIdx].id;
    acts = next;
    const keep = acts.findIndex((x) => x.id === curId);
    aIdx = keep >= 0 ? keep : 0;
    paintIsland(now);
  }
  island.addEventListener('click', () => {
    const a = acts[aIdx];
    if (!a) return;
    if (!expanded) { expanded = true; paintIsland(Date.now()); setTimeout(() => { expanded = false; paintIsland(Date.now()); }, 6000); return; }
    const target = a.href && document.querySelector(a.href);
    if (target) target.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  });
  island.addEventListener('mouseenter', () => { expanded = true; paintIsland(Date.now()); });
  island.addEventListener('mouseleave', () => { expanded = false; paintIsland(Date.now()); });
  api.on('tick', (now) => {
    if (acts.length > 1 && !expanded && now - aAt > 5000) { aAt = now; aIdx = (aIdx + 1) % acts.length; }
    paintIsland(now);
  });

  // ================================================================ wiring
  onBaselines(() => renderMoments());
  const refresh = () => { const now = Date.now(); readData(now); overlay(now); renderMoments(); renderChips(); refreshIsland(now); if (reducedMotion()) draw(performance.now()); };
  api.on('render', refresh);
  api.on('minute', refresh);
  api.on('activity', () => refreshIsland());
  api.on('ui', refresh);
  resize();
  refresh();
  kick();
}
