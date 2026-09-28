// Opt-in browser notifications for live activity (Notification API), with per-kind rules, a minimum importance,
// "only when this tab is hidden", quiet hours, an optional chime, and throttling (at most one per 20 s; the rest
// are batched into "N more updates"). ui keys: 'notify.on', 'notify.rules' (comma list), 'notify.hiddenOnly'
// ('0' = always), 'notify.sound' ('1'), 'notify.quiet' ('22-7' style range or null).
// Events: listens for 'notify:open' (e.g. the 'n' shortcut); emits 'notify:changed'.
import { icon } from '../icons.js';

export const RULES = [
  { id: 'bridge', label: 'Ballard or Fremont Bridge goes up', def: true, match: (it) => it.kind === 'bridge' && /\b(ballard|fremont)\b/i.test(it.title) && /\bUP\b/.test(it.title) },
  { id: 'fire', label: 'Serious 911 calls nearby (fires, rescues, crashes)', def: true, match: (it) => it.kind === 'fire' && rank(it) >= 1 },
  { id: 'alert', label: 'Weather and marine alerts', def: true, match: (it) => it.kind === 'alert' && !/ended$/i.test(it.title) },
  { id: 'rain', label: 'Rain starting soon', def: true, match: (it) => it.kind === 'weather' && /^Rain starting/i.test(it.title) },
  { id: 'power', label: 'Power outages in Ballard', def: true, match: (it) => it.kind === 'power' },
  { id: 'quake', label: 'Earthquakes', def: true, match: (it) => it.kind === 'quake' },
  { id: 'aircraft', label: 'Aircraft emergencies overhead', def: true, match: (it) => it.kind === 'aircraft' && rank(it) >= 3 },
  { id: 'transit', label: 'Bus delays and Metro alerts', def: false, match: (it) => it.kind === 'transit' },
  { id: 'air', label: 'Air quality changes', def: false, match: (it) => it.kind === 'air' },
  { id: 'water', label: 'Sewer overflows, surges and extreme tides', def: false, match: (it) => it.kind === 'water' },
  { id: 'locks', label: 'Locks closures and queues', def: false, match: (it) => it.kind === 'locks' && rank(it) >= 1 },
  { id: 'wildlife', label: 'Notable wildlife sightings', def: false, match: (it) => it.kind === 'wildlife' && rank(it) >= 1 },
  { id: 'news', label: 'New Ballard news stories', def: false, match: (it) => it.kind === 'news' && rank(it) >= 1 },
];
const SEV = { info: 0, notice: 1, warn: 2, alert: 3 };
function rank(it) { return SEV[it.severity] || 0; }

export default function init(api) {
  const { esc } = api.util;
  const supported = typeof window.Notification === 'function';
  const enabledRules = () => {
    const v = api.ui['notify.rules'];
    return new Set(typeof v === 'string' ? v.split(',').filter(Boolean) : RULES.filter((r) => r.def).map((r) => r.id));
  };
  const isOn = () => !!api.ui['notify.on'] && supported && Notification.permission === 'granted';

  // ------------------------------------------------ header button
  const btn = api.addHeaderButton({ id: 'notify-btn', html: icon('bell', { size: 17 }), title: 'Notifications (n)', onClick: () => openPanel() });
  const syncBtn = () => { if (btn) { btn.setAttribute('aria-pressed', String(isOn())); btn.classList.toggle('on', isOn()); } };
  syncBtn();

  // ------------------------------------------------ chime (WebAudio; unlocked by a click in the panel)
  let audio = null;
  function chime(level) {
    if (api.ui['notify.sound'] !== '1') return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const t = audio.currentTime;
      const notes = level >= 3 ? [880, 660, 880] : [660, 880];
      notes.forEach((f, i) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + i * 0.18);
        g.gain.exponentialRampToValueAtTime(0.18, t + i * 0.18 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.16);
        o.connect(g).connect(audio.destination);
        o.start(t + i * 0.18); o.stop(t + i * 0.18 + 0.18);
      });
    } catch { /* audio unavailable */ }
  }

  // ------------------------------------------------ delivery
  function quietNow(now = Date.now()) {
    const q = String(api.ui['notify.quiet'] || '');
    const m = /^(\d{1,2})-(\d{1,2})$/.exec(q);
    if (!m) return false;
    const h = api.util.pparts(now).hh;
    const a = +m[1], b = +m[2];
    return a <= b ? h >= a && h < b : h >= a || h < b;
  }
  let lastShown = 0, pending = [], batchTimer = null;
  function show(title, body, item, tag) {
    try {
      const n = new Notification(title, { body, tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', renotify: false });
      n.onclick = () => {
        window.focus();
        n.close();
        if (item) {
          if (Number.isFinite(item.lat) && Number.isFinite(item.lon)) api.emit('activity:locate', item);
          else document.getElementById('live')?.scrollIntoView({ behavior: 'smooth' });
        }
      };
    } catch (err) { console.info('[notify] could not show a notification', err); }
  }
  function flush() {
    batchTimer = null;
    if (!pending.length) return;
    const items = pending; pending = [];
    lastShown = Date.now();
    if (items.length === 1) show(items[0].title, items[0].detail || '', items[0], `bl-${items[0].id}`);
    else show(`${items.length} more Ballard updates`, items.slice(0, 4).map((x) => `• ${x.title}`).join('\n'), null, 'bl-batch');
    chime(Math.max(...items.map(rank)));
  }
  api.on('activity', (it) => {
    if (!isOn() || !it) return;
    if (Date.now() - it.t > 10 * 60e3) return; // catch-up after a reconnect: not news any more
    if (api.ui['notify.hiddenOnly'] !== '0' && document.visibilityState === 'visible') return;
    if (quietNow() && rank(it) < 3) return; // alerts still come through quiet hours
    const rules = enabledRules();
    if (!RULES.some((r) => rules.has(r.id) && r.match(it))) return;
    const since = Date.now() - lastShown;
    if (since >= 20000 && !pending.length) {
      lastShown = Date.now();
      show(it.title, it.detail || '', it, `bl-${it.id}`);
      chime(rank(it));
    } else {
      pending.push(it);
      if (!batchTimer) batchTimer = setTimeout(flush, Math.max(1000, 20000 - since));
    }
  });

  // ------------------------------------------------ panel
  function panelHTML() {
    const rules = enabledRules();
    const perm = supported ? Notification.permission : 'unsupported';
    const status = !supported ? '<p class="bl-note">This browser doesn\'t support notifications.</p>'
      : perm === 'denied' ? '<p class="bl-note">Notifications are blocked for this site. To allow them, click the icon to the left of the address bar, open the site settings, and set Notifications to Allow. Then reopen this panel.</p>'
        : perm === 'default' ? '<p class="bl-row"><button type="button" class="bl-btn primary" data-n="ask">Allow notifications</button><span class="bl-note">Your browser will ask for permission.</span></p>'
          : '';
    return `${status}
      <label class="bl-check"><input type="checkbox" data-n="on" ${api.ui['notify.on'] ? 'checked' : ''} ${perm !== 'granted' ? 'disabled' : ''}> <b>Notify me about new activity</b></label>
      <h4>What to notify about</h4>
      ${RULES.map((r) => `<label class="bl-check"><input type="checkbox" data-n-rule="${r.id}" ${rules.has(r.id) ? 'checked' : ''}> ${esc(r.label)}</label>`).join('')}
      <h4>When</h4>
      <label class="bl-check"><input type="checkbox" data-n="hiddenOnly" ${api.ui['notify.hiddenOnly'] !== '0' ? 'checked' : ''}> Only when this tab is in the background</label>
      <label class="bl-check"><input type="checkbox" data-n="sound" ${api.ui['notify.sound'] === '1' ? 'checked' : ''}> Play a short chime</label>
      <div class="bl-row"><label class="bl-check" style="padding:0"><input type="checkbox" data-n="quietOn" ${api.ui['notify.quiet'] ? 'checked' : ''}> Quiet hours</label>
        <select data-n="quietFrom" aria-label="Quiet from">${hours(quietParts()[0])}</select> to <select data-n="quietTo" aria-label="Quiet until">${hours(quietParts()[1])}</select>
        <span class="bl-note">(alerts still come through)</span></div>
      <div class="bl-row" style="margin-top:10px"><button type="button" class="bl-btn" data-n="test" ${perm !== 'granted' ? 'disabled' : ''}>Send a test notification</button></div>`;
  }
  const quietParts = () => { const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(api.ui['notify.quiet'] || '')); return m ? [+m[1], +m[2]] : [22, 7]; };
  function hours(sel) {
    let o = '';
    for (let h = 0; h < 24; h++) o += `<option value="${h}" ${h === sel ? 'selected' : ''}>${h === 0 ? '12 am' : h < 12 ? `${h} am` : h === 12 ? '12 pm' : `${h - 12} pm`}</option>`;
    return o;
  }
  function save(key, value) {
    api.setUI(key, value, { render: false });
    api.emit('notify:changed', key, value);
    syncBtn();
  }
  function openPanel() {
    const d = api.util.openDialog({ id: 'notify-dlg', title: 'Notifications', html: panelHTML() });
    if (!d) return;
    const rerender = () => { d.body.innerHTML = panelHTML(); };
    d.body.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-n]');
      if (!t) return;
      if (t.dataset.n === 'ask') {
        try { await Notification.requestPermission(); } catch { /* ignore */ }
        if (Notification.permission === 'granted') save('notify.on', true);
        rerender();
      } else if (t.dataset.n === 'test') {
        const was = api.ui['notify.sound'];
        show('Ballard Live notifications are on', 'You\'ll hear about the things you picked, even when this tab is in the background.', null, 'bl-test');
        if (was === '1') chime(2);
      }
    });
    d.body.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.nRule) {
        const r = enabledRules();
        if (t.checked) r.add(t.dataset.nRule); else r.delete(t.dataset.nRule);
        save('notify.rules', [...r].join(','));
        return;
      }
      switch (t.dataset.n) {
        case 'on': save('notify.on', t.checked || null); break;
        case 'hiddenOnly': save('notify.hiddenOnly', t.checked ? null : '0'); break;
        case 'sound': save('notify.sound', t.checked ? '1' : null); if (t.checked) chime(1); break;
        case 'quietOn': case 'quietFrom': case 'quietTo': {
          const on = d.body.querySelector('[data-n="quietOn"]').checked;
          const a = d.body.querySelector('[data-n="quietFrom"]').value, b = d.body.querySelector('[data-n="quietTo"]').value;
          save('notify.quiet', on ? `${a}-${b}` : null);
          break;
        }
        default:
      }
    });
  }
  api.on('notify:open', openPanel);
}
