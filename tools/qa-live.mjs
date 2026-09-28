// Visual QA for the live 3D app (dev tool): drives headless Chrome through scenarios and saves screenshots.
// Moving things are injected through the page's QA handle (window.__live) where the live feeds are quiet (at night
// there may be no buses or flights), so models, lights, motion and cards can be inspected at any hour. Nothing here
// ships to users.
//   node tools/qa-live.mjs [outDir] [scenario ...]
// Scenarios: day, night, bus, bridge, calls, card, mobile, sky, thermal, nvg, director
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './cdp.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:4177';
const out = path.resolve(process.argv[2] || 'qa-live');
const only = process.argv.slice(3);
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GL = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'];
const DAY = '2026-09-27T21:30:00Z', NIGHT = '2026-09-28T05:10:00Z';

// Synthetic flights around Ballard (types seen here every day).
const AIR = `(() => {
  const now = Date.now();
  const mk = (hex, cs, type, lat, lon, altFt, gsKt, track, vrFpm, extra = {}) => ({ hex, callsign: cs, reg: 'N' + hex.slice(0, 4).toUpperCase(), type, lat, lon, altFt, gsKt, track, vrFpm,
    onGround: false, t: now, distKm: 1, kind: extra.kind || 'airliner', category: extra.category || 'A3', operator: extra.operator || null, squawk: extra.squawk || '4312', ...extra });
  const list = window.__qaAir = [
    mk('a1b2c3', 'ASA1085', 'B739', 47.6716, -122.3822, 2400, 165, 165, -800, { operator: 'Alaska Airlines' }),
    mk('a2c3d4', 'KAB301', 'DHC2', 47.6668, -122.3882, 700, 92, 250, -250, { kind: 'seaplane', category: 'A1' }),
    mk('a3d4e5', 'N911KC', 'EC35', 47.6660, -122.3790, 600, 55, 30, 0, { kind: 'helicopter', category: 'A7' }),
    mk('a4e5f6', 'QXE2201', 'E75L', 47.6760, -122.3960, 5200, 230, 135, 1500, { operator: 'Horizon Air' }),
    mk('a5f6a7', 'DAL1234', 'A21N', 47.6800, -122.3700, 11000, 280, 180, -1200, { operator: 'Delta' }),
  ];
  const L = window.__live;
  L.layers.air.ingest({ aircraft: list });
  clearInterval(window.__qaAirT);
  window.__qaAirT = setInterval(() => { const n = Date.now(); for (const a of list) { const dt = (n - a.t) / 1000; const r = a.track * Math.PI / 180; const v = a.gsKt * 0.5144;
    a.lat += Math.cos(r) * v * dt / 111320; a.lon += Math.sin(r) * v * dt / (111320 * Math.cos(a.lat * Math.PI / 180)); a.altFt = Math.max(300, a.altFt + a.vrFpm * dt / 60); a.track += (a.kind === 'helicopter' ? 6 : 0) * dt; a.t = n; }
    L.layers.air.ingest({ aircraft: list }); }, 4000);
  return list.length;
})()`;

// Synthetic buses on real Metro trips through Ballard (D Line, 44, 40), with next-stop predictions along the shape.
const BUS = `(() => {
  const L = window.__live, T = L.transit, raw = T.raw;
  const pick = (short) => { const ri = raw.routes.findIndex((r) => r.short === short); return Object.entries(raw.trips).find(([id, t]) => t[0] === ri)?.[0]; };
  const plan = [['D Line', 6069, 0.35], ['44', 4312, 0.55], ['40', 7212, 0.42], ['D Line', 6212, 0.62]];
  const now = Date.now(), vehicles = [];
  for (const [short, vid, frac] of plan) {
    const trip = pick(short); if (!trip) continue;
    const info = T.tripInfo(trip); const line = info.line;
    const s0 = line.len * frac;
    const stops = Object.keys(raw.stops).map((id) => ({ id, s: T.stopAlong(info.shape, id) })).filter((x) => x.s != null && x.s > s0 + 30).sort((a, b) => a.s - b.s).slice(0, 8);
    const pt = line.pts[Math.max(0, line.cum.findIndex((c) => c >= s0))];
    vehicles.push({ id: String(vid), trip, route: info.route.id, dir: info.dir, lat: pt[1], lon: pt[0], t: now, stopSeq: 1, status: 'in transit', delay: short === '44' ? 180 : 20,
      next: stops.map((x, i) => [x.id, i + 2, now + ((x.s - s0) / 6.5) * 1000 + i * 12000, short === '44' ? 180 : 20]) });
  }
  window.__qaBus = vehicles;
  L.layers.bus.ingest({ vehicles });
  return vehicles.map((v) => v.id + ':' + v.route);
})()`;

async function scenario(name, fn) {
  if (only.length && !only.includes(name)) return;
  const t0 = Date.now();
  try { await fn(); console.log(`✓ ${name} (${((Date.now() - t0) / 1000).toFixed(0)} s)`); } catch (e) { console.log(`✗ ${name}: ${e.message}`); }
}
async function page({ t = DAY, cam, w = 1280, h = 800, mobile = false, hash = '', settle = 14000, extra = '' } = {}) {
  const b = await launch({ width: w, height: h, scheme: 'dark', mobile, dpr: mobile ? 2 : 1, chromeArgs: GL });
  await b.goto(`${BASE}/?qa=1&t=${t}${cam ? `&cam=${cam}` : ''}${extra}${hash}`, { settle });
  return b;
}
async function finish(b, file) {
  await b.shot(path.join(out, file));
  const errs = b.errors({ ignore: [/favicon/, /Failed to load resource/] });
  if (errs.length) console.log(`   ${file}: ${errs.slice(0, 5).join(' | ')}`);
  await b.close();
}

await scenario('day', async () => {
  const b = await page({ cam: '-122.3890,47.6655,15.6,64,30' });
  await b.eval(AIR); await b.eval(BUS); await sleep(9000);
  await finish(b, 'day.png');
});
await scenario('night', async () => {
  const b = await page({ t: NIGHT, cam: '-122.3890,47.6655,15.6,64,30' });
  await b.eval(AIR); await b.eval(BUS); await sleep(9000);
  await finish(b, 'night.png');
});
await scenario('bus', async () => {
  const b = await page({ cam: '-122.3762,47.6680,17.4,62,20' });
  const ids = await b.eval(BUS);
  await sleep(2500);
  await b.eval(`window.__live.open('bus', ${JSON.stringify(ids[0].split(':')[0])})`);
  await sleep(4000);
  await b.eval(`window.__live.scene.follow(() => window.__live.layers.bus.now(${JSON.stringify(ids[0].split(':')[0])}), 'chase', { zoom: 19 })`);
  await sleep(9000);
  await finish(b, 'bus-chase.png');
});
await scenario('card', async () => {
  const b = await page({ cam: '-122.3860,47.6690,15.2,58,20' });
  await b.eval(AIR); await sleep(3000);
  await b.eval(`window.__live.open('aircraft', 'a1b2c3')`); await sleep(6000);
  await b.eval(`document.querySelector('[data-act="follow"]').click()`); await sleep(2500);
  await finish(b, 'card-flight.png');
});
await scenario('chase', async () => {
  const b = await page({ cam: '-122.3822,47.6716,16.5,60,165' });
  await b.eval(AIR); await sleep(2500);
  await b.eval(`window.__live.scene.follow(() => window.__live.layers.air.now('a1b2c3'), 'chase', { zoom: 17.2 })`);
  await sleep(10000);
  await finish(b, 'chase-737.png');
});
await scenario('bridge', async () => {
  const b = await page({ cam: '-122.3770,47.6588,17.2,62,-20' });
  await b.eval(`(() => { const L = window.__live; const d = JSON.parse(JSON.stringify(L.store.get('bridges'))); for (const x of d.bridges) if (x.name === 'Ballard') { x.up = true; x.since = Date.now() - 95000; } L.store.data.bridges = d; L.layers.bridge.ingest(d); return true; })()`);
  await sleep(20000);
  await b.eval(`window.__live.open('bridge', 'Ballard')`); await sleep(4000);
  await finish(b, 'bridge-up.png');
});
await scenario('calls', async () => {
  const b = await page({ t: NIGHT, cam: '-122.3830,47.6690,16.2,60,0' });
  await b.eval(`(() => { const L = window.__live; const now = Date.now();
    const inc = [{ id: 'Q1', type: 'Fire in Building', address: '5300 Ballard Ave NW', t: now - 300000, lat: 47.6668, lon: -122.3842, units: 'E18 L8 B4 M1', active: true },
                 { id: 'Q2', type: 'Aid Response', address: '2200 NW Market St', t: now - 900000, lat: 47.6687, lon: -122.3843, units: 'M18', active: false }];
    L.layers.incidents.ingest({ incidents: inc }, { incidents: [] }); return inc.length; })()`);
  await sleep(4000);
  await finish(b, 'calls-night.png');
});
await scenario('mobile', async () => {
  const b = await page({ w: 390, h: 844, mobile: true, cam: '-122.3860,47.6680,15.2,60,20' });
  await b.eval(AIR); await sleep(3000);
  await b.shot(path.join(out, 'mobile-home.png'));
  await b.eval(`window.__live.open('aircraft', 'a2c3d4')`); await sleep(5000);
  await finish(b, 'mobile-card.png');
});
await scenario('sky', async () => {
  const b = await page({ t: NIGHT });
  await b.eval(AIR);
  await b.eval(`document.querySelector('[data-rail="sky"]').click()`); await sleep(6000);
  await finish(b, 'sky.png');
});
for (const v of ['thermal', 'nvg']) {
  await scenario(v, async () => {
    const b = await page({ cam: '-122.3860,47.6690,15.8,62,30', extra: `&vision=${v}` });
    await b.eval(AIR); await b.eval(BUS); await sleep(6000);
    await finish(b, `vision-${v}.png`);
  });
}
await scenario('director', async () => {
  const b = await page({});
  await b.eval(AIR); await b.eval(BUS);
  await b.eval(`document.querySelector('[data-rail="director"]').click()`); await sleep(9000);
  await finish(b, 'director.png');
});
await scenario('briefing', async () => {
  const b = await page({ hash: '#/briefing', settle: 16000 });
  await finish(b, 'briefing.png');
});
