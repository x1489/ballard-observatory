// Shared helpers for Ballard Live source modules. Zero dependencies (Node 18+).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
// BALLARD_DATA_DIR relocates all server state (source state files, history, activity, snapshot), e.g. for a
// second instance that must not share files with the main one.
export const DATA_DIR = process.env.BALLARD_DATA_DIR ? path.resolve(process.env.BALLARD_DATA_DIR) : path.join(ROOT, 'data');

export const TZ = 'America/Los_Angeles';
export const CENTER = { lat: 47.6687, lon: -122.3847 }; // NW Market St & Ballard Ave NW
export const BBOX = { n: 47.700, s: 47.655, w: -122.410, e: -122.360 };

// Descriptive UA. Some hosts (spdblotter, Seattle Times) 403 a bare "Mozilla/5.0".
export const UA = 'Mozilla/5.0 (compatible; BallardLive/1.0; local neighborhood dashboard)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Release a response we don't want (error pages, 429s). Drains instead of body.cancel(): on Node 18's undici,
 * cancelling a body that is still receiving data can throw 'Controller is already closed' asynchronously,
 * outside any promise, which crashes the process.
 */
export async function discard(res) {
  try { await res.arrayBuffer(); } catch { /* ignore */ }
}
export { sleep };

/**
 * Fetch with timeout, retries, and a sane UA.
 * as: 'json' | 'text' | 'buffer' (Uint8Array) | 'response'
 * Throws Error with .status on non-2xx (after retries).
 */
export async function get(url, { as = 'json', headers = {}, timeout = 15000, retries = 1, retryOn = [429, 500, 502, 503, 504], backoff = 1500, method = 'GET' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      if (as === 'response') return res;
      if (!res.ok) {
        await discard(res); // release the socket now, not at GC
        const err = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
        err.status = res.status;
        if (retryOn.includes(res.status) && attempt < retries) {
          lastErr = err;
          await sleep(backoff * (attempt + 1));
          continue;
        }
        throw err;
      }
      if (as === 'buffer') return new Uint8Array(await res.arrayBuffer());
      const text = await res.text();
      if (as === 'text') return text;
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Bad JSON from ${new URL(url).host}: ${text.slice(0, 120)}`);
      }
    } catch (e) {
      if (e.name === 'AbortError') lastErr = new Error(`Timeout after ${timeout}ms: ${new URL(url).host}`);
      else if (e instanceof TypeError && e.message === 'fetch failed') {
        // undici's bare 'fetch failed' names neither the host nor the cause (DNS, TLS, refused...).
        const c = e.cause || {};
        lastErr = new Error(`fetch failed (${c.code || c.message || 'network error'}): ${new URL(url).host}`, { cause: e.cause });
      } else lastErr = e;
      if (e.status && !retryOn.includes(e.status)) throw lastErr;
      if (attempt < retries) {
        await sleep(backoff * (attempt + 1));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** Serial queue enforcing a minimum gap between task starts (for shared rate-limited APIs). */
export function limiter(minGapMs) {
  let chain = Promise.resolve();
  let last = 0;
  return (fn) => {
    const run = chain.then(async () => {
      const wait = last + minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  };
}

// ---------- Pacific time ----------

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
});

/** Pacific wall-clock parts for an epoch/Date. weekday: 0=Sun..6=Sat */
export function pacificParts(d = Date.now()) {
  const o = {};
  for (const p of partsFmt.formatToParts(new Date(d))) o[p.type] = p.value;
  return {
    y: +o.year, m: +o.month, d: +o.day, hh: +o.hour % 24, mm: +o.minute, ss: +o.second,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday),
  };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 'YYYY-MM-DD' for today in Pacific time, shifted by offsetDays. */
export function pacificDate(offsetDays = 0, from = Date.now()) {
  const p = pacificParts(from);
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + offsetDays));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

function tzOffsetMs(epoch) {
  const p = pacificParts(epoch);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(epoch / 1000) * 1000;
}

/** Epoch ms for a Pacific wall-clock time. */
export function pacificToEpoch(y, m, d, hh = 0, mm = 0, ss = 0) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  const off1 = tzOffsetMs(guess);
  let t = guess - off1;
  const off2 = tzOffsetMs(t);
  if (off2 !== off1) t = guess - off2;
  return t;
}

/**
 * Parse a floating Pacific timestamp string to epoch ms. Accepts:
 * 'YYYY-MM-DD', 'YYYY-MM-DD HH:MM', 'YYYY-MM-DDTHH:MM:SS(.sss)', 'M/D/YYYY h:mm(:ss) AM',
 * 'MM/DD/YY HH:mm', 'MM/DD/YYYY HH:mm(:ss)'. Returns null if unparseable.
 */
export function fromPacific(s) {
  if (s == null) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return pacificToEpoch(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    let hh = +(m[4] || 0);
    const ap = m[7] && m[7].toUpperCase();
    if (ap === 'PM' && hh < 12) hh += 12;
    if (ap === 'AM' && hh === 12) hh = 0;
    return pacificToEpoch(y, +m[1], +m[2], hh, +(m[5] || 0), +(m[6] || 0));
  }
  return null;
}

/** Epoch -> floating Pacific 'YYYY-MM-DDTHH:MM:SS' (for Socrata $where on floating timestamps). */
export function toPacificFloating(epoch) {
  const p = pacificParts(epoch);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}`;
}

/** Parse a UTC timestamp that may lack a zone suffix ('2026-09-25T02:33:00'). */
export function fromUTC(s) {
  if (s == null) return null;
  s = String(s).trim();
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
  const t = Date.parse(s.replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

// ---------- Geo ----------

export function haversineKm(lat1, lon1, lat2 = CENTER.lat, lon2 = CENTER.lon) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** In the Ballard bbox, optionally padded by padKm on every side. */
export function inBbox(lat, lon, padKm = 0) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  const dLat = padKm / 111.32, dLon = padKm / (111.32 * Math.cos(CENTER.lat * Math.PI / 180));
  return lat <= BBOX.n + dLat && lat >= BBOX.s - dLat && lon >= BBOX.w - dLon && lon <= BBOX.e + dLon;
}

// ---------- Parsing ----------

/** RFC4180-ish CSV parser -> array of string arrays. */
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

/** CSV -> array of objects keyed by header row. */
export function parseCSVObjects(text) {
  const [head, ...rows] = parseCSV(text);
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i]])));
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
export function decodeEntities(s = '') {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}

export function stripTags(s = '') {
  return decodeEntities(String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Fix UTF-8 text that was decoded as Windows-1252/Latin-1 ('â€“' -> '–'). Returns input unchanged if it isn't mojibake. */
const CP1252 = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
export function fixMojibake(s = '') {
  s = String(s);
  if (!/[ÃÂâ][\u0080-\u00bf\u0152-\u2122]/.test(s)) return s;
  // Repair each run of suspicious characters independently so clean text around it is untouched.
  return s.replace(/[\u00c0-\u00ff][\u0080-\u00bf\u0152-\u2122]{1,3}/g, (run) => {
    const bytes = [];
    for (const ch of run) {
      const c = ch.codePointAt(0);
      if (c < 0x100) bytes.push(c);
      else if (CP1252[c] != null) bytes.push(CP1252[c]);
      else return run;
    }
    const out = Buffer.from(bytes).toString('utf8');
    return out.includes('\uFFFD') ? run : out;
  });
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
}

/** Parse RSS 2.0 or Atom into [{title, link, t, summary, author, categories, source, thumbnail}]. */
export function parseFeed(xml) {
  const items = [];
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    let link = tag(b, 'link');
    if (isAtom || !link) {
      const m = b.match(/<link[^>]*href="([^"]+)"/i);
      if (m) link = m[1];
    }
    const date = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    const t = Date.parse(date);
    const categories = [...b.matchAll(/<category(?:[^>]*term="([^"]*)")?[^>]*?(?:\/>|>([\s\S]*?)<\/category>)/gi)]
      .map((m) => stripTags(m[2] || m[1] || '')).filter(Boolean);
    const srcM = b.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
    const thumbM = b.match(/<media:thumbnail[^>]*url="([^"]+)"/i);
    items.push({
      title: stripTags(tag(b, 'title')),
      link: decodeEntities(link),
      t: Number.isFinite(t) ? t : null,
      summary: stripTags(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 400),
      author: stripTags(tag(b, 'dc:creator') || tag(b, 'name')),
      categories,
      source: srcM ? stripTags(srcM[1]) : null,
      thumbnail: thumbM ? decodeEntities(thumbM[1]) : null,
    });
  }
  return items;
}

// ---------- Math / units ----------

export function median(arr) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export const round = (n, d = 0) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
export const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
export const cToF = (c) => (Number.isFinite(c) ? c * 9 / 5 + 32 : null);
export const kmhToMph = (k) => (Number.isFinite(k) ? k * 0.621371 : null);
export const msToMph = (v) => (Number.isFinite(v) ? v * 2.23694 : null);
export const msToKt = (v) => (Number.isFinite(v) ? v * 1.94384 : null);

/** EPA 2024 PM2.5 (ug/m3, NowCast) -> US AQI. */
export function pm25ToAqi(pm) {
  if (!Number.isFinite(pm) || pm < 0) return null;
  const bp = [[0, 9.0, 0, 50], [9.1, 35.4, 51, 100], [35.5, 55.4, 101, 150], [55.5, 125.4, 151, 200], [125.5, 225.4, 201, 300], [225.5, 500.4, 301, 500]];
  const c = Math.floor(pm * 10) / 10;
  for (const [cl, ch, il, ih] of bp) if (c <= ch) return Math.round(((ih - il) / (ch - cl)) * (Math.max(c, cl) - cl) + il);
  return 500;
}

// ---------- Small persistence (for state the server observes itself) ----------

export function readState(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); } catch { return fallback; }
}
export function writeState(name, value) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const p = path.join(DATA_DIR, name);
    fs.writeFileSync(p + '.tmp', JSON.stringify(value));
    fs.renameSync(p + '.tmp', p);
  } catch (e) { console.error('writeState', name, e.message); }
}
