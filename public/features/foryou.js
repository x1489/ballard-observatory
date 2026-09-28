// For You: learns which cards you care about, and when, entirely in this browser (localStorage 'bl-engage'):
// on-screen dwell time per card, clicks inside cards, and the kinds of questions asked in Ask Ballard, bucketed by
// Pacific hour of day with a 7-day half-life. A compact "For you this morning" row then shows live mini-cards for
// what you usually check at this hour (sensible time-of-day defaults until it has learned), each jumping to its card.
import { SUMMARY, CARD_SUMMARY } from '../insight.js';
import { icon } from '../icons.js';

const KEY = 'bl-engage';
const HALF_LIFE = 7 * 24 * 3600e3;
const ASK_TO_CARD = { bus: 'transit', bridge: 'bridges', tide: 'tides', weather: 'now', sun: 'sun', air: 'air', fire: 'fire', aircraft: 'aircraft', events: 'events', news: 'news', salmon: 'salmon', wildlife: 'wildlife', locks: 'locks', power: 'outages', quake: 'quakes', open: 'open', scooter: 'lime', camera: 'cameras', traffic: 'traffic', boating: 'water-wx' };
// Cold start: what people usually want at each time of day.
const DEFAULTS = [[5, 10, ['transit', 'now', 'traffic', 'bridges']], [10, 15, ['now', 'tides', 'events', 'wildlife']], [15, 19, ['traffic', 'transit', 'bridges', 'events']], [19, 24, ['events', 'sun', 'aircraft', 'now']], [0, 5, ['now', 'fire', 'aircraft', 'sun']]];

export default function init(api) {
  const u = api.util;
  const { esc, isNum, pparts, reducedMotion } = u;
  let st = load();

  function load() {
    try {
      const j = JSON.parse(localStorage.getItem(KEY) || '{}');
      const s = j && j.cards ? j : { cards: {}, at: Date.now(), n: 0 };
      const f = Math.pow(0.5, Math.max(0, Date.now() - (s.at || Date.now())) / HALF_LIFE); // decay since last save
      for (const c of Object.values(s.cards)) { c.score *= f; c.hours = (c.hours || []).map((x) => x * f); }
      return s;
    } catch { return { cards: {}, at: Date.now(), n: 0 }; }
  }
  let saveT = 0;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { st.at = Date.now(); try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* ignore */ } }, 1500); };
  function bump(name, pts) {
    if (!name) return;
    const h = pparts(Date.now()).hh;
    const c = st.cards[name] || (st.cards[name] = { score: 0, hours: Array(24).fill(0) });
    if (!Array.isArray(c.hours) || c.hours.length !== 24) c.hours = Array(24).fill(0);
    c.score += pts;
    c.hours[h] += pts;
    st.n = (st.n || 0) + pts;
    save();
  }

  // ---------------------------------------------- signals
  const visibleSince = new Map();
  const io = new IntersectionObserver((es) => {
    for (const e of es) {
      const name = e.target.dataset.card;
      if (e.isIntersecting && e.intersectionRatio >= 0.55) visibleSince.set(name, Date.now());
      else if (visibleSince.has(name)) { credit(name, visibleSince.get(name)); visibleSince.delete(name); }
    }
  }, { threshold: [0, 0.55] });
  function credit(name, since) {
    const secs = Math.min(90, (Date.now() - since) / 1000);
    if (secs >= 2.5 && document.visibilityState === 'visible' && !document.documentElement.classList.contains('bl-modal-open')) bump(name, secs / 10);
  }
  const watch = () => { for (const el of document.querySelectorAll('[data-card]')) if (!el._blIO) { el._blIO = true; io.observe(el); } };
  setInterval(() => { for (const [name, since] of visibleSince) { credit(name, since); visibleSince.set(name, Date.now()); } }, 15000);
  document.addEventListener('pointerdown', (e) => { const c = e.target.closest && e.target.closest('[data-card]'); if (c) bump(c.dataset.card, 2); }, { passive: true });
  api.on('ask:asked', (x) => { if (x && ASK_TO_CARD[x.intent]) bump(ASK_TO_CARD[x.intent], 4); });
  api.on('features', watch);
  new MutationObserver(watch).observe(document.querySelector('main'), { childList: true, subtree: true });

  // ---------------------------------------------- summaries for cards without one in insight
  const EXTRA = {
    events: (D, now) => { const ev = D('events'); const n = ((ev && ev.events) || []).filter((e) => !e.canceled && e.start > now && e.start - now < 12 * 3600e3).length; return ev ? { icon: 'event', label: 'Events', value: String(n), sub: n ? 'in the next 12 hours' : 'none soon' } : null; },
    news: (D) => { const n = D('news'); const it = n && (n.items || []).find((x) => x.ballard); return it ? { icon: 'news', label: 'Ballard news', value: '', sub: it.title } : null; },
    salmon: (D) => { const s = D('salmon'); const sp = s && (s.species || []).filter((x) => x.latestCount > 0).sort((a, b) => b.latestCount - a.latestCount)[0]; return sp ? { icon: 'wildlife', label: `${sp.name} at the Locks`, value: sp.latestCount.toLocaleString(), sub: `on ${sp.latestDate}` } : null; },
    wildlife: (D) => { const w = D('wildlife'); return w && w.counts ? { icon: 'wildlife', label: 'Wildlife', value: String(w.counts.species), sub: 'species in 14 days' } : null; },
    fire: SUMMARY.fire, quakes: (D) => { const q = D('quakes'); const x = q && [...(q.notable || []), ...(q.recent || [])].sort((a, b) => b.t - a.t)[0]; return x ? { icon: 'quake', label: 'Latest quake', value: `M${x.mag.toFixed(1)}`, sub: x.place } : null; },
    outages: (D) => { const o = D('outages'); return o ? { icon: 'power', label: 'Power', value: (o.ballard || []).length ? 'Outage' : 'On', sub: (o.ballard || []).length ? `${o.ballard.length} in Ballard` : 'no outages in Ballard', tone: (o.ballard || []).length ? 'warn' : 'ok' } : null; },
    open: () => null, cameras: (D) => { const c = D('cameras'); return c ? { icon: 'camera', label: 'Cameras', value: String((c.cameras || []).filter((x) => x.ok).length), sub: 'live + time-lapse' } : null; },
    'water-wx': (D) => { const wp = D('westpoint'); return wp && isNum(wp.windKt) ? { icon: 'water', label: 'West Point wind', value: `${Math.round(wp.windKt)} kt`, sub: 'on the Sound' } : null; },
  };
  const summaryFor = (name, D, now) => {
    const k = CARD_SUMMARY[name];
    try { return (k && SUMMARY[k] ? SUMMARY[k](D, now) : EXTRA[name] ? EXTRA[name](D, now) : null); } catch { return null; }
  };

  // ---------------------------------------------- picks
  function picks(now) {
    const h = pparts(now).hh;
    const learned = (st.n || 0) >= 25;
    const scored = Object.entries(st.cards).map(([name, c]) => {
      const around = (c.hours[h] || 0) * 2 + (c.hours[(h + 23) % 24] || 0) + (c.hours[(h + 1) % 24] || 0);
      return { name, s: around * 1.5 + c.score * 0.25 };
    }).filter((x) => x.s > 0.5).sort((a, b) => b.s - a.s).map((x) => x.name);
    const def = (DEFAULTS.find(([a, b]) => h >= a && h < b) || DEFAULTS[0])[2];
    const order = learned ? [...scored, ...def] : [...def, ...scored];
    const out = [];
    for (const name of order) {
      if (out.some((x) => x.name === name) || !document.querySelector(`[data-card="${CSS.escape(name)}"]`)) continue;
      const s = summaryFor(name, api.D, now);
      if (s) out.push({ name, ...s });
      if (out.length >= 4) break;
    }
    return { learned, items: out };
  }

  // ---------------------------------------------- the row
  const row = document.createElement('section');
  row.className = 'fy';
  row.setAttribute('aria-label', 'For you');
  const anchor = document.getElementById('glance');
  anchor.parentNode.insertBefore(row, anchor);
  const part = (h) => (h < 5 ? 'tonight' : h < 12 ? 'this morning' : h < 17 ? 'this afternoon' : 'this evening');
  function render() {
    const now = Date.now();
    const { learned, items } = picks(now);
    if (!items.length) { row.hidden = true; return; }
    row.hidden = false;
    const title = learned ? `For you ${part(pparts(now).hh)}` : `Suggested for ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long' }).format(now)} ${part(pparts(now).hh)}`;
    api.setHTML(row, `<div class="fy-head"><span class="fy-title">${icon('heart', { size: 14 })} ${esc(title)}</span><span class="fy-note">${learned ? 'based on what you check at this time of day' : 'learns your routine as you use it'}</span></div>
      <div class="fy-row" style="--n:${items.length}">${items.map((x) => `<button type="button" class="fy-card ${x.tone === 'warn' ? 'warn' : ''}" data-fy="${esc(x.name)}"><span class="fy-ico">${icon(x.icon || 'sparkle', { size: 18 })}</span><span class="fy-txt"><span class="fy-label">${esc(x.label)}</span>${x.value ? `<span class="fy-val">${esc(x.value)}</span>` : ''}<span class="fy-sub">${esc(x.sub || '')}</span></span></button>`).join('')}</div>`);
  }
  row.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fy]');
    if (!b) return;
    const el = document.querySelector(`[data-card="${CSS.escape(b.dataset.fy)}"]`);
    if (!el) return;
    bump(b.dataset.fy, 3);
    el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
    el.classList.add('fy-flash');
    setTimeout(() => el.classList.remove('fy-flash'), 1600);
  });
  let last = 0;
  api.on('render', () => { if (Date.now() - last > 5000) { last = Date.now(); render(); } });
  api.on('minute', render);
  api.on('features', () => { watch(); render(); });
  render();
}
