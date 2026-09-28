// Live activity feed: the server's detectors (bridge openings, 911 calls, alerts, rain, outages, news, wildlife,
// aircraft, ...) as a live card with filters, a "since you were last here" marker, toasts for important items,
// click-to-locate on the map, a map layer of recent located items, and an unread count in the tab title.
// ui keys: 'activity.hidden' (comma list of hidden kinds), 'activity.min' ('all' | 'notice').
import { icon as svg, KIND } from '../icons.js';

/** kind -> [icon markup, label] (line icons from icons.js, tinted by severity in CSS). */
export const KINDS = Object.fromEntries(Object.entries(KIND).map(([k, [name, label]]) => [k, [svg(name, { size: 16 }), label]]));
const DOT = svg('dot', { size: 14 });
const SEV_RANK = { info: 0, notice: 1, warn: 2, alert: 3 };
const SEEN_KEY = 'bl-activity-seen';

export default function init(api) {
  const { esc, href, isNum, time, dayLabel, dayKey, relEl, newBadge, reducedMotion, plural } = api.util;
  const pageLoad = Date.now();
  let lastVisit = 0;
  try { lastVisit = +localStorage.getItem(SEEN_KEY) || 0; } catch { /* private mode */ }
  const arrived = new Map(); // id -> arrival time (items that came in live during this page session)
  const animate = new Set();  // ids to animate in on the next render
  let limit = 60;
  let unread = 0;
  const baseTitle = document.title;

  const hidden = () => new Set(String(api.ui['activity.hidden'] || '').split(',').filter(Boolean));
  const minSev = () => (api.ui['activity.min'] === 'notice' ? 1 : 0);
  const items = () => api.activity.items();
  const visible = () => {
    const h = hidden(), m = minSev();
    return items().filter((it) => !h.has(it.kind) && (SEV_RANK[it.severity] || 0) >= m);
  };

  function groupLabel(t, now) {
    if (now - t < 15 * 60e3) return 'Just now';
    if (dayKey(t) === dayKey(now)) return 'Earlier today';
    if (dayKey(t) === dayKey(now - 86400e3)) return 'Yesterday';
    return dayLabel(t);
  }

  function itemHTML(it, now) {
    const [icon, label] = KINDS[it.kind] || [DOT, it.kind || 'Update'];
    const fresh = arrived.has(it.id) && now - arrived.get(it.id) < 10 * 60e3;
    const since = !fresh && lastVisit && it.t > lastVisit && it.t <= pageLoad;
    const locate = isNum(it.lat) && isNum(it.lon)
      ? `<button type="button" class="act-loc" data-act-loc="${esc(it.id)}" title="Show on map" aria-label="Show ${esc(it.title)} on the map">${svg('pin', { size: 15 })}</button>` : '';
    const title = it.link ? `<a href="${href(it.link)}" target="_blank" rel="noopener">${esc(it.title)}</a>` : esc(it.title);
    return `<li class="act-item sev-${esc(it.severity)}${animate.has(it.id) ? ' act-in' : ''}" data-id="${esc(it.id)}">
      <span class="act-ico" title="${esc(label)}" aria-hidden="true">${icon}</span>
      <div class="grow"><div class="act-title">${title}${fresh ? ' ' + newBadge() : since ? ' <span class="act-since" title="New since your last visit">•</span>' : ''}</div>
      ${it.detail ? `<div class="sub act-detail">${esc(it.detail)}</div>` : ''}</div>
      <div class="act-meta"><span class="t">${time(it.t)}</span><span class="t faint">${relEl(it.t)}</span>${locate}</div></li>`;
  }

  function render(D, ctx) {
    const sup = api.activity.supported();
    const all = items();
    if (sup === false) return '<div class="empty">This server has no activity feed. Restart it on the latest version.</div>';
    if (sup == null && !all.length) return null;
    const now = ctx.now;
    const list = visible();
    const h = hidden();
    const kindsPresent = [...new Set(all.map((x) => x.kind))].filter((k) => KINDS[k]);
    const chips = kindsPresent.map((k) => `<button type="button" class="chip act-chip ${h.has(k) ? '' : 'on'}" data-act-kind="${esc(k)}" aria-pressed="${!h.has(k)}">${svg(KIND[k][0], { size: 13 })} ${esc(KINDS[k][1])}</button>`).join('');
    const sinceItems = lastVisit ? all.filter((it) => it.t > lastVisit && it.t <= pageLoad) : [];
    let sinceLine = '';
    if (sinceItems.length) {
      const by = {};
      for (const it of sinceItems) by[it.kind] = (by[it.kind] || 0) + 1;
      const parts = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `<span class="act-sum">${svg((KIND[k] || ['info'])[0], { size: 13 })} ${n}</span>`).join(' ');
      sinceLine = `<div class="act-since-line"><b>${plural(sinceItems.length, 'update')} since you were last here</b> <span class="muted">(${esc(dayLabel(lastVisit))} ${time(lastVisit)})</span> <span class="small">${parts}</span></div>`;
    }
    let html = `<div class="act-controls"><div class="act-chips" role="group" aria-label="Filter by kind">${chips}</div>
      <div class="seg" role="group" aria-label="Importance"><button type="button" data-act-min="all" class="${minSev() ? '' : 'on'}" aria-pressed="${!minSev()}">All</button><button type="button" data-act-min="notice" class="${minSev() ? 'on' : ''}" aria-pressed="${!!minSev()}">Important</button></div></div>${sinceLine}`;
    if (!list.length) return html + `<div class="empty">${all.length ? 'Nothing matches these filters.' : 'No activity yet. Bridge openings, 911 calls, alerts, rain, new stories and more will appear here as they happen.'}</div>`;
    html += '<div class="scroll act-scroll"><ul class="list act-list">';
    let group = null;
    let dividerDone = !lastVisit;
    for (const it of list.slice(0, limit)) {
      const g = groupLabel(it.t, now);
      if (!dividerDone && it.t <= lastVisit) {
        dividerDone = true;
        html += `<li class="act-divider" role="separator"><span>Last visit · ${time(lastVisit)}</span></li>`;
      }
      if (g !== group) { group = g; html += `<li class="act-group">${esc(g)}</li>`; }
      html += itemHTML(it, now);
    }
    html += '</ul>';
    if (list.length > limit) html += `<button type="button" class="act-more" data-act-more>Show ${Math.min(60, list.length - limit)} more</button>`;
    return html + '</div>';
  }

  api.registerCard('activity', {
    deps: [], title: 'Live activity', section: 'live', wide: true, order: 10,
    render,
    after() { animate.clear(); },
  });

  // Card interactions (delegated; the card body is re-rendered often).
  document.addEventListener('click', (ev) => {
    const kind = ev.target.closest('[data-act-kind]');
    if (kind) {
      const h = hidden();
      const k = kind.dataset.actKind;
      if (h.has(k)) h.delete(k); else h.add(k);
      api.setUI('activity.hidden', [...h].join(',') || null, { render: false });
      api.invalidate('activity');
      return;
    }
    const min = ev.target.closest('[data-act-min]');
    if (min) { api.setUI('activity.min', min.dataset.actMin === 'notice' ? 'notice' : null, { render: false }); api.invalidate('activity'); return; }
    if (ev.target.closest('[data-act-more]')) { limit += 60; api.invalidate('activity'); return; }
    const loc = ev.target.closest('[data-act-loc]');
    if (loc) { const it = items().find((x) => String(x.id) === loc.dataset.actLoc); if (it) locate(it); }
  });

  // ------------------------------------------------ locate on the map
  let tempMarker = null, tempTimer = null;
  function locate(it) {
    const m = api.map.getMap && api.map.getMap();
    if (!m || !window.L) return;
    const sec = document.getElementById('map-section');
    if (sec) sec.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    if (tempMarker) tempMarker.remove();
    clearTimeout(tempTimer);
    tempMarker = L.marker([it.lat, it.lon], { icon: L.divIcon({ className: '', html: `<div class="act-pin sev-${esc(it.severity)}">${(KINDS[it.kind] || [DOT])[0]}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }), zIndexOffset: 2000 })
      .addTo(m).bindPopup(`<b>${esc(it.title)}</b>${it.detail ? `<br><span class="small">${esc(it.detail)}</span>` : ''}<br><span class="muted small">${time(it.t)} · ${esc(dayLabel(it.t))}</span>`);
    m.flyTo([it.lat, it.lon], Math.max(m.getZoom(), 15), { duration: reducedMotion() ? 0 : 0.8 });
    setTimeout(() => tempMarker && tempMarker.openPopup(), reducedMotion() ? 0 : 850);
    tempTimer = setTimeout(() => { if (tempMarker) tempMarker.remove(); tempMarker = null; }, 60000);
  }

  // ------------------------------------------------ map layer: recent located items
  api.registerLayer({
    key: 'activity', label: 'Recent activity', color: '#f43f5e', on: true, deps: [],
    draw(g, { now, add }) {
      for (const it of items()) {
        if (!isNum(it.lat) || !isNum(it.lon) || now - it.t > 3 * 3600e3 || it.t > now + 60e3) continue;
        const recent = now - it.t < 10 * 60e3;
        add(L.marker([it.lat, it.lon], {
          icon: L.divIcon({ className: '', html: `<div class="act-dot sev-${esc(it.severity)}${recent ? ' recent' : ''}" title="${esc(it.title)}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }),
          opacity: Math.max(0.45, 1 - (now - it.t) / (3 * 3600e3)),
        }).bindPopup(`<span class="act-pop-ico">${(KINDS[it.kind] || [DOT])[0]}</span> <b>${esc(it.title)}</b>${it.detail ? `<br><span class="small">${esc(it.detail)}</span>` : ''}<br><span class="muted small">${time(it.t)}</span>${it.link ? `<br><a href="${href(it.link)}" target="_blank" rel="noopener">More</a>` : ''}`), it.id);
      }
    },
    count: () => items().filter((it) => isNum(it.lat) && Date.now() - it.t < 3 * 3600e3).length || null,
  });
  api.on('minute', () => api.map.drawLayer && api.map.drawLayer('activity'));

  // ------------------------------------------------ toasts
  const region = document.createElement('div');
  region.className = 'act-toasts';
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-label', 'Live updates');
  document.body.appendChild(region);
  function toast(it) {
    while (region.children.length >= 3) region.firstElementChild.remove();
    const el = document.createElement('div');
    el.className = `act-toast sev-${it.severity}`;
    el.innerHTML = `<span class="act-ico" aria-hidden="true">${(KINDS[it.kind] || [DOT])[0]}</span><div class="grow"><b>${esc(it.title)}</b>${it.detail ? `<div class="small">${esc(it.detail)}</div>` : ''}</div><button type="button" class="act-x" aria-label="Dismiss">${svg('close', { size: 14 })}</button>`;
    let timer = null;
    const close = () => { clearTimeout(timer); el.classList.add('out'); setTimeout(() => el.remove(), reducedMotion() ? 0 : 250); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(close, 8000); };
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', arm);
    el.addEventListener('focusin', () => clearTimeout(timer));
    el.querySelector('.act-x').addEventListener('click', close);
    el.addEventListener('click', (e) => {
      if (e.target.closest('.act-x')) return;
      if (isNum(it.lat) && isNum(it.lon)) locate(it);
      else document.getElementById('live')?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth' });
      close();
    });
    region.appendChild(el);
    arm();
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && region.lastElementChild && !document.querySelector('[role="dialog"]:not([hidden])')) region.lastElementChild.querySelector('.act-x')?.click(); });

  // ------------------------------------------------ new items
  api.on('activity', (it) => {
    const now = Date.now();
    arrived.set(it.id, now);
    if (!reducedMotion()) animate.add(it.id);
    api.invalidate('activity');
    if (api.map.drawLayer) api.map.drawLayer('activity');
    const important = (SEV_RANK[it.severity] || 0) >= 2 || (it.kind === 'bridge' && it.severity === 'notice');
    if (important && now - it.t < 30 * 60e3) toast(it);
    if (document.visibilityState === 'hidden' && (SEV_RANK[it.severity] || 0) >= 1) {
      unread++;
      document.title = `(${unread}) ${baseTitle}`;
    }
  });
  api.activity.ready.then(() => api.invalidate('activity')).catch(() => {});
  api.on('activity:locate', (it) => { if (it && isNum(it.lat) && isNum(it.lon)) locate(it); }); // e.g. a notification click

  // ------------------------------------------------ last-seen bookkeeping
  const markSeen = () => {
    const newest = items()[0];
    try { localStorage.setItem(SEEN_KEY, String(Math.max(Date.now(), newest ? newest.t : 0))); } catch { /* ignore */ }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { unread = 0; document.title = baseTitle; }
    else markSeen();
  });
  window.addEventListener('pagehide', markSeen);
}
