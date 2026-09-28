// Smoke test for a running deployment (local or hosted): the pages, the live API, the analytics outputs, and a
// headless page load of the live app with no script errors and the 3D scene rendering. Exit code 1 on failure.
//   node tools/smoke.mjs [baseUrl] [--http]   (default: the hosted site; --http skips the headless-browser check)
import { launch } from './cdp.mjs';

const args = process.argv.slice(2);
const HTTP_ONLY = args.includes('--http');
const BASE = (args.find((a) => !a.startsWith('--')) || 'https://ballard-observatory.ballard-observatory-edge.workers.dev').replace(/\/$/, '');
const fails = [];
const check = (ok, what) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) fails.push(what); };
async function get(p, as = 'text') {
  const r = await fetch(BASE + p, { headers: { 'User-Agent': 'BallardObservatory-smoke/1.0' }, signal: AbortSignal.timeout(20000) });
  return { status: r.status, body: as === 'json' ? await r.json().catch(() => null) : await r.text() };
}

try {
  const home = await get('/');
  check(home.status === 200 && home.body.includes('/live/app.js'), 'home page serves the live app');
  for (const p of ['/live/app.js', '/live/scene.js', '/live/live.css', '/data/transit.json', '/models/b789.glb', '/vendor/deck.gl.min.js', '/pro']) {
    const r = await fetch(BASE + p, { method: 'GET', signal: AbortSignal.timeout(20000) });
    check(r.status === 200, `${p} ${r.status}`);
    await r.arrayBuffer().catch(() => {});
  }
  const live = await get('/api/live?ids=bridges,weather,buses,fire911', 'json');
  const env = (live.body && live.body.envelopes) || {};
  check(live.status === 200 && !!env.bridges && !!env.weather, '/api/live answers');
  for (const id of ['bridges', 'weather', 'buses']) check(env[id] && env[id].data != null, `live feed ${id} has data`);
  const ins = await get('/api/obs/insights.json', 'json');
  check(ins.status === 200 && ins.body && Array.isArray(ins.body.insights), 'analytics outputs (insights.json)');
} catch (e) { check(false, `HTTP checks threw: ${e.message}`); }

if (!HTTP_ONLY) try {
  const b = await launch({ width: 1024, height: 700, chromeArgs: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
  await b.goto(`${BASE}/?qa=1`, { settle: 15000 });
  const st = await b.eval(`JSON.stringify({ app: !!window.__live, frames: window.__live ? window.__live.scene.state.frames : 0, boot: document.querySelector('#boot') && document.querySelector('#boot').classList.contains('done') })`).then(JSON.parse);
  check(st.app, 'live app booted (window.__live)');
  check(st.frames > 0, `3D scene rendering (${st.frames} frames)`);
  check(st.boot, 'loading screen dismissed');
  const errs = b.errors({ ignore: [/favicon/, /Failed to load resource/] });
  check(errs.length === 0, `no page errors${errs.length ? `: ${errs.slice(0, 3).join(' | ')}` : ''}`);
  await b.close();
} catch (e) { check(false, `browser check threw: ${e.message}`); }

console.log(fails.length ? `SMOKE FAILED (${fails.length})` : 'SMOKE OK');
process.exit(fails.length ? 1 : 0);
