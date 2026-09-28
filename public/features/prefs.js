// Personalization: favorite buses (glance tile + optional "due now" heads-up), card layout (show/hide, pin to top,
// reorder), display options (compact density, summary line, glance tiles), install-as-app, and the service worker
// registration with an honest "offline: showing saved data" heads-up.
// ui keys: 'prefs.buses' ("route|headsign" list), 'prefs.busAlert' ('1'), 'prefs.hidden', 'prefs.pinned' (comma lists
// of card names), 'prefs.order' (JSON { sectionId: [names] }), 'prefs.compact', 'prefs.noSummary', 'prefs.noGlance'.
// Events: listens for 'prefs:open' (the ',' shortcut); emits 'prefs:changed'.
import { icon } from '../icons.js';

export default function init(api) {
  const { esc, openDialog, $$ } = api.util;
  const C = api.cards || {};
  const list = (k) => String(api.ui[k] || '').split(',').filter(Boolean);
  const busKey = (g) => `${g.route}|${g.headsign}`;
  const save = (k, v) => { api.setUI(k, v, { render: false }); api.emit('prefs:changed', k, v); };

  // ------------------------------------------------ my buses
  const eta = (a, now) => {
    const v = C.etaText ? C.etaText(a.t, now) : String(Math.round((a.t - now) / 60e3));
    return `<span data-eta="${a.t}">${esc(v)}</span>${v === 'now' ? '' : ' <small>min</small>'}`;
  };
  function favGroups(D, now) {
    const favs = new Set(list('prefs.buses'));
    const tr = D('transit');
    if (!favs.size || !tr || !C.liveGroups) return null;
    return C.liveGroups(tr, now).filter((g) => favs.has(busKey(g)) && g.arrivals && g.arrivals.length)
      .sort((a, b) => a.arrivals[0].t - b.arrivals[0].t);
  }
  api.registerTile({
    id: 'mybus', order: 150,
    render(D, ctx) {
      if (!list('prefs.buses').length) return null;
      const gs = favGroups(D, ctx.now);
      if (!gs) return null;
      if (!gs.length) return api.tile({ href: '#move', k: 'My buses', v: '—', s: 'none in the next 45 min' });
      const [g, ...rest] = gs;
      const label = `${g.route === 'D Line' ? 'D' : g.route} ${g.dir || g.headsign}`;
      return api.tile({ href: '#move', k: `My bus · ${esc(label)}`, v: eta(g.arrivals[0], ctx.now), s: rest.slice(0, 2).map((x) => `${esc(x.route === 'D Line' ? 'D' : x.route)} ${esc((x.dir || x.headsign).replace(/^to /, '→ '))} ${eta(x.arrivals[0], ctx.now)}`).join(' · ') || (g.arrivals[1] ? `then ${eta(g.arrivals[1], ctx.now)}` : '') });
    },
  });
  api.registerHeadsup({
    id: 'mybus', order: 290,
    render(D, ctx) {
      if (api.ui['prefs.busAlert'] !== '1') return null;
      const gs = favGroups(D, ctx.now) || [];
      return gs.filter((g) => g.arrivals[0].t - ctx.now <= 2 * 60e3).slice(0, 2).map((g) => api.hu({ cls: 'info', href: '#move', b: `${esc(g.route)} ${esc(g.dir || g.headsign)}`, small: `arriving ${eta(g.arrivals[0], ctx.now)}`.replace(' <small>min</small>', ' min') }));
    },
  });

  // ------------------------------------------------ card layout
  function sections() {
    return $$('main section.section').filter((s) => s.id !== 'health' && s.querySelector(':scope > .cards'));
  }
  const cardTitle = (el) => (el.querySelector('header h3') || {}).textContent || el.dataset.card;
  function pinnedGrid(create) {
    let sec = document.getElementById('pinned');
    if (!sec && create) {
      sec = document.createElement('section');
      sec.id = 'pinned';
      sec.className = 'section';
      sec.innerHTML = '<div class="section-head"><h2>Pinned</h2></div><div class="cards masonry"></div>';
      const before = document.getElementById('live') || document.getElementById('map-section');
      before.parentNode.insertBefore(sec, before);
    }
    return sec ? sec.querySelector('.cards') : null;
  }
  function apply() {
    const hidden = new Set(list('prefs.hidden'));
    const pinned = list('prefs.pinned');
    let order = {};
    try { order = JSON.parse(api.ui['prefs.order'] || '{}') || {}; } catch { order = {}; }
    const moved = [];
    // Unpin: back to the home section.
    for (const el of $$('#pinned [data-card]')) {
      if (pinned.includes(el.dataset.card)) continue;
      const home = el.dataset.home && document.querySelector(`#${CSS.escape(el.dataset.home)} > .cards`);
      if (home) { home.appendChild(el); moved.push(el); }
    }
    if (pinned.length) {
      const grid = pinnedGrid(true);
      for (const name of pinned) {
        const el = document.querySelector(`[data-card="${CSS.escape(name)}"]`);
        if (!el) continue;
        if (!el.dataset.home) el.dataset.home = el.closest('section').id;
        if (el.parentElement !== grid) moved.push(el);
        grid.appendChild(el); // appending in list order also orders them
      }
    }
    const pg = pinnedGrid(false);
    if (pg) pg.closest('section').hidden = !pg.children.length;
    // Order within each section (by the saved order, then data-order for the rest).
    for (const sec of sections()) {
      if (sec.id === 'pinned') continue;
      const grid = sec.querySelector(':scope > .cards');
      const saved = order[sec.id];
      const els = [...grid.children];
      const rank = (el) => { const i = Array.isArray(saved) ? saved.indexOf(el.dataset.card) : -1; return i >= 0 ? i : 1000 + (+el.dataset.order || 0); };
      const sorted = els.slice().sort((a, b) => rank(a) - rank(b));
      if (sorted.some((el, i) => el !== els[i])) sorted.forEach((el) => grid.appendChild(el));
    }
    for (const el of $$('[data-card]')) el.hidden = hidden.has(el.dataset.card);
    for (const el of moved) api.observeCard(el);
    document.documentElement.classList.toggle('compact', api.ui['prefs.compact'] === '1');
    const sum = document.getElementById('summary-line');
    if (sum) sum.classList.toggle('prefs-off', api.ui['prefs.noSummary'] === '1');
    document.getElementById('glance')?.classList.toggle('prefs-off', api.ui['prefs.noGlance'] === '1');
  }
  api.on('features', apply);
  api.on('prefs:changed', apply);
  apply();

  function move(name, dir) {
    const el = document.querySelector(`[data-card="${CSS.escape(name)}"]`);
    const sec = el && el.closest('section');
    if (!sec) return;
    if (sec.id === 'pinned') {
      const p = list('prefs.pinned');
      const i = p.indexOf(name), j = i + dir;
      if (i < 0 || j < 0 || j >= p.length) return;
      [p[i], p[j]] = [p[j], p[i]];
      save('prefs.pinned', p.join(','));
      return;
    }
    const names = [...sec.querySelector(':scope > .cards').children].map((x) => x.dataset.card);
    const i = names.indexOf(name), j = i + dir;
    if (j < 0 || j >= names.length) return;
    [names[i], names[j]] = [names[j], names[i]];
    let order = {};
    try { order = JSON.parse(api.ui['prefs.order'] || '{}') || {}; } catch { order = {}; }
    order[sec.id] = names;
    save('prefs.order', JSON.stringify(order));
  }

  // ------------------------------------------------ install + service worker + offline notice
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });
  let offlineSince = null;
  if ('serviceWorker' in navigator && (window.isSecureContext || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.info('[prefs] service worker not registered:', err && err.message));
    navigator.serviceWorker.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m.type === 'bl-offline') { if (!offlineSince) offlineSince = m.savedAt || Date.now(); api.invalidate('headsup'); }
      if (m.type === 'bl-online' && offlineSince) { offlineSince = null; api.invalidate('headsup'); }
    });
  }
  api.registerHeadsup({
    id: 'sw-offline', order: 1,
    render: () => (offlineSince ? api.hu({ cls: 'warn', b: 'Offline', small: 'showing the data saved on this device; it refreshes when the server is back' }) : null),
  });

  // ------------------------------------------------ the settings dialog
  function busRows() {
    const tr = api.D('transit');
    const favs = new Set(list('prefs.buses'));
    const groups = tr && C.liveGroups ? C.liveGroups(tr, Date.now()) : [];
    const known = new Map(groups.map((g) => [busKey(g), g]));
    for (const k of favs) if (!known.has(k)) { const [route, headsign] = k.split('|'); known.set(k, { route, headsign, dir: headsign, stopName: '(no arrivals right now)' }); }
    if (!known.size) return '<p class="bl-note">Bus data hasn\'t loaded yet.</p>';
    return [...known.values()].map((g) => `<label class="bl-check"><input type="checkbox" data-p-bus="${esc(busKey(g))}" ${favs.has(busKey(g)) ? 'checked' : ''}>
      ${C.routeBadge ? C.routeBadge(g.route, true) : esc(g.route)} <span>${esc(g.dir || g.headsign)} <span class="bl-note">· ${esc(g.stopName || '')}</span></span></label>`).join('');
  }
  function cardRows() {
    const hidden = new Set(list('prefs.hidden'));
    const pinned = new Set(list('prefs.pinned'));
    return sections().map((sec) => {
      const cards = [...sec.querySelectorAll(':scope > .cards > [data-card]')];
      if (!cards.length) return '';
      const title = (sec.querySelector('.section-head h2') || {}).textContent || sec.id;
      return `<div class="pf-sec"><div class="pf-sec-t">${esc(title)}</div>${cards.map((el, i) => {
        const n = el.dataset.card, t = cardTitle(el);
        return `<div class="pf-card"><label class="bl-check"><input type="checkbox" data-p-show="${esc(n)}" ${hidden.has(n) ? '' : 'checked'}> ${esc(t)}</label>
          <span class="pf-actions"><button type="button" class="pf-b" data-p-pin="${esc(n)}" aria-pressed="${pinned.has(n)}" title="${pinned.has(n) ? 'Unpin' : 'Pin to top'}" aria-label="${pinned.has(n) ? 'Unpin' : 'Pin'} ${esc(t)}">${pinned.has(n) ? '★' : '☆'}</button>
          <button type="button" class="pf-b" data-p-up="${esc(n)}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(t)} up">↑</button>
          <button type="button" class="pf-b" data-p-down="${esc(n)}" ${i === cards.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(t)} down">↓</button></span></div>`;
      }).join('')}</div>`;
    }).join('');
  }
  function html() {
    return `<h4>My buses</h4><p class="bl-note">Favorites appear as the first glance tile.</p>${busRows()}
      <label class="bl-check"><input type="checkbox" data-p="busAlert" ${api.ui['prefs.busAlert'] === '1' ? 'checked' : ''}> Heads-up when a favorite bus is 2 minutes away</label>
      <h4>Display</h4>
      <label class="bl-check"><input type="checkbox" data-p="compact" ${api.ui['prefs.compact'] === '1' ? 'checked' : ''}> Compact layout</label>
      <label class="bl-check"><input type="checkbox" data-p="summary" ${api.ui['prefs.noSummary'] === '1' ? '' : 'checked'}> "Now in Ballard" summary line</label>
      <label class="bl-check"><input type="checkbox" data-p="glance" ${api.ui['prefs.noGlance'] === '1' ? '' : 'checked'}> Glance tiles</label>
      <h4>Cards</h4><p class="bl-note">Hide cards, pin them to a section at the top (★), or move them within their section.</p>${cardRows()}
      <h4>App</h4>
      <div class="bl-row">${installEvt ? '<button type="button" class="bl-btn primary" data-p-act="install">Install Ballard Live as an app</button>' : '<span class="bl-note">To install it as an app, use your browser\'s "Install" or "Add to Home Screen" option. It works offline with the last saved data.</span>'}</div>
      <div class="bl-row"><a class="bl-btn" href="?kiosk=1">Open in kiosk mode</a><span class="bl-note">Full-screen wall display that cycles through the sections (or press <span class="bl-kbd">k</span>).</span></div>
      <h4>Reset</h4>
      <div class="bl-row"><button type="button" class="bl-btn" data-p-act="reset-layout">Reset card layout</button><button type="button" class="bl-btn danger" data-p-act="clear">Clear all saved settings</button></div>
      <p class="bl-note">Settings are saved in this browser only. Press <span class="bl-kbd">?</span> for keyboard shortcuts.</p>`;
  }
  function openPanel() {
    let offSource = null;
    const d = openDialog({ id: 'prefs-dlg', title: 'Settings', html: html(), wide: true, onClose: () => offSource && offSource() });
    if (!d) return;
    // Bus data may arrive after the panel opened (e.g. via /?panel=settings): refresh that list once it does.
    if (!api.D('transit')) offSource = api.on('source', (id) => { if (id === 'transit' && api.D('transit')) { offSource(); offSource = null; rerender(); } });
    const rerender = (focusSel) => {
      const y = d.el.scrollTop;
      d.body.innerHTML = html();
      d.el.scrollTop = y;
      const f = focusSel && d.body.querySelector(focusSel);
      if (f && !f.disabled) f.focus({ preventScroll: true });
    };
    d.body.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.pBus) {
        const s = new Set(list('prefs.buses'));
        if (t.checked) s.add(t.dataset.pBus); else s.delete(t.dataset.pBus);
        save('prefs.buses', [...s].join(',') || null);
        api.invalidate('glance', 'headsup');
      } else if (t.dataset.pShow) {
        const s = new Set(list('prefs.hidden'));
        if (t.checked) s.delete(t.dataset.pShow); else s.add(t.dataset.pShow);
        save('prefs.hidden', [...s].join(',') || null);
      } else if (t.dataset.p === 'busAlert') { save('prefs.busAlert', t.checked ? '1' : null); api.invalidate('headsup'); }
      else if (t.dataset.p === 'compact') save('prefs.compact', t.checked ? '1' : null);
      else if (t.dataset.p === 'summary') save('prefs.noSummary', t.checked ? null : '1');
      else if (t.dataset.p === 'glance') save('prefs.noGlance', t.checked ? null : '1');
    });
    d.body.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.pPin) {
        const p = list('prefs.pinned');
        const i = p.indexOf(t.dataset.pPin);
        if (i >= 0) p.splice(i, 1); else p.push(t.dataset.pPin);
        save('prefs.pinned', p.join(',') || null);
        rerender(`[data-p-pin="${CSS.escape(t.dataset.pPin)}"]`);
      } else if (t.dataset.pUp || t.dataset.pDown) {
        const n = t.dataset.pUp || t.dataset.pDown;
        move(n, t.dataset.pUp ? -1 : 1);
        rerender(`[data-p-${t.dataset.pUp ? 'up' : 'down'}="${CSS.escape(n)}"]`);
      } else if (t.dataset.pAct === 'install' && installEvt) {
        installEvt.prompt();
        try { await installEvt.userChoice; } catch { /* ignore */ }
        installEvt = null;
        rerender();
      } else if (t.dataset.pAct === 'reset-layout') {
        for (const k of ['prefs.hidden', 'prefs.pinned', 'prefs.order']) api.setUI(k, null, { render: false });
        api.emit('prefs:changed');
        location.reload();
      } else if (t.dataset.pAct === 'clear') {
        if (t.dataset.confirm !== '1') { t.dataset.confirm = '1'; t.textContent = 'Click again to clear everything'; return; }
        try { for (const k of Object.keys(localStorage)) if (k.startsWith('bl-')) localStorage.removeItem(k); } catch { /* ignore */ }
        location.reload();
      }
    });
  }
  api.addHeaderButton({ id: 'prefs-btn', html: icon('gear', { size: 17 }), title: 'Settings (,)', onClick: openPanel });
  api.on('prefs:open', openPanel);
}
