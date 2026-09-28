// Loads every source module. A broken module is reported, not fatal; a module that doesn't exist yet is skipped.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { INTEL } from './intel.mjs';

const MODULES = ['weather.mjs', 'water.mjs', 'move.mjs', 'civic.mjs', 'extra.mjs', 'tracks.mjs'];
// Ids that would shadow the server's own /api/ routes.
const RESERVED = new Set(['sources', 'stream', 'history', 'activity', 'cams', 'baseline', 'live', 'flight', 'obs']);

/** Check a definition; returns an error string, or null if it is usable. */
function invalid(s) {
  if (!s || typeof s !== 'object') return 'not an object';
  if (typeof s.id !== 'string' || !s.id) return 'missing id';
  if (typeof s.fetch !== 'function') return 'fetch is not a function';
  if (typeof s.ttl !== 'number' || !Number.isFinite(s.ttl) || s.ttl <= 0) return 'ttl must be a positive number of seconds';
  if (RESERVED.has(s.id)) return `id '${s.id}' is reserved`;
  return null;
}

export async function loadSources({ modules = MODULES } = {}) {
  const sources = [];
  const loadErrors = [];
  const seen = new Set();
  for (const file of modules) {
    const url = new URL(`./${file}`, import.meta.url);
    if (!fs.existsSync(fileURLToPath(url))) continue; // optional module (e.g. extra.mjs) not written yet
    let mod;
    try {
      mod = await import(url);
    } catch (e) {
      loadErrors.push({ file, error: String(e && e.message || e) });
      continue;
    }
    for (const s of Array.isArray(mod.default) ? mod.default : []) {
      const why = invalid(s);
      if (why) {
        loadErrors.push({ file, error: `invalid source definition ${JSON.stringify(s && s.id)}: ${why}` });
        continue;
      }
      if (seen.has(s.id)) {
        loadErrors.push({ file, error: `duplicate source id '${s.id}' (ignored)` });
        continue;
      }
      const src = { group: file.replace('.mjs', ''), title: s.id, ...s };
      // v2 metrics / detectors / idle rates from intel.mjs fill in whatever the module doesn't define itself.
      const intel = INTEL[s.id];
      if (intel) for (const k of ['idleTtl', 'metrics', 'detect']) if (src[k] === undefined && intel[k] !== undefined) src[k] = intel[k];
      // Optional v2 fields: drop malformed ones (with a load error) instead of failing at refresh time.
      if (src.idleTtl !== undefined && src.idleTtl !== null && !(typeof src.idleTtl === 'number' && src.idleTtl > 0)) {
        loadErrors.push({ file, error: `${s.id}: idleTtl must be a positive number or null (using the default)` });
        delete src.idleTtl;
      }
      for (const fn of ['metrics', 'detect']) {
        if (src[fn] !== undefined && typeof src[fn] !== 'function') {
          loadErrors.push({ file, error: `${s.id}: ${fn} must be a function (ignored)` });
          delete src[fn];
        }
      }
      seen.add(s.id);
      sources.push(src);
    }
  }
  return { sources, loadErrors };
}
