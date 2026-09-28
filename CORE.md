# Ballard Live core (server internals)

How the v2 server refreshes, stores and pushes data. `GOAL.md` is the spec. This file describes how it is built and how a source uses it.

## Files

| File | What it does |
|---|---|
| `server.mjs` | `createServer(opts)` builds everything and returns `{ server, port, url, scheduler, hub, history, activity, camstore, baseline, persist(), close() }`. Running `node server.mjs` is the CLI. It listens on `PORT` (default 4177) and `HOST` (default 127.0.0.1), and on SIGINT/SIGTERM it saves state and exits. |
| `core/scheduler.mjs` | The source cache and the proactive refresh loop. Pure helpers: `idleTtlOf`, `dueAt`, `isFresh`, `isStale`, `expiresAt`, `nextPacificMidnight`. |
| `core/hub.mjs` | The SSE client registry, `broadcast(event, data)`, and a ping every 25 s. |
| `core/history.mjs` | The metric time series, persisted to `data/history.json`. |
| `core/activity.mjs` | The activity log and `runDetector`, persisted to `data/activity.json`. |
| `core/http.mjs` | gzip negotiation, ETag matching, and MIME types. |
| `core/persist.mjs` | `readJson`, `writeJsonAtomic` (write a temp file, then rename it), and `throttledSaver`. |
| `core/baseline.mjs` | v3 "usual for this hour": hourly rollups `[sum, count]` per metric key over 4 weeks (at most 300 keys), persisted to `data/baseline.json` every 10 min and on exit, and seeded from the history store on first run. `usual(key, now)` returns the median and quartiles of the hourly means at the same Pacific hour on earlier days (never the current or previous hour). The basis is `hour-of-week` once two or more same-weekday samples exist, otherwise `hour-of-day`, and `n` is how many past hours were used. |
| `core/camstore.mjs` | v3 camera time-lapse frames: after each `cameras` refresh the server fetches each SDOT still (same allow-list as `/img`) and keeps the frame only if it's a real JPEG of at least 31 KB with a new `lastModified`. The smaller frames are SDOT's "camera offline" placeholder. It keeps 90 frames per camera (about 3 hours) under `data/cams/<id>/<t>.jpg`. |

`BALLARD_DATA_DIR=/some/dir` moves every state file there. That includes the sources' own `bridges.json` and `reddit.json`, which is useful for a second instance or for tests.

## Refresh loop (scheduler)

- A 250 ms tick finds the sources that are due and starts at most 2 per tick, background sources first. It never runs more than 10 scheduled fetches at once. This spaces out the startup and the burst that happens when the first browser returns after an idle period.
- Due time: `fetchedAt + interval`. For `daily` sources it is capped at the next Pacific midnight.
  - The **interval** is `ttl` while the server is *active* and `idleTtl` otherwise. The server is active when at least one SSE client is connected or when any HTTP request arrived in the last 2 minutes.
  - `idleTtl` defaults to `max(ttl*5, 900)`. `idleTtl: null` means the source doesn't refresh while idle.
  - `background: true` sources always use `ttl`.
  - A source that has never loaded is due immediately.
  - After a failed fetch, the retry is at `errorAt + min(ttl, 60 s)`.
- Every refresh is deduped while in flight and bounded by a 45 s deadline. On failure the cache keeps the last good data and sets `error` (stale-while-error). A `fetch()` that returns `null` or `undefined` counts as an error.
- `/api/<id>` behaves as in v1. It returns the cache when it is fresh (within `ttl`, the same Pacific day for daily sources, or within the retry window after an error). Otherwise it waits for a refresh. The envelope is unchanged: `{ id, title, ttl, fetchedAt, expiresAt, stale, error, data }`.
- `stale` is true when the data is more than 3×ttl old or is daily data from an earlier Pacific day. It is computed from the real `fetchedAt`, including for data restored from the snapshot, so it stays truthful.

## After each refresh (server.mjs `afterRefresh`)

On success:
1. The snapshot is marked dirty. It is written at most every 30 s.
2. `src.metrics(data)` runs in try/catch. Every numeric entry is appended to history and to the baselines.
3. The server broadcasts `source`, then `metric` for each *new* sample.
4. `src.detect(prev, next, ctx)` runs in try/catch with a 5 s cap on async detectors. The drafts go to the activity log, and each new item is broadcast as `activity`.
5. For `cameras`, the camera store captures new frames in the background; failures are logged, never thrown.

On failure, it broadcasts `source` only when the error text changed (for example, from ok to failing, or from failing back to ok on the next success).

## SSE: `GET /api/stream`

The stream starts with `retry: 3000`, then `hello` `{ now, sources: [rows], loadErrors }`, then one `source` event per cached source (the snapshot). After that it sends `source`, `activity` and `metric` events as they happen, plus `ping` `{ now }` every 25 s. Each frame is a single `event:` line plus a single `data:` line of JSON. The stream is never gzipped. A client that falls more than 8 MB behind is dropped; its EventSource reconnects and gets a fresh snapshot. The limit is 200 clients.

## Other endpoints

- `GET /api/sources` returns `{ now, loadErrors, sources: [rows], clients, active }`. Each row has `id, title, group, ttl, idleTtl, daily, background, fetchedAt, expiresAt, stale, restored, error, errorAt, ms, ok, fail, hasMetrics, hasDetect`.
- `GET /api/history?keys=a,b&hours=24[&points=N]` returns `{ series: { key: [[t, v], ...] }, keys: [all known keys] }`.
  - With no `keys`, every series is returned.
  - `hours` is capped at 48.
  - `points` thins each series to N points, keeping the last sample of each bucket, which is useful for sparklines.
- `GET /api/activity?limit=200&since=<t>` returns `{ items }`, newest first by `t`. `since` keeps only items with `t > since`. `limit` is capped at 500.
- `GET /api/baseline[?keys=a,b]` returns `{ now, baselines: { key: { usual, p25, p75, n, basis, current?, ratio? } } }`, where `current` is the latest history value. Keys without a learned value for this hour are omitted, and with no `keys` every key is considered.
- `GET /api/cams` returns `{ cameras: [{ id, label, frames: [t, ...] }] }`, with frame times ascending.
- `GET /cam/<id>/<t>.jpg` returns one stored frame (`Cache-Control: public, max-age=604800, immutable`). Ids must match `/^[A-Za-z0-9-]{1,32}$/` and `t` must be 10–14 digits; anything else gets a 404.
- `/api/<id>` has a weak ETag built from fetchedAt, id, error and the stale bit. A matching `If-None-Match` gets a `304`. It sends `Cache-Control: no-cache`, so a browser that stores the response revalidates it.
- JSON and static text (html/js/css/svg/json/webmanifest) are gzipped when the client accepts gzip and the body is at least 1 KB. Images and SSE are never gzipped. Static files get an ETag (from size and mtime) and return 304. Their gzip output is cached per file version.

## History store

- Each key has one ascending `[[t, v], ...]` array, with at most one sample per calendar minute. A later value in the same minute overwrites that minute's sample, and **no** `metric` event is sent for it.
- Retention is 48 h, with at most 256 keys and about 2,882 samples per key.
- It is saved to `data/history.json` every 5 min (only when changed) and on exit, and loaded at startup. Loading validates and sorts the samples, drops expired ones, and keeps one sample per minute.
- Keys match `/^[A-Za-z0-9_][\w.:-]{0,99}$/`. Values must be finite numbers. Booleans become 0/1; anything else is ignored.

## Activity log

- `add(drafts)` assigns `id`. It defaults `t` to now and `source` to the source id, `kind` to `'civic'`, and `severity` to `'info'` when it isn't one of info/notice/warn/alert.
  - Drafts without a `title` are dropped.
  - `link` must be http(s).
  - Only the documented fields are kept: `key, t, source, kind, severity, title, detail?, link?, lat?, lon?`.
- **Dedupe**: a key emitted in the last 7 days is dropped. Every emission refreshes that key's clock, so a condition a detector keeps reporting never fires again.
- **No floods**:
  - On a source's first-ever load (`prev == null`), whatever the detector returns only seeds the dedupe keys; nothing is added.
  - The same happens when the prev is a restored snapshot older than `max(6 h, 2 × idle interval)`. In that case the detector gets `prev = null`.
  - At most 20 items (the newest) are added per refresh.
- The newest 500 items are kept (by `t`). The file `data/activity.json` holds `{ items, seen }` and is written at most every 2 s after changes, and on exit.

## Snapshot

`data/snapshot.json` holds `{ v, savedAt, sources: { id: { fetchedAt, data } } }`, the last good data per source. At startup it is restored into the cache with the original `fetchedAt`, and entries older than 7 days are ignored. Because of that, the page renders instantly and detectors have a real `prev` across restarts. `/api/sources` rows show `restored: true` until the first live refresh. Fresh restored data is not refetched until it is due.

## Adding metrics, a detector, or idleTtl to a source

```js
{
  id: 'weather', title: 'Weather', ttl: 600, fetch,
  idleTtl: 1800,                 // optional; default max(ttl*5, 900); null = skip while idle
  metrics: (d) => ({ 'weather.tempF': d.current?.tempF }),   // numbers only; null/undefined are skipped
  detect(prev, next, ctx) {      // prev === null on the first load → return []
    if (!prev) return [];
    const out = [];
    if (!prev.rainStartsAt && next.rainStartsAt) out.push({
      key: `rain:${next.rainStartsAt}`, t: ctx.now, kind: 'weather', severity: 'notice',
      title: 'Rain starting soon', detail: '…', link: 'https://…',
    });
    return out;
  },
}
```

`ctx` contains:
- `now`: the refresh time.
- `sourceId`
- `firstLoad`
- `restored`: prev came from the snapshot.
- `prevFetchedAt`
- `history`: read-only, with `get(key, hours, points?)`, `latest(key)`, `at(key, t, toleranceMs = 15 min)` and `keys()`.
- `data(id)`: another source's current cached data.

Detectors should be synchronous, cheap and pure. Throwing is safe but gets logged. Build the `key` from stable identity, such as `bridge:<id>:up:<upAt>` or `fire:<incidentId>`, never from the refresh time.

The loader (`sources/index.mjs`) reports malformed `idleTtl`, `metrics` or `detect` values as load errors and ignores them. It also rejects duplicate ids and the reserved ids `sources`, `stream`, `history`, `activity`, `cams` and `baseline`. `extra.mjs` is in the module list. A module file that doesn't exist is skipped silently.

## Tests

Run them with `node --test tests/` (387 tests). The core tests in `tests/core/` start real servers on port 0 with fake sources and temp data dirs, and never touch the network. `tests/core/camstore-baseline.test.mjs` covers the v3 stores, and `tests/frontend/` covers the browser's insight engine against a frozen snapshot. Node 18 note: a top-level `after()` only runs at `beforeExit`, which an open server prevents. Keep server lifecycle hooks inside a `describe()`.

## v2 intelligence for the v1 sources

`sources/intel.mjs` exports `INTEL`, a table by source id of `{ idleTtl?, metrics?, detect? }`. `sources/index.mjs` merges each entry into the loaded definition, but only for fields the source module doesn't define itself. The v1 modules therefore stay untouched, and a new module can still bring its own. The same file exports `hysteresis(name, prev, next, on, off)`, a state machine for detectors that works across refreshes, plus `hash` and `slug` helpers. The catalogue of metrics and activity events is in CONTRACT.md. The tests are in `tests/sources/intel.test.mjs` and `tests/sources/extra.test.mjs`.
