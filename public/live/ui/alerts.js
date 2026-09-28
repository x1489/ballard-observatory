// Alerts that reach you with the app closed (Web Push): pick what you want to hear about; the edge sends it the
// moment the feed shows it. Works in Chrome, Edge, Firefox and Safari; on iPhone, after "Add to Home Screen".
import { esc } from '../fmt.js';
import { icon } from './icons.js';

const b64uDec = (s) => { const t = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(t, (c) => c.charCodeAt(0)); };
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export function createAlerts(app) {
  let key = null;
  async function info() {
    if (key) return key;
    const r = await fetch('/api/push/key').catch(() => null);
    key = r && r.ok ? await r.json() : { error: r && r.status === 404 ? 'not configured' : 'offline' };
    return key;
  }
  async function registration() {
    if (!('serviceWorker' in navigator)) return null;
    return (await navigator.serviceWorker.getRegistration('/')) || navigator.serviceWorker.register('/push-sw.js', { scope: '/' });
  }
  async function current() {
    // Only looks: never installs the service worker for someone who hasn't turned alerts on.
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration('/') : null;
    const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
    if (!sub) return { sub: null, topics: [], watch: [] };
    const r = await fetch('/api/push/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => null);
    const j = r && r.ok ? await r.json() : {};
    return { sub, topics: j.topics || [], watch: j.watch || [] };
  }
  async function save(topics, watch = null) {
    if (watch == null) watch = (await current().catch(() => ({ watch: [] }))).watch;
    const k = await info();
    if (!k.publicKey) throw new Error('Alerts are only available on the hosted site.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in your browser settings, then try again.');
    const reg = await registration();
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uDec(k.publicKey) });
    const r = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON(), topics, watch }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    if (!topics.length && !(j.watch || []).length) await sub.unsubscribe().catch(() => {});
    return j.topics || [];
  }
  /** Bus stop alert on/off for one stop (optionally one route). Returns true when now watching. */
  async function toggleStop(w) {
    const k = await info();
    if (!k.publicKey) throw new Error('Alerts are only available on the hosted site.');
    if (isIOS() && !standalone()) throw new Error('On iPhone, add Ballard to your Home Screen first (Share → Add to Home Screen), then open it from there.');
    const cur = await current().catch(() => ({ topics: [], watch: [] }));
    const has = cur.watch.some((x) => x.stop === w.stop && (x.route || null) === (w.route || null));
    const watch = has ? cur.watch.filter((x) => !(x.stop === w.stop && (x.route || null) === (w.route || null))) : [...cur.watch, w].slice(-5);
    await save(cur.topics, watch);
    return !has;
  }
  async function render(root) {
    root.innerHTML = `<div class="list-h"><h2>Alerts</h2><p>Notifications that reach you with the app closed, sent the moment the live feeds show it.</p></div><div class="rows" data-k="rows"><div class="empty">Checking…</div></div>`;
    const rows = root.querySelector('[data-k="rows"]');
    const k = await info();
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    if (!k.publicKey) { rows.innerHTML = `<div class="fine" style="margin:0 8px">Alerts are sent by the hosted site. Open <a href="https://ballard-observatory.ballard-observatory-edge.workers.dev/#/alerts">ballard-observatory.ballard-observatory-edge.workers.dev</a> to turn them on.</div>`; return; }
    if (isIOS() && !standalone()) { rows.innerHTML = `<div class="fine" style="margin:0 8px;font-size:13px">On iPhone and iPad, alerts need the app on your Home Screen: tap <b>Share</b>, then <b>Add to Home Screen</b>, open Ballard from there, and come back to Alerts.</div>`; return; }
    if (!supported) { rows.innerHTML = '<div class="fine" style="margin:0 8px">This browser can\'t receive push notifications.</div>'; return; }
    let cur = { topics: [], watch: [] };
    try { cur = await current(); } catch { /* not subscribed */ }
    const on = new Set(cur.topics);
    if (cur.watch.length) on.add('__stops');
    rows.innerHTML = `${Object.entries(k.topics).map(([t, label]) => `<label class="row" style="grid-template-columns:40px 1fr auto;cursor:pointer"><div class="b" style="background:rgba(90,200,250,.12);color:var(--air)">${icon(t.startsWith('bridge') ? 'bridge' : t === 'fire' ? 'siren' : t === 'brief' ? 'sun' : t === 'iss' ? 'sat' : 'plane')}</div>
      <div><div class="t">${esc(label)}</div><div class="s">${t.startsWith('bridge') ? 'every time it opens for a vessel, and when it comes back down' : t === 'fire' ? 'fires, smoke and rescues within about a mile' : t === 'brief' ? 'weather and rain timing, the bridge, overnight calls, what\'s unusual' : t === 'iss' ? 'only passes you can see: after dark, at least 10° up' : 'squawk 7500 / 7600 / 7700 within 20 miles'}</div></div>
      <input type="checkbox" data-t="${esc(t)}" ${on.has(t) ? 'checked' : ''} style="width:20px;height:20px;accent-color:var(--air)"></label>`).join('')}
      <div class="sec" style="margin:14px 8px 0"><h3>Bus stop alerts <span>about 5 minutes before a bus arrives</span></h3>${cur.watch.length ? cur.watch.map((w) => `<div class="row" style="grid-template-columns:40px 1fr auto;padding:6px 0"><div class="b" style="background:rgba(255,176,32,.14);color:var(--bus)">${icon('bus')}</div>
        <div><div class="t">${esc(w.name || `Stop ${w.stop}`)}</div><div class="s">${esc(w.label ? `${w.label} only` : 'any route')}</div></div><button class="btn" data-unwatch="${esc(w.stop)}|${esc(w.route || '')}">Remove</button></div>`).join('')
        : '<div class="fine" style="margin:0">Open a bus and tap the bell next to a stop to be told when it\'s about 5 minutes away.</div>'}</div>
      <div class="fine" style="margin:8px 8px 0" data-k="msg">${Notification.permission === 'denied' ? 'Notifications are blocked for this site in your browser settings.' : ''}</div>
      <div class="actions" style="margin:10px 8px 0"><button class="btn" data-k="test" ${on.size ? '' : 'hidden'}>${icon('bell')} Send me a test alert</button></div>`;
    rows.querySelector('[data-k="test"]').addEventListener('click', async (e) => {
      e.preventDefault();
      const msg = rows.querySelector('[data-k="msg"]');
      try {
        const { sub } = await current();
        const r = await fetch('/api/push/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub && sub.endpoint }) });
        const j = await r.json().catch(() => ({}));
        msg.textContent = r.ok ? 'Sent: it should arrive in a few seconds.' : (j.error || `HTTP ${r.status}`);
      } catch (err) { msg.textContent = err.message; }
    });
    rows.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-unwatch]');
      if (!b) return;
      const [stop, route] = b.dataset.unwatch.split('|');
      try { await toggleStop({ stop, route: route || null }); render(root); } catch (err) { rows.querySelector('[data-k="msg"]').textContent = err.message; }
    });
    rows.addEventListener('change', async () => {
      const topics = [...rows.querySelectorAll('input[data-t]:checked')].map((x) => x.dataset.t);
      const msg = rows.querySelector('[data-k="msg"]');
      msg.textContent = 'Saving…';
      try { const t = await save(topics); msg.textContent = t.length ? 'Saved. You\'ll get a notification when it happens.' : 'Alerts off.'; rows.querySelector('[data-k="test"]').hidden = !t.length; }
      catch (e) { msg.textContent = e.message; }
    });
  }
  // A tapped notification opens its target in the running app.
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'open') { const u = new URL(e.data.url); location.hash = u.hash; app.route(); } });
  return { render, toggleStop, current };
}
