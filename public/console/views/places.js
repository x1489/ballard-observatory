// Places: address intelligence. Search any Ballard address to see every agency's records for it, joined; plus the
// neighborhood portfolios (development pipeline, new businesses, persistent problem locations, restaurant inspections).
import { esc, $, table, num, date, icon, isNum } from '../ui.js';
import { obs } from '../api.js';

const TABS = [['search', 'Address search'], ['pipeline', 'Development pipeline'], ['openings', 'New businesses'], ['nuisance', 'Persistent & emerging problems'], ['restaurants', 'Restaurant inspections']];

async function sha1hex2(s) {
  const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 1).map((x) => x.toString(16).padStart(2, '0')).join('');
}
export function normAddr(a) {
  return String(a || '').toUpperCase().replace(/\s+(#|UNIT|STE|SUITE|APT|BLDG|FL|SPC|RM)\s*[A-Z0-9-]*\s*$/, '').replace(/\bNORTHWEST\b/g, 'NW')
    .replace(/\bAVENUE\b/g, 'AVE').replace(/\bSTREET\b/g, 'ST').replace(/\bPLACE\b/g, 'PL').replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

export async function mount(root, { args, setCrumb }) {
  let tab = TABS.some(([k]) => k === args[0]) ? args[0] : 'search';
  const query = tab === 'search' ? (args[0] === 'search' ? args.slice(1) : args).join(' ') : '';
  root.innerHTML = `<div class="page">
    <div class="page-head"><div><h2>Places</h2><p>Address-level intelligence joined across agencies (SDCI permits and complaints, business and liquor licensing, King County food safety, short-term rental licensing) with nearby incident volumes. Coordinates and records come from the public sources listed in Datasets.</p></div></div>
    <div class="seg" id="tabs" style="margin-bottom:14px">${TABS.map(([k, l]) => `<button data-t="${k}" aria-pressed="${k === tab}">${esc(l)}</button>`).join('')}</div>
    <div id="body"></div></div>`;
  $('#tabs', root).addEventListener('click', (e) => { const b = e.target.closest('[data-t]'); if (b) location.hash = `#/places/${b.dataset.t}`; });
  const body = $('#body', root);
  const P = await obs('places.json');
  let cleanup = null;
  if (tab === 'search') cleanup = await searchView(body, query, setCrumb);
  if (tab === 'pipeline') pipelineView(body, P.pipeline, setCrumb);
  if (tab === 'openings') openingsView(body, P.openings, setCrumb);
  if (tab === 'nuisance') nuisanceView(body, P.nuisance, setCrumb);
  if (tab === 'restaurants') restaurantsView(body, P.restaurants, setCrumb);
  return { unmount() { if (cleanup) cleanup(); } };
}

// ------------------------------------------------------------ address search and dossier
async function searchView(el, query, setCrumb) {
  el.innerHTML = `<div class="grid" style="grid-template-columns:380px 1fr;align-items:start">
    <div class="panel"><div class="toolbar"><input class="field" id="addr-q" placeholder="e.g. 5400 Ballard Ave NW" value="${esc(query)}" style="flex:1"></div>
      <div id="results" style="max-height:70vh;overflow:auto"></div></div>
    <div id="dossier"><div class="panel"><div class="empty">Search an address, or pick one from the list, to see every public record about it.</div></div></div></div>`;
  const idx = await obs('place_index.json');
  const rows = idx.rows.map((r) => Object.fromEntries(idx.cols.map((c, i) => [c, r[i]])));
  const list = $('#results', el);
  const render = (q) => {
    const nq = normAddr(q);
    const hits = (nq ? rows.filter((r) => r.addr_key.includes(nq)) : rows).slice(0, 80);
    list.innerHTML = hits.map((r) => `<div class="ins" style="border-radius:0;border-width:0 0 1px 0" data-k="${esc(r.addr_key)}">
      <div class="tt">${esc(r.addr_key)}</div><div class="st">${num(r.records)} records · ${esc((r.srcs || []).length)} sources${(r.names || []).length ? ` · ${esc(r.names.slice(0, 3).join(', '))}` : ''}</div></div>`).join('') || '<div class="empty">No matching addresses.</div>';
  };
  render(query);
  $('#addr-q', el).addEventListener('input', (e) => render(e.target.value));
  list.addEventListener('click', (e) => { const c = e.target.closest('[data-k]'); if (c) showDossier(c.dataset.k); });
  let mini = null;
  async function showDossier(k) {
    setCrumb(k);
    const shard = await sha1hex2(k);
    const data = await obs(`places/${shard}.json`);
    const p = data[k];
    const d = $('#dossier', el);
    if (!p) { d.innerHTML = '<div class="panel"><div class="empty">No records for this address.</div></div>'; return; }
    const kinds = {};
    for (const r of p.records) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
    const near = p.nearby_12m || {};
    const nearLbl = { police_call: 'Police calls', crime: 'Crime reports', fire_ems: 'Fire & medical 911', '311': '311 requests', encampment_report: 'Encampment reports', illegal_dumping: 'Illegal dumping' };
    d.innerHTML = `<div class="panel"><div class="panel-h"><h3>${esc(p.address || k)}</h3><span class="sub">${num(p.records.length)} records</span>
        <div class="right">${isNum(p.lat) ? `<a class="btn" href="#/overview/@${p.lon},${p.lat}">${icon('overview')} Show on 3D map</a>` : ''}</div></div>
      <div class="grid" style="grid-template-columns:1fr 1fr;gap:0">
        <div id="mini" style="height:260px;border-right:1px solid var(--line)"></div>
        <div class="panel-b"><h4 style="margin:0 0 8px;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)">Within ~100 m, last 12 months</h4>
          <dl class="kv">${Object.entries(nearLbl).map(([kk, l]) => `<dt>${esc(l)}</dt><dd>${num(near[kk] || 0)}</dd>`).join('')}</dl>
          <h4 style="margin:14px 0 8px;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)">Records by type</h4>
          <dl class="kv">${Object.entries(kinds).map(([kk, n]) => `<dt>${esc(kk)}</dt><dd>${num(n)}</dd>`).join('')}</dl></div></div>
      <div id="recs"></div></div>`;
    table($('#recs', d), {
      columns: [{ key: 'd', label: 'Date', fmt: (v) => esc(v ? date(v) : '–'), width: '120px' }, { key: 'kind', label: 'Record', width: '160px' },
        { key: 'summary', label: 'Summary', fmt: (v, r) => `<div>${esc(v || '')}</div>${r.detail ? `<div class="muted">${esc(r.detail)}</div>` : ''}` },
        { key: 'ref', label: 'Reference', fmt: (v, r) => (r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(v)}</a>` : `<span class="mono">${esc(v)}</span>`), width: '150px' }],
      rows: p.records, sort: 'd', dir: -1, exportName: `records-${k.replace(/\W+/g, '-')}`,
    });
    if (mini) mini.remove();
    if (isNum(p.lat)) {
      mini = new window.maplibregl.Map({ container: $('#mini', d), center: [p.lon, p.lat], zoom: 18.2, pitch: 0, attributionControl: false, interactive: true,
        style: { version: 8, sources: { a: { type: 'raster', tiles: ['https://gismaps.kingcounty.gov/arcgis/rest/services/BaseMaps/KingCo_Aerial_2025/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 20 } },
          layers: [{ id: 'a', type: 'raster', source: 'a' }] } });
      new window.maplibregl.Marker({ color: '#3b9eff' }).setLngLat([p.lon, p.lat]).addTo(mini);
    } else {
      $('#mini', d).innerHTML = '<div class="empty">No coordinates recorded for this address.</div>';
    }
  }
  if (query) { const nq = normAddr(query); const hit = rows.find((r) => r.addr_key === nq) || rows.find((r) => r.addr_key.includes(nq)); if (hit) showDossier(hit.addr_key); }
  return () => { if (mini) mini.remove(); };
}

// ------------------------------------------------------------ portfolios
function pipelineView(el, p, setCrumb) {
  const rows = (p.in_review || []).map((r) => Object.fromEntries(p.in_review_cols.map((c, i) => [c, r[i]])));
  const iss = (p.issued_12m || []).map((r) => Object.fromEntries(p.issued_cols.map((c, i) => [c, r[i]])));
  const units = rows.reduce((a, r) => a + (r.units_added || 0), 0);
  const unitsIss = iss.reduce((a, r) => a + (r.units_added || 0), 0);
  setCrumb('Development pipeline');
  el.innerHTML = `<div class="grid cols-4" style="margin-bottom:14px">
      <div class="panel kpi"><div class="k">Land use applications in review</div><div class="v">${num(rows.length)}</div><div class="d">${num(units)} housing units proposed</div></div>
      <div class="panel kpi"><div class="k">Permits issued, last 12 months</div><div class="v">${num(iss.length)}</div><div class="d">${num(unitsIss)} units added</div></div>
      <div class="panel kpi"><div class="k">Permits completed, 12 months</div><div class="v">${num((p.completed_12m || [])[0])}</div><div class="d">${num((p.completed_12m || [])[1])} units</div></div>
      <div class="panel kpi"><div class="k">Units permitted per year</div><div class="v"><div id="upy" class="spark"></div></div><div class="d">since 2010</div></div></div>
    <div class="panel"><div class="panel-h"><h3>In review (land use)</h3><span class="sub">largest first</span></div><div id="t1"></div></div>
    <div class="panel" style="margin-top:14px"><div class="panel-h"><h3>Issued in the last 12 months</h3></div><div id="t2"></div></div>`;
  const addrLink = (v) => `<a href="#/places/search/${encodeURIComponent(v || '')}">${esc(v)}</a>`;
  table($('#t1', el), { columns: [{ key: 'address', label: 'Address', fmt: addrLink }, { key: 'type', label: 'Type' }, { key: 'status', label: 'Status' },
    { key: 'units_added', label: 'Units', num: true, fmt: (v) => num(v) }, { key: 'applied', label: 'Applied', fmt: (v) => esc(date(v)) },
    { key: 'description', label: 'Description', clip: true }, { key: 'link', label: '', fmt: (v) => (v ? `<a href="${esc(v)}" target="_blank" rel="noopener">SDCI</a>` : ''), sortable: false }],
    rows, sort: 'units_added', exportName: 'ballard-land-use-in-review' });
  table($('#t2', el), { columns: [{ key: 'address', label: 'Address', fmt: addrLink }, { key: 'type', label: 'Type' }, { key: 'units_added', label: 'Units', num: true, fmt: (v) => num(v) },
    { key: 'cost', label: 'Est. cost', num: true, fmt: (v) => (isNum(v) ? `$${num(v)}` : '–') }, { key: 'issued', label: 'Issued', fmt: (v) => esc(date(v)) },
    { key: 'description', label: 'Description', clip: true }], rows: iss, sort: 'issued', exportName: 'ballard-permits-issued-12m' });
  const upy = p.units_by_year || [];
  const ch = window.echarts.init($('#upy', el));
  ch.setOption({ grid: { left: 0, right: 0, top: 2, bottom: 0 }, xAxis: { type: 'category', show: false, data: upy.map((r) => r[0]) }, yAxis: { show: false },
    tooltip: { trigger: 'axis' }, series: [{ type: 'bar', data: upy.map((r) => r[1]), itemStyle: { color: '#3b9eff' } }] });
}

function openingsView(el, o, setCrumb) {
  setCrumb('New businesses');
  const rows = (o.new_licenses || []).map((r) => ({ name: r[0], sector: r[1], address: r[2], zip: r[3], start: r[4] }));
  el.innerHTML = `<div class="grid" style="grid-template-columns:2fr 1fr;align-items:start">
    <div class="panel"><div class="panel-h"><h3>Business licenses started in the last 90 days</h3><span class="sub">${rows.length} businesses (ZIP 98107/98117)</span></div><div id="t"></div></div>
    <div class="panel"><div class="panel-h"><h3>New licenses by sector, 12 months</h3></div><div id="sect" class="chart lg"></div></div></div>
    <div class="panel" style="margin-top:14px"><div class="panel-h"><h3>Liquor licenses (WSLCB roster)</h3><span class="sub">${(o.liquor || []).length} active</span></div><div id="liq"></div></div>`;
  table($('#t', el), { columns: [{ key: 'name', label: 'Business' }, { key: 'sector', label: 'Sector', clip: true }, { key: 'address', label: 'Address', fmt: (v) => `<a href="#/places/search/${encodeURIComponent(v || '')}">${esc(v)}</a>` },
    { key: 'start', label: 'Licensed from', fmt: (v) => esc(date(v)) }], rows, sort: 'start', exportName: 'ballard-new-businesses' });
  const sec = (o.new_by_sector || []).slice().reverse();
  const ch = window.echarts.init($('#sect', el));
  const css = getComputedStyle(document.documentElement);
  ch.setOption({ grid: { left: 190, right: 30, top: 10, bottom: 20 }, tooltip: {}, xAxis: { type: 'value', axisLabel: { color: css.getPropertyValue('--muted') }, splitLine: { lineStyle: { color: css.getPropertyValue('--line') } } },
    yAxis: { type: 'category', data: sec.map((r) => r[0].slice(0, 32)), axisLabel: { color: css.getPropertyValue('--muted'), fontSize: 11 } },
    series: [{ type: 'bar', data: sec.map((r) => r[1]), itemStyle: { color: '#3b9eff' }, label: { show: true, position: 'right', color: css.getPropertyValue('--ink') } }] });
  table($('#liq', el), { columns: [{ key: 0, label: 'Trade name' }, { key: 1, label: 'Address' }, { key: 2, label: 'Privileges', clip: true }, { key: 3, label: 'Renewal', fmt: (v) => esc(date(v)) }],
    rows: o.liquor || [], exportName: 'ballard-liquor-licenses' });
}

function nuisanceView(el, rows, setCrumb) {
  setCrumb('Persistent & emerging problems');
  const L = { code_complaint: 'Code complaints', illegal_dumping: 'Illegal dumping', encampment_report: 'Encampment reports' };
  el.innerHTML = `<div class="panel"><div class="panel-h"><h3>Locations with persistent or newly emerging problems</h3><span class="sub">~0.015 km² cells; last 8 quarters; emerging = last quarter far above the location's own history (Poisson p &lt; 0.001)</span></div><div id="t"></div></div>`;
  table($('#t', el), {
    columns: [{ key: 'status', label: 'Status', fmt: (v) => `<span class="badge ${v === 'emerging' ? 'alert' : ''}">${esc(v)}</span>` }, { key: 'kind', label: 'Problem', fmt: (v) => esc(L[v] || v) },
      { key: 'address', label: 'Near', fmt: (v) => `<a href="#/places/search/${encodeURIComponent(v || '')}">${esc(v)}</a>` },
      { key: 'recent', label: 'Last quarter', num: true }, { key: 'baseline_per_quarter', label: 'Prior avg / quarter', num: true, fmt: (v) => num(v, 1) },
      { key: 'persistent_quarters', label: 'Quarters ≥3 (of last 4)', num: true },
      { key: 'quarters', label: 'Trend (8 quarters, oldest → newest)', fmt: (v) => `<span class="mono">${esc([...v].reverse().map((x) => Math.round(x)).join(' · '))}</span>`, sortable: false }],
    rows: rows || [], sort: 'recent', exportName: 'ballard-problem-locations' });
}

function restaurantsView(el, rows, setCrumb) {
  setCrumb('Restaurant inspections');
  el.innerHTML = `<div class="panel"><div class="panel-h"><h3>Unsatisfactory inspections and closures, last 6 months</h3><span class="sub">King County Public Health</span></div><div id="t"></div></div>`;
  table($('#t', el), {
    columns: [{ key: 0, label: 'Establishment' }, { key: 1, label: 'Address', fmt: (v) => `<a href="#/places/search/${encodeURIComponent(v || '')}">${esc(v)}</a>` },
      { key: 2, label: 'Date', fmt: (v) => esc(date(v)) }, { key: 5, label: 'Closed', fmt: (v) => (v ? '<span class="badge alert">Closed by inspector</span>' : '') },
      { key: 6, label: 'Red points', num: true }, { key: 7, label: 'Red violations', fmt: (v) => esc((v || []).join('; ')), clip: true }],
    rows: rows || [], sort: 2, exportName: 'ballard-restaurant-inspections' });
}
