// Rewind data: hour files recorded by the always-on relay (core/recorder.mjs), published with the analytics
// (/api/obs/replay/<date>/<HH>.json), and interpolation of every recorded aircraft, bus and train at any moment.
const TZ = 'America/Los_Angeles';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function pacificHour(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' })
    .formatToParts(t).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
}
const key = (date, hour) => `${date}/${String(hour).padStart(2, '0')}`;

/** Index of the samples around dt (seconds from the hour's t0): [i0, i1, f] or null when outside (with a little slack). */
export function bracket(p, dt, slack = 45) {
  if (!p.length || dt < p[0][0] - slack || dt > p[p.length - 1][0] + slack) return null;
  let lo = 0, hi = p.length - 1;
  if (dt <= p[0][0]) return [0, 0, 0];
  if (dt >= p[hi][0]) return [hi, hi, 0];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p[m][0] <= dt) lo = m; else hi = m; }
  const gap = p[hi][0] - p[lo][0];
  if (gap > 120) return null; // a hole in the recording: don't invent a path across it
  return [lo, hi, gap ? (dt - p[lo][0]) / gap : 0];
}
const lerp = (a, b, f) => a + (b - a) * f;
const lerpAngle = (a, b, f) => { const d = ((((b - a) % 360) + 540) % 360) - 180; return (a + d * f + 360) % 360; };
const bearing = (lat1, lon1, lat2, lon2) => { const r = Math.PI / 180, y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r), x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r); return ((Math.atan2(y, x) / r) + 360) % 360; };

/** Everything recorded at time t from one hour record. */
export function statesAt(rec, t) {
  const dt = (t - rec.t0) / 1000;
  const air = [], buses = [], trains = [];
  for (const [hex, a] of Object.entries(rec.aircraft || {})) {
    const b = bracket(a.p, dt);
    if (!b) continue;
    const [i, j, f] = b, p = a.p[i], q = a.p[j];
    air.push({ hex, callsign: a.cs, type: a.type, reg: a.reg, kind: a.kind, category: a.cat, lat: lerp(p[1], q[1], f) / 1e5, lon: lerp(p[2], q[2], f) / 1e5,
      altFt: lerp(p[3], q[3], f) * 10, onGround: p[3] === 0 && q[3] === 0, track: lerpAngle(p[4], q[4], f), gsKt: lerp(p[5], q[5], f), vrFpm: j > i ? ((q[3] - p[3]) * 10) / ((q[0] - p[0]) / 60) : 0 });
  }
  for (const [id, v] of Object.entries(rec.buses || {})) {
    const b = bracket(v.p, dt, 60);
    if (!b) continue;
    const [i, j, f] = b, p = v.p[i], q = v.p[j];
    const moving = j > i && (p[1] !== q[1] || p[2] !== q[2]);
    buses.push({ id, route: v.route, trip: v.trip, lat: lerp(p[1], q[1], f) / 1e5, lon: lerp(p[2], q[2], f) / 1e5, delay: isNum(p[3]) ? p[3] : null,
      bearing: moving ? bearing(p[1] / 1e5, p[2] / 1e5, q[1] / 1e5, q[2] / 1e5) : null });
  }
  for (const [id, r] of Object.entries(rec.trains || {})) {
    const b = bracket(r.p, dt, 90);
    if (!b) continue;
    const [i, j, f] = b, p = r.p[i], q = r.p[j];
    trains.push({ id, route: r.route, num: r.num, lat: lerp(p[1], q[1], f) / 1e5, lon: lerp(p[2], q[2], f) / 1e5, speedMph: isNum(p[3]) ? p[3] : null,
      heading: j > i ? (bearing(p[1] / 1e5, p[2] / 1e5, q[1] / 1e5, q[2] / 1e5) < 90 || bearing(p[1] / 1e5, p[2] / 1e5, q[1] / 1e5, q[2] / 1e5) > 270 ? 'N' : 'S') : null });
  }
  return { aircraft: air, buses, trains };
}

export function createReplay() {
  const hours = new Map(); // key -> Promise<record|null>
  let idx = null;
  async function index(force = false) {
    if (idx && !force && Date.now() - idx.at < 60e3) return idx.v;
    const r = await fetch('/api/obs/replay/index.json').catch(() => null);
    const v = r && r.ok ? await r.json() : { hours: [] };
    idx = { at: Date.now(), v };
    return v;
  }
  function hour(date, h) {
    const k = key(date, h);
    if (!hours.has(k)) {
      const p = fetch(`/api/obs/replay/${k}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      hours.set(k, p);
      p.then((v) => { if (!v) hours.delete(k); });
      if (hours.size > 6) hours.delete(hours.keys().next().value);
    }
    return hours.get(k);
  }
  /** The record covering time t (loads it), or null. Prefetches the next hour. */
  async function recordAt(t) {
    const h = pacificHour(t);
    const rec = await hour(h.date, h.hour);
    const n = pacificHour(t + 3600e3);
    hour(n.date, n.hour);
    return rec;
  }
  return { index, recordAt, hour };
}
