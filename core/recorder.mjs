// Recorder: keeps a replayable history of everything that moves (aircraft, buses, trains) on the always-on machine.
// Every 30 s it samples the latest positions; each Pacific hour becomes one compact file,
// <outDir>/replay/YYYY-MM-DD/HH.json, rewritten every few minutes while the hour is in progress, plus index.json
// listing the hours on hand (seven days are kept). The hourly pipeline publishes them with the other outputs, and the
// app's Rewind plays them back.
import fs from 'node:fs';
import path from 'node:path';

const TZ = 'America/Los_Angeles';
const STEP_MS = 30_000, WRITE_MS = 5 * 60e3, KEEP_DAYS = 7;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function pacificHour(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' })
    .formatToParts(t).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
}

/** Pure: add one sample of every moving thing to an hour record (arrays of [dtSec, lat*1e5, lon*1e5, ...]). */
export function addSample(rec, t, { aircraft, buses, trains }) {
  const dt = Math.round((t - rec.t0) / 1000);
  for (const a of (aircraft && aircraft.aircraft) || []) {
    if (!a.hex || !isNum(a.lat) || !isNum(a.lon)) continue;
    const o = rec.aircraft[a.hex] || (rec.aircraft[a.hex] = { cs: a.callsign || null, type: a.type || null, reg: a.reg || null, kind: a.kind || null, cat: a.category || null, p: [] });
    o.cs = a.callsign || o.cs;
    o.p.push([dt, Math.round(a.lat * 1e5), Math.round(a.lon * 1e5), a.onGround ? 0 : Math.round((a.altFt || 0) / 10), Math.round(a.track || 0), Math.round(a.gsKt || 0)]);
  }
  for (const v of (buses && buses.vehicles) || []) {
    if (!v.id || !isNum(v.lat) || !isNum(v.lon)) continue;
    const o = rec.buses[v.id] || (rec.buses[v.id] = { route: v.route || null, trip: v.trip || null, p: [] });
    o.route = v.route || o.route; o.trip = v.trip || o.trip;
    o.p.push([dt, Math.round(v.lat * 1e5), Math.round(v.lon * 1e5), isNum(v.delay) ? v.delay : null]);
  }
  for (const r of (trains && trains.trains) || []) {
    if (!r.id || !isNum(r.lat) || !isNum(r.lon)) continue;
    const o = rec.trains[r.id] || (rec.trains[r.id] = { route: r.route, num: r.num, p: [] });
    o.p.push([dt, Math.round(r.lat * 1e5), Math.round(r.lon * 1e5), isNum(r.speedMph) ? Math.round(r.speedMph) : null]);
  }
}

export function createRecorder({ scheduler, outDir, log = console, now = () => Date.now() }) {
  const dir = path.join(outDir, 'replay');
  let rec = null, lastSample = 0, lastWrite = 0, lastKey = { aircraft: 0, buses: 0, trains: 0 };
  const newRec = (t) => { const h = pacificHour(t); return { v: 1, date: h.date, hour: h.hour, step: STEP_MS / 1000, t0: t, aircraft: {}, buses: {}, trains: {} }; };
  /** After a restart, carry on with this hour's file instead of starting it over. */
  function resume(h) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, h.date, `${String(h.hour).padStart(2, '0')}.json`), 'utf8'));
      return r && r.v === 1 && r.date === h.date && r.hour === h.hour ? r : null;
    } catch { return null; }
  }
  function write(r) {
    try {
      fs.mkdirSync(path.join(dir, r.date), { recursive: true });
      const file = path.join(dir, r.date, `${String(r.hour).padStart(2, '0')}.json`);
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(r));
      fs.renameSync(`${file}.tmp`, file);
      index();
    } catch (e) { log.warn(`[recorder] write: ${e.message}`); }
  }
  function index() {
    const cutoff = pacificHour(now() - KEEP_DAYS * 86400e3).date;
    const hours = [];
    let from = null;
    for (const d of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      if (d < cutoff) { fs.rmSync(path.join(dir, d), { recursive: true, force: true }); continue; }
      for (const f of fs.readdirSync(path.join(dir, d)).sort()) {
        if (!/^\d{2}\.json$/.test(f)) continue;
        hours.push([d, +f.slice(0, 2)]);
        if (from == null) { // first recorded moment: t0 of the oldest hour file
          const head = fs.readFileSync(path.join(dir, d, f), 'utf8').slice(0, 200);
          const m = /"t0":(\d+)/.exec(head);
          if (m) from = +m[1];
        }
      }
    }
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ updated: now(), step: STEP_MS / 1000, from, last: lastSample || null, hours }));
  }
  function tick() {
    const t = now();
    // keep the moving feeds fresh whether or not anyone has the local app open (aircraft: the relay does this)
    for (const [id, maxAge] of [['buses', 30e3], ['trains', 60e3]]) {
      const en = scheduler.entry(id);
      if (en && !en.inflight && t - (en.fetchedAt || 0) > maxAge && t - (en.errorAt || 0) > maxAge) scheduler.refresh(id, 'recorder');
    }
    if (t - lastSample < STEP_MS - 500) return;
    const get = (id) => scheduler.entry(id);
    const e = { aircraft: get('aircraft'), buses: get('buses'), trains: get('trains') };
    // only record feeds that are fresh (not replaying the same stale snapshot)
    const data = {};
    for (const [k, en] of Object.entries(e)) data[k] = en && en.data && t - (en.fetchedAt || 0) < 3 * 60e3 && en.fetchedAt !== lastKey[k] ? en.data : null;
    for (const [k, en] of Object.entries(e)) if (data[k]) lastKey[k] = en.fetchedAt;
    const h = pacificHour(t);
    if (!rec || rec.date !== h.date || rec.hour !== h.hour) { if (rec) write(rec); rec = resume(h) || newRec(t); }
    addSample(rec, t, data);
    lastSample = t;
    if (t - lastWrite > WRITE_MS) { write(rec); lastWrite = t; }
  }
  const timer = setInterval(tick, 5000);
  if (timer.unref) timer.unref();
  return { stop() { clearInterval(timer); if (rec) write(rec); }, tick, get current() { return rec; } };
}
