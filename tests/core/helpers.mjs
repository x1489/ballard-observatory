// Shared helpers for the core tests (not a test file itself).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

export const quiet = { log() {}, info() {}, warn() {}, error() {} };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const tmpDir = (prefix = 'bl-core-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A fake source: fetch returns { n } with an incrementing n; counts calls. */
export function fakeSource(id, ttl, def = {}) {
  const src = {
    id, title: `Fake ${id}`, ttl, calls: 0,
    async fetch() { src.calls++; return { n: src.calls, at: Date.now(), pad: 'x'.repeat(def.padBytes || 0) }; },
    ...def,
  };
  return src;
}

/**
 * Open GET /api/stream with fetch streaming and parse SSE frames as they arrive.
 * Returns { res, events, retry, next(event, pred, ms), close() }. close() aborts the request.
 */
export async function openStream(url, headers = {}) {
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal, headers });
  const events = [];
  const waiters = new Set();
  const state = { retry: null, ended: false };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = 'message', data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
            else if (line.startsWith('retry: ')) state.retry = Number(line.slice(7));
          }
          if (!data) continue;
          const ev = { event, data: JSON.parse(data), at: Date.now() };
          events.push(ev);
          for (const w of [...waiters]) if (w.test(ev)) { waiters.delete(w); w.resolve(ev); }
        }
      }
    } catch { /* aborted */ }
    state.ended = true;
  })();
  return {
    res,
    events,
    get retry() { return state.retry; },
    get ended() { return state.ended; },
    /** Resolve with the first event (already received or future) named `event` that matches pred. */
    next(event, pred = () => true, ms = 3000, { fromIndex = 0 } = {}) {
      const test = (ev) => ev.event === event && pred(ev.data);
      const have = events.slice(fromIndex).find(test);
      if (have) return Promise.resolve(have);
      return new Promise((resolve, reject) => {
        const w = { test, resolve };
        waiters.add(w);
        setTimeout(() => { if (waiters.delete(w)) reject(new Error(`timed out waiting for SSE '${event}' after ${ms} ms`)); }, ms).unref();
      });
    },
    async close() { ctrl.abort(); await pump; },
  };
}

/** Raw HTTP GET via node:http (no transparent decompression), resolving { status, headers, body: Buffer }. */
export function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

/** Wait until fn() is truthy (polling), or throw after ms. */
export async function until(fn, ms = 3000, step = 10) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(step);
  }
}
