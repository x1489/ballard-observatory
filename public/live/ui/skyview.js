// Sky view: the whole sky over Ballard as a dome (zenith in the middle, horizon at the rim): the Sun, the Moon, every
// satellite above the horizon (the ISS and Tiangong highlighted, lit ones bright), and every aircraft that is above
// the horizon from Market St, labelled. On phones it can turn with the compass so "up" is where you're facing.
import { esc, time, day, compass, dur, titleCase } from '../fmt.js';

export function createSkyView(app) {
  const el = document.createElement('div');
  el.className = 'skyview';
  el.innerHTML = `<canvas></canvas><div class="title"><b>The sky over Ballard</b><span data-k="sub"></span></div>
    <div class="panel glass" data-k="panel"></div>`;
  document.body.appendChild(el);
  const cv = el.querySelector('canvas'), g = cv.getContext('2d');
  let open = false, raf = 0, heading = 0, useCompass = false, hits = [];
  const onOrient = (e) => { const h = e.webkitCompassHeading ?? (e.absolute && e.alpha != null ? 360 - e.alpha : null); if (h != null) heading = h; };

  function resize() { const d = Math.min(devicePixelRatio || 1, 2); cv.width = innerWidth * d; cv.height = innerHeight * d; g.setTransform(d, 0, 0, d, 0, 0); }
  function polar(az, el, cx, cy, R) {
    const r = R * (1 - Math.max(0, el) / 90), a = ((az - (useCompass ? heading : 0)) - 90) * Math.PI / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }
  function draw() {
    if (!open) return;
    const W = innerWidth, H = innerHeight;
    const cx = W / 2, cy = H / 2 + 10, R = Math.min(W, H) * 0.4;
    g.clearRect(0, 0, W, H);
    const sun = app.sky.sun(), dark = sun.elevation < -6;
    // dome
    const bg = g.createRadialGradient(cx, cy, 0, cx, cy, R);
    bg.addColorStop(0, dark ? '#0b1430' : '#2b5f99'); bg.addColorStop(1, dark ? '#050912' : sun.elevation < 5 ? '#c07a5a' : '#8fb8e0');
    g.fillStyle = bg; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.14)'; g.lineWidth = 1;
    for (const e of [30, 60]) { g.beginPath(); g.arc(cx, cy, R * (1 - e / 90), 0, Math.PI * 2); g.stroke(); }
    g.strokeStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    g.font = '700 13px Inter, sans-serif'; g.fillStyle = 'rgba(255,255,255,.8)'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const [lab, az] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) { const [x, y] = polar(az, -6, cx, cy, R * 1.07); g.fillText(lab, x, y); }
    hits = [];
    const dot = (az, e, r, fill, label, sub, id) => {
      const [x, y] = polar(az, e, cx, cy, R);
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = fill; g.fill();
      if (label) { g.textAlign = 'left'; g.font = '600 12px Inter, sans-serif'; g.fillStyle = '#fff'; g.fillText(label, x + r + 5, y - 1); if (sub) { g.font = '500 11px Inter, sans-serif'; g.fillStyle = 'rgba(255,255,255,.65)'; g.fillText(sub, x + r + 5, y + 12); } }
      if (id) hits.push({ x, y, r: Math.max(r, 12), id });
    };
    if (sun.elevation > -1) dot(sun.azimuth, sun.elevation, 11, '#ffd66b', 'Sun', `${Math.round(sun.elevation)}°`);
    const moon = app.sky.moon();
    if (moon.elevation > -1) dot(moon.azimuth, moon.elevation, 8, '#e8ecf2', 'Moon', `${Math.round(moon.illumination * 100)}% lit`);
    const t = Date.now();
    for (const s of app.sky.overhead(t, 0)) {
      const big = s.sat.iss || s.sat.css;
      const col = s.visible ? (big ? '#c4b5fd' : '#e9e5ff') : 'rgba(170,160,220,.45)';
      dot(s.az, s.el, big ? 6 : 2.6, col, big || (s.visible && s.el > 25) ? (s.sat.iss ? 'ISS' : s.sat.css ? 'Tiangong' : titleCase(s.sat.name)) : '', big ? `${Math.round(s.el)}° · ${s.visible ? 'visible' : s.sunlit ? 'daylit sky' : 'in shadow'}` : '', `sat:${s.sat.id}`);
    }
    for (const a of app.layers.air.list()) {
      const s = app.layers.air.now(a.hex);
      if (!s) continue;
      const la = app.sky.lookAt(s.lon, s.lat, s.alt);
      if (la.el < 2) continue;
      g.save();
      const [x, y] = polar(la.az, la.el, cx, cy, R);
      g.translate(x, y); g.rotate(((s.heading - (useCompass ? heading : 0)) * Math.PI) / 180);
      g.fillStyle = '#5ac8fa'; g.beginPath(); g.moveTo(0, -7); g.lineTo(5, 6); g.lineTo(0, 3); g.lineTo(-5, 6); g.closePath(); g.fill();
      g.restore();
      g.textAlign = 'left'; g.font = '600 11.5px Inter, sans-serif'; g.fillStyle = '#bfe9ff';
      g.fillText(a.rec.callsign || a.rec.reg || a.hex.toUpperCase(), x + 9, y - 2);
      g.font = '500 10.5px Inter, sans-serif'; g.fillStyle = 'rgba(191,233,255,.7)'; g.fillText(`${Math.round(la.el)}° · ${Math.round(a.rec.altFt / 100) * 100} ft`, x + 9, y + 10);
      hits.push({ x, y, r: 14, id: `air:${a.hex}` });
    }
    raf = requestAnimationFrame(() => setTimeout(draw, 90));
  }
  function panel() {
    const iss = app.sky.iss();
    const P = el.querySelector('[data-k="panel"]');
    const sun = app.sky.sun(), rs = app.sunTimes();
    const passes = iss ? app.sky.passes(iss, Date.now(), 48, 10).filter((p) => p.visible).slice(0, 4) : [];
    P.innerHTML = `<h3>Next visible ISS passes</h3>${passes.length ? passes.map((p) => `<div class="row" data-open="sat:${iss.id}" style="grid-template-columns:1fr auto;padding:6px 4px"><div><div class="t">${esc(day(p.rise))} ${esc(time(p.rise))}</div><div class="s">${esc(compass(p.riseAz))} → ${esc(compass(p.setAz))} · up to ${Math.round(p.maxEl)}°</div></div><div class="r">${esc(dur((p.set - p.rise) / 1000))}</div></div>`).join('') : '<div class="fine" style="margin:0">None in the next two days.</div>'}
      <h3 style="margin-top:12px">Sun</h3><div class="s" style="color:var(--muted)">${sun.elevation > 0 ? `Up ${Math.round(sun.elevation)}°, sets ${esc(time(rs.set))}` : `Down ${Math.round(-sun.elevation)}°, rises ${esc(time(rs.rise))}`}</div>
      ${'DeviceOrientationEvent' in window && matchMedia('(pointer: coarse)').matches ? `<button class="btn" data-k="cmp" style="margin-top:12px">${useCompass ? 'Compass: on' : 'Turn with my phone'}</button>` : ''}`;
    const b = P.querySelector('[data-k="cmp"]');
    if (b) b.onclick = async () => {
      try { if (typeof DeviceOrientationEvent.requestPermission === 'function') await DeviceOrientationEvent.requestPermission(); } catch { /* denied */ }
      useCompass = !useCompass;
      if (useCompass) addEventListener('deviceorientation', onOrient); else removeEventListener('deviceorientation', onOrient);
      panel();
    };
    el.querySelector('[data-k="sub"]').textContent = `From NW Market St · ${app.sky.list().length} satellites tracked · updated live`;
  }
  cv.addEventListener('click', (e) => {
    const h = hits.find((x) => Math.hypot(x.x - e.clientX, x.y - e.clientY) < x.r);
    if (!h) return;
    const [kind, id] = h.id.split(':');
    app.open(kind === 'air' ? 'aircraft' : 'sat', id);
  });
  el.addEventListener('click', (e) => { const o = e.target.closest('[data-open]'); if (o) { const [k, id] = o.dataset.open.split(':'); app.open(k, id); } });
  addEventListener('resize', () => { if (open) resize(); });
  return {
    async show() { open = true; el.classList.add('open'); document.body.classList.add('sky'); resize(); await app.sky.load().catch(() => {}); panel(); cancelAnimationFrame(raf); draw(); },
    hide() { open = false; el.classList.remove('open'); document.body.classList.remove('sky'); cancelAnimationFrame(raf); removeEventListener('deviceorientation', onOrient); },
    get open() { return open; },
  };
}
