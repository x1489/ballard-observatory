// group `civic` parsers (sources/civic.mjs _test) on real fixtures, with a fixed clock.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { _test as C } from '../../sources/civic.mjs';
import { NOW, MIN, HOUR, DAY, fixtureJson, fixtureText, ok, fail, assertContract, assertShape, hygiene } from './_helpers.mjs';
import * as S from './_schemas.mjs';

const Z = (s) => Date.parse(s);
const clone = (o) => JSON.parse(JSON.stringify(o));

describe('fire911 (Socrata kzjm-xkqj + SFD realtime911 HTML)', () => {
  const soc = fixtureJson('civic/socrata-kzjm-xkqj.json');
  const max = fixtureJson('civic/socrata-kzjm-xkqj-max.json');
  const today = C.parseRt911(fixtureText('civic/sfd-realtime911-today.html'));
  const prev = C.parseRt911(fixtureText('civic/sfd-realtime911-prev.html'));
  const live = C.mergeRt911(today, prev);
  const build = (o = {}) => C.buildFire911({ socOk: true, socRows: soc, maxRows: max, live, activeKnown: true, now: NOW, ...o });

  test('parseRt911: Pacific M/D/YYYY h:mm:ss AM|PM, units, level, active cells', () => {
    assert.equal(today.size, 249);
    assert.equal(prev.size, 291);
    assert.deepEqual({ ...today.get('F260137529'), units: [...today.get('F260137529').units] }, {
      id: 'F260137529', t: Z('2026-09-26T01:40:06Z'), level: 1, active: true, units: ['E2', 'L4'], address: '1600 2nd Ave', type: 'Alarm Bell',
    });
    assert.equal([...today.values()].filter((h) => h.active).length, 11);
  });
  test('parseRt911: rows of one incident merge (units union, max level, any active, earliest time)', () => {
    const row = (time, id, level, units, cls = 'closed') => `<tr id=row_1><td class="${cls}">${time}</td><td class="${cls}">${id}</td><td class="${cls}">${level}</td><td class="${cls}">${units}</td><td class="${cls}">5400 Ballard Ave Nw</td><td class="${cls}">Fire in Building</td></tr>`;
    const m = C.parseRt911(`<table>${row('9/25/2026 6:40:00 PM', 'F1', '1', 'E18 L8')}${row('9/25/2026 6:35:00 PM', 'F1', '2', 'E18 M18 B4', 'active')}${row('x', 'NOTANID', '1', 'E1')}</table>`);
    assert.equal(m.size, 1);
    const h = m.get('F1');
    assert.deepEqual([h.t, h.level, h.active, [...h.units].sort()], [Z('2026-09-26T01:35:00Z'), 2, true, ['B4', 'E18', 'L8', 'M18']]);
    assert.equal(C.parseRt911('<html><body>Service Unavailable</body></html>').size, 0);
  });
  test('meets the contract: 14 located Ballard calls, enriched from the live page', () => {
    const out = build();
    assertContract(out, S.fire911);
    assert.equal(out.incidents.length, 14);
    assert.ok(out.incidents.every((i) => i.located && i.units));
    assert.deepEqual(out.incidents[0], {
      id: 'F260137510', type: 'Aid Response', address: '949 NW Market St', t: Z('2026-09-26T00:58:10Z'), // HTML seconds, 17:58:10 PDT
      lat: 47.668661, lon: -122.369127, units: 'E18', level: 1, active: false, distKm: 1.17, located: true,
    });
    assert.deepEqual([out.activeKnown, out.activeCount, out.newest], [true, 0, Z('2026-09-26T00:58:10Z')]);
    out.incidents.forEach((x, i) => i && assert.ok(x.t <= out.incidents[i - 1].t));
  });
  test('a live Ballard call not yet in Socrata is added unlocated and counts as active', () => {
    const extra = new Map(live);
    extra.set('F999', { id: 'F999', t: NOW - MIN, level: 1, active: true, units: new Set(['E18']), address: '5400 Ballard Ave Nw', type: 'Aid Response' });
    extra.set('F998', { id: 'F998', t: NOW - MIN, level: 1, active: true, units: new Set(['E2']), address: '1600 2nd Ave', type: 'Aid Response' });
    const out = build({ live: extra });
    assert.deepEqual(out.incidents[0], {
      id: 'F999', type: 'Aid Response', address: '5400 Ballard Ave NW', t: NOW - MIN, lat: null, lon: null, units: 'E18', level: 1, active: true, distKm: null, located: false,
    });
    assert.equal(out.incidents.length, 15); // the downtown call is not added
    assert.equal(out.activeCount, 1);
  });
  test('Socrata down: Ballard-looking live rows only, all unlocated', () => {
    const out = build({ socOk: false, socRows: undefined, maxRows: null });
    assertContract(out, S.fire911);
    assert.equal(out.incidents.length, 15);
    assert.ok(out.incidents.every((i) => !i.located && i.lat === null && i.t >= NOW - DAY));
    assert.ok(out.incidents.some((i) => i.id === 'F260137374')); // 8340 15th Ave NW: Ballard, but > 2 km so not in Socrata
    assert.ok(!out.incidents.some((i) => i.id === 'F260137162')); // 3763 W Commodore Way: in the 2 km circle, not Ballard
  });
  test('live pages down: Socrata rows unenriched, active count unknown (null, not 0)', () => {
    const out = build({ live: null, activeKnown: false });
    assertContract(out, S.fire911);
    assert.equal(out.incidents.length, 14);
    assert.ok(out.incidents.every((i) => i.units === null && i.active === null && i.level === null));
    assert.equal(out.incidents[0].t, Z('2026-09-26T00:58:00Z')); // Socrata minute precision
    assert.deepEqual([out.activeKnown, out.activeCount], [false, null]);
  });
  test("mergeRt911: today's rows win over the previous day's; null when both are missing", () => {
    const a = new Map([['F1', { id: 'F1', active: false }]]);
    const b = new Map([['F1', { id: 'F1', active: true }], ['F2', { id: 'F2' }]]);
    const m = C.mergeRt911(b, a);
    assert.deepEqual([m.get('F1').active, m.size], [true, 2]);
    assert.equal(C.mergeRt911(null, null), null);
    assert.equal(C.mergeRt911(null, a).size, 1);
  });
  test('coords from report_location when lat/lon are missing; bad coords are null; duplicate rows collapse', () => {
    const rows = clone(soc);
    delete rows[0].latitude;
    delete rows[0].longitude;
    rows[1].latitude = 'REDACTED';
    rows[1].report_location = null;
    rows.push(clone(rows[2]));
    const out = build({ socRows: rows });
    assert.equal(out.incidents.length, 14);
    assert.deepEqual([out.incidents[0].lat, out.incidents[0].lon, out.incidents[0].located], [47.668661, -122.369127, true]);
    const r1 = out.incidents.find((i) => i.id === rows[1].incident_number);
    assert.deepEqual([r1.lat, r1.lon, r1.distKm, r1.located], [null, null, null, false]);
  });
  test('looksBallard / titleCase', () => {
    for (const a of ['5433 Leary Ave Nw', 'Nw Market St / 22nd Ave Nw', '2034 Nw 56th St', '6512 4th Ave Nw', '1 Seaview Ave Nw', 'Ballard Locks']) assert.ok(C.looksBallard(a), a);
    for (const a of ['1600 2nd Ave', '100 Nw 90th St', '6512 40th Ave Nw', '3763 W Commodore Way', '', null]) assert.ok(!C.looksBallard(a), String(a));
    assert.equal(C.titleCase('8TH AVE NW / NW MARKET ST'), '8th Ave NW / NW Market St');
    assert.equal(C.titleCase("HATTIE'S HAT"), "Hattie's Hat");
    assert.equal(C.titleCase('49XX BLOCK OF LEARY AVE NW'), '49XX block of Leary Ave NW');
    assert.equal(C.titleCase(null), null);
  });
});

describe('crime (SPD tazs-3rd5)', () => {
  const rows = fixtureJson('civic/socrata-tazs-3rd5.json');
  test('meets the contract with exact values', () => {
    const out = C.parseCrime(rows, NOW);
    assertContract(out, S.crime);
    assert.equal(out.reports.length, 48);
    assert.deepEqual(out.byCategory, { PROPERTY: 34, PERSON: 8, SOCIETY: 2 });
    assert.deepEqual(out.reports[0], {
      id: '2026-285082', t: Z('2026-09-24T20:35:32Z'), offenseT: Z('2026-09-24T17:38:00Z'), offenses: ['Aggravated Assault'], category: 'PERSON',
      block: '49XX block of Leary Ave NW', lat: 47.66441113, lon: -122.379465521095, beat: 'B1',
    });
    assert.equal(out.newest, Z('2026-09-24T20:35:32Z'));
    assert.equal(out.lagHours, 29.2);
  });
  test('rows group by report number: offenses merged, worst category, earliest offense, Not Reportable dropped', () => {
    const base = { report_number: 'R1', report_date_time: '2026-09-25T10:00:00.000', block_address: 'REDACTED', latitude: 'REDACTED', longitude: 'REDACTED', beat: '' };
    const out = C.parseCrime([
      { ...base, offense_date: '2026-09-25T02:00:00.000', nibrs_offense_code_description: 'Theft From Motor Vehicle', nibrs_crime_against_category: 'PROPERTY' },
      { ...base, offense_date: '2026-09-25T01:00:00.000', nibrs_offense_code_description: 'Simple Assault', nibrs_crime_against_category: 'PERSON', block_address: '15XX BLOCK OF NW MARKET ST', latitude: '47.6687', longitude: '-122.376' },
      { ...base, nibrs_offense_code_description: 'Not Reportable to NIBRS', nibrs_crime_against_category: 'NOT_A_CRIME' },
    ], NOW);
    assert.deepEqual(out.reports[0], {
      id: 'R1', t: Z('2026-09-25T17:00:00Z'), offenseT: Z('2026-09-25T08:00:00Z'), offenses: ['Theft From Motor Vehicle', 'Simple Assault'], category: 'PERSON',
      block: '15XX block of NW Market St', lat: 47.6687, lon: -122.376, beat: null,
    });
    assert.deepEqual(out.byCategory, { PROPERTY: 0, PERSON: 1, SOCIETY: 0 });
  });
  test('max 80 reports; empty and non-array inputs', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ report_number: `R${i}`, report_date_time: `2026-09-2${i % 5}T10:${String(i % 60).padStart(2, '0')}:00.000` }));
    assert.equal(C.parseCrime(many, NOW).reports.length, 80);
    assert.deepEqual(C.parseCrime([], NOW), { reports: [], byCategory: { PROPERTY: 0, PERSON: 0, SOCIETY: 0 }, newest: null, lagHours: null });
    assert.throws(() => C.parseCrime({ error: true, message: 'Unrecognized arguments' }, NOW), /unexpected response/);
  });
});

describe('quakes (USGS)', () => {
  const a = fixtureJson('civic/usgs-recent.json'), b = fixtureJson('civic/usgs-notable.json');
  test('meets the contract with exact values', () => {
    const out = C.buildQuakes(ok(a), ok(b));
    assertContract(out, S.quakes);
    assert.equal(out.recent.length, 14);
    assert.equal(out.notable.length, 3);
    assert.deepEqual(out.recent[0], {
      id: 'uw714109682', mag: 1.66, place: '2 km E of Granite Falls, Washington', t: 1790371824000, depthKm: -0.4, lat: 48.0845, lon: -121.9298,
      url: 'https://earthquake.usgs.gov/earthquakes/eventpage/uw714109682', felt: null, distKm: 57.3,
    });
    assert.equal(out.notable[0].felt, 19);
    out.recent.forEach((q, i) => i && assert.ok(q.t <= out.recent[i - 1].t));
  });
  test('one query down: warning; both down: throws; features without geometry are skipped', () => {
    const o = C.buildQuakes(fail('HTTP 503 from earthquake.usgs.gov'), ok(b));
    assert.deepEqual([o.recent, o.notable.length, o.warnings], [[], 3, ['recent (150 km) query failed: HTTP 503 from earthquake.usgs.gov']]);
    assert.throws(() => C.buildQuakes(fail('x'), fail('y')), /USGS: x/);
    const x = clone(a);
    x.features[0].geometry = null;
    x.features[1].properties.time = null;
    assert.equal(C.buildQuakes(ok(x), ok(b)).recent.length, 12);
    assert.deepEqual(C.buildQuakes(ok({ type: 'FeatureCollection' }), ok(b)).recent, []);
  });
});

describe('outages (Seattle City Light / DataCapable)', () => {
  const ev = fixtureJson('civic/scl-events.json'), st = fixtureJson('civic/scl-stats.json');
  test('real fixture: none in Ballard; citywide totals; updated from stats', () => {
    const out = C.buildOutages(ok(ev), ok(st));
    assertContract(out, S.outages);
    assert.equal(typeof st.lastUpdatedTime, 'string'); // upstream sends epoch ms as a string
    assert.deepEqual(out, { ballard: [], citywide: { count: 7, customers: 1030 }, updated: 1790386929722 });
  });
  test('a Ballard outage: ring [lon,lat] -> [lat,lon], first ring only; sorted by customers', () => {
    const x = clone(ev);
    const e = x[0];
    Object.assign(e, { id: 1, latitude: 47.668, longitude: -122.385, numPeople: 12 });
    e.polygons.rings = [[[-122.3851, 47.6681], [-122.3849, 47.6682], [-122.3850, 47.6679]], [[0, 0]]];
    Object.assign(x[1], { id: 2, latitude: 47.67, longitude: -122.38, numPeople: 300, polygons: null, etrTime: 1790387100 }); // seconds, not ms
    const out = C.buildOutages(ok(x), ok(st));
    assertContract(out, S.outages);
    assert.deepEqual(out.ballard.map((o) => o.id), [2, 1]);
    assert.deepEqual(out.ballard[1].ring, [[47.6681, -122.3851], [47.6682, -122.3849], [47.6679, -122.385]]);
    assert.equal(out.ballard[0].ring, null);
    assert.equal(out.ballard[0].etr, null); // an epoch in seconds is not trusted as ms
    assert.equal(out.ballard[1].start, e.startTime);
  });
  test('stats down: updated from the newest event, with a warning; events down or not an array: throws', () => {
    const o = C.buildOutages(ok(ev), fail('timeout'));
    assert.equal(o.updated, Math.max(...ev.map((e) => Number(e.lastUpdatedTime))));
    assert.deepEqual(o.warnings, ['SCL stats failed: timeout']);
    assert.throws(() => C.buildOutages(fail('HTTP 502'), ok(st)), /SCL events: HTTP 502/);
    assert.throws(() => C.buildOutages(ok({ message: 'error' }), ok(st)), /unexpected response/);
    assert.deepEqual(C.buildOutages(ok([]), ok(st)).citywide, { count: 0, customers: 0 });
  });
});

describe('news (merged RSS/Atom)', () => {
  const FILES = { 'My Ballard': 'myballard', PhinneyWood: 'phinneywood', 'Seattle Times': 'seattletimes', 'SPD Blotter': 'spdblotter', 'SFD Fireline': 'fireline', 'SDOT Blog': 'sdotblog', 'Seattle Parks': 'parkways', 'Google News': 'googlenews' };
  const texts = C.NEWS_FEEDS.map((f) => fixtureText(`civic/rss-${FILES[f.name]}.xml`));
  const out = C.buildNews(texts.map(ok));

  test('meets the contract; every feed ok', () => {
    assertContract(out, S.news);
    assert.deepEqual(out.feeds, C.NEWS_FEEDS.map((f) => ({ name: f.name, ok: true, count: f.google ? 25 : 10 })));
    assert.equal(out.items.length, 50);
    out.items.forEach((x, i) => i && assert.ok(x.t <= out.items[i - 1].t));
  });
  test('My Ballard items are always Ballard; citywide feeds keep Ballard items + their newest 3', () => {
    const count = (src) => out.items.filter((i) => i.source === src).length;
    assert.equal(count('My Ballard'), 10);
    assert.ok(out.items.filter((i) => i.source === 'My Ballard').every((i) => i.ballard));
    for (const src of ['Seattle Times', 'SPD Blotter', 'SFD Fireline', 'SDOT Blog', 'Seattle Parks']) assert.ok(count(src) <= 3 || out.items.filter((i) => i.source === src && !i.ballard).length <= 3, src);
    assert.deepEqual(out.items.find((i) => i.source === 'My Ballard'), {
      source: 'My Ballard', title: 'Seattle Sauna Festival returns to National Nordic Museum in November',
      link: 'https://www.myballard.com/2026/09/25/seattle-sauna-festival-returns-to-national-nordic-museum-in-november/', t: Z('2026-09-25T20:18:28Z'),
      summary: 'The Seattle Sauna Festival will return to the National Nordic Museum in Ballard on Nov. 7 and 8. The festival debuted at the museum last November. This year, it will…',
      ballard: true,
    });
  });
  test("Google News: ' - Source' suffix moved to source; no summary; titles deduped across feeds", () => {
    const g = out.items.find((i) => i.source === 'MyNorthwest.com');
    assert.equal(g.title, '20-year-old sentenced to more than 3 years for deadly 2025 Ballard hit-and-run');
    assert.equal(g.summary, null);
    const seen = new Set();
    for (const i of out.items) {
      assert.ok(!i.title.endsWith(` - ${i.source}`), i.title);
      const k = C.normTitle(i.title);
      assert.ok(!seen.has(k), `duplicate: ${i.title}`);
      seen.add(k);
    }
  });
  test('MaxPreps/NFHS and high-school game pages are dropped', () => {
    const extra = texts.slice();
    const gi = C.NEWS_FEEDS.findIndex((f) => f.google);
    const item = (title, host) => `<item><title>${title}</title><link>https://${host}/x</link><pubDate>Fri, 25 Sep 2026 20:00:00 GMT</pubDate><source url="https://${host}">${host}</source></item>`;
    extra[gi] = extra[gi].replace('</channel>', `${item('Ballard vs Garfield - MaxPreps', 'www.maxpreps.com')}${item('Ballard JV Football vs Roosevelt - Game Page', 'x.com')}${item('Watch Ballard live - NFHS Network', 'www.nfhsnetwork.com')}</channel>`);
    const o = C.buildNews(extra.map(ok));
    assert.ok(!o.items.some((i) => /maxpreps|nfhs|JV Football/i.test(i.title + i.source)));
    assert.equal(o.items.length, 50);
  });
  test('a failed feed and an HTML page are reported in feeds; all failing throws', () => {
    const r = texts.map(ok);
    r[1] = fail('HTTP 403 from phinneywood.com');
    r[2] = ok('<!DOCTYPE html><html><body>Just a moment...</body></html>');
    const o = C.buildNews(r);
    assert.deepEqual(o.feeds[1], { name: 'PhinneyWood', ok: false, count: 0, error: 'HTTP 403 from phinneywood.com' });
    assert.deepEqual(o.feeds[2], { name: 'Seattle Times', ok: false, count: 0, error: 'not an RSS/Atom feed' });
    assert.ok(!o.items.some((i) => i.source === 'PhinneyWood'));
    assertShape(o, S.news);
    assert.throws(() => C.buildNews(C.NEWS_FEEDS.map(() => fail('offline'))), /all news feeds failed/);
  });
  test('cleanSummary / cleanLink', () => {
    assert.equal(C.cleanSummary('Big news here. The post Big News appeared first on My Ballard.'), 'Big news here.');
    assert.equal(C.cleanSummary('Story text ... Read more'), 'Story text…');
    assert.equal(C.cleanSummary('<p>Hello &amp; <b>bye</b></p>'), 'Hello & bye');
    assert.equal(C.cleanSummary(''), null);
    assert.equal(C.cleanSummary('x'.repeat(400)).length <= 280, true);
    assert.equal(C.cleanLink('https://ex.com/a?utm_source=rss&id=3&UTM_medium=x'), 'https://ex.com/a?id=3');
    assert.equal(C.cleanLink('not a url'), 'not a url');
  });
});

describe('reddit (Atom)', () => {
  test('r/Ballard and r/Seattle items: authors without the leading slash, epoch times', () => {
    const b = C.redditItems(fixtureText('civic/reddit-ballard.xml'), 'r/Ballard');
    const s = C.redditItems(fixtureText('civic/reddit-seattle.xml'), 'r/Seattle');
    assert.equal(b.length, 25);
    assert.equal(s.length, 25);
    assertContract({ items: [...b, ...s].slice(0, 30) }, S.reddit);
    assert.ok(b.every((i) => i.sub === 'r/Ballard' && /^u\//.test(i.author) && /\/r\/Ballard\/comments\//.test(i.link)));
    assert.equal(b[0].link, 'https://www.reddit.com/r/Ballard/comments/1wnlmlp/hi_everyone_im_jackie_a_dental_hygiene_student_at/');
    assert.equal(b[0].t, 1790110282000);
  });
  test('an HTML block page yields no items (the fetch wrapper then throws "not an Atom feed")', () => {
    assert.deepEqual(C.redditItems('<!doctype html><html><body>whoa there, pardner!</body></html>', 'r/Ballard'), []);
  });
});

describe('events (Visit Ballard + SPL Trumba)', () => {
  const vb = C.mapVisitBallardEvents(fixtureJson('civic/visitballard-events.json').events);
  const spl = C.parseSplBallard(fixtureJson('civic/trumba-kalendaro.json'));
  const out = { events: C.mergeEvents(vb, spl, NOW) };

  test('meets the contract', () => {
    assertContract(out, S.events);
    assert.equal(vb.length, 29);
    assert.equal(spl.length, 13);
    assert.equal(out.events.length, 37);
    out.events.forEach((e, i) => i && assert.ok(e.start >= out.events[i - 1].start));
    assert.ok(out.events.every((e) => (e.end ?? e.start + 2 * HOUR) >= NOW));
  });
  test('exact Visit Ballard and SPL rows (UTC fields / explicit offsets)', () => {
    assert.deepEqual(vb[0], {
      id: 'vb-10005946', title: 'Moomins’ Sea Adventures & Tove and the Sea', start: Z('2026-09-25T15:00:00Z'), end: Z('2026-09-26T00:00:00Z'), allDay: false,
      venue: 'National Nordic Museum', address: '2655 NW Market St', cost: '$10 – $25',
      url: 'https://www.visitballard.com/event/moomins-sea-adventures-tove-and-the-sea/2026-09-25/', source: 'Visit Ballard', canceled: false, category: null,
    });
    assert.deepEqual(spl[0], {
      id: 'spl-206603394', title: 'Seattle Reads: Sara Nović discusses "True Biz"', start: Z('2026-09-25T18:00:00Z'), end: Z('2026-09-25T19:15:00Z'), allDay: false,
      venue: 'Ballard Branch', address: '5614 22nd Ave NW', cost: null, url: 'https://www.spl.org/event-calendar?trumbaEmbed=view%3Devent%26eventid%3D206603394',
      source: 'SPL Ballard', canceled: false, category: null,
    });
    assert.ok(spl.some((e) => e.canceled));
  });
  test('trumbaTime: explicit offsets, fallback to Pacific, all-day dates', () => {
    assert.equal(C.trumbaTime('2026-09-25T11:00:00', '-0700'), Z('2026-09-25T18:00:00Z'));
    assert.equal(C.trumbaTime('2026-12-01T11:00:00', '-08:00'), Z('2026-12-01T19:00:00Z'));
    assert.equal(C.trumbaTime('2026-12-01T11:00:00', null), Z('2026-12-01T19:00:00Z'));
    assert.equal(C.trumbaTime('2026-09-26', '-0700'), Z('2026-09-26T07:00:00Z'));
    assert.equal(C.trumbaTime(null, '-0700'), null);
  });
  test('Visit Ballard: local-time fallback, end before start, venue arrays, cancellations', () => {
    const [e] = C.mapVisitBallardEvents([{
      id: 1, title: 'CANCELLED: Pie Social', start_date: '2026-09-26 10:00:00', end_date: '2026-09-26 09:00:00', all_day: true,
      venue: [{ venue: 'Ballard Commons', address: '5701 22nd Ave NW, ' }], categories: [{ name: 'Food &amp; Drink' }], url: 'https://x/1', cost: '',
    }, { id: 2, title: 'No dates' }]);
    assert.deepEqual(e, {
      id: 'vb-1', title: 'CANCELLED: Pie Social', start: Z('2026-09-26T17:00:00Z'), end: null, allDay: true, venue: 'Ballard Commons', address: '5701 22nd Ave NW',
      cost: null, url: 'https://x/1', source: 'Visit Ballard', canceled: true, category: 'Food & Drink',
    });
  });
  test('SPL: other branches skipped; CANCELLED prefix stripped; not an array throws', () => {
    const base = { eventID: 5, location: '<a href="#">Ballard Branch</a>', startDateTime: '2026-09-26T10:00:00', startTimeZoneOffset: '-0700', endDateTime: '2026-09-26T11:00:00' };
    const r = C.parseSplBallard([{ ...base, title: 'CANCELLED - Toddler Play Group' }, { ...base, eventID: 6, location: 'Fremont Branch', title: 'x' }]);
    assert.deepEqual(r.map((e) => [e.id, e.title, e.canceled, e.start]), [['spl-5', 'Toddler Play Group', true, Z('2026-09-26T17:00:00Z')]]);
    assert.throws(() => C.parseSplBallard({ error: 'Calendar not found' }), /SPL Trumba: unexpected response/);
  });
  test('mergeEvents: over events drop (no end = start + 2 h), duplicates collapse, cap 150', () => {
    const ev = (id, start, end = null, title = `E${id}`) => ({ id, title, start, end, allDay: false, venue: 'V', address: null, cost: null, url: 'u', source: 'Visit Ballard', canceled: false, category: null });
    const r = C.mergeEvents([ev(1, NOW - HOUR), ev(2, NOW - 3 * HOUR), ev(3, NOW - 3 * HOUR, NOW + MIN), ev(4, NOW + HOUR, null, 'Dup'), ev(5, NOW + HOUR, null, 'Dup')], [], NOW);
    assert.deepEqual(r.map((e) => e.id), [3, 1, 4]);
    const many = Array.from({ length: 200 }, (_, i) => ev(i, NOW + i * MIN));
    assert.equal(C.mergeEvents(many, [], NOW).length, 150);
  });
});

describe('closures (Seattle street closures ium9-iqtc)', () => {
  const rows = fixtureJson('civic/socrata-ium9-iqtc.json');
  test('meets the contract with exact values (Friday)', () => {
    const out = C.parseClosures(rows, NOW);
    assertContract(out, S.closures);
    assert.equal(out.closures.length, 5);
    const c = out.closures.find((x) => x.permit === 'SUFUN0006224');
    assert.deepEqual({ ...c, segments: c.segments.length }, {
      permit: 'SUFUN0006224', type: 'Play Street', name: 'Play Street | Fri Sun | 9th Ave NW b/t 65th & 67th', street: '9th Ave NW', from: 'NW 65th St', to: 'NW 67th St',
      todayHours: '4PM-9PM', days: { sun: '1PM-8PM', fri: '4PM-9PM' }, start: Z('2026-05-12T07:00:00Z'), end: c.end, segments: 1,
    });
    assert.deepEqual(c.segments[0].line[0], [47.67598, -122.36874]); // [lat, lon]
    // Closures with hours today sort first.
    const firstNoHours = out.closures.findIndex((x) => !x.todayHours);
    assert.ok(firstNoHours === -1 || out.closures.slice(firstNoHours).every((x) => !x.todayHours));
  });
  test("midnight rollover: todayHours follows the Pacific weekday", () => {
    const at = (iso) => C.parseClosures(rows, Z(iso)).closures.find((x) => x.permit === 'SUFUN0006224').todayHours;
    assert.equal(at('2026-09-26T06:59:59Z'), '4PM-9PM'); // Fri 23:59:59 PDT
    assert.equal(at('2026-09-26T07:00:00Z'), null); // Sat 00:00 PDT
    assert.equal(at('2026-09-27T07:00:00Z'), '1PM-8PM'); // Sun
  });
  test('rows group by permit; contiguous segments give an overall from/to; absurd years dropped', () => {
    const seg = (from, to, lon0) => ({
      permit_number: 'P1', permit_type: 'Block Party', project_name: 'Block party', street_on: 'NW 58TH ST', street_from: from, street_to: to,
      start_date: '2026-09-25T00:00:00.000', end_date: '2026-09-25T23:59:00.000', friday: '10AM-8PM',
      line_string: { type: 'MultiLineString', coordinates: [[[lon0, 47.67], [lon0 + 0.001, 47.67]]] },
    });
    const out = C.parseClosures([
      seg('24TH AVE NW', '22ND AVE NW', -122.388), seg('22ND AVE NW', '20TH AVE NW', -122.386),
      { ...seg('A', 'B', -122.38), permit_number: 'P2', end_date: '2924-09-25T00:00:00.000' },
    ], NOW);
    assert.equal(out.closures.length, 1);
    assert.deepEqual([out.closures[0].from, out.closures[0].to, out.closures[0].segments.length, out.closures[0].todayHours], ['24th Ave NW', '20th Ave NW', 2, '10AM-8PM']);
    assert.deepEqual(out.closures[0].segments[0].line, [[47.67, -122.388], [47.67, -122.387]]);
    assert.throws(() => C.parseClosures({ error: true }, NOW), /unexpected response/);
    assert.deepEqual(C.parseClosures([], NOW), { closures: [] });
  });
});

describe('requests311 (5ngg-rpne)', () => {
  test('meets the contract with exact values', () => {
    const out = C.parseRequests311(fixtureJson('civic/socrata-5ngg-rpne.json'));
    assertContract(out, S.requests311);
    assert.equal(out.requests.length, 40);
    assert.deepEqual(out.requests[0], {
      id: '26-00287925', type: 'General Inquiry - Customer Service Bureau', status: 'New', t: Z('2026-09-25T07:35:08Z'), address: '3051 NW 56th St',
      lat: 47.66932024, lon: -122.3979023, area: 'Sunset Hill/Loyal Heights',
    });
    assert.equal(out.newest, Z('2026-09-25T07:35:08Z'));
  });
  test('missing fields are null; non-array throws', () => {
    const out = C.parseRequests311([{ servicerequestnumber: 'X', createddate: 'garbage', latitude: '0', longitude: '0' }]);
    assert.deepEqual(out, { requests: [{ id: 'X', type: null, status: null, t: null, address: null, lat: null, lon: null, area: null }], newest: null });
    assert.throws(() => C.parseRequests311('<html>'), /unexpected response/);
  });
});

describe('permits (76t5-zqzr)', () => {
  const rows = fixtureJson('civic/socrata-76t5-zqzr.json');
  test('meets the contract with exact values; Issued first; newest first', () => {
    const out = C.parsePermits(rows, NOW);
    assertContract(out, S.permits);
    assert.equal(out.permits.length, 25);
    assert.deepEqual(out.permits[0], {
      id: '7142489-CN', type: 'Addition/Alteration',
      description: 'Allow a new detached housing unit maintaining an existing dwelling (no work) per the land use code. Construct a one-family dwelling per plans',
      address: '7532 Jones Ave NW', issued: Z('2026-09-23T07:00:00Z'), status: 'Issued', cost: 254633, units: 1, lat: 47.68420578, lon: -122.38605471,
      url: 'https://services.seattle.gov/portal/customize/LinkToRecord.aspx?altId=7142489-CN',
    });
    out.permits.forEach((p, i) => i && assert.ok(p.issued <= out.permits[i - 1].issued));
  });
  test('date-only issue dates are Pacific midnight; future-dated rows appear once their day starts', () => {
    const r = [{ permitnum: 'A', issueddate: '2026-09-26T00:00:00.000', statuscurrent: 'Ready for Issuance' }, { permitnum: 'B', issueddate: '2026-09-25T00:00:00.000', statuscurrent: 'Issued', estprojectcost: '0' }];
    assert.deepEqual(C.parsePermits(r, NOW).permits.map((p) => p.id), ['B']);
    assert.deepEqual(C.parsePermits(r, Z('2026-09-26T07:00:00Z')).permits.map((p) => p.id), ['A', 'B']); // shown newest first
    assert.equal(C.parsePermits(r, NOW).permits[0].cost, null); // 0 cost is unknown
  });
  test("'Issued' permits win the 25 slots even when older", () => {
    const r = [
      ...Array.from({ length: 30 }, (_, i) => ({ permitnum: `N${i}`, issueddate: `2026-09-${String(10 + (i % 15)).padStart(2, '0')}`, statuscurrent: 'Completed' })),
      { permitnum: 'OLD-ISSUED', issueddate: '2026-08-27', statuscurrent: 'Issued' },
    ];
    const p = C.parsePermits(r, NOW).permits;
    assert.equal(p.length, 25);
    assert.equal(p.at(-1).id, 'OLD-ISSUED');
  });
  test('long descriptions are cut at 300 chars; duplicates collapse; non-array throws', () => {
    const r = [{ permitnum: 'A', issueddate: '2026-09-20', description: 'word '.repeat(100) }, { permitnum: 'A', issueddate: '2026-09-21' }];
    const p = C.parsePermits(r, NOW).permits;
    assert.equal(p.length, 1);
    assert.ok(p[0].description.length <= 300 && p[0].description.endsWith('…'));
    assert.throws(() => C.parsePermits({ error: true }, NOW), /unexpected response/);
    assert.deepEqual(hygiene(C.parsePermits(rows, NOW)), []);
  });
});
