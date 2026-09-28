// Trends: 24-hour sparklines and "vs 1 hour ago" deltas from the server's metric history, added to the built-in
// cards (wrapping their render functions), plus per-route bus delay chips and a 24 h up/down strip for the bridges.
export const css = false; // styles live in style.css (.trend*, .bstrip*)
import { vsUsual } from '../insight.js';
import { usualOf, onBaselines } from '../baseline.js';

export default function init(api) {
  const { esc, isNum, r0, time, hour, sparkline, pparts } = api.util;
  const HOUR = 3600e3;

  /** A labelled 24 h sparkline with the current value and the change over the last hour. */
  function trend(ctx, key, { label, unit = '', dp = 0, lowerIsBetter = false, better = lowerIsBetter ? 'lower' : null, minDiff, hours = 24, color = 'var(--accent)', min, suffix = '', daily = false } = {}) {
    let s = ctx.series(key, hours);
    if (s && daily) { // a count that resets at local midnight: only today's samples mean anything
      const p = pparts(ctx.now);
      const midnight = ctx.now - ((p.hh * 60 + p.mm) * 60e3) - (ctx.now % 60e3);
      s = s.filter(([t]) => t >= midnight);
    }
    if (!s || s.length < 3) return '';
    const fmt = (v) => (dp ? (Math.round(v * 10 ** dp) / 10 ** dp).toFixed(dp) : String(Math.round(v)));
    const last = s[s.length - 1];
    const ago = s.find(([t]) => t >= ctx.now - HOUR - 5 * 60e3);
    let delta = '';
    if (ago && last[0] - ago[0] >= 30 * 60e3) {
      const d = last[1] - ago[1];
      const tiny = Math.abs(d) < (dp ? 0.5 * 10 ** -dp : 0.5);
      const cls = tiny ? '' : (d > 0) === lowerIsBetter ? 'bad' : 'good';
      delta = `<span class="trend-d ${cls}" title="An hour ago: ${fmt(ago[1])}${unit}">${tiny ? '= 1h' : `${d > 0 ? '▲' : '▼'} ${fmt(Math.abs(d))}${unit} 1h`}</span>`;
    }
    // vs what this dashboard has learned is usual for this hour (see baseline.js)
    const v = vsUsual(usualOf(key), last[1], ctx.now, { better, unit, dp, minDiff: minDiff ?? (dp ? 0.5 : 1) });
    let usual = '';
    if (v) {
      const d = last[1] - v.usual;
      usual = `<span class="trend-u ${v.dir === 'usual' ? '' : v.tone || 'odd'}" title="${esc(v.title)}">${v.dir === 'usual' ? `≈ ${v.vs}` : `${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}${esc(unit)} vs ${v.vs}`}</span>`;
    }
    const ys = s.map((p) => p[1]);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const span = Math.round((ctx.now - s[0][0]) / HOUR);
    const aria = `${label}, last ${span} hours: from ${fmt(s[0][1])} to ${fmt(last[1])}${unit}, range ${fmt(lo)} to ${fmt(hi)}`;
    return `<div class="trend" role="img" aria-label="${esc(aria)}" title="${esc(aria)}">
      <span class="trend-k">${esc(label)}</span>
      <span class="trend-spark">${sparkline(s.map(([x, y]) => ({ x, y })), { w: 180, h: 26, stroke: color, min })}</span>
      <span class="trend-v">${fmt(last[1])}${esc(unit)}${suffix}</span><span class="trend-x">${delta}${usual}</span></div>`;
  }
  const block = (rows) => { const r = rows.filter(Boolean); return r.length ? `<div class="trends"><div class="label">Last 24 hours</div>${r.join('')}</div>` : ''; };

  /** Wrap a built-in card: extra(D, ctx) is appended (or prepended) to its body. */
  function wrap(name, extra, { prepend = false, deps = [] } = {}) {
    const base = api.getCard(name);
    if (!base) return;
    api.registerCard(name, {
      ...base,
      deps: [...new Set([...(base.deps || []), ...deps])],
      render(D, ctx) {
        const h = base.render(D, ctx);
        if (h == null) return h;
        let x = '';
        try { x = extra(D, ctx) || ''; } catch (err) { console.error(`trends ${name}`, err); }
        return prepend ? x + h : h + x;
      },
    });
  }

  onBaselines(() => api.renderAll());

  wrap('now', (D, ctx) => block([
    trend(ctx, 'weather.tempF', { label: 'Temperature', unit: '°', color: 'var(--warn)' }),
    trend(ctx, 'weather.windMph', { label: 'Wind', unit: ' mph', lowerIsBetter: true, min: 0 }),
    trend(ctx, 'weather.pressureHpa', { label: 'Pressure', unit: '', color: 'var(--muted)' }),
  ]));
  wrap('air', (D, ctx) => block([trend(ctx, 'purpleair.aqi', { label: 'Ballard AQI', lowerIsBetter: true, min: 0, color: '#16a34a' })]));
  wrap('water-wx', (D, ctx) => block([
    trend(ctx, 'westpoint.windKt', { label: 'Wind', unit: ' kt', lowerIsBetter: true, min: 0 }),
    trend(ctx, 'westpoint.gustKt', { label: 'Gusts', unit: ' kt', lowerIsBetter: true, min: 0, color: 'var(--warn)' }),
  ]));
  wrap('lime', (D, ctx) => block([trend(ctx, 'lime.near', { label: 'Near Market St', min: 0, color: '#65a30d' })]));
  wrap('locks', (D, ctx) => block([trend(ctx, 'lockages.today', { label: 'Lockages today', min: 0, color: 'var(--blue)', daily: true })]), { prepend: false });
  wrap('fire', (D, ctx) => block([trend(ctx, 'fire911.count24h', { label: 'Calls in 24 h', lowerIsBetter: true, min: 0, color: 'var(--danger)' })]));

  // Drive times: trend per link plus "usual" (the 48 h median at this site).
  wrap('traffic', (D, ctx) => {
    const t = D('traffic');
    const rows = [];
    for (const s of (t && t.sites) || []) {
      const key = `traffic.downtown${s.id}`;
      const series = ctx.series(key, 48);
      const cur = (s.links || []).find((l) => /downtown/i.test(l.name));
      let usual = '';
      if (!usualOf(key) && series && series.length > 60 && cur && isNum(cur.minutes)) { // until a real baseline is learned
        const ys = series.map((p) => p[1]).sort((a, b) => a - b);
        const med = ys[ys.length >> 1];
        const diff = cur.minutes - med;
        usual = ` <span class="trend-d ${diff >= 3 ? 'bad' : diff <= -2 ? 'good' : ''}" title="48-hour median ${med} min">${Math.abs(diff) < 2 ? 'usual' : diff > 0 ? `+${r0(diff)} vs usual` : `${r0(diff)} vs usual`}</span>`;
      }
      rows.push(trend(ctx, key, { label: `Downtown from ${s.id === '1991' ? '15th & 61st' : 'Holman Rd'}`, unit: ' min', lowerIsBetter: true, min: 0, minDiff: 3, suffix: usual }));
    }
    return block(rows);
  });

  // Buses: per-route average delay chips (from the vehicles feed via history) with mini sparklines.
  wrap('transit', (D, ctx) => {
    const chips = [];
    for (const [key, route, cls] of [['transit.delay.D', 'D Line', 'd'], ['transit.delay.40', '40', ''], ['transit.delay.44', '44', '']]) {
      const s = ctx.series(key, 6);
      if (!s || !s.length || ctx.now - s[s.length - 1][0] > 30 * 60e3) continue;
      const v = s[s.length - 1][1];
      const txt = Math.abs(v) < 1 ? 'on time' : v > 0 ? `${r0(v)} min late` : `${r0(-v)} min early`;
      const sp = s.length > 2 ? sparkline(s.map(([x, y]) => ({ x, y })), { w: 60, h: 16, stroke: v >= 5 ? 'var(--warn)' : 'var(--accent)', fill: false }) : '';
      chips.push(`<span class="delay-chip ${v >= 5 ? 'late' : ''}" title="Average schedule deviation of ${esc(route)} buses on the road, last 6 hours">${api.cards.routeBadge ? api.cards.routeBadge(route, true) : esc(route)} ${txt}<span class="delay-spark">${sp}</span></span>`);
    }
    return chips.length ? `<div class="delay-row">${chips.join('')}</div>` : '';
  }, { prepend: true });

  // Bridges: 24 h strip of up/down periods from the history (Ballard, Fremont).
  function periods(series, now, t0) {
    const out = [];
    let start = null, prevT = null;
    for (const [t, v] of series) {
      if (t < t0) continue;
      if (v >= 1 && start == null) start = t;
      if (v < 1 && start != null) { out.push([start, t]); start = null; }
      // a gap of more than 5 minutes in the samples closes an open period
      if (start != null && prevT != null && t - prevT > 5 * 60e3 && t !== start) { out.push([start, prevT + 60e3]); start = v >= 1 ? t : null; }
      prevT = t;
    }
    if (start != null) out.push([start, Math.min(now, (prevT || now) + 60e3)]);
    return out;
  }
  wrap('bridges', (D, ctx) => {
    const now = ctx.now, t0 = now - 24 * HOUR;
    const pct = (t) => Math.max(0, Math.min(100, ((t - t0) / (now - t0)) * 100));
    const rows = [];
    for (const [key, name] of [['bridges.ballardUp', 'Ballard'], ['bridges.fremontUp', 'Fremont']]) {
      const s = ctx.series(key, 24);
      if (!s || s.length < 10) continue;
      const ps = periods(s, now, t0);
      const covered = pct(s[0][0]);
      const segs = ps.map(([a, b]) => `<span class="bstrip-up" style="left:${pct(a)}%;width:max(2px, ${pct(b) - pct(a)}%)" title="${name} up ${time(a)}–${time(b)} (${Math.max(1, Math.round((b - a) / 60e3))} min)"></span>`).join('');
      rows.push(`<div class="bstrip-row"><span class="bstrip-name">${name}</span><div class="bstrip" title="${covered > 1 ? `Recorded since ${time(s[0][0])}` : 'Last 24 hours'}"><span class="bstrip-cov" style="left:${covered}%"></span>${segs}</div><span class="bstrip-n">${ps.length}×</span></div>`);
    }
    if (!rows.length) return '';
    let ticks = '';
    for (let t = Math.ceil(t0 / HOUR) * HOUR; t <= now; t += HOUR) {
      if (pparts(t).hh % 6) continue;
      ticks += `<span style="left:${pct(t)}%">${hour(t)}</span>`;
    }
    return `<div class="divider"></div><div class="label">Last 24 hours (seen by this dashboard)</div>${rows.join('')}<div class="bstrip-axis"><span class="bstrip-name"></span><div class="bstrip-ticks">${ticks}</div><span class="bstrip-n"></span></div>`;
  });
}
