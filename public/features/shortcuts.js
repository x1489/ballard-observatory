// Keyboard shortcuts (ignored while typing): ? help · t theme · k kiosk · n notifications · , settings ·
// 1-7 jump to sections · m map · / filter cards by title · Esc closes the filter.
const SECTIONS = [['1', 'live', 'Live'], ['2', 'map-section', 'Map'], ['3', 'weather', 'Weather'], ['4', 'water', 'Water & Locks'], ['5', 'move', 'Getting around'], ['6', 'safety', 'Safety'], ['7', 'community', 'Community'], ['8', 'health', 'Feed health']];

export default function init(api) {
  const { esc, openDialog, reducedMotion, $$ } = api.util;
  const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  const jump = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    const h = el.querySelector('h2');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  };

  // ---------------------------------------------- quick card filter
  let filterEl = null;
  function openFilter() {
    if (filterEl) { filterEl.querySelector('input').focus(); return; }
    filterEl = document.createElement('div');
    filterEl.className = 'sc-filter';
    filterEl.innerHTML = '<label class="sr-only" for="sc-q">Filter cards</label><input id="sc-q" type="search" placeholder="Filter cards… (Esc to clear)" autocomplete="off"><span class="sc-count" aria-live="polite"></span>';
    document.body.appendChild(filterEl);
    const input = filterEl.querySelector('input');
    const count = filterEl.querySelector('.sc-count');
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      let n = 0;
      for (const card of $$('[data-card]')) {
        const t = ((card.querySelector('header h3') || {}).textContent || '').toLowerCase();
        const match = !q || t.includes(q) || card.dataset.card.includes(q);
        card.classList.toggle('sc-miss', !match);
        if (match && q) n++;
      }
      for (const sec of $$('main section.section')) sec.classList.toggle('sc-empty', !!q && !sec.querySelector('[data-card]:not(.sc-miss)') && sec.querySelector('[data-card]'));
      count.textContent = q ? `${n} match${n === 1 ? '' : 'es'}` : '';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeFilter(); }
      if (e.key === 'Enter') { const first = document.querySelector('[data-card]:not(.sc-miss)'); if (first) first.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' }); }
    });
    input.focus();
  }
  function closeFilter() {
    if (!filterEl) return;
    for (const c of $$('.sc-miss')) c.classList.remove('sc-miss');
    for (const s of $$('.sc-empty')) s.classList.remove('sc-empty');
    filterEl.remove();
    filterEl = null;
  }

  // ---------------------------------------------- help
  const KEYS = [
    ['?', 'Show this help'], ['⌘K / Ctrl+K', 'Ask Ballard (questions, voice)'], ['t', 'Toggle light / dark theme'], ['k', 'Kiosk mode (wall display)'], ['n', 'Notifications'], [',', 'Settings'],
    ['m', 'Jump to the map'], ['/', 'Filter cards by title'], ...SECTIONS.map(([k, , name]) => [k, `Jump to ${name}`]), ['Esc', 'Close a panel or the filter'],
  ];
  function help() {
    openDialog({ id: 'shortcuts-dlg', title: 'Keyboard shortcuts', html: `<table class="sc-table">${KEYS.map(([k, d]) => `<tr><td><span class="bl-kbd">${esc(k)}</span></td><td>${esc(d)}</td></tr>`).join('')}</table>
      <p class="bl-note">Shortcuts are off while you type in a text field.</p>` });
  }

  // Deep links: /?panel=settings | notifications | shortcuts opens that panel once the features are ready.
  api.on('features', () => {
    const p = new URLSearchParams(location.search).get('panel');
    if (p === 'settings') api.emit('prefs:open');
    else if (p === 'notifications') api.emit('notify:open');
    else if (p === 'shortcuts') help();
  });

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (typing(e.target)) return;
    if (document.querySelector('.bl-dialog') && e.key !== '?') return;
    const k = e.key;
    let handled = true;
    if (k === '?') help();
    else if (k === 't') document.getElementById('theme-btn')?.click();
    else if (k === 'k') api.emit('kiosk:toggle');
    else if (k === 'n') api.emit('notify:open');
    else if (k === ',') api.emit('prefs:open');
    else if (k === 'm') { jump('map-section'); document.getElementById('map')?.focus({ preventScroll: true }); }
    else if (k === '/') openFilter();
    else if (k === 'Escape' && filterEl) closeFilter();
    else {
      const s = SECTIONS.find(([key]) => key === k);
      if (s) jump(s[1]); else handled = false;
    }
    if (handled) e.preventDefault();
  });
}
