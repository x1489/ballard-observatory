// End-to-end wiring: every v1 source's real fetch() against the captured fixtures, through a fixture-backed
// globalThis.fetch (no network) with the clock pinned to the capture time. Checks that each source requests the
// URLs its parser expects, and that the whole normalized output meets CONTRACT.md (shape + hygiene).
// State files (bridges.json, reddit.json) go to a temp dir via BALLARD_DATA_DIR, never to the real data/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NOW, fixtureFetch, shapeProblems, hygiene, isEpoch } from './_helpers.mjs';
import { BY_ID } from './_schemas.mjs';

const GROUPS = ['weather', 'water', 'move', 'civic'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ballard-wiring-'));
const realFetch = globalThis.fetch;
const realNow = Date.now;
const log = [];
const results = {}; // id -> { ok, value } | { ok: false, error }
let lib;

before(async () => {
  process.env.BALLARD_DATA_DIR = tmp; // must be set before lib.mjs is first imported in this process
  lib = await import('../../lib.mjs');
  globalThis.fetch = fixtureFetch({ log });
  Date.now = () => NOW;
  const mods = await Promise.all(GROUPS.map((g) => import(`../../sources/${g}.mjs`)));
  const defs = mods.flatMap((m) => m.default);
  // State-writing sources only run when their writes provably land in the temp dir.
  const safe = path.resolve(lib.DATA_DIR) === path.resolve(tmp);
  await Promise.all(defs.map(async (s) => {
    if (!safe && (s.id === 'bridges' || s.id === 'reddit')) { results[s.id] = { skipped: true }; return; }
    try {
      results[s.id] = { ok: true, value: await s.fetch({ prev: null, fetchedAt: 0 }) };
    } catch (e) {
      results[s.id] = { ok: false, error: e };
    }
  }));
});

after(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('all 38 v1 sources are defined and each one ran', () => {
  assert.equal(Object.keys(results).length, 38, Object.keys(results).join(' '));
  assert.deepEqual(Object.keys(results).sort(), Object.keys(BY_ID).sort());
});

test('state files are written to BALLARD_DATA_DIR, not the real data/ dir', () => {
  assert.equal(path.resolve(lib.DATA_DIR), path.resolve(tmp), 'lib.mjs no longer honors BALLARD_DATA_DIR; bridges/reddit were skipped');
  assert.ok(fs.existsSync(path.join(tmp, 'bridges.json')));
  assert.ok(fs.existsSync(path.join(tmp, 'reddit.json')));
});

test('no request fell through to the network', () => {
  // fixtureFetch rejects unrouted URLs; any source that hit one would show it as an error or warning below.
  assert.ok(log.length >= 50, `only ${log.length} requests`);
  for (const line of log) assert.match(line, /^(GET|HEAD) https:\/\//);
});

for (const id of Object.keys(BY_ID)) {
  test(`${id}: fetch() output meets CONTRACT.md`, () => {
    const r = results[id];
    assert.ok(r, `${id} did not run`);
    if (r.skipped) return;
    assert.ok(r.ok, `${id} threw: ${r.error && r.error.stack}`);
    const problems = [...shapeProblems(r.value, BY_ID[id], id), ...hygiene(r.value, id)];
    assert.deepEqual(problems, [], problems.join('\n'));
    // Every source parses its fixture cleanly: no partial-failure warnings, except the ones that are inherent to
    // the capture (the station metadata endpoint is not captured, so coords come from the built-in table silently).
    assert.equal(r.value.warnings, undefined, `${id} warnings: ${JSON.stringify(r.value.warnings)}`);
  });
}

test('requests carry the right Pacific "today" parameters for the pinned clock (Fri 2026-09-25 18:45 PDT)', () => {
  const has = (re) => assert.ok(log.some((l) => re.test(l)), `no request matching ${re}`);
  has(/aa\.usno\.navy\.mil\/api\/rstt\/oneday\?date=2026-09-25&/);
  has(/aa\.usno\.navy\.mil\/api\/rstt\/oneday\?date=2026-09-26&/);
  has(/visitballard\.com\/.*start_date=2026-09-25&end_date=2026-10-02/);
  // NOAA hilo from Pacific midnight, expressed in GMT: 2026-09-25 00:00 PDT = 07:00Z.
  has(/datagetter\?.*station=9447265.*begin_date=20260925\+07%3A00/);
  // Socrata floating-Pacific windows: fire 24 h back, closures active today.
  has(/kzjm-xkqj\.json\?\$where=.*datetime%20%3E%20'2026-09-24T18%3A45%3A00'/);
  has(/ium9-iqtc\.json\?\$where=.*start_date%20%3C%3D%20'2026-09-25T23%3A59%3A59'/);
  // SFD previous-day page for Thursday 9/24/2026.
  has(/realtime911\/getRecsForDatePub\.asp\?incDate=9%2F24%2F2026&/);
  // LPMS stoppages window: 8 days back to 120 days ahead, DDMMYYYY.
  has(/stall_stoppage_json\?begin_date=17092026&end_date=23012027/);
});

test('a few end-to-end values survive the whole pipeline', () => {
  const v = (id) => results[id].value;
  assert.equal(v('weather').current.t, Date.parse('2026-09-26T01:30:00Z'));
  assert.equal(v('tides').next[0].t, Date.parse('2026-09-26T06:16:00Z'));
  assert.equal(v('lockages').today.total, 36);
  assert.equal(v('bridges').bridges[0].name, 'Ballard');
  assert.equal(v('bridges').observingSince, NOW);
  assert.equal(v('fire911').incidents.length, 14);
  assert.equal(v('fire911').activeKnown, true);
  assert.equal(v('cameras').cameras.filter((c) => c.ok).length, 8);
  assert.equal(v('reddit').items.length, 30);
  assert.ok(v('reddit').items.every((i, k, a) => k === 0 || a[k - 1].t >= i.t));
  assert.ok(isEpoch(v('purpleair').t));
});
