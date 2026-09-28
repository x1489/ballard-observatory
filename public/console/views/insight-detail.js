// Insight detail drawer: statement, confidence, evidence, a chart suited to the insight type, and provenance.
import { esc, openDrawer, confBadge, typeBadge, pval, num, pct, date, chart, axis, themeColors, icon, isNum } from '../ui.js';
import { obs } from '../api.js';

const METHOD_ANCHOR = { relationship: 'relationships', anomaly: 'anomalies', change: 'changes', hotspot: 'hotspots', near_repeat: 'space-time', cascade: 'space-time' };

export async function showInsight(ins) {
  const ev = ins.evidence || {};
  const m = ins.metrics || {};
  const rows = [
    ['Test', ev.test],
    ev.p != null && ['p-value', pval(ev.p)],
    ev.q != null && ['q-value (FDR)', pval(ev.q)],
    ev.n_days && ['Days analyzed', num(ev.n_days)],
    ev.period && ['Period', ev.period.filter(Boolean).map(date).join(' – ')],
    ev.replicated != null && ['Replicated in both halves', ev.replicated ? 'Yes' : 'No'],
    ev.recurrence_days && ['Recurrence interval', `once in ${num(ev.recurrence_days)} days by chance`],
    isNum(m.r) && ['Correlation (residuals)', m.r.toFixed(3)],
    isNum(m.partial_r) && ['Partial r (weather removed)', m.partial_r.toFixed(3)],
    isNum(m.lag_days) && ['Lag', `${m.lag_days} day${m.lag_days === 1 ? '' : 's'}`],
    isNum(m.ratio) && ['Observed ÷ expected', m.ratio.toFixed(2)],
    isNum(m.relative_risk) && ['Relative risk', m.relative_risk.toFixed(2)],
    isNum(m.observed) && ['Observed', num(m.observed)],
    isNum(m.expected) && ['Expected', num(m.expected, 1)],
    isNum(m.relative) && ['Change', pct(m.relative * 100)],
  ].filter(Boolean);
  const d = openDrawer(`
    <div class="drawer-h"><div style="flex:1;min-width:0"><h3>${esc(ins.title)}</h3>
      <div class="meta">${typeBadge(ins.type)} ${confBadge(ins.confidence)} ${(ins.domains || []).map((x) => `<span class="badge">${esc(x)}</span>`).join(' ')}</div></div>
      <button class="icon-btn" data-close aria-label="Close">${icon('close')}</button></div>
    <div class="drawer-b">
      <p class="stmt">${esc(ins.statement)}</p>
      ${ins.caveat ? `<div class="caveat">${esc(ins.caveat)}</div>` : ''}
      <h4>Evidence</h4><div class="chart" id="ins-chart"></div>
      <h4>Statistics</h4><dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <h4>Provenance</h4><dl class="kv">
        <dt>Series</dt><dd>${esc((ins.series || []).join(', ') || '–')}</dd>
        <dt>Datasets</dt><dd>${(ins.sources || []).map((s) => `<a href="#/datasets/${esc(s)}">${esc(s)}</a>`).join(', ') || '–'}</dd>
        <dt>Method</dt><dd><a href="#/methods/${METHOD_ANCHOR[ins.type] || ''}">How this is computed</a></dd>
        <dt>Insight ID</dt><dd>${esc(ins.id)}</dd><dt>Generated</dt><dd>${esc(ins.generated || '')}</dd></dl>
      <p class="faint" style="margin-top:18px;font-size:12px">Statistical associations are not proof of cause. Each finding is tested against a null model that preserves the data's own rhythms, controlled for false discoveries across everything tested, and replicated across time where applicable.</p>
    </div>`);
  const el = d.querySelector('#ins-chart');
  try { await renderEvidence(el, ins); } catch (e) { el.innerHTML = `<div class="empty">Chart unavailable: ${esc(e.message)}</div>`; }
}

async function renderEvidence(el, ins) {
  const c = themeColors();
  if ((ins.type === 'relationship' || ins.type === 'anomaly' || ins.type === 'change') && ins.series && ins.series.length) {
    const S = await obs('series.json');
    const start = new Date(`${S.start}T12:00:00`);
    const weekly = (vals) => {
      const out = [];
      for (let i = 0; i < vals.length; i += 7) {
        const w = vals.slice(i, i + 7).filter((x) => x != null);
        if (w.length >= 5) out.push([new Date(start.getTime() + (i + 3) * 86400e3).toISOString().slice(0, 10), w.reduce((a, b) => a + b, 0) / w.length]);
      }
      return out;
    };
    const years = ins.type === 'relationship' ? 3 : 5;
    const cut = new Date(Date.now() - years * 365 * 86400e3).toISOString().slice(0, 10);
    const series = ins.series.map((name, i) => ({
      name: S.meta[name] ? S.meta[name].label : name, type: 'line', showSymbol: false, yAxisIndex: i, smooth: false,
      lineStyle: { width: 1.4 }, data: weekly(S.values[name] || []).filter((p) => p[0] >= cut),
    }));
    const markLine = ins.type === 'change' && ins.metrics ? { symbol: 'none', lineStyle: { color: c.warn, type: 'dashed' }, data: [{ xAxis: (ins.evidence.period || [])[0] }] } : undefined;
    if (markLine) series[0].markLine = markLine;
    chart(el, {
      color: [c.accent, c.warn],
      tooltip: { trigger: 'axis' },
      legend: { data: series.map((s) => s.name) },
      xAxis: axis({ type: 'time' }),
      yAxis: series.map((s, i) => axis({ type: 'value', scale: true, position: i ? 'right' : 'left', splitLine: { show: i === 0, lineStyle: { color: c.line, opacity: 0.5 } } })),
      grid: { left: 52, right: series.length > 1 ? 52 : 16, top: 34, bottom: 30 },
      series,
    });
    return;
  }
  if (ins.type === 'near_repeat' || ins.type === 'cascade') {
    const m = ins.metrics;
    chart(el, {
      tooltip: { trigger: 'item' },
      xAxis: axis({ type: 'category', data: ['Expected by chance', 'Observed'] }),
      yAxis: axis({ type: 'value', name: 'pairs', nameTextStyle: { color: c.muted } }),
      series: [{ type: 'bar', barWidth: '42%', data: [{ value: Math.round(m.expected), itemStyle: { color: c.muted } }, { value: m.observed, itemStyle: { color: c.accent } }],
        label: { show: true, position: 'top', color: c.ink } }],
    });
    return;
  }
  if (ins.type === 'hotspot' && ins.scope) {
    const maplibregl = window.maplibregl;
    el.style.height = '320px';
    const map = new maplibregl.Map({ container: el, center: [ins.scope.lon, ins.scope.lat], zoom: 16.2, pitch: 45, bearing: -15, attributionControl: false,
      style: { version: 8, sources: { a: { type: 'raster', tiles: ['https://gismaps.kingcounty.gov/arcgis/rest/services/BaseMaps/KingCo_Aerial_2025/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 20 } },
        layers: [{ id: 'a', type: 'raster', source: 'a' }] } });
    const geo = await obs('hotspots.geojson');
    const f = geo.features.find((x) => x.properties.id === ins.id);
    map.on('load', () => {
      if (!f) return;
      map.addSource('h', { type: 'geojson', data: f });
      map.addLayer({ id: 'hf', type: 'fill', source: 'h', paint: { 'fill-color': '#f25555', 'fill-opacity': 0.22 } });
      map.addLayer({ id: 'hl', type: 'line', source: 'h', paint: { 'line-color': '#ff6b6b', 'line-width': 2.5 } });
    });
    return;
  }
  el.innerHTML = '<div class="empty">No chart for this insight type.</div>';
}
