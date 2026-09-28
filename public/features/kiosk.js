// Kiosk / TV mode for a wall tablet: bigger type, no page chrome, cycles through the sections, keeps the screen
// awake (Wake Lock API), hides the idle cursor, and pauses cycling for a minute after any interaction.
// Enter with ?kiosk=1 (e.g. a home-screen bookmark), the full-screen header button, or the 'k' key ('kiosk:toggle').
// Exit with the button, 'k' or Esc. Not persisted on purpose: a plain reload always returns to the normal page,
// so nobody gets stuck; bookmark /?kiosk=1 for a dedicated display. ui key: 'kiosk.interval' (seconds, default 20).
import { icon } from '../icons.js';

export default function init(api) {
  const { reducedMotion } = api.util;
  const root = document.documentElement;
  let on = false, timer = null, pausedUntil = 0, idleTimer = null, wake = null, idx = -1;
  const interval = () => Math.max(8, +api.ui['kiosk.interval'] || 20) * 1000;
  const order = ['live', 'map-section', 'weather', 'water', 'move', 'safety', 'community'];
  const targets = () => order.map((id) => document.getElementById(id)).filter((el) => el && !el.hidden && el.offsetHeight > 40);

  const btn = api.addHeaderButton({ id: 'kiosk-btn', html: icon('expand', { size: 17 }), title: 'Kiosk mode (k)', onClick: () => toggle(true) });

  async function lockScreen() {
    try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wake = await navigator.wakeLock.request('screen'); } catch { wake = null; }
  }
  function step() {
    if (!on) return;
    if (Date.now() < pausedUntil) return;
    const t = targets();
    if (!t.length) return;
    idx = (idx + 1) % t.length;
    t[idx].scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  }
  function poke() {
    if (!on) return;
    pausedUntil = Date.now() + 60000;
    root.classList.remove('kiosk-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => root.classList.add('kiosk-idle'), 3000);
  }
  function enter(userGesture) {
    if (on) return;
    on = true;
    root.classList.add('kiosk');
    if (btn) { btn.setAttribute('aria-pressed', 'true'); btn.title = 'Exit kiosk mode (k or Esc)'; }
    if (userGesture && document.fullscreenEnabled && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    lockScreen();
    idx = -1;
    pausedUntil = 0;
    timer = setInterval(step, interval());
    poke();
    pausedUntil = Date.now() + 5000; // let the first screen settle
    api.emit('kiosk:changed', true);
    window.scrollTo({ top: 0 });
  }
  function exit() {
    if (!on) return;
    on = false;
    root.classList.remove('kiosk', 'kiosk-idle');
    clearInterval(timer); clearTimeout(idleTimer);
    if (btn) { btn.setAttribute('aria-pressed', 'false'); btn.title = 'Kiosk mode (k)'; }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (wake) { wake.release().catch(() => {}); wake = null; }
    if (new URLSearchParams(location.search).get('kiosk')) {
      const u = new URL(location.href);
      u.searchParams.delete('kiosk');
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    }
    api.emit('kiosk:changed', false);
  }
  function toggle(userGesture) { if (on) exit(); else enter(userGesture); }

  for (const ev of ['pointerdown', 'wheel', 'keydown', 'touchstart', 'pointermove']) window.addEventListener(ev, poke, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (on && e.key === 'Escape' && !document.fullscreenElement && !document.querySelector('.bl-dialog')) exit();
  });
  document.addEventListener('visibilitychange', () => { if (on && document.visibilityState === 'visible') lockScreen(); });
  api.on('kiosk:toggle', () => toggle(true));
  if (new URLSearchParams(location.search).get('kiosk') === '1') enter(false);
}
