// Console shell: navigation, routing (#/view/arg), global search, data status, theme.
import { esc, icon, $, closeDrawer, ago } from './ui.js';
import { obs, sources, subscribe } from './api.js';

const ROUTES = [
  { id: 'overview', label: 'Overview', icon: 'overview', section: 'Monitor', load: () => import('./views/overview.js') },
  { id: 'operations', label: 'Operations', icon: 'ops', section: 'Monitor', load: () => import('./views/operations.js') },
  { id: 'insights', label: 'Insights', icon: 'insights', section: 'Analyze', load: () => import('./views/insights.js'), count: 'insights' },
  { id: 'places', label: 'Places', icon: 'places', section: 'Analyze', load: () => import('./views/places.js') },
  { id: 'datasets', label: 'Datasets', icon: 'data', section: 'Platform', load: () => import('./views/datasets.js'), count: 'datasets' },
  { id: 'methods', label: 'Methods', icon: 'methods', section: 'Platform', load: () => import('./views/methods.js') },
  { id: 'api', label: 'API', icon: 'api', section: 'Platform', load: () => import('./views/apidocs.js') },
];

const view = $('#view');
let current = null;

function renderNav(counts = {}) {
  let html = '', sec = null;
  for (const r of ROUTES) {
    if (r.section !== sec) { sec = r.section; html += `<li class="nav-sec">${esc(sec)}</li>`; }
    const n = r.count && counts[r.count] != null ? `<span class="count">${counts[r.count]}</span>` : '';
    html += `<li><a class="nav-item" href="#/${r.id}" data-route="${r.id}">${icon(r.icon)}<span>${esc(r.label)}</span>${n}</a></li>`;
  }
  $('#nav').innerHTML = html;
  markNav();
}
function markNav() {
  const id = (location.hash.slice(2).split('/')[0]) || 'overview';
  for (const a of document.querySelectorAll('.nav-item')) a.setAttribute('aria-current', a.dataset.route === id ? 'page' : 'false');
}

async function route() {
  closeDrawer();
  const [id = 'overview', ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  const r = ROUTES.find((x) => x.id === id) || ROUTES[0];
  markNav();
  $('#title').textContent = r.label;
  $('#crumb').textContent = '';
  if (current && current.unmount) { try { current.unmount(); } catch (e) { console.error(e); } }
  view.innerHTML = '<div class="page"><div class="skel" style="height:28px;width:240px"></div><div class="skel" style="height:240px;margin-top:16px"></div></div>';
  try {
    const mod = await r.load();
    view.innerHTML = '';
    current = await mod.mount(view, { args: rest.map(decodeURIComponent), setCrumb: (t) => { $('#crumb').textContent = t || ''; } });
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="page"><div class="panel"><div class="panel-b"><b>This view failed to load.</b><div class="muted">${esc(e.message)}</div></div></div></div>`;
  }
  view.focus({ preventScroll: true });
}

// ------------------------------------------------------------ status: freshness of feeds + platform run
async function refreshStatus() {
  try {
    const [s, run] = await Promise.all([sources({ force: true }), obs('run.json').catch(() => null)]);
    const rows = s.sources || [];
    const ok = rows.filter((r) => !r.error).length;
    const cls = ok === rows.length ? 'ok' : ok >= rows.length - 3 ? 'warn' : 'alert';
    $('#status').innerHTML = `<span class="dot ${cls}"></span><span>${ok}/${rows.length} live feeds</span>`;
    $('#status').title = rows.filter((r) => r.error).map((r) => `${r.title}: ${r.error}`).join('\n') || 'All live feeds healthy';
    $('#nav-foot').innerHTML = `<div class="row"><span>Analytics run</span><span class="mono">${run ? ago(run.generated) : '–'}</span></div>
      <div class="row"><span>Insights</span><span class="mono">${run ? run.insights : '–'}</span></div>`;
  } catch {
    $('#status').innerHTML = '<span class="dot alert"></span><span>Server unreachable</span>';
  }
}

async function counts() {
  const out = {};
  try { out.insights = (await obs('insights.json')).count; } catch { /* not generated yet */ }
  try { out.datasets = (await obs('catalog.json')).datasets.length; } catch { /* ignore */ }
  renderNav(out);
}

// ------------------------------------------------------------ global search: addresses, insights, datasets
$('#q').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  if (!q) return;
  location.hash = /^\d/.test(q) ? `#/places/${encodeURIComponent(q)}` : `#/insights/q/${encodeURIComponent(q)}`;
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('#q').focus(); }
});
$('#theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('bo-theme', next); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('bo:theme', { detail: next }));
});

renderNav();
counts();
refreshStatus();
setInterval(refreshStatus, 60_000);
subscribe((ev) => { if (ev === 'hello' || ev === 'error') refreshStatus(); });
window.addEventListener('hashchange', route);
route();
