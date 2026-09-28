// Overview: the 3D operational map with live and analytic layers, plus the situation panel (key indicators vs
// expected, active signals from the discovery engines, and the live activity log).
import { esc, num, ago, time, confBadge, typeBadge, $, isNum } from '../ui.js';
import { obs, live, liveMany, subscribe } from '../api.js';
import { createMap, popupHTML, AERIAL_YEARS } from '../map3d.js';
import { showInsight } from './insight-detail.js';

const LAYERS = [
  { group: 'Live', items: [['incidents', 'Fire & medical 911 (24 h)', '#ff5a4f', true], ['transit', 'Buses (live)', '#0f7fbf', true],
    ['aircraft', 'Aircraft (3D, live)', '#9ec9ff', true], ['bridges', 'Drawbridges', '#2fbf71', true], ['radar', 'Weather radar (NEXRAD)', '#6fd36f', false],
    ['cameras', 'Traffic cameras', '#e6edf3', false]] },
  { group: 'Analytics', items: [['hotspots', 'Emerging hotspots', '#f25555', true], ['density', 'Incident density (90 days)', '#fbb021', false],
    ['development', 'Development pipeline', '#a78bfa', false]] },
  { group: 'Scene', items: [['buildings', '3D buildings', '#d7dce2', true], ['terrain', 'Terrain', '#8b7d6b', true]] },
];
const DENSITY_KINDS = [['police.disturbance', 'Police: disturbances'], ['police.theft', 'Police: thefts'], ['crime.car_prowl', 'Car prowls'],
  ['crime.burglary', 'Burglaries'], ['311.encampment', 'Encampment reports'], ['311.dumping', 'Illegal dumping'], ['fire.medical', 'Medical 911'],
  ['code.complaints', 'Code complaints'], ['dev.building_permits', 'Building permits']];

export async function mount(root, { args = [], setCrumb }) {
  root.innerHTML = `<div class="ov">
    <div class="ov-map"><div class="map" id="map"></div>
      <div class="map-ui map-layers" id="layers"></div>
      <div class="map-ui map-hud" id="hud"></div>
    </div>
    <aside class="ov-side">
      <div class="sec"><h3>Situation <span class="right muted" id="sit-t"></span></h3><div class="kpis" id="kpis"></div></div>
      <div class="sec"><h3>Active signals <span class="right"><a href="#/insights">All insights</a></span></h3><div class="card-list" id="signals"></div></div>
      <div class="sec"><h3>Live activity <span class="right muted" id="act-n"></span></h3><ul class="feed" id="feed"></ul></div>
    </aside></div>`;
  setCrumb('Greater Ballard · live');
  const popup = new window.maplibregl.Popup({ closeButton: true, maxWidth: '340px' });
  const M = createMap($('#map', root), {
    onPick: (p) => {
      if (p.type === 'hotspots') { obs('insights.json').then((j) => { const ins = j.insights.find((i) => i.id === p.data.id); if (ins) showInsight(ins); }); return; }
      const ll = p.lngLat || (p.data.lon != null ? { lng: p.data.lon, lat: p.data.lat } : null);
      if (ll) popup.setLngLat(ll).setHTML(popupHTML(p)).addTo(M.map);
    },
  });

  // ---------------------------------------------------------------- layer panel
  const on = {};
  $('#layers', root).innerHTML = LAYERS.map((g) => `<div class="grp"><div class="gt">${esc(g.group)}</div>${g.items.map(([id, label, color, def]) => {
    on[id] = def;
    return `<label><input type="checkbox" data-layer="${id}" ${def ? 'checked' : ''}><span class="sw" style="background:${color}"></span>${esc(label)}<span class="n" data-n="${id}"></span></label>`;
  }).join('')}${g.group === 'Analytics' ? `<select class="field" id="dens-kind" style="width:100%;margin-top:6px">${DENSITY_KINDS.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>` : ''}</div>`).join('')
    + `<div class="grp"><div class="gt">Aerial imagery</div><select class="field" id="year" style="width:100%">${AERIAL_YEARS.map((y) => `<option value="${y}">${y}${y === 2025 ? ' (latest)' : ''}</option>`).join('')}</select>
       <div class="seg" style="margin-top:8px;width:100%"><button data-view="3d" aria-pressed="true" style="flex:1">3D</button><button data-view="2d" aria-pressed="false" style="flex:1">2D</button></div></div>`;
  $('#layers', root).addEventListener('change', (e) => {
    const cb = e.target.closest('[data-layer]');
    if (cb) { on[cb.dataset.layer] = cb.checked; M.setVisible(cb.dataset.layer, cb.checked); }
    if (e.target.id === 'year') M.setYear(e.target.value);
    if (e.target.id === 'dens-kind') loadDensity();
  });
  $('#layers', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    for (const x of root.querySelectorAll('[data-view]')) x.setAttribute('aria-pressed', String(x === b));
    M.setView(b.dataset.view);
  });
  M.ready.then(() => {
    for (const [id, v] of Object.entries(on)) M.setVisible(id, v);
    root.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
    const at = (args[0] || '').match(/^@(-?[\d.]+),(-?[\d.]+)$/);
    if (at) {
      M.flyTo(+at[1], +at[2], 18);
      new window.maplibregl.Marker({ color: '#3b9eff' }).setLngLat([+at[1], +at[2]]).addTo(M.map);
    }
  });
  const setN = (id, n) => { const el = root.querySelector(`[data-n="${id}"]`); if (el) el.textContent = n == null ? '' : num(n); };

  // ---------------------------------------------------------------- HUD: time and the real sun driving the lighting
  const hud = () => {
    const s = M.sun();
    const dir = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(s.azimuth / 45) % 8];
    $('#hud', root).innerHTML = `<div class="hud-chip"><span class="dot ok"></span>Live · ${esc(time(Date.now()))}</div>
      <div class="hud-chip" title="Scene lighting follows the actual solar position over Ballard">Sun ${s.elevation >= 0 ? `${s.elevation.toFixed(0)}° above horizon, ${dir}` : `below horizon (${s.elevation.toFixed(0)}°)`}</div>`;
  };
  hud();
  const hudTimer = setInterval(hud, 30_000);

  // ---------------------------------------------------------------- live layers
  async function loadLive() {
    const L = await liveMany(['fire911', 'vehicles', 'buses', 'bridges', 'cameras', 'aircraft', 'purpleair', 'weather']).catch(() => ({}));
    const [fire, veh, br, cams, ac] = [L.fire911, L.vehicles, L.bridges, L.cameras, L.aircraft];
    if (L.buses && L.buses.data) M.setBuses(L.buses.data);
    const now = Date.now();
    const inc = (fire?.data?.incidents || []).filter((x) => isNum(x.lat) && now - x.t < 24 * 3600e3);
    const cat = (t) => (/aid|medic|triaged|low acuity/i.test(t) ? 'medical' : /fire|smoke|rubbish|brush/i.test(t) && !/alarm/i.test(t) ? 'fire' : /motor vehicle|mvi|collision/i.test(t) ? 'collision' : 'other');
    M.setData('incidents', { type: 'FeatureCollection', features: inc.map((x) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [x.lon, x.lat] },
      properties: { type: x.type, address: x.address, t: x.t, active: !!x.active, cat: cat(x.type), age_h: (now - x.t) / 3600e3 } })) });
    setN('incidents', inc.length);
    const vs = (veh?.data?.vehicles || []).filter((v) => isNum(v.lat));
    M.setData('transit', { type: 'FeatureCollection', features: vs.map((v) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
      properties: { route: v.route, headsign: v.headsign, delay: isNum(v.deviationSec) ? (v.deviationSec > 60 ? `${Math.round(v.deviationSec / 60)} min late` : v.deviationSec < -60 ? `${Math.round(-v.deviationSec / 60)} min early` : 'on time') : null } })) });
    setN('transit', (L.buses && L.buses.data && L.buses.data.vehicles || vs).length);
    const bs = br?.data?.bridges || [];
    M.setData('bridges', { type: 'FeatureCollection', features: bs.map((b) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [b.lon, b.lat] }, properties: { name: b.name, up: !!b.up, since: b.since } })) });
    setN('bridges', bs.filter((b) => b.up).length || null);
    const cs = (cams?.data?.cameras || []).filter((c) => c.ok);
    M.setData('cameras', { type: 'FeatureCollection', features: cs.map((c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
      properties: { label: c.label, lastModified: c.lastModified, img: `/img?u=${encodeURIComponent(c.url)}&t=${c.lastModified}` } })) });
    setN('cameras', cs.length);
    const air = (ac?.data?.aircraft || []).filter((a) => !a.onGround && isNum(a.lat)).map((a) => ({ ...a, altM: (a.altFt || 0) * 0.3048 }));
    M.setAircraft(air);
    setN('aircraft', air.length);
    return { fire, br, ac, inc };
  }

  // ---------------------------------------------------------------- analytic layers
  async function loadDensity() {
    const kind = $('#dens-kind', root).value;
    const g = await obs('density.geojson').catch(() => ({ features: [] }));
    const fs = g.features.filter((f) => f.properties.kind === kind);
    M.setData('density', { type: 'FeatureCollection', features: fs });
    setN('density', fs.reduce((a, f) => a + f.properties.n, 0));
  }
  async function loadAnalytics() {
    const [hot, places] = await Promise.all([obs('hotspots.geojson').catch(() => null), obs('places.json').catch(() => null)]);
    if (hot) { M.setData('hotspots', hot); setN('hotspots', hot.features.length); }
    if (places && places.pipeline) {
      const p = places.pipeline;
      const f = [];
      const add = (rows, cols, stage, label) => {
        for (const r of rows || []) {
          const o = Object.fromEntries(cols.map((c, i) => [c, r[i]]));
          if (isNum(o.lat) && isNum(o.lon)) f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [o.lon, o.lat] },
            properties: { address: o.address, type: o.type, units: o.units_added || 0, stage, stageLabel: label, description: o.description } });
        }
      };
      add(p.in_review, p.in_review_cols, 'review', 'Land use review');
      add(p.issued_12m, p.issued_cols, 'issued', 'Permit issued (12 months)');
      M.setData('development', { type: 'FeatureCollection', features: f });
      setN('development', f.length);
    }
    loadDensity();
  }

  // ---------------------------------------------------------------- situation panel
  async function situation(liveData) {
    const [S, ins, aq, wx] = await Promise.all([obs('series.json').catch(() => null), obs('insights.json').catch(() => null),
      live('purpleair').catch(() => null), live('weather').catch(() => null)]);
    const k = [];
    const typicalDaily = (name) => {
      if (!S || !S.values[name]) return null;
      const v = S.values[name].slice(-91).filter((x) => x != null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const inc24 = liveData.inc.length;
    const exp = typicalDaily('fire.all');
    k.push({ k: 'Fire & medical 911, 24 h', v: num(inc24), d: exp ? delta(inc24, exp) : '' });
    const bl = liveData.br?.data?.log || [];
    const today = new Date().toDateString();
    const opens = bl.filter((l) => l.bridge === 'Ballard' && new Date(l.upAt).toDateString() === today).length;
    const expB = typicalDaily('bridge.ballard_openings');
    k.push({ k: 'Ballard Bridge openings today', v: num(opens), d: expB ? `<span class="muted">typical ${num(expB, 1)}/day</span>` : '' });
    const air = liveData.ac?.data;
    k.push({ k: 'Aircraft within 20 nm', v: num(air?.airborne ?? null), d: air?.nearest ? `<span class="muted">nearest ${esc(air.nearest.callsign || air.nearest.hex)}</span>` : '' });
    k.push({ k: 'Air quality (PurpleAir AQI)', v: num(aq?.data?.medianAqi ?? null), d: `<span class="muted">${num(aq?.data?.count ?? null)} sensors</span>` });
    const t = wx?.data?.current;
    k.push({ k: 'Temperature', v: t ? `${Math.round(t.tempF)}<small>°F</small>` : '–', d: t ? `<span class="muted">wind ${Math.round(t.windMph)} mph</span>` : '' });
    const hs = ins ? ins.insights.filter((i) => i.type === 'hotspot').length : null;
    k.push({ k: 'Active emerging hotspots', v: num(hs), d: '<span class="muted">space-time scan, p ≤ 0.05</span>' });
    $('#kpis', root).innerHTML = k.map((x) => `<div class="kpi"><div class="k">${esc(x.k)}</div><div class="v">${x.v}</div><div class="d">${x.d || '&nbsp;'}</div></div>`).join('');
    $('#sit-t', root).textContent = time(Date.now());
    if (ins) {
      const sig = ins.insights.filter((i) => ['hotspot', 'anomaly', 'change'].includes(i.type)).slice(0, 8);
      $('#signals', root).innerHTML = sig.map((i) => `<div class="ins" data-id="${esc(i.id)}"><div class="h">${typeBadge(i.type)} ${confBadge(i.confidence)}</div>
        <div class="tt">${esc(i.title)}</div><div class="st">${esc(i.statement)}</div></div>`).join('') || '<div class="muted">No active signals.</div>';
      $('#signals', root).onclick = (e) => { const c = e.target.closest('[data-id]'); if (c) showInsight(ins.insights.find((i) => i.id === c.dataset.id)); };
    }
  }
  function delta(v, e) {
    const p = (100 * (v - e)) / e;
    const cls = Math.abs(p) < 10 ? 'flat' : p > 0 ? 'up' : 'down';
    return `<span class="delta ${cls}">${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(0)}%</span><span class="muted">vs ${num(e, 1)} typical</span>`;
  }

  async function feed() {
    const r = await fetch('/api/activity?limit=40').then((x) => x.json()).catch(() => ({ items: [] }));
    const items = r.items || [];
    $('#act-n', root).textContent = `${items.length} recent`;
    $('#feed', root).innerHTML = items.slice(0, 40).map((it) => `<li class="sev-${esc(it.severity)}" data-lat="${it.lat ?? ''}" data-lon="${it.lon ?? ''}">
      <span class="t">${esc(time(it.t))}</span><div><div class="ti">${esc(it.title)}</div>${it.detail ? `<div class="de">${esc(it.detail)}</div>` : ''}</div></li>`).join('');
  }
  $('#feed', root).addEventListener('click', (e) => {
    const li = e.target.closest('li[data-lat]');
    if (li && li.dataset.lat) M.flyTo(+li.dataset.lon, +li.dataset.lat, 17);
  });

  const liveData = await loadLive();
  loadAnalytics();
  situation(liveData);
  feed();
  const timers = [setInterval(async () => { const d = await loadLive(); situation(d); }, 20_000), setInterval(feed, 30_000)];
  const unsub = subscribe((ev, data) => { if (ev === 'activity') feed(); if (ev === 'source' && data && ['aircraft', 'vehicles', 'fire911', 'bridges'].includes(data.id)) loadLive(); });
  const onTheme = () => {};
  window.addEventListener('bo:theme', onTheme);
  return { unmount() { timers.forEach(clearInterval); clearInterval(hudTimer); unsub(); window.removeEventListener('bo:theme', onTheme); popup.remove(); M.destroy(); } };
}
