// Director: a hands-off, cinematic tour of what is happening right now: an establishing orbit over Ballard, then
// whatever is live (a plane on approach, a bus on Market St, a bridge that's up, a train on the shore line, an active
// 911 call), each held for a while with a lower-third caption. Any touch hands the camera back.
import { esc } from '../fmt.js';

export function createDirector(app) {
  const cap = document.createElement('div');
  cap.className = 'caption';
  document.body.appendChild(cap);
  const bar = document.createElement('div');
  bar.className = 'director-bar';
  bar.textContent = '● DIRECTOR';
  document.body.appendChild(bar);
  let on = false, timer = 0, orbit = 0, shotIdx = 0, recent = [];

  function caption(k, t, s, color = 'var(--air)') {
    cap.innerHTML = `<span class="k" style="background:${color}">${esc(k)}</span><div class="t">${esc(t)}</div><div class="s">${esc(s || '')}</div>`;
    cap.classList.add('show');
  }
  const hide = () => cap.classList.remove('show');
  function stopOrbit() { cancelAnimationFrame(orbit); orbit = 0; }
  function orbitAround(center, { zoom = 15, pitch = 62, speed = 3.2 } = {}) {
    stopOrbit();
    const m = app.scene.map;
    m.easeTo({ center, zoom, pitch, duration: 3200, essential: true });
    let last = performance.now();
    const step = (ts) => {
      const dt = (ts - last) / 1000; last = ts;
      if (!m.isEasing()) m.setBearing(m.getBearing() + speed * dt);
      orbit = requestAnimationFrame(step);
    };
    setTimeout(() => { if (on) orbit = requestAnimationFrame(step); }, 3300);
  }

  // Candidate shots, in priority order; each returns null when there's nothing to film.
  const SHOTS = [
    () => ({ kind: 'overview', ms: 16000, run() { app.scene.follow(null); orbitAround([-122.3847, 47.6687], { zoom: 14.6, pitch: 64, speed: 3 }); caption('Live', 'Ballard, right now', app.summaryText()); } }),
    () => {
      const b = ((app.store.get('bridges') || {}).bridges || []).find((x) => x.up && ['Ballard', 'Fremont'].includes(x.name));
      if (!b) return null;
      const g = app.layers.bridge.get(b.name);
      return { kind: `bridge:${b.name}`, ms: 18000, run() { app.scene.follow(null); orbitAround(g.center, { zoom: 17.4, pitch: 66, speed: 5 }); caption('Drawbridge', `${b.name} Bridge is up`, 'Open to boats on the Ship Canal', 'var(--bridge)'); } };
    },
    () => {
      const list = app.layers.air.list().filter((a) => a.rec && !a.rec.onGround && a.rec.altFt < 9000 && a.rec.distKm < 14).sort((a, b) => a.rec.distKm - b.rec.distKm);
      const a = list.find((x) => !recent.includes(`air:${x.hex}`)) || list[0];
      if (!a) return null;
      return { kind: `air:${a.hex}`, ms: 20000, run() {
        stopOrbit(); app.select('aircraft', a.hex, { focus: false, card: false });
        app.scene.follow(() => app.layers.air.now(a.hex), 'chase', { zoom: a.spec.len > 30 ? 16.2 : 17.4 });
        const r = a.rec; caption('In the air', r.callsign || r.reg || a.hex.toUpperCase(), `${a.spec.desc} · ${Math.round(r.altFt / 100) * 100} ft · ${Math.round(r.gsKt)} kt`);
      } };
    },
    () => {
      const list = app.layers.bus.list().filter((b) => b.track && b.track.fix && b.route);
      const b = list.find((x) => !recent.includes(`bus:${x.id}`)) || list[0];
      if (!b) return null;
      return { kind: `bus:${b.id}`, ms: 18000, run() {
        stopOrbit(); app.select('bus', b.id, { focus: false, card: false });
        app.scene.follow(() => app.layers.bus.now(b.id), 'chase', { zoom: 18.2 });
        caption('On the road', `${b.route.short} ${b.info && b.info.headsign ? `to ${b.info.headsign}` : ''}`, `King County Metro · bus ${b.id}`, 'var(--bus)');
      } };
    },
    () => {
      const t = app.layers.train.list()[0];
      if (!t) return null;
      return { kind: `train:${t.id}`, ms: 18000, run() { stopOrbit(); app.scene.follow(() => app.layers.train.now(t.id), 'chase', { zoom: 16.4 }); caption('On the rails', `${t.rec.route} ${t.rec.num}`, `${t.rec.origin.name} → ${t.rec.dest.name}`, 'var(--train)'); } };
    },
    () => {
      const x = app.layers.incidents.list().find((i) => i.active && i.src === 'fire');
      if (!x) return null;
      return { kind: `inc:${x.id}`, ms: 15000, run() { app.scene.follow(null); orbitAround([x.lon, x.lat], { zoom: 17, pitch: 60, speed: 6 }); caption('911 response', x.label, x.rec.address || '', 'var(--alert)'); } };
    },
  ];
  function next() {
    if (!on) return;
    hide();
    let shot = null;
    for (let i = 0; i < SHOTS.length && !shot; i++) {
      const cand = SHOTS[(shotIdx + i) % SHOTS.length]();
      shotIdx = (shotIdx + i + 1) % SHOTS.length;
      if (cand && (!recent.includes(cand.kind) || cand.kind === 'overview')) shot = cand;
    }
    shot = shot || SHOTS[0]();
    recent = [shot.kind, ...recent].slice(0, 4);
    setTimeout(() => { if (on) shot.run(); }, 350);
    timer = setTimeout(next, shot.ms);
  }
  function stop() {
    if (!on) return;
    on = false; clearTimeout(timer); stopOrbit(); hide(); app.scene.follow(null);
    document.body.classList.remove('director');
    app.onDirector(false);
  }
  const interrupt = (e) => { if (on && !(e.target.closest && e.target.closest('.keep'))) stop(); };
  for (const ev of ['pointerdown', 'wheel', 'keydown']) addEventListener(ev, interrupt, { capture: true, passive: true });
  return {
    start() { if (on) return; if (app.rewind && app.rewind.on) app.rewind.close(); on = true; shotIdx = 0; document.body.classList.add('director'); app.closeSheet(); app.onDirector(true); next(); },
    stop, get on() { return on; },
  };
}
