// Minimal Chrome DevTools Protocol driver for interactive QA (dev tool; no dependencies, Node 18+).
// Launches headless Chrome with a throwaway profile and speaks CDP over a tiny built-in WebSocket client, so a QA
// script can navigate, run JS in the page, click through features, emulate light/dark and phone widths, collect
// console errors/exceptions, and save PNG screenshots of any state.
//
//   import { launch } from './tools/cdp.mjs';
//   const b = await launch({ width: 1440, height: 1000, scheme: 'dark' });
//   await b.goto('http://127.0.0.1:4177/', { settle: 8000 });
//   await b.eval(`document.querySelector('#ask-btn').click()`);
//   await b.shot('ask.png');                     // viewport; { full: true } for the whole page; { clip: {x,y,width,height} }
//   console.log(b.errors());                      // console errors + uncaught exceptions + failed loads seen so far
//   await b.close();
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// ------------------------------------------------------------------ WebSocket (client side, RFC 6455 subset)
function wsConnect(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') },
    });
    req.on('error', reject);
    req.on('response', (res) => reject(new Error(`websocket upgrade refused: ${res.statusCode}`)));
    req.on('upgrade', (res, socket, head) => {
      const listeners = new Set();
      let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      let frag = [];
      const send = (text, opcode = 1) => {
        const payload = Buffer.from(text);
        const n = payload.length;
        const hdr = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
        hdr[0] = 0x80 | opcode;
        if (n < 126) hdr[1] = 0x80 | n;
        else if (n < 65536) { hdr[1] = 0x80 | 126; hdr.writeUInt16BE(n, 2); }
        else { hdr[1] = 0x80 | 127; hdr.writeBigUInt64BE(BigInt(n), 2); }
        const mask = crypto.randomBytes(4);
        for (let i = 0; i < n; i++) payload[i] ^= mask[i & 3];
        socket.write(Buffer.concat([hdr, mask, payload]));
      };
      socket.on('data', (d) => {
        buf = buf.length ? Buffer.concat([buf, d]) : d;
        for (;;) {
          if (buf.length < 2) return;
          const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          const mk = masked ? buf.subarray(off, off + 4) : null;
          if (masked) off += 4;
          if (buf.length < off + len) return;
          const data = Buffer.from(buf.subarray(off, off + len));
          if (mk) for (let i = 0; i < data.length; i++) data[i] ^= mk[i & 3];
          buf = buf.subarray(off + len);
          if (op === 9) { send(data, 10); continue; }
          if (op === 8) { socket.end(); continue; }
          if (op === 1 || op === 2 || op === 0) {
            frag.push(data);
            if (fin) { const msg = Buffer.concat(frag).toString('utf8'); frag = []; for (const l of listeners) l(msg); }
          }
        }
      });
      resolve({ send: (t) => send(t), onMessage: (fn) => listeners.add(fn), close: () => { try { socket.end(); socket.destroy(); } catch { /* gone */ } } });
    });
    req.end();
  });
}

// ------------------------------------------------------------------ browser
export async function launch({ width = 1440, height = 1000, scheme = null, mobile = null, dpr = 1, chromeArgs = [] } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'blcdp-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${width},${height}`, ...chromeArgs, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] });
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    try { port = +fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { /* not yet */ }
  }
  if (!port) { chrome.kill('SIGKILL'); throw new Error('Chrome did not start'); }
  let target = null;
  for (let i = 0; i < 50 && !target; i++) { try { target = (await getJSON(port, '/json/list')).find((t) => t.type === 'page'); } catch { /* retry */ } if (!target) await sleep(100); }
  const ws = await wsConnect(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map(), waiters = [], handlers = new Map();
  const logs = [];
  ws.onMessage((raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`)); else p.resolve(m.result); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ');
      logs.push({ level: m.params.type, text });
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      logs.push({ level: 'exception', text: `${(d.exception && d.exception.description) || d.text} @ ${d.url || ''}:${d.lineNumber}` });
    } else if (m.method === 'Log.entryAdded') {
      logs.push({ level: m.params.entry.level, text: `${m.params.entry.text} ${m.params.entry.url || ''}`.trim(), source: m.params.entry.source });
    }
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].method === m.method) { waiters[i].resolve(m.params); waiters.splice(i, 1); }
    if (m.method && handlers.has(m.method)) for (const fn of handlers.get(m.method)) { try { fn(m.params); } catch (err) { console.error(err); } }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject, method }); ws.send(JSON.stringify({ id: n, method, params })); });
  const waitFor = (method, ms = 30000) => new Promise((resolve, reject) => { const w = { method, resolve }; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`timeout waiting for ${method}`)); } }, ms); });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  let vw = width, vh = height;
  const setViewport = async (w, h, isMobile = mobile ?? w < 600) => { vw = w; vh = h; await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: !!isMobile }); };
  await setViewport(width, height);
  if (mobile ?? width < 600) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const setScheme = (s) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: s || '' }] });
  if (scheme) await setScheme(scheme);

  const api = {
    send, waitFor, setViewport, setScheme, logs,
    async goto(url, { settle = 3000 } = {}) {
      const loaded = waitFor('Page.loadEventFired', 45000).catch(() => null);
      await send('Page.navigate', { url });
      await loaded;
      if (settle) await sleep(settle);
    },
    async eval(expression, { awaitPromise = true } = {}) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(`page eval failed: ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`);
      return r.result ? r.result.value : undefined;
    },
    async waitFn(expression, { timeout = 15000, every = 200 } = {}) {
      const end = Date.now() + timeout;
      while (Date.now() < end) { if (await api.eval(`!!(${expression})`).catch(() => false)) return true; await sleep(every); }
      throw new Error(`timeout: ${expression}`);
    },
    async click(selector) {
      const box = await api.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!box) throw new Error(`no element: ${selector}`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
      return box;
    },
    async key(key, { code = key, modifiers = 0, text } = {}) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, text, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : { Escape: 27, Enter: 13, ArrowRight: 39, ArrowLeft: 37, ' ': 32 }[key] || 0 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : { Escape: 27, Enter: 13, ArrowRight: 39, ArrowLeft: 37, ' ': 32 }[key] || 0 });
    },
    async type(text) { await send('Input.insertText', { text }); },
    async shot(file, { full = false, clip = null } = {}) {
      let params = { format: 'png' };
      if (full) {
        const m = await send('Page.getLayoutMetrics');
        const s = m.cssContentSize || m.contentSize;
        params = { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: vw, height: Math.ceil(s.height), scale: 1 } };
      } else if (clip) params = { format: 'png', captureBeyondViewport: true, clip: { scale: 1, ...clip } };
      const r = await send('Page.captureScreenshot', params);
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
    errors({ ignore = [] } = {}) {
      return logs.filter((l) => (l.level === 'error' || l.level === 'exception' || l.level === 'assert') && !ignore.some((re) => re.test(l.text))).map((l) => l.text.slice(0, 300));
    },
    sleep,
    /** Listen to any CDP event: on('Network.responseReceived', fn). */
    on(method, fn) { if (!handlers.has(method)) handlers.set(method, []); handlers.get(method).push(fn); },
    /**
     * Answer matching requests from the test instead of the network (call before goto). routes: [[urlPattern, fn]]
     * where urlPattern is a CDP glob ('*' wildcards) and fn(url) returns { status = 200, body (string or object),
     * type = 'application/json' } or null to let the request through.
     */
    async mock(routes) {
      api.on('Fetch.requestPaused', async (p) => {
        const hit = routes.find(([pat]) => new RegExp(`^${pat.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(p.request.url));
        const r = hit ? await hit[1](p.request.url) : null;
        if (!r) { send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}); return; }
        const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
        send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: r.status || 200, responseHeaders: [{ name: 'Content-Type', value: r.type || 'application/json' }, { name: 'Cache-Control', value: 'no-store' }], body: Buffer.from(body).toString('base64') }).catch(() => {});
      });
      await send('Fetch.enable', { patterns: routes.map(([urlPattern]) => ({ urlPattern, requestStage: 'Request' })) });
    },
    async close() {
      ws.close();
      try { process.kill(chrome.pid, 'SIGKILL'); } catch { /* gone */ }
      await sleep(200);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
  return api;
}
