// Headless-Chrome QA capture for Ballard Live (dev tool; no dependencies).
// Usage: node tools/qa.mjs [--url http://127.0.0.1:4177/] [--width 1440] [--height 3000] [--wait 15000]
//                          [--scheme light|dark] [--out shot.png] [--polling]
// Loads the page inside a wrapper frame whose load event is held by a slow request for --wait ms, so the
// screenshot is taken after live data arrived (virtual time never settles while the page polls or streams).
// Prints the page's console errors (from Chrome's log) and exits. Chrome is always killed afterwards.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const url = new URL(args.url || 'http://127.0.0.1:4177/');
if (args.polling) url.searchParams.set('transport', 'polling');
const W = +args.width || 1440, Hh = +args.height || 3000, WAIT = +args.wait || 15000;
const out = path.resolve(args.out || 'qa-shot.png');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let wrapper = '';
const slow = http.createServer((req, res) => {
  if (req.url.startsWith('/wrap')) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(wrapper); return; }
  const ms = +new URL(req.url, 'http://x').searchParams.get('ms') || 1000;
  setTimeout(() => { res.writeHead(200, { 'Content-Type': 'image/gif', 'Access-Control-Allow-Origin': '*' }); res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64')); }, ms);
});
await new Promise((r) => slow.listen(0, '127.0.0.1', r));
const port = slow.address().port;
wrapper = `<!doctype html><html><body style="margin:0;background:#888">
<iframe src="${url.href}" style="display:block;border:0;width:${W}px;height:${Hh}px"></iframe>
<img src="http://127.0.0.1:${port}/slow?ms=${WAIT}" style="display:none" alt=""></body></html>`;
// Served from 127.0.0.1 too: Chrome's Private Network Access blocks a data: page from framing 127.0.0.1.
const dataUrl = `http://127.0.0.1:${port}/wrap`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'blqa-'));
try { fs.unlinkSync(out); } catch { /* none */ }
const flags = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${profile}`,
  `--window-size=${Math.max(W, 520)},${Hh}`, `--timeout=${WAIT + 20000}`, '--enable-logging=stderr', '--v=0', `--screenshot=${out}`];
if (args.scheme === 'light') flags.push('--blink-settings=preferredColorScheme=1');
if (args.scheme === 'dark') flags.push('--blink-settings=preferredColorScheme=0');
const chrome = spawn(CHROME, [...flags, dataUrl], { stdio: ['ignore', 'ignore', 'pipe'] });
let log = '';
chrome.stderr.on('data', (d) => { log += d; });

const deadline = Date.now() + WAIT + 45000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  if (fs.existsSync(out) && fs.statSync(out).size > 0) { await new Promise((r) => setTimeout(r, 800)); break; }
}
try { process.kill(chrome.pid, 'SIGKILL'); } catch { /* gone */ }
slow.close();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }

const lines = log.split('\n').filter((l) => /CONSOLE/.test(l));
const errors = lines.filter((l) => /Uncaught|Error|error|failed|Failed/.test(l) && !/\[features\] \w[\w-]*: not loaded/.test(l));
console.log(JSON.stringify({ screenshot: fs.existsSync(out) ? out : null, consoleLines: lines.length, errors: errors.map((l) => l.replace(/^\[[^\]]*\]\s*/, '').slice(0, 300)) }, null, 1));
process.exit(0);
