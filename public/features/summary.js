// "Ballard right now": a one-line ambient summary under the heads-up strip, and the "Today in Ballard" timeline
// card (daylight, tides, rain, bridge openings seen + typical, open hours, events, alerts, with a moving NOW line)
// plus a "last hour" digest built from the metric history and the activity feed.
import { icon } from '../icons.js';
const PLACES = [
  { name: 'Farmers market', hours: { 0: [9, 14] } },
  { name: 'Library', hours: { 0: [10, 18], 1: [10, 18], 2: [10, 20], 3: [10, 20], 4: [10, 20], 5: [10, 18], 6: [10, 18] } },
  { name: 'Nordic Museum', hours: { 0: [10, 17], 2: [10, 17], 3: [10, 17], 4: [10, 20], 5: [10, 17], 6: [10, 17] } },
];
const H = 3600e3;
const IC = { size: 14, cls: 'dg-ic' };

export default function init(api) {
  const u = api.util;
  const { esc, isNum, r0, r1, time, hour, wd, pparts, wxText, wxIcon, aqiInfo } = u;
  const C = api.cards || {};

  // ------------------------------------------------ the summary line
  const el = document.createElement('p');
  el.id = 'summary-line';
  el.className = 'sum-line';
  el.setAttribute('aria-live', 'off');
  const anchor = document.getElementById('headsup');
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(el, anchor.nextSibling);
  else document.querySelector('main')?.prepend(el);

  function parts(D, now) {
    const out = [];
    const w = D('weather');
    if (w && w.current) {
      const c = w.current;
      let s = `${wxIcon(c.code, c.isDay)} <b>${r0(c.tempF)}°</b> ${esc(wxText(c.code).toLowerCase())}`;
      const rt = C.rainTimes ? C.rainTimes(w, now) : { startsAt: w.rainStartsAt, endsAt: w.rainEndsAt };
      if (rt && isNum(rt.startsAt) && rt.startsAt - now < 3 * H && rt.startsAt > now) s += `, rain ~${time(rt.startsAt)}`;
      else if (rt && isNum(rt.endsAt) && rt.endsAt > now) s += `, rain easing ~${time(rt.endsAt)}`;
      out.push(s);
    }
    const b = D('bridges');
    const bb = b && (b.bridges || []).find((x) => /ballard/i.test(x.name));
    if (bb) out.push(bb.up ? `<b class="sum-warn">Ballard Bridge UP</b>${bb.sinceKnown && isNum(bb.since) ? ` (${Math.max(1, Math.round((now - bb.since) / 60e3))} min)` : ''}` : 'Ballard Bridge down');
    const tr = D('transit');
    if (tr && C.liveGroups) {
      const g = C.liveGroups(tr, now).find((x) => x.route === 'D Line' && /downtown/i.test(`${x.headsign} ${x.dir}`));
      if (g && g.arrivals[0]) {
        const v = C.etaText ? C.etaText(g.arrivals[0].t, now) : r0((g.arrivals[0].t - now) / 60e3);
        out.push(`D Line downtown ${v === 'now' ? '<b>now</b>' : `in <b>${esc(v)}</b> min`}`);
      }
    }
    const td = D('tides');
    if (td) {
      const cur = C.tideAt ? C.tideAt(td, now) : { ft: null, trend: td.trend };
      const nx = C.nextTides ? C.nextTides(td, now)[0] : (td.next || [])[0];
      if (isNum(cur.ft) || nx) out.push(`tide ${isNum(cur.ft) ? `${r1(cur.ft)} ft ` : ''}${cur.trend === 'rising' ? '↑' : cur.trend === 'falling' ? '↓' : ''}${nx ? `, ${nx.type === 'H' ? 'high' : 'low'} ${r1(nx.ft)} at ${time(nx.t)}` : ''}`);
    }
    const pa = D('purpleair');
    if (pa && isNum(pa.medianAqi)) out.push(`air ${esc(aqiInfo(pa.medianAqi).short || aqiInfo(pa.medianAqi).label).toLowerCase()} (${pa.medianAqi})`);
    const sky = D('sky');
    if (sky && sky.sun) {
      const { rise, set } = sky.sun;
      if (isNum(set) && now < set && (!isNum(rise) || now > rise)) out.push(`sunset ${time(set)}`);
      else if (isNum(rise) && now < rise) out.push(`sunrise ${time(rise)}`);
      else if (sky.tomorrowSun && isNum(sky.tomorrowSun.rise)) out.push(`sunrise ${time(sky.tomorrowSun.rise)}`);
    }
    const act = api.activity.items().filter((x) => now - x.t < H && x.t <= now + 60e3);
    if (act.length) out.push(`<a href="#live">${act.length} update${act.length === 1 ? '' : 's'} in the last hour</a>`);
    return out;
  }
  function renderLine() {
    const now = Date.now();
    const p = parts(api.D, now);
    const html = p.length ? `<span class="sum-k">Now in Ballard</span> ${p.join('<span class="sum-sep" aria-hidden="true"> · </span>')}` : '';
    api.setHTML(el, html);
    el.hidden = !p.length;
  }
  api.on('render', renderLine);
  api.on('minute', renderLine);
  api.on('activity', renderLine);
  renderLine();

  // ------------------------------------------------ the timeline
  function sunBands(D, t0, t1) {
    const sky = D('sky');
    if (!sky || !sky.sun) return null;
    const days = [];
    const s = sky.sun;
    if (isNum(s.rise) && isNum(s.set)) days.push({ dawn: s.civilDawn ?? s.rise - 30 * 60e3, rise: s.rise, set: s.set, dusk: s.civilDusk ?? s.set + 30 * 60e3 });
    const ts = sky.tomorrowSun;
    if (ts && isNum(ts.rise) && isNum(ts.set)) days.push({ dawn: ts.rise - 30 * 60e3, rise: ts.rise, set: ts.set, dusk: ts.set + 30 * 60e3 });
    // Yesterday, approximated from today (for the 6 h lookback just after midnight).
    if (days[0]) days.unshift({ dawn: days[0].dawn - 864e5, rise: days[0].rise - 864e5, set: days[0].set - 864e5, dusk: days[0].dusk - 864e5 });
    return days.filter((d) => d.dusk > t0 && d.dawn < t1);
  }

  function timeline(D, ctx) {
    const now = ctx.now;
    const t0 = now - 6 * H, t1 = now + 18 * H;
    const pct = (t) => Math.max(0, Math.min(100, ((t - t0) / (t1 - t0)) * 100));
    const within = (t) => isNum(t) && t >= t0 && t <= t1;
    const lanes = [];

    // Sky
    const bands = sunBands(D, t0, t1);
    if (bands) {
      const stops = ['var(--tl-night) 0%'];
      for (const d of bands) {
        stops.push(`var(--tl-night) ${pct(d.dawn)}%`, `var(--tl-twilight) ${pct((d.dawn + d.rise) / 2)}%`, `var(--tl-day) ${pct(d.rise + 45 * 60e3)}%`,
          `var(--tl-day) ${pct(d.set - 45 * 60e3)}%`, `var(--tl-twilight) ${pct((d.set + d.dusk) / 2)}%`, `var(--tl-night) ${pct(d.dusk)}%`);
      }
      stops.push('var(--tl-night) 100%');
      const marks = bands.flatMap((d) => [[d.rise, icon('sunrise', { size: 13 }), 'Sunrise'], [d.set, icon('sunset', { size: 13 }), 'Sunset']]).filter(([t]) => within(t))
        .map(([t, ic, name]) => `<span class="tl-mark" style="left:${pct(t)}%" title="${name} ${time(t)}">${ic}<small>${time(t)}</small></span>`).join('');
      lanes.push(['Daylight', `<div class="tl-sky" style="background:linear-gradient(90deg, ${stops.join(', ')})"></div>${marks}`]);
    }

    // Tide
    const td = D('tides');
    if (td && (td.curve || []).length) {
      const pts = td.curve.filter((p) => p.t >= t0 - 6 * 60e3 && p.t <= t1 + 6 * 60e3 && isNum(p.ft));
      if (pts.length > 2) {
        const lo = Math.min(...pts.map((p) => p.ft)) - 0.5, hi = Math.max(...pts.map((p) => p.ft)) + 0.5;
        const y = (ft) => 100 - ((ft - lo) / (hi - lo)) * 100;
        const d = pts.map((p, i) => `${i ? 'L' : 'M'}${(pct(p.t) * 10).toFixed(1)},${y(p.ft).toFixed(1)}`).join('');
        const hl = (td.hilo || []).filter((e) => within(e.t)).map((e) => `<span class="tl-tide ${e.type === 'H' ? 'hi' : 'lo'}" style="left:${pct(e.t)}%;top:${e.type === 'H' ? 0 : 55}%" title="${e.type === 'H' ? 'High' : 'Low'} tide ${r1(e.ft)} ft at ${time(e.t)}">${e.type === 'H' ? '▲' : '▼'} ${r1(e.ft)}<small> ${time(e.t)}</small></span>`).join('');
        lanes.push(['Tide', `<svg class="tl-svg" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true"><path d="${d} L1000,100 L0,100 Z" class="tl-tide-fill"/><path d="${d}" class="tl-tide-line" vector-effect="non-scaling-stroke"/></svg>${hl}`, 'tall']);
      }
    }

    // Rain: hourly chance, plus the 15-minute nowcast for the next 3 hours
    const w = D('weather');
    if (w && (w.hourly || []).length) {
      const bars = w.hourly.filter((h) => within(h.t) && (h.pop || 0) > 0).map((h) => `<span class="tl-rain" style="left:${pct(h.t)}%;width:${(H / (t1 - t0)) * 100}%;height:${Math.max(8, h.pop)}%;opacity:${0.3 + h.pop / 140}" title="${hour(h.t)}: ${h.pop}% chance of rain"></span>`).join('');
      const now15 = (w.nowcast || []).filter((s) => within(s.t) && s.precipIn > 0.001).map((s) => `<span class="tl-rain now" style="left:${pct(s.t)}%;width:${(15 * 60e3 / (t1 - t0)) * 100}%" title="${time(s.t)}: rain (${s.precipIn} in)"></span>`).join('');
      if (bars || now15) lanes.push(['Rain', bars + now15]);
      else lanes.push(['Rain', '<span class="tl-none">No rain expected</span>']);
    }

    // Bridges: openings this dashboard saw, then the typical rate ahead (bridge-odds), with the rush-hour closures.
    const b = D('bridges');
    const odds = D('bridge-odds');
    let bl = '';
    for (const l of (b && b.log) || []) {
      if (!/ballard|fremont/i.test(l.bridge) || !isNum(l.upAt) || l.upAt > t1 || (l.downAt || now) < t0) continue;
      const end = isNum(l.downAt) ? l.downAt : now;
      bl += `<span class="tl-open ${/ballard/i.test(l.bridge) ? 'ballard' : 'fremont'}" style="left:${pct(l.upAt)}%;width:max(3px, ${pct(end) - pct(l.upAt)}%)" title="${esc(l.bridge)} Bridge up ${time(l.upAt)}${isNum(l.minutes) ? `, ${l.minutes} min` : isNum(l.downAt) ? '' : ' (still up)'}"></span>`;
    }
    if (odds && Array.isArray(odds.hourly) && odds.hourly.length === 168) {
      for (let t = Math.ceil(now / H) * H - H; t < t1; t += H) {
        const p = pparts(t);
        const slot = odds.hourly[p.wd * 24 + p.hh];
        if (!slot || t + H < now) continue;
        const from = Math.max(t, now);
        const hgt = Math.min(100, slot.avgOpenings * 60);
        if (hgt > 3) bl += `<span class="tl-typical" style="left:${pct(from)}%;width:${pct(t + H) - pct(from)}%;height:${hgt}%" title="${hour(t)}: usually ${slot.avgOpenings.toFixed(1)} openings per hour (Ballard, last 12 weeks)"></span>`;
      }
      for (let d = -1; d <= 1; d++) {
        const base = pparts(now + d * 864e5);
        const dow = base.wd;
        if (dow < 1 || dow > 5) continue;
        for (const [a, z] of [[7, 9], [16, 18]]) {
          const start = now + d * 864e5 - ((base.hh * 60 + base.mm) * 60e3) + a * H;
          const end = start + (z - a) * H;
          if (end < t0 || start > t1) continue;
          bl += `<span class="tl-restrict" style="left:${pct(start)}%;width:${pct(end) - pct(start)}%" title="Rush-hour rule: no openings for boats under 1,000 tons (${time(start)}–${time(end)} weekdays)"></span>`;
        }
      }
    }
    if (b || odds) lanes.push(['Bridges', bl || '<span class="tl-none">No openings seen yet</span>']);

    // Open hours
    let open = '';
    PLACES.forEach((pl, i) => {
      for (let d = -1; d <= 1; d++) {
        const base = pparts(now + d * 864e5);
        const hrs = pl.hours[base.wd];
        if (!hrs) continue;
        const start = now + d * 864e5 - ((base.hh * 60 + base.mm) * 60e3) + hrs[0] * H;
        const end = now + d * 864e5 - ((base.hh * 60 + base.mm) * 60e3) + hrs[1] * H;
        if (end < t0 || start > t1) continue;
        const isOpen = now >= start && now < end;
        open += `<span class="tl-hours p${i}${isOpen ? ' open' : ''}" style="left:${pct(start)}%;width:${pct(end) - pct(start)}%;top:${i * 33}%" title="${esc(pl.name)}: ${time(start)}–${time(end)} ${esc(wd(start))}">${esc(pl.name)}</span>`;
      }
    });
    if (open) lanes.push(['Open', open, 'tall']);

    // Events and alerts
    const ev = D('events');
    const evs = ((ev && ev.events) || []).filter((e) => !e.allDay && !e.canceled && within(e.start)).slice(0, 40);
    if (evs.length) lanes.push(['Events', evs.map((e) => `<a class="tl-ev" href="${u.href(e.url)}" target="_blank" rel="noopener" style="left:${pct(e.start)}%" title="${time(e.start)} · ${esc(e.title)}${e.venue ? ' · ' + esc(e.venue) : ''}">●</a>`).join('')]);
    const al = [];
    for (const a of ((D('alerts') || {}).alerts || [])) {
      const s = isNum(a.onset) ? a.onset : now, e = a.ends || a.expires;
      if (!isNum(e) || e < t0 || s > t1) continue;
      al.push(`<span class="tl-alert ${/severe|extreme/i.test(a.severity) ? 'sev' : ''}" style="left:${pct(s)}%;width:${pct(e) - pct(s)}%" title="${esc(a.event)} ${time(s)}–${time(e)}">${esc(a.event)}</span>`);
    }
    for (const a of ((D('metro-alerts') || {}).alerts || [])) {
      if (!isNum(a.start) || !isNum(a.end) || a.end < t0 || a.start > t1) continue;
      al.push(`<span class="tl-alert metro" style="left:${pct(a.start)}%;width:${pct(a.end) - pct(a.start)}%" title="${esc(a.header)}">${esc((a.routes || []).join('/'))} ${esc(a.effect === 'NO_SERVICE' ? 'stop closed' : 'alert')}</span>`);
    }
    if (al.length) lanes.push(['Alerts', al.join('')]);

    // Axis
    let ticks = '';
    for (let t = Math.ceil(t0 / H) * H; t <= t1; t += H) {
      const p = pparts(t);
      if (p.hh % 3) continue;
      ticks += `<span class="tl-tick${p.hh === 0 ? ' day' : ''}" style="left:${pct(t)}%">${p.hh === 0 ? esc(wd(t)) : hour(t)}</span>`;
    }
    if (!lanes.length) return null;
    return `<div class="tl-wrap"><div class="tl" style="--now:${pct(now).toFixed(2)}">
        ${lanes.map(([name, html, cls]) => `<div class="tl-lane ${cls || ''}"><div class="tl-name">${name}</div><div class="tl-track">${html}</div></div>`).join('')}
        <div class="tl-lane axis"><div class="tl-name"></div><div class="tl-track">${ticks}</div></div>
        <div class="tl-now" aria-hidden="true"><span>now</span></div>
      </div></div>
      ${digest(D, ctx)}`;
  }

  // ------------------------------------------------ last-hour digest
  function delta(ctx, key, fmt, unit = '', lowerIsBetter = false) {
    const s = ctx.series(key, 3);
    if (!s || s.length < 2) return null;
    const last = s[s.length - 1];
    const ago = s.find(([t]) => t >= ctx.now - H - 5 * 60e3);
    if (!ago || last[0] - ago[0] < 30 * 60e3) return null;
    const d = last[1] - ago[1];
    const dir = Math.abs(d) < 0.05 ? '' : d > 0 ? '▲' : '▼';
    const good = !dir ? '' : (d > 0) === lowerIsBetter ? 'bad' : 'good';
    return { html: `${fmt(last[1])}${unit} <span class="dg-d ${good}" title="An hour ago: ${fmt(ago[1])}${unit}">${dir}${dir ? fmt(Math.abs(d)) : '='}</span>` };
  }
  function digest(D, ctx) {
    const now = ctx.now;
    const bits = [];
    const t = delta(ctx, 'weather.tempF', (v) => r0(v), '°');
    if (t) bits.push(`${icon('thermo', IC)} ${t.html}`);
    const w = delta(ctx, 'weather.windMph', (v) => r0(v), ' mph', true);
    if (w) bits.push(`${icon('wind', IC)} ${w.html}`);
    const a = delta(ctx, 'purpleair.aqi', (v) => r0(v), '', true);
    if (a) bits.push(`${icon('air', IC)} AQI ${a.html}`);
    const dr = delta(ctx, 'traffic.downtown1991', (v) => r0(v), ' min', true);
    if (dr) bits.push(`${icon('traffic', IC)} downtown ${dr.html}`);
    const dl = ctx.series('transit.delay.D', 2);
    if (dl && dl.length && now - dl[dl.length - 1][0] < 30 * 60e3) {
      const v = dl[dl.length - 1][1];
      bits.push(`${icon('transit', IC)} D Line ${Math.abs(v) < 1 ? 'on time' : v > 0 ? `${r0(v)} min late` : `${r0(-v)} min early`}`);
    }
    const act = api.activity.items().filter((x) => now - x.t < H && x.t <= now + 60e3);
    if (act.length) {
      const by = {};
      for (const x of act) by[x.kind] = (by[x.kind] || 0) + 1;
      bits.push(`<a href="#live">${act.length} update${act.length === 1 ? '' : 's'}</a> <span class="muted">(${Object.entries(by).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, n]) => `${esc(k)} ${n}`).join(', ')})</span>`);
    }
    return bits.length ? `<div class="dg"><span class="label">Last hour</span> ${bits.join('<span class="sum-sep"> · </span>')}</div>` : '';
  }

  api.registerCard('timeline', {
    deps: ['sky', 'tides', 'weather', 'bridges', 'bridge-odds', 'events', 'alerts', 'metro-alerts'],
    title: 'Today in Ballard', section: 'live', wide: true, order: 0, clock: true,
    render: timeline,
    after(el, ctx) {
      // Keep NOW in view on narrow screens (the timeline scrolls sideways there).
      const wrap = el.querySelector('.tl-wrap');
      if (wrap && ctx.changed && wrap.scrollWidth > wrap.clientWidth + 40 && !wrap._blScrolled) {
        wrap._blScrolled = true;
        wrap.scrollLeft = Math.max(0, (wrap.scrollWidth - 64) * 0.25 - 60); // NOW sits 25% in; keep some past visible
      }
    },
  });
  api.on('activity', () => api.invalidate('timeline'));

  // ------------------------------------------------ sky strip: a thin band under the top bar tinted by the real sky
  const bar = document.querySelector('.topbar');
  const strip = document.createElement('div');
  strip.className = 'sky-strip';
  strip.setAttribute('aria-hidden', 'true');
  if (bar) bar.appendChild(strip);
  function paintSky() {
    const sky = api.D('sky'), w = api.D('weather');
    if (!sky || !sky.sun) { strip.hidden = true; return; }
    strip.hidden = false;
    const now = Date.now();
    const { civilDawn, rise, set, civilDusk } = sky.sun;
    const c = (w && w.current) || {};
    const wet = isNum(c.code) && c.code >= 51;
    let bg, phase;
    if (isNum(civilDawn) && isNum(rise) && now >= civilDawn && now < rise + 40 * 60e3) { bg = 'linear-gradient(90deg, #312e81, #db2777 35%, #f59e0b 70%, #fde68a)'; phase = 'Dawn'; }
    else if (isNum(set) && isNum(civilDusk) && now >= set - 40 * 60e3 && now < civilDusk) { bg = 'linear-gradient(90deg, #fde68a, #f97316 30%, #db2777 65%, #312e81)'; phase = 'Dusk'; }
    else if (isNum(rise) && isNum(set) && now >= rise && now < set) {
      phase = 'Daylight';
      bg = wet ? 'linear-gradient(90deg, #475569, #94a3b8, #64748b)' : (c.cloud ?? 0) > 80 ? 'linear-gradient(90deg, #94a3b8, #cbd5e1, #94a3b8)'
        : (c.cloud ?? 0) > 40 ? 'linear-gradient(90deg, #7dd3fc, #cbd5e1 50%, #7dd3fc)' : 'linear-gradient(90deg, #38bdf8, #7dd3fc 50%, #38bdf8)';
    } else { bg = 'linear-gradient(90deg, #0f172a, #312e81 50%, #0f172a)'; phase = 'Night'; }
    strip.style.background = bg;
    strip.dataset.phase = phase.toLowerCase();
  }
  api.on('minute', paintSky);
  api.on('render', ({ changed }) => { if (changed && (changed.has('sky') || changed.has('weather'))) paintSky(); });
  paintSky();
}
