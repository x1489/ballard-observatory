// Dev harness: run one or more sources' fetch() live and print the normalized output.
// Usage: node tools/probe.mjs <id> [<id>...] [--full]      node tools/probe.mjs --group weather
import { loadSources } from '../sources/index.mjs';

const args = process.argv.slice(2);
const full = args.includes('--full');
const gi = args.indexOf('--group');
const group = gi >= 0 ? args[gi + 1] : null;
const ids = args.filter((a, i) => !a.startsWith('--') && !(gi >= 0 && i === gi + 1));

const { sources, loadErrors } = await loadSources();
for (const le of loadErrors) console.error('LOAD ERROR', le.file, le.error);
const pick = sources.filter((s) => (group ? s.group === group : ids.includes(s.id)));
if (!pick.length) {
  console.error('No matching sources. Available:', sources.map((s) => `${s.group}/${s.id}`).join(' '));
  process.exit(1);
}

function trim(v, depth = 0) {
  if (full) return v;
  if (Array.isArray(v)) return v.length > 4 ? [...v.slice(0, 3).map((x) => trim(x, depth + 1)), `…(${v.length} total)`] : v.map((x) => trim(x, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x, depth + 1)]));
  if (typeof v === 'string' && v.length > 200) return v.slice(0, 200) + '…';
  return v;
}

let failed = 0;
for (const s of pick) {
  const t0 = Date.now();
  try {
    const data = await s.fetch({ prev: null, fetchedAt: 0 });
    const bytes = JSON.stringify(data).length;
    console.log(`\n=== ${s.id} (ttl ${s.ttl}s) OK in ${Date.now() - t0}ms, ${bytes} bytes`);
    console.log(JSON.stringify(trim(data), null, 1));
  } catch (e) {
    failed++;
    console.log(`\n=== ${s.id} FAILED in ${Date.now() - t0}ms: ${e.stack || e}`);
  }
}
process.exit(failed ? 2 : 0);
