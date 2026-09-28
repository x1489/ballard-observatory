// UI kit: formatting, icons, tables (sort, filter, CSV export), drawer, charts.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const TZ = 'America/Los_Angeles';
const fmtDT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtD = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric' });
const fmtT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
export const dateTime = (t) => (t ? fmtDT.format(new Date(t)) : '–');
export const date = (t) => (t ? fmtD.format(new Date(typeof t === 'string' && t.length === 10 ? `${t}T12:00:00` : t)) : '–');
export const time = (t) => (t ? fmtT.format(new Date(t)) : '–');
export function num(v, dp = 0) {
  if (!isNum(v)) return '–';
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
export const pct = (v, dp = 0) => (isNum(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(dp)}%` : '–');
export function pval(p) {
  if (!isNum(p)) return '–';
  if (p < 1e-12) return '< 10⁻¹²';
  if (p < 1e-3) { const e = Math.floor(Math.log10(p)); const m = p / 10 ** e; return `${m.toFixed(1)} × 10${sup(e)}`; }
  return p.toFixed(3);
}
const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
const sup = (n) => String(n).split('').map((c) => SUP[c] ?? c).join('');
export function ago(t) {
  if (!t) return '–';
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

// ------------------------------------------------------------ icons (line, 24px grid)
const P = {
  overview: 'M3 12l9-8 9 8M5 10v10h14V10', insights: 'M4 19V9m5 10V5m5 14v-7m5 7V3', places: 'M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12zm0-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  ops: 'M3 12h4l3-8 4 16 3-8h4', data: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  methods: 'M9 3h6m-5 0v6L4 19a1.5 1.5 0 0 0 1.3 2h13.4a1.5 1.5 0 0 0 1.3-2L14 9V3', api: 'M8 9l-4 3 4 3m8-6 4 3-4 3M14 5l-4 14',
  close: 'M6 6l12 12M18 6 6 18', ext: 'M14 4h6v6m0-6-9 9M18 14v6H4V6h6', download: 'M12 4v11m-5-5 5 5 5-5M5 20h14',
  layers: 'M12 3 2 8l10 5 10-5-10-5zm-10 10 10 5 10-5', filter: 'M3 5h18l-7 8v6l-4 2v-8L3 5z', network: 'M6 6a2 2 0 1 0 0-.01M18 6a2 2 0 1 0 0-.01M12 18a2 2 0 1 0 0-.01M7.5 7.5l3.5 8.5M16.5 7.5 13 16M8 6h8',
  table: 'M3 5h18v14H3zM3 10h18M3 15h18M9 5v14',
};
export const icon = (n, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${P[n] || ''}"/></svg>`;

export const confBadge = (c) => `<span class="badge ${esc(c)}">${esc(c ? c[0].toUpperCase() + c.slice(1) : '')} confidence</span>`;
export const TYPE_LABEL = { relationship: 'Relationship', anomaly: 'Anomaly', change: 'Structural change', hotspot: 'Emerging hotspot',
  near_repeat: 'Near-repeat', cascade: 'Cascade', pipeline: 'Pipeline' };
export const typeBadge = (t) => `<span class="badge type">${esc(TYPE_LABEL[t] || t)}</span>`;

// ------------------------------------------------------------ table component
/**
 * table(el, { columns: [{ key, label, num?, fmt?(v,row) -> html, sort?(row) -> value, width? }], rows, onRow?(row),
 *             search?: fn(row) -> text, pageSize?, exportName? })
 */
export function table(el, opts) {
  const state = { sort: opts.sort || null, dir: opts.dir || -1, q: '', page: 0 };
  const pageSize = opts.pageSize || 200;
  function rows() {
    let r = opts.rows;
    if (state.q && opts.search) { const q = state.q.toLowerCase(); r = r.filter((x) => opts.search(x).toLowerCase().includes(q)); }
    if (state.sort) {
      const col = opts.columns.find((c) => c.key === state.sort);
      const val = col.sort || ((x) => x[col.key]);
      r = [...r].sort((a, b) => { const va = val(a), vb = val(b); return (va > vb ? 1 : va < vb ? -1 : 0) * state.dir; });
    }
    return r;
  }
  function render() {
    const all = rows();
    const shown = all.slice(0, (state.page + 1) * pageSize);
    el.innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr>${opts.columns.map((c) => `<th ${c.sortable === false ? '' : `data-sort="${c.key}"`} class="${c.num ? 'num' : ''}" ${c.width ? `style="width:${c.width}"` : ''}>${esc(c.label)}${state.sort === c.key ? `<span class="arrow">${state.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('')}</tr></thead>
      <tbody>${shown.map((r, i) => `<tr data-i="${i}" ${opts.onRow ? 'data-href' : ''}>${opts.columns.map((c) => `<td class="${c.num ? 'num' : ''} ${c.clip ? 'clip' : ''}">${c.fmt ? c.fmt(r[c.key], r) : esc(r[c.key] ?? '–')}</td>`).join('')}</tr>`).join('')}</tbody></table>
      ${all.length === 0 ? '<div class="empty">No rows match.</div>' : ''}
      ${shown.length < all.length ? `<div class="empty"><button class="btn" data-more>Show more (${all.length - shown.length} remaining)</button></div>` : ''}</div>`;
    el._rows = shown;
  }
  el.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) { const k = th.dataset.sort; state.dir = state.sort === k ? -state.dir : -1; state.sort = k; render(); return; }
    if (e.target.closest('[data-more]')) { state.page++; render(); return; }
    const tr = e.target.closest('tr[data-i]');
    if (tr && opts.onRow) { $$('tr.sel', el).forEach((x) => x.classList.remove('sel')); tr.classList.add('sel'); opts.onRow(el._rows[+tr.dataset.i]); }
  });
  render();
  return {
    filter(q) { state.q = q; state.page = 0; render(); },
    set(rows) { opts.rows = rows; render(); },
    csv() {
      const cols = opts.columns.filter((c) => c.csv !== false);
      const lines = [cols.map((c) => JSON.stringify(c.label)).join(',')];
      for (const r of rows()) lines.push(cols.map((c) => JSON.stringify(c.csvValue ? c.csvValue(r) : (r[c.key] ?? ''))).join(','));
      const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${opts.exportName || 'export'}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    },
  };
}

// ------------------------------------------------------------ drawer
let drawerClose = null;
export function openDrawer(html, { onClose } = {}) {
  const d = $('#drawer'), s = $('#scrim');
  d.innerHTML = html;
  d.classList.add('open'); s.classList.add('open');
  d.setAttribute('aria-hidden', 'false');
  drawerClose = onClose || null;
  const close = () => closeDrawer();
  $('[data-close]', d)?.addEventListener('click', close);
  s.onclick = close;
  $('[data-close]', d)?.focus();
  return d;
}
export function closeDrawer() {
  const d = $('#drawer');
  if (!d.classList.contains('open')) return;
  d.classList.remove('open'); $('#scrim').classList.remove('open');
  d.setAttribute('aria-hidden', 'true');
  for (const c of d.querySelectorAll('[data-echarts]')) { try { window.echarts.getInstanceByDom(c)?.dispose(); } catch { /* ignore */ } }
  if (drawerClose) drawerClose();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

// ------------------------------------------------------------ charts
export function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return { ink: v('--ink'), muted: v('--muted'), line: v('--line'), accent: v('--accent'), warn: v('--warn'), alert: v('--alert'), ok: v('--ok'), panel: v('--panel'), violet: v('--violet'), font: v('--font'), mono: v('--mono') };
}
export function chart(el, option) {
  const c = themeColors();
  const inst = window.echarts.init(el, null, { renderer: 'canvas' });
  el.dataset.echarts = '1';
  inst.setOption({
    backgroundColor: 'transparent', animation: false,
    textStyle: { color: c.muted, fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11 },
    grid: { left: 48, right: 16, top: 28, bottom: 32, containLabel: false },
    tooltip: { trigger: 'axis', backgroundColor: c.panel, borderColor: c.line, textStyle: { color: c.ink, fontSize: 12 } },
    legend: { textStyle: { color: c.muted }, top: 0, right: 0, itemWidth: 14, itemHeight: 8 },
    ...option,
  });
  const ro = new ResizeObserver(() => inst.resize());
  ro.observe(el);
  return inst;
}
export const axis = (extra = {}) => {
  const c = themeColors();
  return { axisLine: { lineStyle: { color: c.line } }, splitLine: { lineStyle: { color: c.line, opacity: 0.6 } }, axisLabel: { color: c.muted }, ...extra };
};
