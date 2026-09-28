// Small persistence helpers for core state files in data/ (history, activity, snapshot).
import fs from 'node:fs';
import path from 'node:path';

/** Read and parse a JSON file. Missing file -> fallback (silently); unreadable/corrupt -> fallback with a warning. */
export function readJson(file, fallback = null, log = console) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn(`[persist] cannot read ${file}: ${e.message}`);
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    log.warn(`[persist] ${file} is not valid JSON (${e.message}); starting empty`);
    return fallback;
  }
}

/** Write JSON atomically: write a temp file in the same directory, then rename over the target. */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, typeof value === 'string' ? value : JSON.stringify(value));
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * Trailing throttle for saves: mark() schedules fn to run once, delayMs later (further marks in that window are
 * folded into the same run, so a source refreshing every 20 s still writes at most once per delayMs).
 * flush() runs fn now if anything is pending. fn errors are logged, never thrown.
 */
export function throttledSaver(fn, delayMs, { name = 'save', log = console } = {}) {
  let timer = null;
  let dirty = false;
  const run = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return false;
    dirty = false;
    try { fn(); return true; } catch (e) { log.error(`[persist] ${name} failed: ${e && e.message || e}`); return false; }
  };
  return {
    mark() {
      dirty = true;
      if (!timer) {
        timer = setTimeout(run, delayMs);
        if (timer.unref) timer.unref();
      }
    },
    flush: run,
    cancel() { if (timer) clearTimeout(timer); timer = null; },
    get pending() { return dirty; },
  };
}
