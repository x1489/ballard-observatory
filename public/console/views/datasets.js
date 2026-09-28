// Datasets: the lake catalog (every archived dataset with lineage, coverage, freshness and privacy handling), the
// live feed registry, and cross-agency concordance checks (data quality).
import { esc, $, table, num, date, ago, icon, openDrawer, dateTime } from '../ui.js';
import { obs, sources } from '../api.js';

export async function mount(root, { args, setCrumb }) {
  const [cat, conc, feeds, run] = await Promise.all([obs('catalog.json'), obs('concordance.json').catch(() => ({ pairs: [] })), sources().catch(() => ({ sources: [] })), obs('run.json').catch(() => null)]);
  const ds = cat.datasets.filter((d) => d.rows != null);
  const total = ds.reduce((a, d) => a + (d.rows || 0), 0);
  setCrumb(`${ds.length} archived datasets · ${num(total)} records`);
  root.innerHTML = `<div class="page">
    <div class="page-head"><div><h2>Datasets</h2><p>Every source the platform archives. Records are stored change-only (each version kept), compacted to a current table, typed in views, and published as open Parquet. Personal fields are removed at ingest.</p></div>
      <div class="actions"><button class="btn" id="csv">${icon('download')} Export catalog</button></div></div>
    <div class="grid cols-4" style="margin-bottom:14px">
      <div class="panel kpi"><div class="k">Archived datasets</div><div class="v">${ds.length}</div><div class="d">plus ${num((feeds.sources || []).length)} live feeds</div></div>
      <div class="panel kpi"><div class="k">Records in the lake</div><div class="v">${num(total)}</div><div class="d">current versions</div></div>
      <div class="panel kpi"><div class="k">History depth</div><div class="v">2003<small>–now</small></div><div class="d">fire &amp; medical 911 since Nov 2003</div></div>
      <div class="panel kpi"><div class="k">Last analytics run</div><div class="v">${run ? ago(run.generated) : '–'}</div><div class="d">${run ? `${num(run.timings.total, 0)} s · ${run.series} series · ${num(run.pairs_tested)} pairs tested` : ''}</div></div></div>
    <div class="panel"><div class="panel-h"><h3>Archive (lake)</h3><span class="sub">click a row for lineage</span></div><div id="t1"></div></div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="panel"><div class="panel-h"><h3>Live feeds</h3><span class="sub">real-time layer</span></div><div id="t2" style="max-height:520px;overflow:auto"></div></div>
      <div class="panel"><div class="panel-h"><h3>Cross-agency concordance</h3><span class="sub">same incidents in two systems: agreement of daily deviations</span></div><div id="t3"></div>
        <div class="panel-b faint" style="font-size:12px">These pairs record the same events from two agencies or systems. They are excluded from discovery and monitored here as a data-quality signal; a sudden drop in agreement indicates a reporting or coding change.</div></div>
    </div></div>`;
  const T = table($('#t1', root), {
    columns: [{ key: 'title', label: 'Dataset', fmt: (v, r) => `<div style="font-weight:600;color:var(--ink)">${esc(v || r.name)}</div><div class="muted mono" style="font-size:11.5px">${esc(r.name)}</div>` },
      { key: 'topic', label: 'Topic', fmt: (v) => (v ? `<span class="badge">${esc(v)}</span>` : '') }, { key: 'rows', label: 'Records', num: true, fmt: (v) => num(v) },
      { key: 'mode', label: 'Capture', fmt: (v) => esc({ window: 'events, rolling window', full: 'snapshot + deletes', aggregate: 'server-side aggregate' }[v] || v || 'series') },
      { key: 'last_run', label: 'Last refresh', fmt: (v) => esc(v ? ago(v) : '–') },
      { key: 'last_error', label: 'Health', fmt: (v, r) => (v && (!r.last_run || v) ? '<span class="badge alert">error</span>' : '<span class="badge high">ok</span>'), sortable: false },
      { key: 'source', label: 'Source', fmt: (v) => (v ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(new URL(v).hostname)}</a>` : ''), sortable: false }],
    rows: ds, sort: 'rows', exportName: 'ballard-lake-catalog', onRow: detail,
  });
  $('#csv', root).addEventListener('click', () => T.csv());
  table($('#t2', root), { columns: [{ key: 'title', label: 'Feed' }, { key: 'group', label: 'Group' }, { key: 'ttl', label: 'Refresh', num: true, fmt: (v) => `${num(v)} s` },
    { key: 'fetchedAt', label: 'Updated', fmt: (v) => esc(v ? ago(v) : '–') }, { key: 'error', label: 'Status', fmt: (v) => (v ? `<span class="badge alert" title="${esc(v)}">error</span>` : '<span class="badge high">live</span>') }],
    rows: feeds.sources || [], sort: 'title', dir: 1, exportName: 'live-feeds' });
  table($('#t3', root), { columns: [{ key: 'a', label: 'Series A', fmt: (v) => `<span class="mono">${esc(v)}</span>` }, { key: 'b', label: 'Series B', fmt: (v) => `<span class="mono">${esc(v)}</span>` },
    { key: 'r_same_day', label: 'Agreement (r)', num: true, fmt: (v) => v.toFixed(2) }, { key: 'n_days', label: 'Days', num: true, fmt: (v) => num(v) }], rows: conc.pairs || [], sort: 'r_same_day' });
  if (args[0]) { const d = ds.find((x) => x.name === args[0]); if (d) detail(d); }

  function detail(d) {
    openDrawer(`<div class="drawer-h"><div style="flex:1"><h3>${esc(d.title || d.name)}</h3><div class="meta"><span class="badge">${esc(d.topic || 'dataset')}</span><span class="badge mono">${esc(d.name)}</span></div></div>
      <button class="icon-btn" data-close aria-label="Close">${icon('close')}</button></div>
      <div class="drawer-b"><h4>Lineage</h4><dl class="kv">
        <dt>Upstream source</dt><dd>${d.source ? `<a href="${esc(d.source)}" target="_blank" rel="noopener">${esc(d.source)}</a>` : '–'}</dd>
        <dt>Capture mode</dt><dd>${esc(d.mode || 'series')}</dd><dt>Record key</dt><dd>${esc((d.key || []).join(' + '))}</dd>
        <dt>Current records</dt><dd>${num(d.rows)}</dd><dt>Stored last run</dt><dd>${num(d.stored_last_run)}</dd>
        <dt>Last refresh</dt><dd>${esc(d.last_run ? dateTime(d.last_run) : '–')}</dd>
        ${d.backfilled_through ? `<dt>Backfilled through</dt><dd>${esc(date(d.backfilled_through))}</dd>` : ''}
        ${d.through ? `<dt>Complete through</dt><dd>${esc(date(d.through))}</dd>` : ''}
        <dt>Personal fields removed</dt><dd>${esc((d.dropped_fields || []).join(', ') || 'none present')}</dd>
        ${d.last_error ? `<dt>Last error</dt><dd style="color:var(--alert)">${esc(d.last_error)}</dd>` : ''}</dl>
      ${d.notes ? `<h4>Notes</h4><p>${esc(d.notes)}</p>` : ''}
      <h4>Storage</h4><p class="muted">Change-only Parquet batches under <span class="mono">lake/${esc(d.name)}/batches/</span>, compacted to <span class="mono">lake/${esc(d.name)}/current.parquet</span> (latest version per key, with first/last seen and active flags). Typed in the view <span class="mono">${esc(d.name)}</span>.</p></div>`);
  }
}
