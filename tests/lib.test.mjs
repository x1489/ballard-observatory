// lib.mjs helpers: Pacific time conversion, CSV/RSS parsing, text cleanup, geo, math, limiter.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fromPacific, pacificToEpoch, pacificDate, pacificParts, toPacificFloating, fromUTC,
  parseCSV, parseCSVObjects, parseFeed, stripTags, decodeEntities, fixMojibake,
  haversineKm, inBbox, median, pm25ToAqi, limiter, round, num, cToF, kmhToMph, msToMph, msToKt, CENTER, BBOX,
} from '../lib.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const Z = (s) => Date.parse(s); // UTC ISO -> epoch
const HOUR = 3600e3;

describe('fromPacific', () => {
  test('date-only is Pacific local midnight (PDT and PST)', () => {
    assert.equal(fromPacific('2026-09-25'), Z('2026-09-25T07:00:00Z'));
    assert.equal(fromPacific('2026-01-15'), Z('2026-01-15T08:00:00Z'));
  });
  test('ISO-ish floating times (Socrata, Open-Meteo, Visit Ballard)', () => {
    assert.equal(fromPacific('2026-09-24T22:26:00.000'), Z('2026-09-25T05:26:00Z'));
    assert.equal(fromPacific('2026-09-25 08:00:00'), Z('2026-09-25T15:00:00Z'));
    assert.equal(fromPacific('2026-09-25T18:45'), Z('2026-09-26T01:45:00Z'));
    assert.equal(fromPacific('2026-01-15 12:00'), Z('2026-01-15T20:00:00Z'));
  });
  test("SFD / SDOT 'M/D/YYYY h:mm:ss AM|PM'", () => {
    assert.equal(fromPacific('9/25/2026 6:40:06 PM'), Z('2026-09-26T01:40:06Z'));
    assert.equal(fromPacific('9/25/2026 12:05:00 AM'), Z('2026-09-25T07:05:00Z')); // 12 AM = 00h
    assert.equal(fromPacific('9/25/2026 12:05:00 PM'), Z('2026-09-25T19:05:00Z')); // 12 PM = 12h
    assert.equal(fromPacific('11/21/2026 11:59:00 PM'), Z('2026-11-22T07:59:00Z')); // PST
  });
  test("LPMS 'MM/DD/YY HH:mm', CSO 'MM/DD/YYYY HH:mm', stoppages with a static zone label", () => {
    assert.equal(fromPacific('09/25/26 09:05'), Z('2026-09-25T16:05:00Z'));
    assert.equal(fromPacific('09/25/2026 18:40'), Z('2026-09-26T01:40:00Z'));
    assert.equal(fromPacific('03/31/2026 18:00:00 PDT'), Z('2026-04-01T01:00:00Z'));
    assert.equal(fromPacific('9/25/2026'), Z('2026-09-25T07:00:00Z'));
  });
  test('unparseable input is null, never NaN', () => {
    for (const s of [null, undefined, '', '   ', ' PDT', 'garbage', '6/12-8/31x'.slice(0, 0), 'Sept 25']) {
      assert.equal(fromPacific(s), null, JSON.stringify(s));
    }
    // A range cell like '6/12-8/31' is not a date.
    assert.equal(fromPacific('6/12-8/31'), null);
  });
});

describe('pacificToEpoch across DST', () => {
  test('ordinary PDT and PST wall times', () => {
    assert.equal(pacificToEpoch(2026, 9, 25, 18, 45), Z('2026-09-26T01:45:00Z'));
    assert.equal(pacificToEpoch(2026, 12, 31, 23, 59, 59), Z('2027-01-01T07:59:59Z'));
    assert.equal(pacificToEpoch(2026, 1, 1), Z('2026-01-01T08:00:00Z'));
  });
  test('spring-forward day (2026-03-08): times either side of the gap are exact', () => {
    assert.equal(pacificToEpoch(2026, 3, 8, 0, 0), Z('2026-03-08T08:00:00Z'));
    assert.equal(pacificToEpoch(2026, 3, 8, 1, 59), Z('2026-03-08T09:59:00Z')); // last PST minute
    assert.equal(pacificToEpoch(2026, 3, 8, 3, 0), Z('2026-03-08T10:00:00Z')); // first PDT minute
    assert.equal(pacificToEpoch(2026, 3, 9, 0, 0), Z('2026-03-09T07:00:00Z'));
  });
  test('spring-forward gap: a nonexistent 02:xx wall time resolves to a real instant in the adjacent hour', () => {
    // 02:00-02:59 does not exist on 2026-03-08. Today it lands one hour EARLIER (09:30Z = 01:30 PST), not the
    // RFC 5545/Temporal "compatible" 03:30 PDT (10:30Z). Either convention is accepted here (reported as a minor lib
    // quirk: across the gap the mapping is not monotonic, 02:00 -> 09:00Z sorts before 01:59 -> 09:59Z).
    const t = pacificToEpoch(2026, 3, 8, 2, 30);
    assert.ok(Number.isFinite(t));
    assert.ok([Z('2026-03-08T09:30:00Z'), Z('2026-03-08T10:30:00Z')].includes(t), new Date(t).toISOString());
  });
  test('fall-back overlap (2026-11-01 01:00-01:59 happens twice): resolves to the first (PDT) occurrence', () => {
    assert.equal(pacificToEpoch(2026, 11, 1, 0, 59), Z('2026-11-01T07:59:00Z'));
    assert.equal(pacificToEpoch(2026, 11, 1, 1, 30), Z('2026-11-01T08:30:00Z')); // not 09:30Z (PST)
    assert.equal(pacificToEpoch(2026, 11, 1, 2, 0), Z('2026-11-01T10:00:00Z')); // PST
    assert.equal(fromPacific('2026-11-01'), Z('2026-11-01T07:00:00Z'));
    assert.equal(fromPacific('2026-11-02'), Z('2026-11-02T08:00:00Z')); // a 25-hour day
  });
  test('round-trips pacificParts -> pacificToEpoch every 15 min across both transition days', () => {
    for (const [from, to] of [['2026-03-08T06:00:00Z', '2026-03-08T14:00:00Z'], ['2026-11-01T05:00:00Z', '2026-11-01T13:00:00Z']]) {
      for (let t = Z(from); t <= Z(to); t += 15 * 60e3) {
        const p = pacificParts(t);
        const back = pacificToEpoch(p.y, p.m, p.d, p.hh, p.mm, p.ss);
        // The repeated 01:xx PST hour maps back to its PDT twin, exactly one hour earlier; everything else is exact.
        const repeatedHour = t >= Z('2026-11-01T09:00:00Z') && t < Z('2026-11-01T10:00:00Z');
        assert.equal(back, repeatedHour ? t - HOUR : t, new Date(t).toISOString());
      }
    }
  });
});

describe('pacificParts / pacificDate at the midnight edges', () => {
  test('one second before and at Pacific midnight', () => {
    assert.equal(pacificDate(0, Z('2026-09-25T06:59:59Z')), '2026-09-24');
    assert.equal(pacificDate(0, Z('2026-09-25T07:00:00Z')), '2026-09-25');
    const p = pacificParts(Z('2026-09-25T07:00:00Z'));
    assert.deepEqual(p, { y: 2026, m: 9, d: 25, hh: 0, mm: 0, ss: 0, weekday: 5 }); // hh is 0, never 24
    assert.equal(pacificParts(Z('2026-09-25T06:59:59Z')).hh, 23);
  });
  test('offsets roll months and years', () => {
    const nye = Z('2027-01-01T07:30:00Z'); // 2026-12-31 23:30 PST
    assert.equal(pacificDate(0, nye), '2026-12-31');
    assert.equal(pacificDate(1, nye), '2027-01-01');
    assert.equal(pacificDate(-1, Z('2026-03-01T12:00:00Z')), '2026-02-28');
    assert.equal(pacificDate(7, Z('2026-09-26T01:45:00Z')), '2026-10-02');
    assert.equal(pacificDate(-30, Z('2026-09-26T01:45:00Z')), '2026-08-26');
  });
  test('UTC date differs from Pacific date in the evening', () => {
    const t = Z('2026-09-26T01:45:00Z'); // Fri 18:45 PDT
    assert.equal(pacificDate(0, t), '2026-09-25');
    assert.equal(pacificParts(t).weekday, 5);
  });
  test('across DST days the next date is still the next calendar day', () => {
    assert.equal(pacificDate(1, Z('2026-11-01T07:30:00Z')), '2026-11-02'); // 25 h day
    assert.equal(pacificDate(1, Z('2026-03-08T08:30:00Z')), '2026-03-09'); // 23 h day
  });
  test('defaults to the current time', () => {
    assert.equal(pacificDate(), pacificDate(0, Date.now()));
    assert.equal(typeof pacificParts().hh, 'number');
  });
});

describe('toPacificFloating', () => {
  test('formats floating Pacific wall time for Socrata $where', () => {
    assert.equal(toPacificFloating(Z('2026-09-26T01:45:00Z')), '2026-09-25T18:45:00');
    assert.equal(toPacificFloating(Z('2026-01-15T20:00:05Z')), '2026-01-15T12:00:05');
    assert.equal(toPacificFloating(Z('2026-09-25T07:00:00Z')), '2026-09-25T00:00:00');
  });
  test('round-trips with fromPacific (to the second)', () => {
    for (const t of [Z('2026-09-26T01:45:07Z'), Z('2026-02-01T00:00:00Z'), Z('2026-07-04T23:59:59Z')]) {
      assert.equal(fromPacific(toPacificFloating(t)), t);
    }
  });
});

describe('fromUTC', () => {
  test('zone-less strings are UTC (NOAA gmt, USACE GMT, SWPC time_tag)', () => {
    assert.equal(fromUTC('2026-09-25T02:33:00'), Z('2026-09-25T02:33:00Z'));
    assert.equal(fromUTC('2026-09-25 11:27'), Z('2026-09-25T11:27:00Z'));
    assert.equal(fromUTC('2026-09-24T22:26:00.000'), Z('2026-09-24T22:26:00Z'));
    assert.equal(fromUTC('2026-09-25'), Z('2026-09-25T00:00:00Z'));
  });
  test('explicit zones are honored', () => {
    assert.equal(fromUTC('2026-09-25T02:33:00Z'), Z('2026-09-25T02:33:00Z'));
    assert.equal(fromUTC('2026-09-25T02:33:00+00:00'), Z('2026-09-25T02:33:00Z'));
    assert.equal(fromUTC('2026-09-25T02:33:00-07:00'), Z('2026-09-25T09:33:00Z'));
    assert.equal(fromUTC('2026-09-26 01:00:00+0000'), Z('2026-09-26T01:00:00Z')); // PurpleAir utc_ts
    assert.equal(fromUTC('2026-09-26 01:00:00+00:00'), Z('2026-09-26T01:00:00Z'));
  });
  test('garbage is null', () => {
    for (const s of [null, undefined, '', 'garbage', 'MM']) assert.equal(fromUTC(s), null, JSON.stringify(s));
  });
});

describe('parseCSV / parseCSVObjects', () => {
  test('quotes, escaped quotes, embedded commas and newlines, CRLF, blank lines', () => {
    const csv = 'a,b\n"x, y","he said ""hi"""\n"multi\nline",z\r\n\r\n,\nlast,row';
    assert.deepEqual(parseCSV(csv), [['a', 'b'], ['x, y', 'he said "hi"'], ['multi\nline', 'z'], ['', ''], ['last', 'row']]);
  });
  test('trailing newline does not add an empty row; single-column rows survive', () => {
    assert.deepEqual(parseCSV('h\n1\n2\n'), [['h'], ['1'], ['2']]);
    assert.deepEqual(parseCSV(''), []);
  });
  test('objects keyed by trimmed header; short rows leave missing fields undefined', () => {
    const rows = parseCSVObjects(' a , b ,c\n1,"2,5",3\n4\n');
    assert.deepEqual(rows[0], { a: '1', b: '2,5', c: '3' });
    assert.equal(rows[1].a, '4');
    assert.equal(rows[1].b, undefined);
  });
  test('real King County CSO CSV parses with its header', () => {
    const rows = parseCSVObjects(fs.readFileSync(path.join(FIX, 'water/kc-cso.csv'), 'utf8'));
    assert.ok(rows.length > 100);
    assert.deepEqual(Object.keys(rows[0]), ['CSO_TagName', 'X_COORD', 'Y_COORD', 'Name', 'DSN', 'DateTime', 'Status']);
  });
});

describe('decodeEntities / stripTags', () => {
  test('named (case-insensitive), decimal and hex entities; unknown ones are left alone; single pass', () => {
    assert.equal(decodeEntities('Fish &amp; Chips &lt;3 &quot;q&quot; &apos;a&apos;'), 'Fish & Chips <3 "q" \'a\'');
    assert.equal(decodeEntities('&#39;&#8217;&#x2019;&#X2014;'), "'’’—");
    assert.equal(decodeEntities('&ndash;&mdash;&hellip;&rsquo;&ldquo;&rdquo;&AMP;'), '–—…’“”&');
    assert.equal(decodeEntities('a&nbsp;b'), 'a b');
    assert.equal(decodeEntities('&foo; &amp;lt;'), '&foo; &lt;'); // no double decoding
    assert.equal(decodeEntities(), '');
  });
  test('stripTags removes tags and CDATA wrappers, decodes, and collapses whitespace', () => {
    assert.equal(stripTags('<p>Hi&nbsp;<b>there</b><br/>x</p>\n\n <![CDATA[<i>c</i>]]>'), 'Hi there x c');
    assert.equal(stripTags('<a href="x">Ballard Branch</a>'), 'Ballard Branch');
    // Entity-encoded markup is decoded AFTER tag removal, so it survives as text (callers strip again if needed).
    assert.equal(stripTags('&lt;b&gt;bold&lt;/b&gt;'), '<b>bold</b>');
    assert.equal(stripTags(), '');
  });
});

describe('fixMojibake (UTF-8 read as Windows-1252)', () => {
  test('repairs the common cp1252 sequences', () => {
    assert.equal(fixMojibake('Ballard â€“ Market'), 'Ballard – Market');
    assert.equal(fixMojibake('Cafeâ€™s'), 'Cafe’s');
    assert.equal(fixMojibake('â€œquotedâ€\u009d'), '“quoted”');
    assert.equal(fixMojibake('CafÃ©'), 'Café');
    assert.equal(fixMojibake('Â°F'), '°F');
    assert.equal(fixMojibake('smile ðŸ˜€ â€”'), 'smile 😀 —');
  });
  test('leaves clean text (including real accents) untouched', () => {
    for (const s of ['Café naïve', 'Ballard – Market', 'plain ASCII', '', 'Señor 5°']) assert.equal(fixMojibake(s), s);
  });
  test('only engages when an Ã/Â/â-led sequence is present (emoji-only mojibake is left as is)', () => {
    assert.equal(fixMojibake('ðŸ˜€ only'), 'ðŸ˜€ only');
  });
  test('a run that does not decode to valid UTF-8 is kept', () => {
    assert.equal(fixMojibake('Ã('), 'Ã(');
  });
});

describe('parseFeed', () => {
  test('RSS 2.0 with CDATA, entities, dc:creator, categories, source and media:thumbnail', () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
      <item><title><![CDATA[Ballard &amp; Fremont: “news”]]></title><link>https://ex.com/a?x=1&amp;y=2</link>
        <pubDate>Fri, 25 Sep 2026 17:02:50 +0000</pubDate><dc:creator><![CDATA[Jane]]></dc:creator>
        <category><![CDATA[Local]]></category><category>Ballard</category>
        <description><![CDATA[<p>Hello <b>world</b></p>]]></description>
        <source url="https://s.com">Seattle Source</source><media:thumbnail url="https://i.com/t.jpg?a=1&amp;b=2"/></item>
      <item><title>No date</title><link>https://ex.com/b</link></item>
    </channel></rss>`;
    const items = parseFeed(xml);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
      title: 'Ballard & Fremont: “news”', link: 'https://ex.com/a?x=1&y=2', t: Z('2026-09-25T17:02:50Z'),
      summary: 'Hello world', author: 'Jane', categories: ['Local', 'Ballard'], source: 'Seattle Source',
      thumbnail: 'https://i.com/t.jpg?a=1&b=2',
    });
    assert.equal(items[1].t, null); // missing date -> null, not NaN
    assert.equal(items[1].source, null);
  });
  test('Atom entries: link href, published/updated, content, author name, category term', () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>r</title>
      <entry><author><name>/u/someone</name></author><category term="Ballard" label="r/Ballard"/>
        <content type="html">&lt;p&gt;Body &amp;amp; more&lt;/p&gt;</content>
        <link href="https://www.reddit.com/r/Ballard/comments/abc/x/" /><updated>2026-09-25T18:00:00+00:00</updated>
        <published>2026-09-25T17:00:00-07:00</published><title>Lost cat near Market St</title></entry></feed>`;
    const [it] = parseFeed(xml);
    assert.equal(it.title, 'Lost cat near Market St');
    assert.equal(it.link, 'https://www.reddit.com/r/Ballard/comments/abc/x/');
    assert.equal(it.t, Z('2026-09-26T00:00:00Z')); // published wins over updated
    assert.equal(it.author, '/u/someone');
    assert.deepEqual(it.categories, ['Ballard']);
    assert.equal(it.summary, '<p>Body &amp; more</p>'); // encoded HTML is decoded once, after tag stripping
  });
  test('garbage and HTML pages give no items', () => {
    assert.deepEqual(parseFeed('<html><body>Service Unavailable</body></html>'), []);
    assert.deepEqual(parseFeed(''), []);
  });
  test('real fixtures: My Ballard (RSS) and r/Ballard (Atom)', () => {
    const rss = parseFeed(fs.readFileSync(path.join(FIX, 'civic/rss-myballard.xml'), 'utf8'));
    assert.equal(rss.length, 10);
    for (const it of rss) {
      assert.ok(it.title && it.link.startsWith('https://'), it.title);
      assert.ok(Number.isFinite(it.t));
    }
    const atom = parseFeed(fs.readFileSync(path.join(FIX, 'civic/reddit-ballard.xml'), 'utf8'));
    assert.ok(atom.length >= 10);
    for (const it of atom) {
      assert.match(it.link, /^https:\/\/www\.reddit\.com\/r\/Ballard\/comments\//);
      assert.ok(Number.isFinite(it.t));
      assert.match(it.author, /^\/u\//);
    }
  });
});

describe('geo', () => {
  test('haversineKm defaults to CENTER and matches a known distance', () => {
    assert.equal(haversineKm(CENTER.lat, CENTER.lon), 0);
    assert.ok(Math.abs(haversineKm(0, 0, 1, 0) - 111.195) < 0.01); // one degree of latitude
    // Ballard Locks (47.6655, -122.3972) is ~1.0 km from NW Market St & Ballard Ave.
    const d = haversineKm(47.6655, -122.3972);
    assert.ok(d > 0.9 && d < 1.1, String(d));
    assert.equal(round(haversineKm(47.6655, -122.3972), 6), round(haversineKm(CENTER.lat, CENTER.lon, 47.6655, -122.3972), 6));
  });
  test('inBbox: inside, edges, outside, padding, bad input', () => {
    assert.equal(inBbox(CENTER.lat, CENTER.lon), true);
    assert.equal(inBbox(BBOX.n, BBOX.w), true);
    assert.equal(inBbox(BBOX.s, BBOX.e), true);
    assert.equal(inBbox(BBOX.n + 0.001, CENTER.lon), false);
    assert.equal(inBbox(CENTER.lat, BBOX.w - 0.001), false);
    // 0.5 km outside the north edge is inside a 1 km pad but not a 0.25 km pad.
    const lat = BBOX.n + 0.5 / 111.32;
    assert.equal(inBbox(lat, CENTER.lon, 1), true);
    assert.equal(inBbox(lat, CENTER.lon, 0.25), false);
    for (const [a, b] of [[NaN, CENTER.lon], [CENTER.lat, null], [undefined, undefined], ['47.67', '-122.38']]) {
      assert.equal(inBbox(a, b), false);
    }
  });
});

describe('math and units', () => {
  test('median: odd, even, empty, ignores non-finite, does not mutate', () => {
    const a = [5, 1, 3];
    assert.equal(median(a), 3);
    assert.deepEqual(a, [5, 1, 3]);
    assert.equal(median([4, 1, 2, 3]), 2.5);
    assert.equal(median([]), null);
    assert.equal(median([NaN, null, undefined, 7, Infinity]), 7);
    assert.equal(median([null]), null);
  });
  test('round / num / unit conversions return null (not NaN) for bad input', () => {
    assert.equal(round(1.2345, 2), 1.23);
    assert.equal(round(2.5), 3);
    assert.equal(round(NaN), null);
    assert.equal(num('12.5 kt'), 12.5);
    assert.equal(num('MM'), null);
    assert.equal(num(''), null);
    assert.equal(num(null), null);
    assert.equal(cToF(100), 212);
    assert.equal(cToF(null), null);
    assert.ok(Math.abs(kmhToMph(100) - 62.1371) < 1e-4);
    assert.ok(Math.abs(msToMph(10) - 22.3694) < 1e-4);
    assert.ok(Math.abs(msToKt(10) - 19.4384) < 1e-4);
    assert.equal(msToKt(undefined), null);
  });
  test('pm25ToAqi: EPA 2024 breakpoints', () => {
    const cases = [
      [0, 0], [9.0, 50], [9.05, 50], [9.1, 51], [12.0, 56], [35.4, 100], [35.45, 100], [35.5, 101], [55.4, 150],
      [55.5, 151], [125.4, 200], [125.5, 201], [225.4, 300], [225.5, 301], [500.4, 500], [800, 500],
    ];
    for (const [pm, aqi] of cases) assert.equal(pm25ToAqi(pm), aqi, `pm ${pm}`);
    for (const bad of [-0.1, NaN, null, undefined, '12']) assert.equal(pm25ToAqi(bad), null, String(bad));
  });
});

describe('limiter', () => {
  test('spaces task starts by at least the gap, keeps order, and survives a rejection', async () => {
    const gap = 80;
    const run = limiter(gap);
    const starts = [];
    const t0 = Date.now();
    const task = (i, fail = false) => run(async () => {
      starts.push(Date.now());
      if (fail) throw new Error(`task ${i} failed`);
      return i;
    });
    const results = await Promise.allSettled([task(0), task(1, true), task(2), task(3)]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
    assert.deepEqual(results.filter((r) => r.value != null).map((r) => r.value), [0, 2, 3]);
    assert.ok(starts[0] - t0 < 40, `first task should start at once (took ${starts[0] - t0} ms)`);
    for (let i = 1; i < starts.length; i++) {
      assert.ok(starts[i] - starts[i - 1] >= gap - 5, `gap ${i}: ${starts[i] - starts[i - 1]} ms`);
    }
  });
  test('a task after an idle period longer than the gap starts immediately', async () => {
    const run = limiter(30);
    await run(async () => 1);
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    await run(async () => 2);
    assert.ok(Date.now() - t0 < 25);
  });
});
