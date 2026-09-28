// Tests for core/camstore.mjs (camera time-lapse frames) and core/baseline.mjs (usual-for-this-hour).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCamStore } from '../../core/camstore.mjs';
import { createBaseline } from '../../core/baseline.mjs';
import { pacificToEpoch } from '../../lib.mjs';

const jpeg = (n = 40000, seed = 1) => { const b = Buffer.alloc(n, seed); b[0] = 0xff; b[1] = 0xd8; return b; };

describe('camstore', () => {
  it('saves new frames once, rejects placeholders and non-JPEGs, prunes to `keep`, and reloads', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blcams-'));
    let calls = 0;
    const images = { good: jpeg(), tiny: jpeg(29000), png: Buffer.alloc(50000, 7) };
    const store = createCamStore({ dir, keep: 3, fetchImage: async (u) => { calls++; return images[u]; }, log: { warn() {} } });
    store.load();
    const cam = (t, url = 'good', ok = true) => ({ id: 'CMR-0011', url, ok, lastModified: t });
    assert.equal(await store.capture([cam(1790000000000)]), 1);
    assert.equal(await store.capture([cam(1790000000000)]), 0); // same Last-Modified: no refetch
    assert.equal(calls, 1);
    assert.equal(await store.capture([cam(1790000120000, 'tiny')]), 0); // maintenance placeholder
    assert.equal(await store.capture([cam(1790000120000, 'png')]), 0); // not a JPEG
    assert.equal(await store.capture([cam(1790000240000, 'good', false)]), 0); // camera not ok
    for (const t of [1790000360000, 1790000480000, 1790000600000]) await store.capture([cam(t)]);
    const frames = store.list({ 'CMR-0011': '15th & Market' }).cameras[0];
    assert.equal(frames.label, '15th & Market');
    assert.deepEqual(frames.frames, [1790000360000, 1790000480000, 1790000600000]);
    await new Promise((r) => setTimeout(r, 50)); // async unlinks
    assert.equal(fs.readdirSync(path.join(dir, 'CMR-0011')).filter((f) => f.endsWith('.jpg')).length, 3);
    assert.ok(store.file('CMR-0011', '1790000600000'));
    assert.equal(store.file('CMR-0011', '1790000000000'), null); // pruned
    assert.equal(store.file('../etc', '1790000600000'), null);
    assert.equal(store.file('CMR-0011', '12;rm'), null);
    const again = createCamStore({ dir, keep: 3, fetchImage: async () => jpeg() });
    again.load();
    assert.deepEqual(again.list().cameras[0].frames, [1790000360000, 1790000480000, 1790000600000]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('baseline', () => {
  it('uses the same hour on the same weekday when there are 2+ weeks, else the same hour of day', () => {
    const b = createBaseline({ log: { warn() {} } });
    const sat11 = pacificToEpoch(2026, 9, 26, 11, 20); // Saturday 11:20 am PDT
    // three previous days at 11 am: 10, 12, 14 (hour-of-day basis)
    for (const [d, v] of [[23, 10], [24, 12], [25, 14]]) for (let m = 0; m < 60; m += 10) b.add('k', pacificToEpoch(2026, 9, d, 11, m), v);
    let u = b.usual('k', sat11);
    assert.equal(u.basis, 'hour-of-day');
    assert.equal(u.usual, 12);
    assert.equal(u.n, 3);
    // two previous Saturdays at 11 am: 30 and 34 -> hour-of-week wins
    for (const [d, v] of [[12, 30], [19, 34]]) b.add('k', pacificToEpoch(2026, 9, d, 11, 5), v);
    u = b.usual('k', sat11);
    assert.equal(u.basis, 'hour-of-week');
    assert.equal(u.usual, 32);
    assert.equal(b.usual('missing', sat11), null);
    // the current (incomplete) hour is not part of its own baseline
    b.add('k', pacificToEpoch(2026, 9, 26, 11, 0), 1000);
    assert.equal(b.usual('k', sat11).usual, 32);
    const q = b.query(['k', 'missing'], sat11, (k) => (k === 'k' ? 40 : null));
    assert.deepEqual(Object.keys(q.baselines), ['k']);
    assert.equal(q.baselines.k.current, 40);
    assert.equal(q.baselines.k.ratio, 40 / 32);
  });
  it('persists and prunes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blbase-'));
    const file = path.join(dir, 'baseline.json');
    const now = Date.now();
    const b = createBaseline({ file, log: { warn() {} } });
    b.add('x', now - 2 * 3600e3, 5);
    b.add('x', now - 40 * 24 * 3600e3, 9); // older than 28 days
    b.save();
    const c = createBaseline({ file, log: { warn() {} } });
    c.load();
    assert.equal(c._buckets.get('x').size, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('seeds from history series', () => {
    const b = createBaseline({ log: { warn() {} } });
    const t = Date.now() - 5 * 3600e3;
    b.seed({ a: [[t, 1], [t + 60e3, 3]] });
    assert.equal(b._buckets.get('a').size, 1);
    const [[, [sum, n]]] = [...b._buckets.get('a').entries()];
    assert.equal(sum, 4);
    assert.equal(n, 2);
  });
});
