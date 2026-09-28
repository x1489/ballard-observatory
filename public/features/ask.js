// Ask Ballard: a Spotlight-style command bar (⌘K / Ctrl+K, the header 🔍, or 'ask:open' with a query).
// Answers come from insight.answer() over the live store as you type. Voice in (Web Speech recognition, where the
// browser has it) and voice out (speechSynthesis): ask by voice and the answer is read back. Recent questions are
// kept in this browser. ui key: 'ask.speak' ('1' = read answers aloud).
import { answer, suggestions } from '../insight.js';
import { icon } from '../icons.js';
import { usualOf } from '../baseline.js';

const RECENT_KEY = 'bl-ask-recent';

export default function init(api) {
  const { esc, reducedMotion } = api.util;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const canSpeak = 'speechSynthesis' in window;
  let root = null, input = null, out = null, opener = null, timer = 0, lastQ = null, rec = null, listening = false;

  const recent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((x) => typeof x === 'string').slice(0, 6); } catch { return []; } };
  const remember = (q) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify([q, ...recent().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 6))); } catch { /* ignore */ } };
  const series = (k, h) => (api.history.cached ? api.history.cached(k, h) : null);
  const ask = (q) => answer(q, api.D, Date.now(), { activity: api.activity.items(), series, baseline: usualOf, favorites: String(api.ui['prefs.buses'] || '').split(',').filter(Boolean) });

  function speak(text) {
    if (!canSpeak || !text) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text.replace(/°/g, ' degrees').replace(/\bNW\b/g, 'Northwest').replace(/\bft\b/g, 'feet').replace(/\bkt\b/g, 'knots'));
      u.rate = 1.02; u.pitch = 1; u.lang = 'en-US';
      const v = speechSynthesis.getVoices().find((x) => /en-US/i.test(x.lang) && /Samantha|Google US English|Ava|Allison|Zoe/i.test(x.name)) || speechSynthesis.getVoices().find((x) => /en-US/i.test(x.lang));
      if (v) u.voice = v;
      speechSynthesis.speak(u);
    } catch { /* ignore */ }
  }

  function homeHTML() {
    const r = recent();
    return `<div class="ask-home">
      <div class="ask-sec">${icon('sparkle', { size: 14 })} Try asking</div>
      <div class="ask-chips">${suggestions(api.D, Date.now()).map((q) => `<button type="button" class="ask-chip" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      ${r.length ? `<div class="ask-sec">${icon('clock', { size: 14 })} Recent</div><div class="ask-chips">${r.map((q) => `<button type="button" class="ask-chip recent" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>` : ''}
      <div class="ask-tips">Ask about buses, the bridge, tides, weather, kayaking, sirens, planes overhead, events, wildlife, salmon, the Locks, air, drive times, cameras… or say “brief me”.</div></div>`;
  }
  function answerHTML(a) {
    if (!a) return `<div class="ask-none">${icon('info', { size: 18 })}<div><b>I don't know that one yet.</b><div class="ask-sub">Try “next bus”, “is the bridge up”, “low tide”, “what's happening tonight” or “brief me”.</div></div></div>`;
    const acts = (a.actions || []).map((x) => x.href
      ? `<a class="ask-act" href="${esc(x.href)}" data-close>${esc(x.label)} ${icon('right', { size: 14 })}</a>`
      : `<button type="button" class="ask-act" data-action="${esc(x.action)}">${esc(x.label)} ${icon('right', { size: 14 })}</button>`).join('');
    return `<article class="ask-card">
      <header><span class="ask-ico">${icon(a.icon || 'sparkle', { size: 20 })}</span><h4>${esc(a.title || '')}</h4>
      ${a.speak && canSpeak ? `<button type="button" class="ask-say" data-say title="Read aloud" aria-label="Read the answer aloud">${icon('speaker', { size: 16 })}</button>` : ''}</header>
      <div class="ask-body">${a.html || ''}</div>${acts ? `<div class="ask-acts">${acts}</div>` : ''}</article>`;
  }

  function run(q, { fromVoice = false, commit = false } = {}) {
    q = String(q || '').trim();
    lastQ = q;
    if (!q) { api.setHTML(out, homeHTML()); out.dataset.state = 'home'; return; }
    const a = ask(q);
    api.setHTML(out, answerHTML(a));
    out.dataset.state = 'answer';
    out._answer = a;
    if (commit || fromVoice) { remember(q); if (a) api.emit('ask:asked', { q, intent: a.intent }); }
    if (a && a.speak && (fromVoice || (commit && api.ui['ask.speak'] === '1'))) speak(a.speak);
  }

  function open(q = '') {
    if (root) { input.value = q || input.value; input.focus(); run(input.value, { commit: !!q }); return; }
    opener = document.activeElement;
    root = document.createElement('div');
    root.className = 'ask-back';
    root.innerHTML = `<div class="ask" role="dialog" aria-modal="true" aria-label="Ask Ballard">
      <div class="ask-bar">${icon('search', { size: 20 })}
        <input type="text" class="ask-in" placeholder="Ask Ballard… “when's my bus?”, “is the bridge up?”" autocomplete="off" spellcheck="false" aria-label="Ask a question" aria-controls="ask-out">
        ${SR ? `<button type="button" class="ask-mic" aria-label="Ask by voice" title="Ask by voice">${icon('mic', { size: 18 })}</button>` : ''}
        ${canSpeak ? `<button type="button" class="ask-spk ${api.ui['ask.speak'] === '1' ? 'on' : ''}" aria-pressed="${api.ui['ask.speak'] === '1'}" title="Read answers aloud" aria-label="Read answers aloud">${icon('speaker', { size: 18 })}</button>` : ''}
        <kbd class="ask-esc">esc</kbd></div>
      <div class="ask-out" id="ask-out" aria-live="polite"></div></div>`;
    document.body.appendChild(root);
    document.documentElement.classList.add('bl-modal-open');
    input = root.querySelector('.ask-in');
    out = root.querySelector('.ask-out');
    input.value = q;
    input.focus();
    run(q, { commit: !!q });
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => run(input.value), 110); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(input.value, { commit: true }); } });
    root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
    root.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-q]');
      if (chip) { input.value = chip.dataset.q; run(chip.dataset.q, { commit: true }); input.focus(); return; }
      if (e.target.closest('[data-say]')) { const a = out._answer; if (a) speak(a.speak); return; }
      if (e.target.closest('.ask-mic')) { listen(); return; }
      const spk = e.target.closest('.ask-spk');
      if (spk) { const on = api.ui['ask.speak'] !== '1'; api.setUI('ask.speak', on ? '1' : null, { render: false }); spk.classList.toggle('on', on); spk.setAttribute('aria-pressed', String(on)); if (!on && canSpeak) speechSynthesis.cancel(); return; }
      const act = e.target.closest('[data-action]');
      if (act) { const x = act.dataset.action; close(); if (x === 'theme') document.getElementById('theme-btn')?.click(); else if (x === 'shortcuts') document.dispatchEvent(new KeyboardEvent('keydown', { key: '?' })); else api.emit(x); return; }
      if (e.target.closest('[data-close]')) close();
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      const f = [...root.querySelectorAll('input,button,a[href]')].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    });
    if (!reducedMotion()) root.querySelector('.ask').animate([{ opacity: 0, transform: 'translateY(-8px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  function close() {
    if (!root) return;
    if (rec && listening) { try { rec.abort(); } catch { /* ignore */ } }
    if (canSpeak) speechSynthesis.cancel();
    root.remove(); root = null;
    document.documentElement.classList.remove('bl-modal-open');
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
  }

  function listen() {
    if (!SR || !root) return;
    if (listening) { try { rec.stop(); } catch { /* ignore */ } return; }
    rec = new SR();
    rec.lang = 'en-US'; rec.interimResults = true; rec.maxAlternatives = 1;
    const mic = root.querySelector('.ask-mic');
    let finalText = '';
    rec.onstart = () => { listening = true; mic.classList.add('on'); input.placeholder = 'Listening…'; };
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) { const r = e.results[i]; if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript; }
      input.value = (finalText || interim).trim();
      if (input.value) run(input.value);
    };
    rec.onerror = (e) => { if (root) api.setHTML(out, `<div class="ask-none">${icon('mic', { size: 18 })}<div><b>Voice input didn't work</b><div class="ask-sub">${esc(e.error === 'not-allowed' ? 'Microphone access was blocked for this page.' : e.error === 'network' ? 'Speech recognition needs an internet connection in this browser.' : `(${e.error})`)}</div></div></div>`); };
    rec.onend = () => { listening = false; if (!root) return; mic.classList.remove('on'); input.placeholder = 'Ask Ballard…'; if (finalText.trim()) run(finalText.trim(), { fromVoice: true }); };
    try { rec.start(); } catch { /* already started */ }
  }

  api.addHeaderButton({ id: 'ask-btn', html: icon('search', { size: 17 }), title: 'Ask Ballard (⌘K)', onClick: () => open('') });
  api.on('ask:open', (q) => open(typeof q === 'string' ? q : ''));
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); if (root) close(); else open(''); }
  });
  // Keep an open answer live as data changes (e.g. bus countdowns, bridge status).
  api.on('render', () => { if (root && lastQ && out.dataset.state === 'answer' && document.activeElement !== out) { const a = ask(lastQ); out._answer = a; api.setHTML(out, answerHTML(a)); } });
  const p = new URLSearchParams(location.search).get('ask');
  if (p) api.on('features', () => setTimeout(() => open(p), 400));
}
