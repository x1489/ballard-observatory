// Insight engine (public/insight.js) over a frozen snapshot of all 41 live feeds (tests/fixtures/frontend/snapshot.json,
// captured Sat Sep 26 2026 11:10 PDT). The module is plain ES with no DOM use at import time, so it runs under Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  answer, intentOf, whenOf, moments, liveActivities, brief, suggestions, SUMMARY, CARD_SUMMARY,
  sunPosition, moonPosition, vsUsual, usualBasis, placeStatus, PLACES,
} from '../../public/insight.js';

const snap = JSON.parse(fs.readFileSync(new URL('../fixtures/frontend/snapshot.json', import.meta.url), 'utf8'));
const NOW = snap.savedAt;
const D = (id) => (snap.sources[id] && snap.sources[id].data) || null;
const EMPTY = () => null;
// Text a person would read or hear must never leak these.
const BAD = /\bundefined\b|\bNaN\b|\[object Object\]|\bnull\b|\bInfinity\b/;
const clean = (label, s) => assert.ok(!BAD.test(String(s)), `${label} contains a leaked value: ${String(s).slice(0, 300)}`);
const MIN = 60e3, H = 60 * MIN;

const ROUTES = {
  'when is the next bus': 'bus', 'next D line downtown': 'bus', 'is the bridge up': 'bridge', 'will the bridge open soon': 'bridge',
  'low tide': 'tide', 'when is high tide': 'tide', sunset: 'sun', 'is the air ok': 'air', 'air quality': 'air',
  'what plane is that': 'aircraft', 'planes overhead': 'aircraft', 'why are there sirens': 'fire', 'weather tonight': 'weather',
  'will it rain': 'weather', "what's happening tonight": 'events', 'things to do': 'events', news: 'news', salmon: 'salmon',
  wildlife: 'wildlife', birds: 'wildlife', locks: 'locks', 'power outage': 'power', earthquake: 'quake',
  'is the library open': 'open', scooters: 'scooter', 'show me the bridge camera': 'camera', 'good time to kayak': 'boating',
  'traffic downtown': 'traffic', 'how long to drive downtown': 'traffic', 'brief me': 'brief', settings: 'nav',
};

test('intent routing covers the everyday questions', () => {
  for (const [q, intent] of Object.entries(ROUTES)) assert.equal(intentOf(q), intent, q);
  assert.equal(intentOf('qwertyuiop'), null);
});

test('every routed question gets a clean answer from live data', () => {
  for (const q of Object.keys(ROUTES)) {
    const a = answer(q, D, NOW, { activity: [], favorites: [] });
    assert.ok(a, `no answer for "${q}"`);
    assert.equal(typeof a.title, 'string', q);
    assert.ok(a.title.length > 0, q);
    assert.equal(typeof a.html, 'string', q);
    assert.ok(Array.isArray(a.actions), q);
    clean(`${q} title`, a.title);
    clean(`${q} html`, a.html);
    if (a.speak) clean(`${q} speak`, a.speak);
  }
});

test('answers degrade gracefully with no data at all', () => {
  for (const q of Object.keys(ROUTES)) {
    const a = answer(q, EMPTY, NOW, {});
    if (!a) continue; // "I don't know" is fine; throwing is not
    clean(`${q} (empty) title`, a.title);
    clean(`${q} (empty) html`, a.html);
  }
  assert.equal(answer('', D, NOW), null);
});

test('time words are understood', () => {
  const t = whenOf("what's happening tonight");
  assert.ok(t, 'tonight should be recognized');
});

test('moments: well-formed, unique, ranked', () => {
  const ms = moments(D, NOW, {});
  assert.ok(ms.length >= 1, 'a Saturday late morning with a full moon should have moments');
  const ids = new Set();
  for (const m of ms) {
    assert.ok(m.id && !ids.has(m.id), `duplicate or missing id ${m.id}`);
    ids.add(m.id);
    assert.ok(m.title && m.icon, m.id);
    assert.equal(typeof m.score, 'number', m.id);
    clean(`moment ${m.id}`, `${m.kicker} ${m.title} ${m.body}`);
  }
  for (let i = 1; i < ms.length; i++) assert.ok(ms[i - 1].score >= ms[i].score, 'moments are ranked by score');
  assert.ok(ms.some((m) => m.id === 'fullmoon'), 'full moon rising tonight (Sep 26 2026)');
});

test('moments: anomalies come from learned baselines only', () => {
  const trafficNow = D('traffic').sites.find((s) => s.id === '1991').links.find((l) => /downtown/i.test(l.name)).minutes;
  const heavy = (k) => (k === 'traffic.downtown1991' ? { usual: trafficNow - 9, p25: trafficNow - 10, p75: trafficNow - 8, n: 5, basis: 'hour-of-day' } : null);
  const ms = moments(D, NOW, { baseline: heavy });
  const m = ms.find((x) => x.id === 'usual-traffic');
  assert.ok(m, 'heavier-than-usual traffic becomes a moment');
  assert.match(m.body, /Usually \d+ min around 11 am \(\d+–\d+ min over the last 5 days\)/);
  clean('usual-traffic', m.body);
  const same = (k) => (k === 'traffic.downtown1991' ? { usual: trafficNow, p25: trafficNow - 1, p75: trafficNow + 1, n: 5, basis: 'hour-of-day' } : null);
  assert.ok(!moments(D, NOW, { baseline: same }).some((x) => /^usual-/.test(x.id)), 'usual values are not news');
  assert.ok(!moments(D, NOW, {}).some((x) => /^usual-/.test(x.id)), 'no baselines, no anomaly moments');
  const oneDay = (k) => (k === 'traffic.downtown1991' ? { usual: trafficNow - 9, n: 1, basis: 'hour-of-day' } : null);
  assert.ok(!moments(D, NOW, { baseline: oneDay }).some((x) => /^usual-/.test(x.id)), 'one past day is not "usual" yet');
});

test('vsUsual: direction, tolerance, tone and wording', () => {
  const u = { usual: 12, p25: 11, p75: 13, n: 6, basis: 'hour-of-day' };
  assert.equal(vsUsual(u, 12.5, NOW).dir, 'usual');
  assert.equal(vsUsual(u, 14.3, NOW).dir, 'usual', 'within the tolerance (13 + 12% of 12)');
  assert.equal(vsUsual(u, 14.6, NOW).dir, 'above');
  const up = vsUsual(u, 20, NOW, { better: 'lower', unit: ' min' });
  assert.equal(up.dir, 'above');
  assert.equal(up.tone, 'bad');
  assert.equal(up.usualText, '12 min');
  assert.equal(up.title, 'Usually 12 min around 11 am (11–13 min over the last 6 days)');
  assert.equal(up.vs, 'usual');
  const y = vsUsual({ usual: 12, n: 1, basis: 'hour-of-day' }, 20, NOW, { unit: ' min' });
  assert.equal(y.vs, 'yesterday');
  assert.equal(y.title, 'Yesterday around 11 am: 12 min');
  assert.equal(y.text, "above yesterday's");
  assert.equal(vsUsual({ usual: 45, p25: 44, p75: 46, n: 3, basis: 'hour-of-week' }, 54, NOW, { unit: '°' }).title, 'Usually 45° on Saturdays around 11 am (44–46° over the last 3 weeks)');
  assert.equal(vsUsual(u, 5, NOW, { better: 'lower' }).tone, 'good');
  assert.equal(vsUsual(u, 5, NOW).tone, '', 'neutral metrics have no tone');
  assert.equal(vsUsual(null, 5, NOW), null);
  assert.equal(vsUsual(u, NaN, NOW), null);
  assert.equal(vsUsual(u, 30, NOW, { minDiff: 20 }).dir, 'usual', 'minDiff widens the band');
  assert.equal(usualBasis({ usual: 1, n: 1, basis: 'hour-of-day' }, NOW), 'yesterday around 11 am');
  assert.equal(usualBasis({ usual: 1, n: 3, basis: 'hour-of-week' }, NOW), 'on Saturdays around 11 am');
  assert.equal(usualBasis({ usual: 1, n: 3, basis: 'hour-of-week' }, NOW + H), 'on Saturdays around noon');
  assert.equal(usualBasis({ usual: 1, n: 4, basis: 'hour-of-day' }, NOW), 'around 11 am');
});

test('traffic answers use the learned baseline when there is one', () => {
  const trafficNow = D('traffic').sites.find((s) => s.id === '1991').links.find((l) => /downtown/i.test(l.name)).minutes;
  const a = answer('traffic downtown', D, NOW, { baseline: (k) => (k === 'traffic.downtown1991' ? { usual: trafficNow - 8, p25: trafficNow - 9, p75: trafficNow - 7, n: 4, basis: 'hour-of-day' } : null) });
  assert.match(a.html, /slower than the usual \d+ min/);
  assert.match(a.speak, /slower than the usual \d+ min/);
});

test('live activities: ranked, timed, clean', () => {
  const xs = liveActivities(D, NOW, { favorites: [], activity: [] });
  assert.ok(Array.isArray(xs));
  for (const x of xs) {
    assert.ok(x.id && x.text && x.icon, JSON.stringify(x));
    assert.equal(typeof x.priority, 'number');
    clean(`activity ${x.id}`, `${x.text} ${x.detail || ''}`);
    if (x.timer) assert.ok(Number.isFinite(x.timer.since ?? x.timer.until), `${x.id} timer`);
  }
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i - 1].priority >= xs[i].priority, 'ranked by priority');
});

test('brief: a clean spoken paragraph', () => {
  const b = brief(D, NOW, { activity: [] });
  assert.match(b.text, /^Good morning\. It's \d+° and /);
  assert.match(b.title, /Good morning from Ballard/);
  clean('brief', b.text);
  const withUsual = brief(D, NOW, { baseline: (k) => (k === 'weather.tempF' ? { usual: 40, p25: 39, p75: 41, n: 5, basis: 'hour-of-day' } : null) });
  assert.match(withUsual.text, /Warmer than usual\./);
  clean('brief (empty)', brief(EMPTY, NOW, {}).text);
});

test('summaries and suggestions are clean', () => {
  for (const [k, fn] of Object.entries(SUMMARY)) {
    const s = fn(D, NOW);
    if (!s) continue;
    assert.ok(s.label && s.icon, k);
    clean(`summary ${k}`, `${s.label} ${s.value} ${s.sub || ''}`);
    assert.equal(fn(EMPTY, NOW), null, `${k} without data`);
  }
  for (const v of Object.values(CARD_SUMMARY)) assert.ok(SUMMARY[v], `CARD_SUMMARY -> ${v}`);
  const sug = suggestions(D, NOW);
  assert.ok(sug.length >= 3);
  for (const q of sug) assert.ok(answer(q, D, NOW, {}), `suggestion "${q}" must be answerable`);
});

test('sun position matches the almanac for Ballard on Sep 26 2026', () => {
  const sky = D('sky');
  // Almanac sunrise/sunset: the upper limb touches the horizon (elevation −0.833° with refraction).
  for (const t of [sky.sun.rise, sky.sun.set]) assert.ok(Math.abs(sunPosition(t).elevation + 0.833) < 0.5, `elevation at ${new Date(t).toISOString()}`);
  let best = { el: -99, t: 0 };
  const day0 = sky.sun.rise;
  for (let t = day0; t < sky.sun.set; t += MIN) { const p = sunPosition(t); if (p.elevation > best.el) best = { el: p.elevation, t }; }
  assert.ok(best.el > 40 && best.el < 42.5, `noon elevation ${best.el}`); // 90 − 47.67 + declination (≈ −1.3°)
  assert.ok(Math.abs(sunPosition(best.t).azimuth - 180) < 1.5, 'due south at solar noon');
  const m = moonPosition(sky, NOW);
  assert.ok(m && Number.isFinite(m.elevation) && Number.isFinite(m.azimuth));
});

test('opening hours', () => {
  const market = PLACES[0];
  assert.equal(placeStatus(market, NOW).open, false, 'the farmers market runs Sundays');
  const sunday11 = NOW + 24 * H;
  assert.equal(placeStatus(market, sunday11).open, true);
});
