// Card renderers. Each card: { deps: [sourceIds], render(D, ctx) -> html | null }.
// D(id) returns that source's data (or null). ctx: { ui, now, env(id) }.
import {
  esc, href, isNum, r0, r1, time, hour, wd, md, full, dayLabel, dayKey, rel, relEl, duration, compass, windArrow,
  wxText, wxIcon, aqiInfo, sparkline, distLabel, plural, pparts, camSrc, live, liveNum, liveAttr, countdownEl, newBadge,
} from './util.js';
import { icon } from './icons.js';

const empty = (msg) => `<div class="empty">${esc(msg)}</div>`;
// "new" badges: items that first appeared after their list's first render in this page session (for 10 min).
const firstSeen = new Map();
const seededScopes = new Set();
function badge(scope, id, now) {
  const k = `${scope}\u0000${id}`;
  if (!firstSeen.has(k)) firstSeen.set(k, seededScopes.has(scope) ? now : 0);
  const t = firstSeen.get(k);
  return t > 0 && now - t < 10 * 60e3 ? ' ' + newBadge() : '';
}
const seeded = (scope, html) => { if (html != null) seededScopes.add(scope); return html; };

const tagFor = (cls, text) => `<span class="tag ${cls}">${esc(text)}</span>`;
const seg = (key, cur, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button type="button" data-set="${key}=${v}" class="${cur === v ? 'on' : ''}" aria-pressed="${cur === v}">${esc(l)}</button>`).join('')}</div>`;
const warnings = (...ds) => {
  const w = ds.flatMap((d) => (d && d.warnings) || []);
  return w.length ? `<div class="err-note">${icon('alert', { size: 14, cls: 'ic-inline' })} ${w.map(esc).join(' · ')}</div>` : '';
};

// ---------------------------------------------------------------- weather

/** Rain start/end from the nowcast, ignoring times that have already passed (the payload can be minutes to hours old). */
export function rainTimes(w, now = Date.now()) {
  const soon = (t) => isNum(t) && t > now - 60000;
  return { startsAt: soon(w.rainStartsAt) ? w.rainStartsAt : null, endsAt: soon(w.rainEndsAt) ? w.rainEndsAt : null };
}

/** West Point: 'peak gust 12 kt at 3:40 pm' when there is no gust at the observation time but the hourly peak is known. */
export const peakGustText = (wp) => (wp && !isNum(wp.gustKt) && isNum(wp.peakGustKt)
  ? `peak gust ${r0(wp.peakGustKt)} kt${isNum(wp.peakGustT) ? ` at ${time(wp.peakGustT)}` : ''}` : '');

function nowCard(D, { now }) {
  const w = D('weather');
  if (!w) return null;
  const c = w.current || {};
  const st = D('stations');
  const wp = D('westpoint');
  const nowcast = (w.nowcast || []).filter((s) => isNum(s.t) && s.t + 15 * 60000 > now);
  const rt = rainTimes(w, now);
  let rainLine = 'No rain expected in the next 3 hours.';
  if (isNum(rt.startsAt)) rainLine = `Rain likely starting around <b>${time(rt.startsAt)}</b> (${relEl(rt.startsAt)}).`;
  else if (isNum(rt.endsAt)) rainLine = `Raining now; easing around <b>${time(rt.endsAt)}</b>.`;
  else if (nowcast.some((s) => s.precipIn > 0.001)) rainLine = 'Rain continuing through the next 3 hours.';
  const maxP = Math.max(0.02, ...nowcast.map((s) => s.precipIn || 0));
  const bars = nowcast.map((s) => `<div class="${s.precipIn > 0.001 ? 'wet' : ''}" style="height:${Math.max(3, ((s.precipIn || 0) / maxP) * 26)}px" title="${time(s.t)}: ${s.precipIn ?? 0} in"></div>`).join('');
  const measured = st && isNum(st.medianTempF)
    ? `<div class="small muted" style="margin-top:6px">Measured at nearby backyard stations: <b class="num">${r0(st.medianTempF)}°F</b> (median of ${isNum(st.medianOf) ? st.medianOf : (st.stations || []).filter((s) => !s.stale).length})</div>` : '';
  // inBallard === false: outside the neighborhood proper (missing = treat as in Ballard).
  const stations = st && st.stations && st.stations.length ? `<div class="divider"></div><div class="label">Neighborhood stations</div><ul class="list">${st.stations.map((s) => `
      <li><div class="grow"><span class="mono small">${esc(s.id)}</span> <span class="small muted">${distLabel(s.distKm)} away</span>${s.inBallard === false ? ' ' + tagFor('', 'nearby') : ''}${s.stale ? ' ' + tagFor('warn', 'stale') : ''}</div>
      <div class="num"><b>${r0(s.tempF)}°</b> <span class="small muted">${r0(s.humidity)}% · ${isNum(s.windMph) ? r0(s.windMph) + ' mph' : '–'}</span></div>
      <div class="t">${relEl(s.t)}</div></li>`).join('')}</ul>` : '';
  const wpPeak = peakGustText(wp);
  const wpLine = wp && isNum(wp.windKt) ? `<div><span>West Point wind</span><b>${windArrow(wp.windDir)} ${r0(wp.windKt)} kt${isNum(wp.gustKt) ? ` g${r0(wp.gustKt)}` : ''}</b>${wpPeak ? `<small class="small muted">${wpPeak}</small>` : ''}</div>` : '';
  return `
    <div class="wx-now">
      <div class="wx-icon">${wxIcon(c.code, c.isDay)}</div>
      <div><div class="big">${isNum(c.tempF) ? liveNum('temp', c.tempF) : '–'}<small>°F</small></div>
      <div>${esc(wxText(c.code))} · feels ${r0(c.feelsF)}°</div></div>
    </div>
    ${measured}
    <div class="kv">
      <div><span>Wind</span><b>${windArrow(c.windDir)} ${compass(c.windDir)} ${r0(c.windMph)} mph</b></div>
      <div><span>Gusts</span><b>${r0(c.gustMph)} mph</b></div>
      <div><span>Humidity</span><b>${r0(c.humidity)}%</b></div>
      <div><span>Pressure</span><b>${r0(c.pressureHpa)} hPa</b></div>
      <div><span>Visibility</span><b>${isNum(c.visMi) ? (c.visMi >= 10 ? '10+ mi' : r1(c.visMi) + ' mi') : '–'}</b></div>
      <div><span>UV index</span><b>${r1(c.uv)}</b></div>
      <div><span>Cloud cover</span><b>${r0(c.cloud)}%</b></div>
      ${wpLine}
    </div>
    <div class="divider"></div>
    <div class="label">Rain, next 3 hours</div>
    <div class="nowcast" aria-hidden="true">${bars}</div>
    <div class="small" style="margin-top:6px">${rainLine}</div>
    ${stations}`;
}

function hourlyCard(D, { now }) {
  const w = D('weather');
  if (!w) return null;
  if (!(w.hourly || []).length) return empty('No hourly forecast in the latest update.');
  // Drop hours that have fully passed since the fetch, so the first column really is "Now".
  const hs = w.hourly.filter((h) => !isNum(h.t) || h.t + 3600e3 > now).slice(0, 24);
  if (!hs.length) return empty('Hourly forecast is out of date. Waiting for a refresh.');
  const cw = 28, W = hs.length * cw, H = 188;
  const temps = hs.map((h) => h.tempF).filter(isNum);
  const tmin = Math.min(...temps), tmax = Math.max(...temps);
  const ty = (t) => 44 + (1 - (t - tmin) / (tmax - tmin || 1)) * 46;
  const pts = hs.map((h, i) => (isNum(h.tempF) ? [i * cw + cw / 2, ty(h.tempF)] : null)).filter(Boolean);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1].toFixed(1)}`).join('');
  // Day/night icons from the forecast's own sunrise/sunset (a fixed 7am-7pm is off by hours in winter).
  const sun = new Map((w.daily || []).filter((d) => isNum(d.t)).map((d) => [dayKey(d.t), d]));
  const cols = hs.map((h, i) => {
    const x = i * cw + cw / 2;
    const pop = h.pop || 0;
    const bh = (pop / 100) * 30;
    const sd = sun.get(dayKey(h.t)), mid = h.t + 30 * 60000;
    const day = sd && isNum(sd.sunrise) && isNum(sd.sunset) ? mid >= sd.sunrise && mid < sd.sunset : pparts(h.t).hh >= 7 && pparts(h.t).hh < 19;
    return `
      <text x="${x}" y="16" text-anchor="middle" style="font-size:14px">${wxIcon(h.code, day)}</text>
      <text x="${x}" y="${ty(h.tempF) - 8}" text-anchor="middle" style="fill:var(--ink);font-weight:600">${r0(h.tempF)}°</text>
       <rect x="${x - 9}" y="${142 - bh}" width="18" height="${bh}" rx="3" fill="var(--blue)" opacity="${0.25 + pop / 160}"><title>${hour(h.t)}: ${pop}% chance, ${h.precipIn ?? 0} in</title></rect>
      ${pop >= 15 ? `<text x="${x}" y="${136 - bh}" text-anchor="middle" style="fill:var(--blue)">${pop}%</text>` : ''}
      <text x="${x}" y="${160}" text-anchor="middle">${i === 0 ? 'Now' : hour(h.t)}</text>
      <text x="${x}" y="${173}" text-anchor="middle">${r0(h.windMph)}</text>
      ${isNum(h.gustMph) && h.gustMph - h.windMph >= 8 ? `<text x="${x}" y="185" text-anchor="middle" style="fill:var(--warn)">g${r0(h.gustMph)}</text>` : ''}`;
  }).join('');
  const midnight = hs.findIndex((h, i) => i > 0 && pparts(h.t).hh === 0);
  const mid = midnight > 0 ? `<line x1="${midnight * cw}" x2="${midnight * cw}" y1="22" y2="150" class="grid"/><text x="${midnight * cw + 4}" y="30" style="font-weight:600">${wd(hs[midnight].t)}</text>` : '';
  return `<div class="hourly-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Hourly temperature and rain chance">
      ${mid}<path d="${path}" fill="none" stroke="var(--warn)" stroke-width="2.2" stroke-linejoin="round"/>${cols}
    </svg></div>
    <div class="small muted">Temperature (°F), chance of rain, wind in mph (g = gusts). Source: Open-Meteo.</div>`;
}

/** Daily forecast rows from today's Pacific date on (after midnight, a not-yet-refreshed payload still starts yesterday). */
export const dailyFrom = (w, now = Date.now()) => (w.daily || []).filter((d) => !isNum(d.t) || dayKey(d.t) >= dayKey(now));

function dailyCard(D, { now }) {
  const w = D('weather');
  if (!w) return null;
  if (!(w.daily || []).length) return empty('No daily forecast in the latest update.');
  const ds = dailyFrom(w, now);
  if (!ds.length) return empty('Daily forecast is out of date. Waiting for a refresh.');
  const today = dayKey(now);
  const lo = Math.min(...ds.map((d) => d.loF).filter(isNum)), hi = Math.max(...ds.map((d) => d.hiF).filter(isNum));
  const pct = (v) => ((v - lo) / (hi - lo || 1)) * 100;
  return `<div class="daily">${ds.map((d) => `
      <div><b>${isNum(d.t) && dayKey(d.t) === today ? 'Today' : esc(wd(d.t))}</b></div>
      <div title="${esc(wxText(d.code))}">${wxIcon(d.code)}</div>
      <div class="track"><div class="bar" style="position:absolute;left:${pct(d.loF)}%;right:${100 - pct(d.hiF)}%"></div></div>
      <div class="num" style="text-align:right"><span class="muted">${r0(d.loF)}°</span> / <b>${r0(d.hiF)}°</b></div>
      <div class="pop">${d.pop ? d.pop + '%' : ''}</div>`).join('')}</div>
    <div class="small muted" style="margin-top:8px">Max gusts this week: ${r0(Math.max(...ds.map((d) => d.gustMph || 0)))} mph · Peak UV ${r1(Math.max(...ds.map((d) => d.uvMax || 0)))}</div>`;
}

function nwsCard(D, { ui, now }) {
  const f = D('nws-forecast');
  if (!f) return null;
  // Skip periods that have ended since the fetch (e.g. 'Tonight' after 6 am).
  const periods = (f.periods || []).filter((p) => !isNum(p.end) || p.end > now);
  if (!periods.length) return empty('No current NWS forecast periods in the latest update.');
  const n = ui.nwsAll ? periods.length : 3;
  return `<div class="periods">${periods.slice(0, n).map((p, i) => `
      <div class="p"><div class="row between"><b>${esc(p.name)}</b><span class="num">${r0(p.tempF)}°${isNum(p.pop) ? ` <span class="small" style="color:var(--blue)">· ${p.pop}%</span>` : ''}</span></div>
      <div class="small ${i < 2 ? '' : 'muted'}">${esc(i < 2 ? p.detail : p.short)}</div></div>`).join('')}</div>
    <div class="row between small" style="margin-top:8px"><span class="muted">Issued ${relEl(f.updated)}</span>
    <a href="#" data-set="nwsAll=${ui.nwsAll ? '' : '1'}">${ui.nwsAll ? 'Show less' : 'Show all ' + periods.length}</a></div>`;
}

function waterWxCard(D) {
  const wp = D('westpoint');
  const mf = D('marine');
  if (!wp && !mf) return null;
  let top = '';
  if (wp) {
    const hist = (wp.history || []).filter((h) => isNum(h.windKt));
    top = `
      <div class="row between"><div>
        <div class="label">West Point, measured</div>
        <div class="big">${windArrow(wp.windDir)} ${isNum(wp.windKt) ? liveNum('wind', wp.windKt) : '–'}<small> kt</small></div>
        <div class="small">${compass(wp.windDir)} ${isNum(wp.gustKt) ? `gusting ${r0(wp.gustKt)} kt · ` : peakGustText(wp) ? `${peakGustText(wp)} · ` : ''}${r0(wp.windMph)} mph · ${relEl(wp.t)}</div>
      </div>
      <div class="kv" style="margin:0;grid-template-columns:repeat(2,auto)">
        <div><span>Air</span><b>${r0(wp.airTempF)}°F</b></div>
        <div><span>Pressure</span><b>${r1(wp.pressureHpa)}</b></div>
        <div><span>3h trend</span><b>${isNum(wp.pressureTendencyHpa) ? (wp.pressureTendencyHpa > 0 ? '+' : '') + r1(wp.pressureTendencyHpa) : '–'}</b></div>
      </div></div>
      ${hist.length > 2 ? `<div class="label" style="margin-top:10px">Wind, last 24h (kt)</div>${sparkline(hist.map((h) => ({ x: h.t, y: h.windKt })), { stroke: 'var(--accent)', min: 0 })}` : ''}`;
  }
  let marine = '';
  if (mf) {
    marine = `<div class="divider"></div><div class="label">Puget Sound marine forecast</div>
      ${(mf.headlines || []).map((h) => `<div style="margin-bottom:6px">${tagFor('warn', h)}</div>`).join('')}
      <div class="periods">${(mf.periods || []).slice(0, 3).map((p) => `<div class="p"><b class="small">${esc(p.name)}</b><div class="small">${esc(p.text)}</div></div>`).join('')}</div>
      <div class="tiny faint" style="margin-top:6px">${esc(mf.issued || '')}</div>`;
  }
  return top + marine + warnings(wp, mf);
}

function airCard(D) {
  const pa = D('purpleair');
  const an = D('airnow');
  if (!pa && !an) return null;
  const local = pa && isNum(pa.medianAqi) ? pa.medianAqi : null;
  const official = an && (an.observed || []).find((o) => o.primary) || (an && an.observed && an.observed[0]);
  const show = isNum(local) ? local : official && official.aqi;
  const info = aqiInfo(show);
  const fc = an ? (an.forecast || []).filter((f) => f.primary !== false) : [];
  const days = [...new Map(fc.map((f) => [f.date, f])).values()].slice(0, 4);
  return `
    <div class="row">
      <div class="aqi-swatch" style="background:${info.color};color:${info.ink || '#111'}">${isNum(show) ? liveNum('aqi', show) : '–'}</div>
      <div><b>${esc(info.label)}</b><div class="small muted">${isNum(local) ? `Median of ${plural(pa.count, 'PurpleAir sensor')} in Ballard (PM2.5)` : 'Official Seattle area AQI'}</div></div>
    </div>
    <div class="kv">
      ${isNum(pa && pa.medianPm25) ? `<div><span>PM2.5</span><b>${r1(pa.medianPm25)} µg/m³</b></div>` : ''}
      ${(an && an.observed || []).map((o) => `<div><span>Official ${esc(o.param)}</span><b>${r0(o.aqi)} <span class="small muted">${esc(o.category || '')}</span></b></div>`).join('')}
    </div>
    ${days.length ? `<div class="divider"></div><div class="label">Forecast (Puget Sound Clean Air Agency)</div>
      <div class="aqi-days">${days.map((f) => `<div><b>${esc(wd(Date.parse(f.date + 'T12:00:00-07:00')))}</b> <span style="color:${aqiInfo(f.aqi).color}">●</span> ${esc(f.category || '')}${isNum(f.aqi) ? ` (${f.aqi})` : ''}</div>`).join('')}</div>` : ''}
    ${an && an.discussion ? `<div class="small muted clamp2" style="margin-top:8px" title="${esc(an.discussion)}">${esc(an.discussion)}</div>` : ''}
    ${warnings(pa, an)}`;
}

function sunCard(D, { now }) {
  const s = D('sky');
  if (!s) return null;
  if (!s.sun) return empty('No sun and moon times in the latest update.');
  const { sun, moon } = s;
  const p = pparts(now);
  const dayStart = now - ((p.hh * 60 + p.mm) * 60000);
  const pos = (t) => (isNum(t) ? Math.max(0, Math.min(100, ((t - dayStart) / 864e5) * 100)) : 50);
  let next;
  if (isNum(sun.rise) && now < sun.rise) next = `Sunrise ${relEl(sun.rise)}`;
  else if (isNum(sun.set) && now < sun.set) next = `Sunset ${relEl(sun.set)}`;
  else if (s.tomorrowSun && isNum(s.tomorrowSun.rise)) next = `Sunrise ${relEl(s.tomorrowSun.rise)}`;
  const len = isNum(sun.rise) && isNum(sun.set) ? sun.set - sun.rise : null;
  const tlen = s.tomorrowSun && isNum(s.tomorrowSun.rise) && isNum(s.tomorrowSun.set) ? s.tomorrowSun.set - s.tomorrowSun.rise : null;
  // USNO times are to the minute, so the change is only meaningful in whole minutes.
  const deltaMin = isNum(len) && isNum(tlen) ? (tlen - len) / 60000 : null;
  const deltaTxt = !isNum(deltaMin) ? '' : Math.abs(deltaMin) < 1 ? 'tomorrow about the same'
    : `tomorrow about ${Math.round(Math.abs(deltaMin))} min ${deltaMin < 0 ? 'shorter' : 'longer'}`;
  return `
    <div class="row between"><div><div class="big" style="font-size:30px">${next || '–'}</div>
      <div class="small muted">${isNum(len) ? `${duration(len)} of daylight` : ''}${deltaTxt ? `${isNum(len) ? ' · ' : ''}${deltaTxt}` : ''}</div></div></div>
    <div class="daybar" style="--a:${pos(sun.civilDawn)}%;--b:${pos(sun.rise)}%;--c:${pos(sun.set)}%;--d:${pos(sun.civilDusk)}%">
      <div class="nowmark" style="left:${pos(now)}%"></div></div>
    <div class="kv">
      <div><span>First light</span><b>${time(sun.civilDawn)}</b></div>
      <div><span>Sunrise</span><b>${time(sun.rise)}</b></div>
      <div><span>Sunset</span><b>${time(sun.set)}</b></div>
      <div><span>Last light</span><b>${time(sun.civilDusk)}</b></div>
    </div>
    <div class="divider"></div>
    <div class="row"><div style="font-size:30px">${moonEmoji(moon && moon.phase)}</div>
      <div><b>${esc(moon && moon.phase || '–')}</b>, ${r0(moon && moon.illum)}% lit
      <div class="small muted">Moonrise ${time(moon && moon.rise)} · moonset ${time(moon && moon.set)}${s.nextPhase ? ` · ${esc(s.nextPhase.phase)} ${esc(dayLabel(s.nextPhase.t))}` : ''}</div></div></div>`;
}
function moonEmoji(phase) {
  const p = String(phase ?? '').toLowerCase();
  if (p.includes('new')) return '🌑';
  if (p.includes('waxing crescent')) return '🌒';
  if (p.includes('first')) return '🌓';
  if (p.includes('waxing gibbous')) return '🌔';
  if (p.includes('full')) return '🌕';
  if (p.includes('waning gibbous')) return '🌖';
  if (p.includes('last') || p.includes('third')) return '🌗';
  if (p.includes('waning crescent')) return '🌘';
  return '🌙';
}

function radarCard(D) {
  const r = D('radar');
  if (!r) return null;
  return `<img class="radar-img" loading="lazy" src="${href(r.loopGif)}?t=${Math.floor((r.valid || Date.now()) / 60000)}" alt="Animated weather radar loop from Camano Island (KATX)">
    <div class="small muted" style="margin-top:6px">Composite valid ${relEl(r.valid)}. For a zoomed view, turn on the <b>Radar</b> layer on the map.</div>`;
}

function auroraCard(D) {
  const k = D('kp');
  if (!k) return null;
  const kp = k.kp;
  let label = 'Quiet', cls = '', chance = 'Not visible from Seattle.';
  if (kp >= 4) { label = 'Active'; cls = 'accent'; chance = 'Unlikely from Seattle.'; }
  if (kp >= 5) { label = 'G1 minor storm'; cls = 'warn'; chance = 'Possible faint glow on the northern horizon from dark sites.'; }
  if (kp >= 6) { label = 'G2 moderate storm'; cls = 'warn'; chance = 'Possible from dark spots like Golden Gardens. Look north.'; }
  if (kp >= 7) { label = 'G3+ strong storm'; cls = 'danger'; chance = 'Good odds of seeing aurora. Look north after dark.'; }
  const rec = k.recent || [];
  return `<div class="row"><div class="big">${r1(kp)}</div><div>${tagFor(cls, label)}<div class="small muted" style="margin-top:4px">Planetary Kp index</div></div></div>
    <div class="small" style="margin-top:8px">${esc(chance)}</div>
    ${rec.length ? `<div class="kpbars" aria-hidden="true">${rec.map((r) => `<div title="${full(r.t)}: Kp ${r.kp}" style="height:${Math.max(4, (r.kp / 9) * 100)}%;background:${r.kp >= 5 ? 'var(--warn)' : 'var(--accent)'}"></div>`).join('')}</div>
    <div class="tiny faint row between"><span>${rel(rec[0].t)}</span><span>3-hour Kp</span><span>${rel(rec[rec.length - 1].t)}</span></div>` : ''}`;
}

function afdCard(D, { ui }) {
  const a = D('afd');
  if (!a) return null;
  return `<div class="small" style="white-space:pre-line">${esc(a.synopsis || '')}</div>
    ${a.shortTerm ? (ui.afdMore ? `<div class="divider"></div><div class="label">Short term</div><div class="small" style="white-space:pre-line">${esc(a.shortTerm)}</div>` : '') : ''}
    <div class="row between small" style="margin-top:8px"><span class="muted">NWS Seattle, ${relEl(a.issued)}</span>
    ${a.shortTerm ? `<a href="#" data-set="afdMore=${ui.afdMore ? '' : '1'}">${ui.afdMore ? 'Less' : 'Short-term details'}</a>` : ''}</div>`;
}

// ---------------------------------------------------------------- water

/**
 * Predicted height and trend at `now`, interpolated from the 6-minute curve. The payload's own `trend`
 * is computed when it was fetched (up to a TTL earlier), so it is wrong for a while after each high/low.
 */
export function tideAt(td, now = Date.now()) {
  const c = (td.curve || []).filter((p) => isNum(p.t) && isNum(p.ft));
  const i = c.findIndex((p) => p.t > now);
  if (i <= 0) return { ft: null, trend: null }; // now is outside the prediction curve
  const a = c[i - 1], b = c[i];
  const ft = a.ft + ((b.ft - a.ft) * (now - a.t)) / (b.t - a.t || 1);
  return { ft, trend: b.ft > a.ft ? 'rising' : b.ft < a.ft ? 'falling' : td.trend || null };
}
/** High/low events still ahead of `now` (payload `next` is relative to fetch time). */
export function nextTides(td, now = Date.now()) {
  const m = new Map();
  for (const e of [...(td.hilo || []), ...(td.next || [])]) if (e && isNum(e.t) && e.t > now) m.set(e.t, e);
  return [...m.values()].sort((a, b) => a.t - b.t);
}

function tideChart(td, now) {
  const W = 720, H = 200, L = 28, R = 8, T = 22, B = 22;
  const curve = (td.curve || []).filter((p) => isNum(p.t) && isNum(p.ft));
  if (curve.length < 2) return '';
  // Nominally 6h back to 24h ahead, clamped to the span the prediction curve covers
  // (it starts at local midnight and runs 36h, so late in the day it ends before now+24h).
  const t0 = Math.max(now - 6 * 3600e3, curve[0].t), t1 = Math.min(now + 24 * 3600e3, curve[curve.length - 1].t);
  if (t1 - t0 < 3600e3) return '';
  const pts = curve.filter((p) => p.t >= t0 - 6e5 && p.t <= t1 + 6e5);
  if (pts.length < 2) return '';
  const obs = (td.observed || []).filter((o) => o.t >= t0 && o.t <= t1 && isNum(o.ft));
  const vals = pts.map((p) => p.ft).concat(obs.map((o) => o.ft));
  const y0 = Math.floor(Math.min(0, ...vals) - 0.5), y1 = Math.ceil(Math.max(...vals) + 1);
  const sx = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const sy = (v) => T + ((y1 - v) / (y1 - y0)) * (H - T - B);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.t).toFixed(1)},${sy(p.ft).toFixed(1)}`).join('');
  const area = `${path}L${sx(pts[pts.length - 1].t).toFixed(1)},${H - B}L${sx(pts[0].t).toFixed(1)},${H - B}Z`;
  let grid = '';
  const step = y1 - y0 > 10 ? 4 : 2;
  for (let v = Math.ceil(y0 / step) * step; v <= y1; v += step) grid += `<line x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}" class="grid"/><text x="${L - 6}" y="${sy(v) + 3}" text-anchor="end">${v}</text>`;
  const h0 = Math.ceil(t0 / 3600e3) * 3600e3;
  for (let t = h0; t <= t1; t += 3600e3) {
    const hh = pparts(t).hh;
    if (hh % 6 || sx(t) > W - R - 10) continue; // no half-clipped label at the right edge
    grid += `<line x1="${sx(t)}" x2="${sx(t)}" y1="${T}" y2="${H - B}" class="grid"/><text x="${sx(t)}" y="${H - 8}" text-anchor="middle">${hh === 0 ? `<tspan style="font-weight:600">${wd(t)}</tspan>` : hour(t)}</text>`;
  }
  const obsPath = obs.length > 1 ? `<path d="${obs.map((o, i) => `${i ? 'L' : 'M'}${sx(o.t).toFixed(1)},${sy(o.ft).toFixed(1)}`).join('')}" fill="none" stroke="var(--blue)" stroke-width="2.4"/>` : '';
  const hl = (td.hilo || []).filter((e) => e.t > t0 && e.t < t1).map((e) => {
    const x = sx(e.t), y = sy(e.ft), up = e.type === 'H';
    return `<circle cx="${x}" cy="${y}" r="3.5" fill="var(--accent)"/><text x="${x}" y="${up ? y - 9 : y + 15}" text-anchor="middle" style="fill:var(--ink);font-weight:600">${r1(e.ft)} ft · ${time(e.t)}</text>`;
  }).join('');
  const nowMark = now >= t0 && now <= t1 ? `<line x1="${sx(now)}" x2="${sx(now)}" y1="${T - 8}" y2="${H - B}" class="now"/><text x="${sx(now)}" y="${T - 11}" text-anchor="middle" style="fill:var(--warn);font-weight:600">now</text>` : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tide height chart, ${time(t0)} to ${esc(dayLabel(t1))} ${time(t1)}">
    ${grid}<path d="${area}" fill="var(--accent)" opacity=".13"/><path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2"/>
    ${obsPath}${nowMark}${hl}</svg>`;
}

function tidesCard(D, { now }) {
  const td = D('tides');
  if (!td) return null;
  const cur = tideAt(td, now);
  const next = nextTides(td, now).slice(0, 4);
  const lat = td.latest;
  return `
    <div class="row wrap between">
      <div><div class="label">Right now (predicted)</div><div class="big">${isNum(cur.ft) ? liveNum('tide', cur.ft, 1) : '–'}<small> ft ${cur.trend === 'rising' ? '↑ rising' : cur.trend === 'falling' ? '↓ falling' : ''}</small></div></div>
      ${lat ? `<div><div class="label">Measured (Seattle gauge)</div><div class="num"><b>${r1(lat.ft)} ft</b> <span class="small muted">${relEl(lat.t)}</span>
        ${isNum(lat.anomalyFt) ? `<div class="small ${Math.abs(lat.anomalyFt) >= 0.5 ? '' : 'muted'}">${lat.anomalyFt >= 0 ? '+' : ''}${r1(lat.anomalyFt)} ft vs predicted</div>` : ''}</div></div>` : ''}
      <div class="row wrap" style="gap:14px">${next.map((e) => `<div><div class="label">${e.type === 'H' ? 'High' : 'Low'}</div><b class="num">${time(e.t)}</b><div class="small muted num">${r1(e.ft)} ft · ${esc(dayLabel(e.t))}</div></div>`).join('')}</div>
    </div>
    <div style="margin-top:8px">${tideChart(td, now)}</div>
    <div class="small muted">Teal line: predicted tide at ${esc(td.station || 'Shilshole')} (shape from the Seattle reference station). Blue line: measured water level at the Seattle gauge. Heights in feet above MLLW.</div>`;
}

function bridgesCard(D) {
  const b = D('bridges');
  const h = D('bridge-history');
  if (!b) return null;
  const list = b.bridges || [];
  const main = list.slice(0, 2), rest = list.slice(2);
  const row = (x, big) => `<div class="bridge-row"><span class="bstat ${x.up ? 'up' : 'down'} ${big ? 'big' : ''}" ${liveAttr(`bridge-${x.id}`)}>${x.up ? 'UP' : 'DOWN'}</span>
    <div class="grow"><b>${esc(x.name)} Bridge</b><div class="small muted">${x.up ? 'Raised for boats; road closed' : 'Open to traffic'}${x.sinceKnown && isNum(x.since) ? ` · since ${time(x.since)} (${relEl(x.since)})` : ''}</div></div></div>`;
  const log = (b.log || []).slice(0, 6);
  const st = h && h.stats;
  return `${main.map((x) => row(x, true)).join('')}
    ${rest.length ? `<div class="small muted" style="margin-top:8px">${rest.map((x) => `${esc(x.name)}: <b style="color:${x.up ? 'var(--warn)' : 'var(--ok)'}">${x.up ? 'up' : 'down'}</b>`).join(' · ')}</div>` : ''}
    ${log.length ? `<div class="divider"></div><div class="label">Openings seen by this dashboard</div><ul class="list">${log.map((l) => `<li><div class="grow">${esc(l.bridge)}</div><div class="t">${time(l.upAt)}${isNum(l.minutes) ? ` · ${l.minutes} min` : ' · still up'}</div><div class="t">${relEl(l.upAt)}</div></li>`).join('')}</ul>` : ''}
    ${st ? `<div class="divider"></div><div class="label">History (city data, about a day behind)</div><div class="small">${['Ballard', 'Fremont'].filter((n) => st[n]).map((n) => `<b>${n}</b>: ${st[n].last24h} openings in the latest day, ${st[n].last7d} in 7 days${isNum(st[n].avgMin) ? `, avg ${r0(st[n].avgMin)} min` : ''}`).join('<br>')}</div>` : ''}
    <div class="tiny faint" style="margin-top:6px">Watching since ${full(b.observingSince)}</div>`;
}

function locksCard(D) {
  const l = D('lockages');
  const s = D('stoppages');
  if (!l && !s) return null;
  let html = '';
  if (l) {
    const t = l.today || {};
    html += `<div class="kv" style="margin-top:0">
      <div><span>Lockages today</span><b>${live('lockages', r0(t.total))}</b></div>
      <div><span>Into lake ↑</span><b>${r0(t.up)}</b></div>
      <div><span>To the Sound ↓</span><b>${r0(t.down)}</b></div>
      <div><span>Waiting now</span><b>${r0(l.queued)}</b></div>
      <div><span>Avg wait</span><b>${isNum(l.avgWaitMin) ? r0(l.avgWaitMin) + ' min' : '–'}</b></div>
      <div><span>Commercial</span><b>${r0(t.commercial)}</b></div></div>
      <div class="divider"></div><div class="label">Recent vessels (large chamber)</div>
      <ul class="list">${(l.recent || []).slice(0, 8).map((v) => `<li>
        <span title="${v.direction === 'up' ? 'Upbound into the lake' : 'Downbound to Puget Sound'}">${v.direction === 'up' ? '↑' : '↓'}</span>
        <div class="grow"><span class="${v.commercial ? 'title' : ''}">${esc(titleCase(v.name))}</span>${v.commercial ? ' ' + tagFor('accent', 'commercial') : ''}</div>
        <div class="t">${isNum(v.end) ? time(v.end) : isNum(v.start) ? 'locking' : 'waiting'}</div></li>`).join('')}</ul>`;
  }
  if (s) {
    const act = s.active || [], up = s.upcoming || [];
    html += `<div class="divider"></div>${act.length ? act.map((x) => `<div>${tagFor('danger', `Chamber ${x.chamber} closed`)} <span class="small">${esc(x.reason)}${isNum(x.end) ? ` · until ${full(x.end)}` : ''}</span></div>`).join('') : '<div class="small">✓ No lock closures reported.</div>'}
      ${up.length ? `<div class="small muted" style="margin-top:6px">Upcoming: ${up.slice(0, 2).map((x) => `chamber ${esc(x.chamber)} ${full(x.begin)} (${esc(x.reason)})`).join('; ')}</div>` : ''}`;
  }
  return html + warnings(l, s);
}
const titleCase = (s) => String(s ?? '').trim().toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(Nw|Ne|Sw|Se|Uw)\b/g, (m) => m.toUpperCase());

function lakeCard(D) {
  const k = D('lake');
  if (!k) return null;
  const hist = (k.history || []).map((h) => ({ x: h.t, y: h.ft }));
  return `<div class="row between"><div><div class="big">${isNum(k.ft) ? liveNum('lake', k.ft, 2) : '–'}<small> ft</small></div>
      <div class="small muted">Lake Washington Ship Canal, above the Locks · ${relEl(k.t)}</div></div></div>
    ${hist.length > 2 ? `<div class="label" style="margin-top:10px">Last 48 hours</div>${sparkline(hist, { stroke: 'var(--blue)' })}
      <div class="tiny faint row between"><span>${r1(Math.min(...hist.map((h) => h.y)))}–${r1(Math.max(...hist.map((h) => h.y)))} ft</span><span>USACE local datum</span></div>` : ''}
    ${isNum(k.outflowCfs) ? `<div class="small" style="margin-top:8px">Outflow through the Locks: <b>${r0(k.outflowCfs)} cfs</b> <span class="muted">(daily average for ${esc(md(k.outflowT))})</span></div>` : ''}
    <div class="small muted" style="margin-top:6px">The Corps holds Salmon Bay, Lake Union and Lake Washington between about 20 and 22 ft. It fills the lake in spring and draws it down in fall.</div>`;
}

function currentsCard(D, { now }) {
  const c = D('currents');
  if (!c) return null;
  const ev = (c.events || []).filter((e) => e.t > now - 3600e3).slice(0, 6);
  if (!ev.length) return empty('No current predictions.');
  return `<ul class="list">${ev.map((e) => `<li>
    ${tagFor(e.type === 'flood' ? 'accent' : e.type === 'ebb' ? 'warn' : '', e.type === 'slack' ? 'slack' : `max ${e.type}`)}
    <div class="grow num">${e.type === 'slack' ? '' : `<b>${r1(Math.abs(e.knots))} kt</b>`}</div>
    <div class="t">${esc(dayLabel(e.t))} ${time(e.t)}</div><div class="t">${relEl(e.t)}</div></li>`).join('')}</ul>
    <div class="small muted" style="margin-top:6px">Flood runs south into the Sound; ebb runs north. Useful for paddling and fishing off Shilshole.</div>`;
}

function salmonCard(D) {
  const s = D('salmon');
  if (!s) return null;
  const sp = s.species || [];
  return `${sp.length ? `<div class="salmon-grid">${sp.map((x) => `<div>
      <div class="label">${esc(x.name)}</div>
      <div class="num"><b style="font-size:20px">${isNum(x.total) ? x.total.toLocaleString() : '–'}</b></div>
      <div class="small muted">season total</div>
      <div class="small">${isNum(x.latestCount) ? `${x.latestCount.toLocaleString()} on ${esc(x.latestDate)}` : 'no recent count'}</div>
      ${(x.recent || []).length > 2 ? sparkline(x.recent.map((r, i) => ({ x: i, y: r.count })), { h: 26, w: 120, min: 0 }) : ''}
    </div>`).join('')}</div>` : empty('No fish counts posted for this season yet.')}
    <div class="small muted" style="margin-top:8px">${esc(String(s.year || ''))} fish-ladder counts from WDFW. Preliminary, posted a few days late. <a href="${href(s.source)}" target="_blank" rel="noopener">Source</a></div>`;
}

function csoCard(D) {
  const c = D('cso');
  if (!c) return null;
  const bad = (c.sites || []).filter((s) => s.status === 'overflowing' || s.status === 'recent');
  const total = (c.sites || []).length;
  return `${bad.length ? `<ul class="list">${bad.map((s) => `<li>${tagFor(s.status === 'overflowing' ? 'danger' : 'warn', s.status === 'overflowing' ? 'overflowing' : 'last 48h')}
      <div class="grow">${esc(s.name)} <span class="mono tiny faint">${esc(s.tag)}</span></div></li>`).join('')}</ul>
      <div class="small" style="margin-top:6px">Stay out of the water near these outfalls for 48 hours after an overflow.</div>`
    : `<div class="row"><span class="bstat down">Clear</span><div class="small">No recent overflows at any of the ${total} outfalls around Ballard, Salmon Bay and Shilshole.</div></div>`}
    <div class="tiny faint" style="margin-top:8px">King County and Seattle combined sewer overflows · ${relEl(c.t)}</div>`;
}

// ---------------------------------------------------------------- getting around

const ROUTE_ORDER = ['D Line', '40', '44', '17', '28'];
export const routeBadge = (r, small) => `<span class="rbadge ${r === 'D Line' ? 'd' : ''} ${small ? 'small' : ''}">${esc(r === 'D Line' ? 'D' : r)}</span>`;
export const etaSpan = (a, first) => `<span class="${first ? 'first' : ''} ${a.confidence === 'live' ? 'live' : a.confidence === 'scheduled' ? 'sched' : ''}" data-eta="${a.t}" title="${a.confidence === 'live' ? 'Real-time prediction' : a.confidence === 'low' ? 'Low-confidence prediction' : 'Scheduled (no real-time data)'}: ${time(a.t)}">${etaText(a.t)}</span>`;
export function etaText(t, now = Date.now()) {
  const m = (t - now) / 60000;
  if (m < 0.75) return 'now';
  return String(Math.round(m));
}

/** Arrivals that have not left yet. The payload is up to a TTL old (much older while OBA is failing). */
export const upcoming = (arrivals, now = Date.now()) => (arrivals || []).filter((a) => a && isNum(a.t) && a.t >= now - 30000);
/** Route groups with only their upcoming arrivals; groups with none left are dropped. */
export const liveGroups = (tr, now = Date.now()) => (tr.groups || []).map((g) => ({ ...g, arrivals: upcoming(g.arrivals, now) })).filter((g) => g.arrivals.length);
// Match on the destination (`dir`, e.g. 'to Ballard'), not the full headsign: KCM headsigns are
// '<destination> <via>', so the westbound 44 'Ballard Wallingford' would otherwise count as toward UW.
const TOWARD_DOWNTOWN = /downtown|uptown|fremont|university|u district|wallingford|\buw\b/i;

function transitCard(D, { ui, now }) {
  const tr = D('transit');
  const al = D('metro-alerts');
  if (!tr) return null;
  const filter = ui.busDir || 'all';
  let groups = liveGroups(tr, now);
  groups.sort((a, b) => (ROUTE_ORDER.indexOf(a.route) + 99) % 99 - (ROUTE_ORDER.indexOf(b.route) + 99) % 99 || String(a.headsign).localeCompare(b.headsign));
  if (filter === 'downtown') groups = groups.filter((g) => TOWARD_DOWNTOWN.test(g.dir || g.headsign || ''));
  const alerts = (al && al.alerts) || [];
  return `<div class="row between wrap" style="margin-bottom:8px">
      <span class="small muted">Minutes until arrival. <span style="color:var(--ok)">●</span> = live GPS; grey = scheduled.</span>
      ${seg('busDir', filter, [['all', 'All'], ['downtown', 'Toward downtown / UW']])}</div>
    <div class="board">${groups.map((g) => `<div class="route">${routeBadge(g.route)}
      <div class="grow" style="min-width:0"><div class="dest">${esc(g.dir || g.headsign)}</div><div class="stop">${esc(g.stopName)}${g.stopDir ? ` (${esc(g.stopDir)})` : ''}</div></div>
      <div class="arr">${g.arrivals.slice(0, 3).map((a, i) => etaSpan(a, i === 0)).join('<span class="unit">·</span>')}<span class="unit">min</span></div></div>`).join('') || empty((tr.groups || []).some((g) => (g.arrivals || []).length) && !liveGroups(tr, now).length ? 'These arrival times have all passed. Waiting for a fresh update.' : 'No buses in the next 45 minutes.')}</div>
    ${alerts.length || (tr.situations || []).length ? `<div class="divider"></div><div class="label">Service alerts on Ballard routes</div><ul class="list">
      ${alerts.map((a) => `<li><div>${(a.routes || []).map((r) => routeBadge(r, true)).join(' ')}</div><div class="grow"><div class="small title">${esc(a.header)}${badge('metro', a.id, now)}</div>${a.description ? `<div class="sub clamp2">${esc(a.description)}</div>` : ''}</div>
        <div class="t">${isNum(a.end) ? 'until ' + esc(dayLabel(a.end)) : ''}</div></li>`).join('')}
      ${(tr.situations || []).filter((s) => !alerts.some((a) => a.header === s.summary)).map((s) => `<li><div class="grow small">${esc(s.summary)}</div></li>`).join('')}</ul>`
      : '<div class="small muted" style="margin-top:8px">✓ No service alerts on D Line, 40, 44, 17 or 28.</div>'}
    ${warnings(tr, al)}`;
}

function trafficCard(D) {
  const t = D('traffic');
  if (!t) return null;
  if (!(t.sites || []).length) return empty('No SDOT travel times right now.');
  return t.sites.map((s) => `<div class="label" style="margin-top:4px">From ${esc(s.name)}</div>
    <div class="tt">${(s.links || []).map((l) => `<span>${esc(prettyLink(l.name))}</span><b>${isNum(l.minutes) ? live(`tt-${s.id}-${l.name}`, l.minutes + ' min') : 'n/a'}</b>`).join('')}</div>`).join('<div class="divider"></div>')
    + '<div class="small muted" style="margin-top:8px">Live SDOT arterial travel times.</div>';
}
const prettyLink = (n = '') => ({ 'DOWNTOWN': 'Downtown', 'AURORA BR': 'Aurora Bridge', 'I-5/DENNY': 'I-5 / Denny', 'LW QN ANN': 'Lower Queen Anne', 'LWR QN ANN': 'Lower Queen Anne', 'INTERBAY': 'Interbay', 'SEA CNTR': 'Seattle Center' }[n.trim()] || titleCase(n));

function camerasCard(D) {
  const c = D('cameras');
  if (!c) return null;
  if (!(c.cameras || []).length) return empty('No camera images right now.');
  return `<div class="cams">${c.cameras.map((cam) => `<figure class="cam ${cam.ok ? '' : 'off'}" data-cam="${esc(cam.url)}" data-label="${esc(cam.label)}" tabindex="0" role="button" aria-label="Enlarge camera: ${esc(cam.label)}">
      <img src="${camSrc(cam.url, cam.lastModified)}" alt="Traffic camera: ${esc(cam.label)}">
      <figcaption><span>${esc(cam.label)}</span><span class="faint nowrap">${cam.ok ? relEl(cam.lastModified) : 'offline'}</span></figcaption></figure>`).join('')}</div>`;
}

function incidentsCard(D) {
  const i = D('incidents');
  if (!i) return null;
  const list = i.incidents || [];
  if (!list.length) return `<div class="row"><span class="bstat down">Clear</span><div class="small">No SDOT-reported collisions, closures or roadwork in or near Ballard. ${plural(i.citywide || 0, 'incident')} citywide.</div></div>`;
  return `<ul class="list">${list.map((x) => `<li>${tagFor(/collision/i.test(x.type) ? 'danger' : 'warn', x.type)}
    <div class="grow"><div class="small">${esc(x.description)}</div><div class="sub">${distLabel(x.distKm)} from center${isNum(x.end) ? ` · until ${time(x.end)}` : ''}</div></div>
    <div class="t">${relEl(x.start)}</div></li>`).join('')}</ul>`;
}

function limeCard(D) {
  const l = D('lime');
  if (!l) return null;
  const n = l.near || {};
  return `<div class="row"><div class="big">${isNum(n.total) ? liveNum('lime', n.total) : '–'}</div><div class="small">Lime vehicles within a 10-minute walk (800 m) of Market &amp; Ballard Ave</div></div>
    <div class="kv"><div><span>Scooters</span><b>${r0(n.scooters)}</b></div><div><span>E-bikes</span><b>${r0(n.ebikes)}</b></div><div><span>In all of Ballard</span><b>${r0(l.inBbox)}</b></div></div>
    <div class="small muted" style="margin-top:8px">Turn on the <b>Scooters</b> map layer to see where they are. ${relEl(l.t)}</div>`;
}

// ---------------------------------------------------------------- safety

function fireCard(D, { ui, now }) {
  const f = D('fire911');
  if (!f) return null;
  // activeKnown: false when SFD's live page is down, so no call's active flag can be trusted (missing = known).
  const known = f.activeKnown !== false;
  let list = f.incidents || [];
  if (ui.fireActive) list = known ? list.filter((x) => x.active) : [];
  const status = !known ? 'Active status unavailable right now'
    : f.activeCount ? `<b style="color:var(--danger)">${plural(f.activeCount, 'active incident')}</b> nearby` : 'No active incidents nearby right now';
  return `<div class="row between wrap" style="margin-bottom:6px"><span class="small">${status} · ${plural((f.incidents || []).length, 'call')} in 24h within 1.2 mi</span>
    ${seg('fireActive', ui.fireActive || '', [['', 'Last 24h'], ['1', 'Active']])}</div>
    <div class="body scroll" style="padding:0">${list.length ? `<ul class="list">${list.slice(0, 40).map((x) => `<li>
      <div style="width:8px;padding-top:6px"><div style="width:8px;height:8px;border-radius:50%;background:${x.active ? 'var(--danger)' : 'var(--line)'}" ${x.active ? 'class="pulse-ring"' : ''}></div></div>
      <div class="grow"><div class="title">${esc(x.type)}${badge('fire', x.id, now)}</div><div class="sub">${esc(titleCase(x.address))}${x.units ? ` · <span class="mono">${esc(x.units)}</span>` : ''}${x.located === false ? ' · location pending' : ''}</div></div>
      <div class="t" style="text-align:right">${time(x.t)}<br>${relEl(x.t)}</div></li>`).join('')}</ul>` : empty(!ui.fireActive ? 'No calls in the last 24 hours.' : known ? 'No active incidents.' : 'Active status unavailable right now.')}</div>
    <div class="tiny faint" style="margin-top:6px">Seattle Fire Department dispatches (fire, medical, crashes). Newest calls come from the live 911 page; map locations arrive about 10 min later.${f.newest ? ` Newest ${rel(f.newest, now)}.` : ''}</div>${warnings(f)}`;
}

function outagesCard(D) {
  const o = D('outages');
  if (!o) return null;
  const b = o.ballard || [];
  const cw = o.citywide || {};
  return `${b.length ? `<ul class="list">${b.map((x) => `<li>${tagFor('danger', 'outage')}<div class="grow"><b>${plural(x.customers, 'customer')}</b><div class="sub">${esc(x.status)} · ${esc(x.cause)} · started ${relEl(x.start)}</div></div>
      <div class="t">${isNum(x.etr) ? 'ETR ' + time(x.etr) : ''}</div></li>`).join('')}</ul>`
    : `<div class="row"><span class="bstat down">On</span><div class="small">No Seattle City Light outages in Ballard.</div></div>`}
    <div class="small muted" style="margin-top:8px">Citywide: ${plural(cw.count || 0, 'outage')}, ${plural(cw.customers || 0, 'customer')} affected.</div>`;
}

function crimeCard(D) {
  const c = D('crime');
  if (!c) return null;
  const bc = c.byCategory || {};
  return `<div class="row wrap" style="gap:6px;margin-bottom:6px">${Object.entries(bc).map(([k, v]) => tagFor(k === 'PERSON' ? 'danger' : k === 'PROPERTY' ? 'warn' : '', `${titleCase(k)} ${v}`)).join('')}</div>
    ${(c.reports || []).length ? `<div class="body scroll" style="padding:0;max-height:320px"><ul class="list">${c.reports.slice(0, 30).map((r) => `<li><div class="grow"><div class="small title">${esc((r.offenses || []).join(', '))}</div><div class="sub">${esc(titleCase(r.block || 'Location withheld'))}</div></div><div class="t">${esc(dayLabel(r.t))}</div></li>`).join('')}</ul></div>` : empty('No reports in the last 7 days.')}
    <div class="tiny faint" style="margin-top:6px">SPD reported offenses, Ballard North &amp; South, last 7 days. Updated daily${isNum(c.lagHours) ? `, about ${Math.round(c.lagHours)}h behind` : ''}.</div>`;
}

function quakesCard(D) {
  const q = D('quakes');
  if (!q) return null;
  const magTag = (m) => `<span class="tag ${m >= 4 ? 'danger' : m >= 2.5 ? 'warn' : ''} mono">M${r1(m)}</span>`;
  const notable = q.notable || [];
  return `${notable.length ? `<div class="label">Felt-size (M2.5+) within 190 mi, 30 days</div><ul class="list">${notable.slice(0, 4).map((e) => `<li>${magTag(e.mag)}<div class="grow"><a href="${href(e.url)}" target="_blank" rel="noopener" class="small">${esc(e.place)}</a>${e.felt ? `<div class="sub">${e.felt} felt reports</div>` : ''}</div><div class="t">${relEl(e.t)}</div></li>`).join('')}</ul><div class="divider"></div>` : ''}
    <div class="label">Recent within 93 mi (M1+)</div>
    <ul class="list">${(q.recent || []).slice(0, 6).map((e) => `<li>${magTag(e.mag)}<div class="grow small">${esc(e.place)} <span class="faint">· ${distLabel(e.distKm)}</span></div><div class="t">${relEl(e.t)}</div></li>`).join('') || '<li class="empty">None this week.</li>'}</ul>`;
}

// ---------------------------------------------------------------- community

const PLACES = [
  { name: 'Ballard Farmers Market', where: 'Ballard Ave NW', hours: { 0: [9, 14] }, note: 'Sundays, year-round, rain or shine' },
  { name: 'Ballard Library', where: '5614 22nd Ave NW', hours: { 0: [10, 18], 1: [10, 18], 2: [10, 20], 3: [10, 20], 4: [10, 20], 5: [10, 18], 6: [10, 18] } },
  { name: 'National Nordic Museum', where: '2655 NW Market St', hours: { 0: [10, 17], 2: [10, 17], 3: [10, 17], 4: [10, 20], 5: [10, 17], 6: [10, 17] }, closedDates: nordicClosed },
];
function nordicClosed(p) {
  if ((p.m === 12 && (p.d === 24 || p.d === 25)) || (p.m === 1 && p.d === 1)) return true;
  if (p.m === 11 && p.wd === 4 && p.d >= 22 && p.d <= 28) return true; // Thanksgiving
  return false;
}
const hh = (h) => (h === 12 ? '12 pm' : h > 12 ? `${h - 12} pm` : `${h} am`);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function openCard(D, { now }) {
  const p = pparts(now);
  const hr = p.hh + p.mm / 60;
  return `<ul class="list">${PLACES.map((pl) => {
    const closedToday = pl.closedDates && pl.closedDates(p);
    const today = closedToday ? null : pl.hours[p.wd];
    let status, cls;
    if (today && hr >= today[0] && hr < today[1]) { status = `Open until ${hh(today[1])}`; cls = 'ok'; }
    else {
      let nextTxt = '';
      for (let i = today && hr < today[0] ? 0 : 1; i <= 7; i++) {
        const d = (p.wd + i) % 7;
        // Calendar date i days ahead, so holiday closures (e.g. Dec 24 then Dec 25) are skipped too.
        const n = new Date(Date.UTC(p.y, p.m - 1, p.d + i));
        const dp = { y: n.getUTCFullYear(), m: n.getUTCMonth() + 1, d: n.getUTCDate(), wd: n.getUTCDay() };
        if (pl.hours[d] && !(pl.closedDates && pl.closedDates(dp))) { nextTxt = `Opens ${i === 0 ? 'today' : i === 1 ? 'tomorrow' : DAYS[d]} ${hh(pl.hours[d][0])}`; break; }
      }
      status = nextTxt || 'Closed'; cls = '';
    }
    return `<li><div class="grow"><div class="title">${esc(pl.name)}</div><div class="sub">${esc(pl.where)}${pl.note ? ' · ' + esc(pl.note) : ''}</div></div>
      <div style="text-align:right">${tagFor(cls, cls === 'ok' ? 'Open' : 'Closed')}<div class="tiny muted" style="margin-top:3px">${esc(status)}</div></div></li>`;
  }).join('')}</ul>
  <div class="tiny faint" style="margin-top:6px">Regular hours from the official sites. Holidays may differ.</div>`;
}

function eventsCard(D, { ui, now }) {
  const e = D('events');
  if (!e) return null;
  const src = ui.evSrc || 'all';
  let list = (e.events || []).filter((x) => (isNum(x.end) ? x.end : x.start + 2 * 3600e3) >= now);
  if (src === 'visit') list = list.filter((x) => x.source === 'Visit Ballard');
  if (src === 'spl') list = list.filter((x) => x.source !== 'Visit Ballard');
  const days = new Map();
  for (const x of list.slice(0, 60)) {
    const k = dayKey(Math.max(x.start, now));
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(x);
  }
  return `<div class="row between wrap" style="margin-bottom:6px"><span class="small muted">${plural(list.length, 'upcoming event')}</span>${seg('evSrc', src, [['all', 'All'], ['visit', 'Visit Ballard'], ['spl', 'Library']])}</div>
    <div class="body scroll" style="padding:0;max-height:480px">${[...days.values()].map((items) => `<div class="label" style="margin-top:10px">${esc(dayLabel(Math.max(items[0].start, now)))}</div>
      <ul class="list">${items.map((x) => `<li><div class="t" style="width:62px">${x.allDay ? 'All day' : x.start < now ? 'On now' : time(x.start)}</div>
        <div class="grow"><a class="title" href="${href(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>${badge('events', x.id, now)}${x.canceled ? ' ' + tagFor('danger', 'canceled') : ''}
        <div class="sub">${esc([x.venue, x.cost].filter(Boolean).join(' · '))}</div></div>
        ${x.source !== 'Visit Ballard' ? tagFor('accent', 'Library') : ''}</li>`).join('')}</ul>`).join('') || empty('No upcoming events.')}</div>`;
}

function newsCard(D, { ui, now }) {
  const n = D('news');
  if (!n) return null;
  const mode = ui.newsMode || 'ballard';
  const items = (n.items || []).filter((x) => mode === 'all' || x.ballard);
  const down = (n.feeds || []).filter((f) => !f.ok);
  return `<div class="row between wrap" style="margin-bottom:6px"><span class="small muted">${plural(items.length, 'story', 'stories')}</span>${seg('newsMode', mode, [['ballard', 'Ballard'], ['all', 'All local']])}</div>
    <div class="body scroll" style="padding:0;max-height:480px"><ul class="list">${items.slice(0, 40).map((x) => `<li>
      <div class="grow"><a class="title" href="${href(x.link)}" target="_blank" rel="noopener">${esc(x.title)}</a>${badge('news', x.link, now)}
      ${x.summary ? `<div class="sub clamp2">${esc(x.summary)}</div>` : ''}</div>
      <div style="text-align:right"><span class="tag">${esc(x.source)}</span><div class="t" style="margin-top:3px">${relEl(x.t)}</div></div></li>`).join('') || '<li class="empty">Nothing yet.</li>'}</ul></div>
    ${down.length ? `<div class="tiny faint" style="margin-top:6px">Unavailable right now: ${down.map((f) => esc(f.name)).join(', ')}</div>` : ''}`;
}

function redditCard(D, { now }) {
  const r = D('reddit');
  if (!r) return null;
  return `<ul class="list">${(r.items || []).slice(0, 12).map((x) => `<li><div class="grow"><a class="small title" href="${href(x.link)}" target="_blank" rel="noopener">${esc(x.title)}</a>${badge('reddit', x.link, now)}</div>
    <div style="text-align:right"><span class="tag">${esc(x.sub)}</span><div class="t">${relEl(x.t)}</div></div></li>`).join('') || '<li class="empty">No posts.</li>'}</ul>${warnings(r)}`;
}

/**
 * A closure's hours for today's Pacific weekday, from its `days` map. The payload's todayHours is computed
 * when it was fetched (up to 6h earlier), so it names the wrong day after midnight.
 */
export const closureToday = (x, now = Date.now()) => (x.days ? x.days[['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][pparts(now).wd]] || null : x.todayHours || null);

function closuresCard(D, { now }) {
  const c = D('closures');
  if (!c) return null;
  const list = c.closures || [];
  if (!list.length) return empty('No community street closures in Ballard today.');
  const active = list.filter((x) => closureToday(x, now));
  const shown = active.length ? active : list;
  return `<ul class="list">${shown.map((x) => `<li>${tagFor('warn', x.type)}<div class="grow"><div class="small title">${esc(titleCase(x.street))}${x.from ? ` <span class="muted">${esc(titleCase(x.from))} to ${esc(titleCase(x.to || ''))}</span>` : ''}</div>
    <div class="sub">${esc(x.name || '')}</div></div><div class="t">${esc(closureToday(x, now) || 'not today')}</div></li>`).join('')}</ul>
    ${!active.length ? '<div class="tiny faint">Permits active this week, but none closes a street today.</div>' : ''}`;
}

function requestsCard(D) {
  const r = D('requests311');
  if (!r) return null;
  return `${(r.requests || []).length ? `<div class="body scroll" style="padding:0;max-height:340px"><ul class="list">${r.requests.slice(0, 25).map((x) => `<li><div class="grow"><div class="small title">${esc(x.type)}</div><div class="sub">${esc((x.address || '').replace(/, SEATTLE.*$/i, ''))}</div></div>
    <div style="text-align:right">${tagFor(/closed/i.test(x.status) ? 'ok' : '', x.status)}<div class="t">${relEl(x.t)}</div></div></li>`).join('')}</ul></div>` : empty('No recent 311 requests nearby.')}
    <div class="tiny faint" style="margin-top:6px">Find It, Fix It and 311 reports within 1.2 mi. Updated daily.</div>`;
}

function permitsCard(D) {
  const p = D('permits');
  if (!p) return null;
  if (!(p.permits || []).length) return empty('No building permits issued within 1.2 mi in the last 30 days.');
  return `<div class="body scroll" style="padding:0;max-height:340px"><ul class="list">${p.permits.slice(0, 20).map((x) => `<li><div class="grow">
    <a class="small title" href="${href(x.url)}" target="_blank" rel="noopener">${esc(titleCase(x.address))}</a>
    <div class="sub clamp2">${esc(x.description)}</div></div>
    <div style="text-align:right"><div class="t">${esc(md(x.issued))}</div>${isNum(x.cost) && x.cost > 0 ? `<div class="tiny muted">$${Math.round(x.cost).toLocaleString()}</div>` : ''}</div></li>`).join('')}</ul></div>`;
}

export const CARDS = {
  now: { deps: ['weather', 'stations', 'westpoint'], render: nowCard },
  hourly: { deps: ['weather'], render: hourlyCard },
  daily: { deps: ['weather'], render: dailyCard },
  nws: { deps: ['nws-forecast'], render: nwsCard },
  'water-wx': { deps: ['westpoint', 'marine'], render: waterWxCard },
  air: { deps: ['purpleair', 'airnow'], render: airCard },
  sun: { deps: ['sky'], render: sunCard, clock: true },
  radar: { deps: ['radar'], render: radarCard },
  aurora: { deps: ['kp'], render: auroraCard },
  afd: { deps: ['afd'], render: afdCard },
  tides: { deps: ['tides'], render: tidesCard, clock: true },
  bridges: { deps: ['bridges', 'bridge-history'], render: bridgesCard },
  locks: { deps: ['lockages', 'stoppages'], render: locksCard },
  lake: { deps: ['lake'], render: lakeCard },
  currents: { deps: ['currents'], render: currentsCard, clock: true },
  salmon: { deps: ['salmon'], render: salmonCard },
  cso: { deps: ['cso'], render: csoCard },
  transit: { deps: ['transit', 'metro-alerts'], render: (D, ctx) => seeded('metro', transitCard(D, ctx)) },
  traffic: { deps: ['traffic'], render: trafficCard },
  cameras: { deps: ['cameras'], render: camerasCard },
  incidents: { deps: ['incidents'], render: incidentsCard },
  lime: { deps: ['lime'], render: limeCard },
  fire: { deps: ['fire911'], render: (D, ctx) => seeded('fire', fireCard(D, ctx)) },
  outages: { deps: ['outages'], render: outagesCard },
  crime: { deps: ['crime'], render: crimeCard },
  quakes: { deps: ['quakes'], render: quakesCard },
  open: { deps: [], render: openCard, clock: true },
  events: { deps: ['events'], render: (D, ctx) => seeded('events', eventsCard(D, ctx)), clock: true },
  news: { deps: ['news'], render: (D, ctx) => seeded('news', newsCard(D, ctx)) },
  reddit: { deps: ['reddit'], render: (D, ctx) => seeded('reddit', redditCard(D, ctx)) },
  closures: { deps: ['closures'], render: closuresCard },
  requests311: { deps: ['requests311'], render: requestsCard },
  permits: { deps: ['permits'], render: permitsCard },
};
