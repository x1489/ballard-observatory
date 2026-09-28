// Insights: every finding from the discovery engines, filterable, exportable, with a network view of the
// relationships between series.
import { esc, $, table, typeBadge, confBadge, pval, date, icon, TYPE_LABEL, themeColors, chart } from '../ui.js';
import { obs } from '../api.js';
import { showInsight } from './insight-detail.js';

const DOMAIN_COLORS = { safety: '#f25555', 'quality-of-life': '#f0a13a', mobility: '#3b9eff', environment: '#2fbf71', development: '#a78bfa',
  economy: '#e879f9', attention: '#94a3b8', health: '#22d3ee', civic: '#fbbf24', housing: '#fb7185' };

export async function mount(root, { args, setCrumb }) {
  const j = await obs('insights.json');
  const all = j.insights;
  const q0 = args[0] === 'q' ? args[1] || '' : '';
  root.innerHTML = `<div class="page">
    <div class="page-head"><div><h2>Insights</h2><p>Findings from the discovery engines, ranked by strength of evidence. Every item was tested against a null model that preserves the data's own rhythms, with false-discovery control across everything tested.</p></div>
      <div class="actions"><div class="seg" id="mode"><button data-m="table" aria-pressed="true">${icon('table')} Table</button><button data-m="network" aria-pressed="false">${icon('network')} Network</button></div>
      <button class="btn" id="csv">${icon('download')} Export CSV</button></div></div>
    <div class="panel">
      <div class="toolbar">
        <input class="field" id="f-q" placeholder="Filter findings…" value="${esc(q0)}" style="width:260px">
        <select class="field" id="f-type"><option value="">All types</option>${Object.entries(TYPE_LABEL).filter(([k]) => all.some((i) => i.type === k)).map(([k, v]) => `<option value="${k}">${esc(v)} (${all.filter((i) => i.type === k).length})</option>`).join('')}</select>
        <select class="field" id="f-dom"><option value="">All domains</option>${[...new Set(all.flatMap((i) => i.domains || []))].sort().map((d) => `<option>${esc(d)}</option>`).join('')}</select>
        <select class="field" id="f-conf"><option value="">Any confidence</option><option value="high">High</option><option value="medium">Medium or higher</option></select>
        <label class="pill"><input type="checkbox" id="f-known"> Include expected mechanisms</label>
        <span class="grow"></span><span class="statline" id="stat"></span>
      </div>
      <div id="tbl"></div><div id="net" class="chart lg" style="display:none;height:640px"></div>
    </div></div>`;
  setCrumb(`${all.length} findings · generated ${date(j.generated)}`);
  const cols = [
    { key: 'type', label: 'Type', fmt: (v) => typeBadge(v), width: '140px' },
    { key: 'title', label: 'Finding', fmt: (v, r) => `<div style="font-weight:600;color:var(--ink)">${esc(v)}</div><div class="muted" style="max-width:760px">${esc(r.statement)}</div>${r.caveat ? `<div style="color:var(--warn);font-size:12px;margin-top:3px">⚠ ${esc(r.caveat)}</div>` : ''}`, csvValue: (r) => `${r.title}: ${r.statement}` },
    { key: 'confidence', label: 'Confidence', fmt: (v) => confBadge(v), sort: (r) => ({ high: 3, medium: 2, low: 1 }[r.confidence] || 0), width: '150px' },
    { key: 'q', label: 'q / p', num: true, fmt: (v, r) => pval(r.evidence.q ?? r.evidence.p), sort: (r) => -(r.evidence.q ?? r.evidence.p ?? 1), csvValue: (r) => r.evidence.q ?? r.evidence.p, width: '110px' },
    { key: 'domains', label: 'Domains', fmt: (v) => (v || []).map((d) => `<span class="badge">${esc(d)}</span>`).join(' '), sortable: false, csvValue: (r) => (r.domains || []).join(' ') },
    { key: 'score', label: 'Score', num: true, fmt: (v) => v.toFixed(1), width: '80px' },
  ];
  const filtered = () => {
    const t = $('#f-type', root).value, d = $('#f-dom', root).value, c = $('#f-conf', root).value, known = $('#f-known', root).checked;
    return all.filter((i) => (!t || i.type === t) && (!d || (i.domains || []).includes(d)) && (!c || (c === 'high' ? i.confidence === 'high' : i.confidence !== 'low'))
      && (known || !i.known_mechanism));
  };
  const T = table($('#tbl', root), { columns: cols, rows: filtered(), onRow: showInsight, exportName: 'ballard-insights', sort: 'score', dir: -1,
    search: (r) => `${r.title} ${r.statement} ${(r.series || []).join(' ')}` });
  const update = () => { const rows = filtered(); T.set(rows); T.filter($('#f-q', root).value); $('#stat', root).innerHTML = `<span><b>${rows.length}</b> shown</span>`; if (mode === 'network') network(); };
  root.addEventListener('input', (e) => { if (e.target.id === 'f-q') T.filter(e.target.value); });
  root.addEventListener('change', (e) => { if (e.target.closest('.toolbar')) update(); });
  $('#csv', root).addEventListener('click', () => T.csv());
  let mode = 'table';
  $('#mode', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    mode = b.dataset.m;
    for (const x of root.querySelectorAll('[data-m]')) x.setAttribute('aria-pressed', String(x === b));
    $('#tbl', root).style.display = mode === 'table' ? '' : 'none';
    $('#net', root).style.display = mode === 'network' ? '' : 'none';
    if (mode === 'network') network();
  });
  update();
  if (q0) T.filter(q0);
  if (args[0] && args[0] !== 'q') { const ins = all.find((i) => i.id === args[0]); if (ins) showInsight(ins); }

  let net = null;
  async function network() {
    const S = await obs('series.json');
    const rels = filtered().filter((i) => i.type === 'relationship');
    const nodes = new Map();
    for (const r of rels) for (const s of r.series) nodes.set(s, (nodes.get(s) || 0) + 1);
    const c = themeColors();
    const data = [...nodes.entries()].map(([id, deg]) => {
      const m = S.meta[id] || {};
      return { id, name: m.label || id, value: deg, symbolSize: 8 + Math.sqrt(deg) * 6, itemStyle: { color: DOMAIN_COLORS[m.domain] || '#94a3b8' },
        label: { show: deg >= 5, color: c.ink, fontSize: 11 }, category: m.domain };
    });
    const links = rels.map((r) => ({ source: r.series[0], target: r.series[1], value: r.metrics.r,
      lineStyle: { width: 0.6 + Math.abs(r.metrics.r) * 14, color: r.metrics.r >= 0 ? '#3b9eff' : '#f25555', opacity: 0.55, curveness: 0.12 },
      tooltip: { formatter: `${esc(r.title)}<br>r = ${r.metrics.r.toFixed(3)}, lag ${r.metrics.lag_days} d` }, ins: r.id }));
    if (net) net.dispose();
    net = chart($('#net', root), {
      tooltip: { trigger: 'item' }, legend: { data: Object.keys(DOMAIN_COLORS).filter((d) => data.some((n) => n.category === d)), top: 8, left: 12 },
      series: [{ type: 'graph', layout: 'force', roam: true, draggable: true, data, links, categories: Object.keys(DOMAIN_COLORS).map((n) => ({ name: n, itemStyle: { color: DOMAIN_COLORS[n] } })),
        force: { repulsion: 420, edgeLength: [90, 240], gravity: 0.06 }, emphasis: { focus: 'adjacency' }, lineStyle: { opacity: 0.5 } }],
    });
    net.on('click', (p) => { if (p.dataType === 'edge' && p.data.ins) showInsight(all.find((i) => i.id === p.data.ins)); });
  }
  return { unmount() { if (net) net.dispose(); } };
}
