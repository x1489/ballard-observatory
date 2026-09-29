// Motion models that turn sparse position reports into continuous, believable movement.
//   FlightTrack  aircraft: dead reckoning from ADS-B ground speed, track, turn rate and vertical rate, with the
//                prediction error of each new report blended out over ~1.5 s (no jumps), plus bank and pitch.
//   PathTrack    buses and trains: constrained to their route geometry; moves toward the next scheduled/predicted
//                stops at the implied speed, never visibly backwards, and holds when reports stop.
// Pure JS (no DOM); covered by tests/frontend/motion.test.mjs.
import { offset, enu, wrap360, angDiff, along, project, toRad, toDeg } from './geo.js';

export const KT = 0.514444;       // m/s per knot
export const FPM = 0.00508;       // m/s per ft/min
export const FT = 0.3048;
const G = 9.81;

const decay = (t, tau) => Math.exp(-Math.max(0, t) / tau);

export class FlightTrack {
  constructor(id) {
    this.id = id;
    this.fix = null;        // latest report: { t, lon, lat, alt, gs, trk, vr, onGround }
    this.turn = 0;          // deg/s, estimated from consecutive tracks
    this.corr = null;       // { t, e, n, u, h } offset blended out after an update
    this.bank = 0;
    this.trail = [];        // [lon, lat, alt, tSeconds]
    this.lastTrail = 0;
    this.firstSeen = 0;
  }

  /** Dead-reckoned state from the latest fix at time `now` (ms), without error blending. */
  raw(now) {
    const f = this.fix;
    const dt = Math.max(0, Math.min(45, (now - f.t) / 1000));
    const v = f.onGround ? Math.min(f.gs || 0, 20) : (f.gs || 0);
    const h0 = f.trk ?? 0;
    let e = 0, n = 0, h = h0;
    if (v > 0.5) {
      const tau = 25; // an observed turn fades out: aircraft roll out of turns
      const w0 = f.onGround ? 0 : this.turn;
      const steps = Math.ceil(dt);
      for (let i = 0; i < steps; i++) {
        const t0 = i, t1 = Math.min(dt, i + 1), mid = (t0 + t1) / 2;
        const hm = h0 + w0 * tau * (1 - Math.exp(-mid / tau));
        e += Math.sin(toRad(hm)) * v * (t1 - t0);
        n += Math.cos(toRad(hm)) * v * (t1 - t0);
      }
      h = h0 + w0 * tau * (1 - Math.exp(-dt / tau));
    }
    const vr = f.onGround ? 0 : (f.vr || 0) * decay(dt, 40);
    const alt = f.onGround ? f.alt : Math.max(0, f.alt + (f.vr || 0) * 40 * (1 - Math.exp(-dt / 40)));
    const [lon, lat] = offset(f.lon, f.lat, e, n);
    return { lon, lat, alt, heading: wrap360(h), vr, gs: v, turn: f.onGround ? 0 : this.turn * decay(dt, 25) };
  }

  update(fix, now = fix.t) {
    if (this.fix && fix.t <= this.fix.t) return false;
    const before = this.fix ? this.at(now) : null;
    if (this.fix) {
      const dt = (fix.t - this.fix.t) / 1000;
      if (dt > 0.5 && dt < 90 && fix.trk != null && this.fix.trk != null && !fix.onGround) {
        const w = Math.max(-4, Math.min(4, angDiff(this.fix.trk, fix.trk) / dt));
        this.turn = Math.abs(w) < 0.15 ? w * 0.3 : this.turn * 0.35 + w * 0.65;
      }
    } else this.firstSeen = now;
    this.fix = { ...fix };
    if (before) {
      const after = this.raw(now);
      const [de, dn] = enu(after.lon, after.lat, before.lon, before.lat);
      const du = before.alt - after.alt;
      // Blend out small errors; teleport on large ones (a new track, a bad fix, a long gap). The error is split into
      // along-track and cross-track parts, each eased out slowly enough that the aircraft only ever speeds up or slows
      // down a little and drifts sideways gently (never slides backwards or darts), however far off it was drawn.
      if (Math.hypot(de, dn) < 3000 && Math.abs(du) < 900) {
        const hr = toRad(after.heading), ue = Math.sin(hr), un = Math.cos(hr);
        const al = de * ue + dn * un, cr = de * un - dn * ue;
        const v = Math.max(after.gs, 1);
        const tauA = Math.max(2, Math.min(30, Math.abs(al) / ((al > 0 ? 0.7 : 0.45) * v))); // slow down to 30%, speed up by 45% at most
        const tauC = Math.max(2, Math.min(30, Math.abs(cr) / (0.4 * v))); // sideways drift eases out gently too
        this.corr = { t: now, al, cr, ue, un, tauA, tauC, u: du, h: angDiff(after.heading, before.heading) };
      } else this.corr = null;
    }
    return true;
  }

  /** Smoothed state at `now`: position, altitude (m), heading, pitch and bank (deg). */
  at(now) {
    const s = this.raw(now);
    if (this.corr) {
      const c = this.corr, dt = (now - c.t) / 1000;
      const ka = decay(dt, c.tauA), kc = decay(dt, c.tauC), kh = decay(dt, 1.6), ku = decay(dt, 2.5);
      if (ka < 0.002 && kc < 0.002 && ku < 0.002) this.corr = null;
      else {
        const a = c.al * ka, x = c.cr * kc;
        [s.lon, s.lat] = offset(s.lon, s.lat, a * c.ue + x * c.un, a * c.un - x * c.ue);
        s.alt += c.u * ku;
        s.heading = wrap360(s.heading + c.h * kh);
      }
    }
    s.pitch = this.fix.onGround ? 0 : Math.max(-12, Math.min(18, toDeg(Math.atan2(s.vr, Math.max(s.gs, 30)))));
    const targetBank = this.fix.onGround ? 0 : Math.max(-32, Math.min(32, toDeg(Math.atan((s.gs * toRad(s.turn)) / G))));
    this.bank += (targetBank - this.bank) * 0.08;
    s.bank = this.bank;
    s.age = (now - this.fix.t) / 1000;
    return s;
  }

  /** Append the drawn position to the trail at most once a second; keep `keepS` seconds. */
  record(now, s, keepS = 150) {
    const ts = now / 1000;
    if (ts - this.lastTrail >= 1) {
      this.trail.push([s.lon, s.lat, s.alt, ts]);
      this.lastTrail = ts;
      while (this.trail.length && ts - this.trail[0][3] > keepS) this.trail.shift();
    }
  }
}

/**
 * A vehicle constrained to a polyline measured with geo.measure(). Reports: { t, lon, lat, speed?, plan? } where
 * plan is [[tMs, sMetres], ...]: predicted times at points further along (e.g. the next stops' predicted arrivals).
 */
export class PathTrack {
  constructor(id, line, { maxSpeed = 22, defaultSpeed = 6, lookaheadS = 75 } = {}) {
    this.id = id;
    this.line = line;
    this.maxSpeed = maxSpeed;
    this.defaultSpeed = defaultSpeed;
    this.lookaheadS = lookaheadS;
    this.fix = null;       // { t, s, d, speed, plan }
    this.v = null;         // m/s estimate from successive fixes
    this.corr = null;
    this.shown = null;     // last displayed s (monotonic when close)
    this.offRoute = false;
    this.trail = [];
    this.lastTrail = 0;
  }

  setLine(line) { if (line !== this.line) { this.line = line; this.fix = null; this.shown = null; this.corr = null; } }

  predicted(now) {
    const f = this.fix;
    const plan = (f.plan || []).filter(([t, s]) => t > f.t + 1000 && s > f.s + 1);
    let s;
    if (plan.length) {
      // piecewise-linear through the plan, starting from the fix
      let t0 = f.t, s0 = f.s;
      s = s0;
      for (const [t1, s1] of plan) {
        if (now <= t1) { s = s0 + (s1 - s0) * Math.max(0, (now - t0) / (t1 - t0)); break; }
        t0 = t1; s0 = s1; s = s1;
      }
      // cap: never run away more than lookahead beyond the fix at max speed
      s = Math.min(s, f.s + this.maxSpeed * this.lookaheadS);
    } else {
      const v = f.speed ?? this.v ?? this.defaultSpeed;
      const dt = Math.max(0, Math.min(this.lookaheadS, (now - f.t) / 1000));
      s = f.s + Math.min(v, this.maxSpeed) * dt;
    }
    return Math.max(0, Math.min(this.line.len, s));
  }

  update(fix, now = fix.t) {
    if (this.fix && fix.t <= this.fix.t) return false;
    const prevShown = this.fix ? this.sAt(now) : null;
    const window = this.fix ? [this.fix.s - 250, this.fix.s + 4000] : [-Infinity, Infinity];
    let p = project(this.line, fix.lon, fix.lat, ...window);
    if (p.d > 60 && this.fix) p = project(this.line, fix.lon, fix.lat); // lost: search the whole line
    this.offRoute = p.d > 90;
    if (this.fix && !this.offRoute) {
      const dt = (fix.t - this.fix.t) / 1000;
      const ds = p.s - this.fix.s;
      if (dt >= 5 && ds >= -20) { const v = Math.max(0, ds / dt); this.v = this.v == null ? v : this.v * 0.4 + v * 0.6; }
    }
    this.fix = { t: fix.t, s: p.s, d: p.d, speed: fix.speed ?? null, plan: fix.plan || null, lon: fix.lon, lat: fix.lat, heading: fix.heading ?? null };
    if (prevShown != null && !this.offRoute) {
      const after = this.predicted(now);
      const err = prevShown - after;
      this.corr = Math.abs(err) < 400 ? { t: now, ds: err } : null;
      if (!this.corr) { this.shown = null; this.shownT = null; }
    }
    return true;
  }

  sAt(now) {
    let s = this.predicted(now);
    if (this.corr) {
      const k = decay((now - this.corr.t) / 1000, 2.0);
      if (k < 0.002) this.corr = null; else s += this.corr.ds * k;
    }
    // Hold instead of sliding backwards when the report says we were a little ahead.
    if (this.shown != null && s < this.shown && this.shown - s < 400) s = this.shown;
    // Never faster than the vehicle can go: when the plan implies a sprint (stop predictions bunched together, a
    // report far ahead), catch up at top speed instead of zipping along.
    if (this.shown != null && this.shownT != null && s > this.shown) {
      const dt = (now - this.shownT) / 1000;
      if (dt > 0 && dt < 3) s = Math.min(s, this.shown + this.maxSpeed * dt);
    }
    this.shown = s;
    this.shownT = now;
    return s;
  }

  /** { lon, lat, heading, s, moving } at `now`; lateral metres to the right of travel (drive on the right). */
  at(now, lateral = 0) {
    if (this.offRoute) return { lon: this.fix.lon, lat: this.fix.lat, heading: this.fix.heading ?? 0, s: this.fix.s, moving: false, offRoute: true };
    const s = this.sAt(now);
    const p = along(this.line, s, lateral);
    const s2 = this.predicted(now + 1000);
    return { ...p, s, moving: s2 - s > 0.3 };
  }

  /** Where a following car/section sits: `back` metres behind along the line. */
  behind(s, back, lateral = 0) { return along(this.line, Math.max(0, s - back), lateral); }

  record(now, p, keepS = 90) {
    const ts = now / 1000;
    if (ts - this.lastTrail >= 1) {
      this.trail.push([p.lon, p.lat, 0, ts]);
      this.lastTrail = ts;
      while (this.trail.length && ts - this.trail[0][3] > keepS) this.trail.shift();
    }
  }
}

/** Closest point of approach of a dead-reckoned straight track to a point: { tS, dM } (seconds ahead, metres). */
export function closestApproach(e0, n0, headingDeg, speed, pe = 0, pn = 0) {
  const vx = Math.sin(toRad(headingDeg)) * speed, vy = Math.cos(toRad(headingDeg)) * speed;
  const rx = e0 - pe, ry = n0 - pn;
  const v2 = vx * vx + vy * vy;
  const t = v2 > 0 ? Math.max(0, -(rx * vx + ry * vy) / v2) : 0;
  return { tS: t, dM: Math.hypot(rx + vx * t, ry + vy * t) };
}
