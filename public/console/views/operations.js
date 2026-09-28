// Operations: the live feeds as an operations board: drawbridges, transit, 911, the Locks, marine and weather
// conditions, tides, air quality, travel times, aircraft, and the live traffic-camera images.
import { esc, $, num, time, dateTime, ago, isNum, chart, axis, themeColors, table } from '../ui.js';
import { live, liveMany, subscribe } from '../api.js';

export async function mount(root, { setCrumb }) {
  setCrumb('live feeds');
  root.innerHTML = `<div class="page">
    <div class="page-head"><div><h2>Operations</h2><p>Live conditions from the platform's real-time feeds, refreshed continuously. Each panel shows the source and the age of its data.</p></div></div>
    <div class="grid cols-4" id="kpi"></div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="panel"><div class="panel-h"><h3>Drawbridges</h3><span class="sub" id="br-s"></span></div><div id="br"></div></div>
      <div class="panel"><div class="panel-h"><h3>Transit arrivals</h3><span class="sub" id="tr-s">OneBusAway · King County Metro</span></div><div id="tr"></div></div>
      <div class="panel"><div class="panel-h"><h3>Fire &amp; medical 911, last 24 hours</h3><span class="sub" id="f-s">Seattle Fire Department</span></div><div id="fire" style="max-height:360px;overflow:auto"></div></div>
      <div class="panel"><div class="panel-h"><h3>Ballard Locks</h3><span class="sub" id="lk-s">US Army Corps of Engineers</span></div><div id="lk" style="max-height:360px;overflow:auto"></div></div>
      <div class="panel"><div class="panel-h"><h3>Weather, next 24 hours</h3><span class="sub" id="wx-s">Open-Meteo · NWS</span></div><div class="panel-b"><div id="wx" class="chart"></div></div></div>
      <div class="panel"><div class="panel-h"><h3>Tide, Shilshole Bay</h3><span class="sub" id="td-s">NOAA CO-OPS 9447130</span></div><div class="panel-b"><div id="td" class="chart"></div></div></div>
      <div class="panel"><div class="panel-h"><h3>Travel times</h3><span class="sub">SDOT</span></div><div id="tt"></div></div>
      <div class="panel"><div class="panel-h"><h3>Aircraft within 8 nm</h3><span class="sub" id="ac-s">ADS-B</span></div><div id="ac" style="max-height:360px;overflow:auto"></div></div>
    </div>
    <div class="panel" style="margin-top:14px"><div class="panel-h"><h3>Traffic cameras</h3><span class="sub">SDOT · live still images</span></div>
      <div class="panel-b"><div id="cams" class="grid" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))"></div></div></div>
  </div>`;
  const charts = [];
  async function render() {
    const ids = ['bridges', 'transit', 'fire911', 'lockages', 'weather', 'tides', 'traffic', 'aircraft', 'purpleair', 'westpoint', 'cameras'];
    const LV = await liveMany(ids).catch(() => ({}));
    const [br, tr, fire, lk, wx, td, tt, ac, aq, wp, cams] = ids.map((id) => LV[id] || { data: null });
    const c = themeColors();
    // KPIs
    const w = wx.data?.current;
    const k = [
      ['Temperature', w ? `${Math.round(w.tempF)}<small>°F</small>` : '–', w ? `feels ${Math.round(w.feelsF)}° · wind ${Math.round(w.windMph)} mph` : ''],
      ['Tide now', td.data?.latest ? `${td.data.latest.ft.toFixed(1)}<small>ft</small>` : '–', td.data?.latest ? `${td.data.latest.anomalyFt >= 0 ? '+' : '−'}${Math.abs(td.data.latest.anomalyFt).toFixed(2)} ft vs predicted` : ''],
      ['Air quality (AQI)', num(aq.data?.medianAqi ?? null), `${num(aq.data?.count ?? null)} PurpleAir sensors, median`],
      ['West Point wind', wp.data ? `${Math.round(wp.data.windKt)}<small>kt</small>` : '–', wp.data ? `gusts ${Math.round(wp.data.gustKt ?? 0)} kt · ${Math.round(wp.data.pressureHpa)} hPa` : ''],
    ];
    $('#kpi', root).innerHTML = k.map(([a, b, d]) => `<div class="panel kpi"><div class="k">${esc(a)}</div><div class="v">${b}</div><div class="d">${esc(d)}</div></div>`).join('');
    // bridges
    const bs = br.data?.bridges || [];
    const logs = br.data?.log || [];
    $('#br-s', root).textContent = `SDOT · ${ago(br.fetchedAt)}`;
    $('#br', root).innerHTML = `<table class="tbl"><thead><tr><th>Bridge</th><th>Status</th><th>Since</th><th class="num">Openings today</th><th class="num">Last opening</th></tr></thead><tbody>${bs.map((b) => {
      const today = logs.filter((l) => l.bridge === b.name && new Date(l.upAt).toDateString() === new Date().toDateString());
      const last = logs.find((l) => l.bridge === b.name);
      return `<tr><td>${esc(b.name)}</td><td>${b.up ? '<span class="badge alert">Open to vessels</span>' : '<span class="badge high">Down</span>'}</td><td>${b.sinceKnown ? esc(time(b.since)) : '–'}</td>
        <td class="num">${today.length}</td><td class="num">${last ? `${esc(time(last.upAt))} · ${num(last.minutes, 0)} min` : '–'}</td></tr>`;
    }).join('')}</tbody></table>`;
    // transit
    const gs = tr.data?.groups || [];
    $('#tr', root).innerHTML = `<table class="tbl"><thead><tr><th>Route</th><th>Destination</th><th>Stop</th><th class="num">Next arrivals (min)</th></tr></thead><tbody>${gs.map((g) =>
      `<tr><td><b>${esc(g.route)}</b></td><td>${esc(g.headsign)}</td><td class="muted">${esc(g.stopName)}</td><td class="num">${(g.arrivals || []).slice(0, 3).map((a) => `${Math.max(0, Math.round(a.min))}${a.predicted ? '' : '*'}`).join(' · ')}</td></tr>`).join('')}</tbody></table>
      <div class="panel-b faint" style="font-size:11.5px">* scheduled (no real-time prediction)</div>`;
    // fire
    const inc = (fire.data?.incidents || []).filter((x) => Date.now() - x.t < 86400e3);
    $('#f-s', root).textContent = `Seattle Fire Department · ${ago(fire.fetchedAt)}`;
    table($('#fire', root), { columns: [{ key: 't', label: 'Time', fmt: (v) => esc(time(v)), width: '90px' }, { key: 'type', label: 'Type' }, { key: 'address', label: 'Location' },
      { key: 'units', label: 'Units', clip: true }, { key: 'active', label: '', fmt: (v) => (v ? '<span class="badge alert">active</span>' : ''), sortable: false }], rows: inc, sort: 't', exportName: 'fire-911-24h' });
    // locks
    const L = lk.data;
    $('#lk', root).innerHTML = L ? `<div class="panel-b statline"><span><b>${num(L.today?.total)}</b> lockages today</span><span><b>${num(L.today?.up)}</b> up</span><span><b>${num(L.today?.down)}</b> down</span>
      <span><b>${num(L.today?.commercial)}</b> commercial</span><span><b>${num(L.queued)}</b> queued</span></div>
      <table class="tbl"><thead><tr><th>Vessel</th><th>Direction</th><th>Arrived</th><th>Type</th></tr></thead><tbody>${(L.recent || []).slice(0, 20).map((v) =>
        `<tr><td>${esc(v.name)}</td><td>${v.direction === 'up' ? 'Up (to the lake)' : 'Down (to the Sound)'}</td><td>${esc(time(v.arrival))}</td><td>${v.commercial ? 'Commercial' : 'Recreational'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No data</div>';
    // weather chart
    const hr = wx.data?.hourly || [];
    charts.push(chart($('#wx', root), { color: [c.warn, c.accent], legend: { data: ['Temperature °F', 'Chance of rain %'] },
      xAxis: axis({ type: 'time' }), yAxis: [axis({ type: 'value', scale: true }), axis({ type: 'value', max: 100, position: 'right', splitLine: { show: false } })],
      series: [{ name: 'Temperature °F', type: 'line', showSymbol: false, data: hr.map((h) => [h.t, h.tempF]) },
        { name: 'Chance of rain %', type: 'bar', yAxisIndex: 1, barWidth: '60%', itemStyle: { opacity: 0.5 }, data: hr.map((h) => [h.t, h.pop]) }] }));
    // tide chart
    const T = td.data;
    if (T) charts.push(chart($('#td', root), { color: [c.accent, c.ok], legend: { data: ['Predicted', 'Observed'] }, xAxis: axis({ type: 'time' }), yAxis: axis({ type: 'value', name: 'ft MLLW', nameTextStyle: { color: c.muted } }),
      series: [{ name: 'Predicted', type: 'line', showSymbol: false, data: (T.curve || []).map((p) => [p.t, p.ft]), lineStyle: { width: 1.5 },
        markLine: { symbol: 'none', lineStyle: { color: c.muted, type: 'dashed' }, data: [{ xAxis: Date.now() }], label: { formatter: 'now', color: c.muted } } },
      { name: 'Observed', type: 'line', showSymbol: false, data: (T.observed || []).map((p) => [p.t, p.ft]), lineStyle: { width: 2 } }] }));
    // travel times
    $('#tt', root).innerHTML = `<table class="tbl"><thead><tr><th>From</th><th>To</th><th class="num">Minutes</th></tr></thead><tbody>${(tt.data?.sites || []).flatMap((s) =>
      s.links.map((l) => `<tr><td>${esc(s.name)}</td><td>${esc(l.name)}</td><td class="num">${num(l.minutes)}</td></tr>`)).join('')}</tbody></table>`;
    // aircraft
    const air = (ac.data?.aircraft || []).filter((a) => !a.onGround);
    $('#ac-s', root).textContent = `ADS-B (${esc(ac.data?.provider || '')}) · ${ago(ac.fetchedAt)}`;
    table($('#ac', root), { columns: [{ key: 'callsign', label: 'Flight', fmt: (v, r) => esc(v || r.reg || r.hex) }, { key: 'type', label: 'Type' }, { key: 'operator', label: 'Operator' },
      { key: 'altFt', label: 'Altitude ft', num: true, fmt: (v) => num(v) }, { key: 'gsKt', label: 'Speed kt', num: true, fmt: (v) => num(v) }, { key: 'distKm', label: 'Distance mi', num: true, fmt: (v) => num(isNum(v) ? v * 0.621 : null, 1) }],
      rows: air, sort: 'distKm', dir: 1, exportName: 'aircraft' });
    // cameras (real images)
    $('#cams', root).innerHTML = (cams.data?.cameras || []).filter((x) => x.ok).map((x) => `<figure style="margin:0"><img src="/img?u=${encodeURIComponent(x.url)}&t=${x.lastModified}" alt="${esc(x.label)}" loading="lazy" style="width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;border:1px solid var(--line);background:#000">
      <figcaption style="display:flex;justify-content:space-between;font-size:12px;margin-top:4px"><span>${esc(x.label)}</span><span class="muted">${esc(ago(x.lastModified))}</span></figcaption></figure>`).join('');
  }
  await render();
  const timer = setInterval(() => { charts.splice(0).forEach((ch) => ch.dispose()); render(); }, 60_000);
  const unsub = subscribe(() => {});
  return { unmount() { clearInterval(timer); unsub(); charts.forEach((ch) => ch.dispose()); } };
}
