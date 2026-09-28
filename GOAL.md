# Ballard Live v2: goal and plan

## Goal
Turn Ballard Live from a dashboard that polls on a timer into a **live neighborhood console driven by events**. It should:
1. **Push** changes to the browser the moment the server sees them (SSE), instead of waiting for poll timers.
2. Show **what is changing and why it matters**: a live activity feed, trends, deltas, and highlights for new and changed values.
3. **Animate the moving parts of the neighborhood**: buses gliding along their routes, aircraft overhead, a radar loop, a moving tide and sun "now", and ticking countdowns.
4. Let the user **make it theirs**: favorite stops, pinned or hidden cards, opt-in notifications, a kiosk/TV mode, and keyboard shortcuts. It should also be installable as an app.
5. Add **high-value new live sources**: aircraft overhead, wildlife sightings, bridge-opening odds and more. Every source must be free, need no key, and be verified live.
6. Stay **robust**: automated tests, no regressions, all feeds live, and correct behavior on phone, tablet and desktop in light and dark themes.

## Acceptance criteria (must all be true at the end)
1. `GET /api/stream` (SSE) pushes source envelopes, activity items and metric samples. The browser uses it and falls back to polling automatically. A server-side refresh reaches the page within 2 s.
2. The server refreshes sources on a schedule and doesn't wait for page requests. It keeps refreshing even when no browser is connected, at a reduced rate (`idleTtl`), so history stays continuous.
3. The history store keeps at least 24 h of time series for at least 12 metrics, persisted to `data/history.json` with a bounded size. The cards show those trends as sparklines and "vs 1 h ago" deltas.
4. The activity feed: source detectors emit typed events (bridge up/down, new 911 call, new NWS alert, rain starting, new news, outage start/end, AQI category change, new quake, Locks closure, Metro alert, …). They are persisted (last 500) and appear in a live "Activity" panel with animations for new items. A detector never floods on first load or after a restart.
5. The map: an animated radar loop with play/pause and a timestamp, buses that interpolate smoothly between fixes with heading arrows, a live aircraft layer, a wildlife layer, a pulse for new 911 calls, and live counts on the layer chips.
6. The UI: values flash or tween when they change, new items get a "new" badge, countdowns tick every second, a "since you were last here" summary, and an ambient one-line summary of Ballard right now.
7. Personalization: favorite stops/routes, pin/hide/reorder cards, per-kind notifications (Notification API, opt-in), kiosk mode (`?kiosk=1` or the `k` key), shortcuts (`?` help), and a PWA manifest plus a service worker (offline shell with the last data).
8. New sources pass `tools/probe.mjs` live and render: `aircraft`, `wildlife` and `bridge-odds`, plus any stretch sources that verify.
9. Performance: gzip for JSON and static files, ETag/304 on `/api/<id>`, and no re-render when data is unchanged.
10. Quality:
    - `npm test` (node:test) passes. It covers lib time/parse helpers, the source parsers (fixtures), the history store, the activity/detectors and the SSE hub.
    - Headless QA at 1440/768/400 in light and dark shows 0 display errors, 0 console errors and no horizontal scroll.
    - A 10-minute soak test shows no crash and stable memory.
    - An adversarial review has run and its confirmed findings are fixed.

## Architecture

### Server
- `server.mjs`: HTTP (static, `/api/<id>`, `/api/sources`, `/api/stream`, `/api/activity`, `/api/history`, `/img`), gzip, ETag.
- `lib.mjs`: existing helpers.
- `core/scheduler.mjs`: refreshes each source every `ttl` while any SSE client is connected, every `idleTtl` when none is, and always for `background` sources. Inflight dedupe, deadline and stale-while-error work as before.
- `core/hub.mjs`: SSE client registry and broadcast, with a ping every 25 s.
- `core/history.mjs`: time-series store with per-key ring buffers (48 h retention, ≤1 sample/min/key). It persists to `data/history.json` every 5 min and on exit.
- `core/activity.mjs`: the activity log (last 500, dedupe by `key`), persisted to `data/activity.json`.
- `data/snapshot.json`: the last good envelope per source, loaded at startup so the page is instant and detectors have a `prev` across restarts.

### Source definition extensions (optional fields)
```js
{
  id, title, ttl, fetch, daily?, background?,
  idleTtl?,                       // seconds between refreshes when no browser is connected (default: max(ttl*5, 900); null = don't refresh while idle)
  metrics?(data) => ({ 'weather.tempF': 54.1, ... }),   // numbers only; sampled after each successful refresh
  detect?(prev, next, ctx) => [ActivityDraft],           // prev is null on the very first ever load → return []
}
```
ActivityDraft / Activity item:
```
{ id /*assigned by hub*/, key /*stable dedupe key, e.g. 'bridge:2:up:1790312000000'*/, t /*epoch ms of the event*/, source /*source id*/,
  kind: 'bridge'|'fire'|'weather'|'alert'|'transit'|'news'|'social'|'power'|'air'|'quake'|'locks'|'traffic'|'event'|'wildlife'|'aircraft'|'water'|'sky'|'civic',
  severity: 'info'|'notice'|'warn'|'alert',
  title, detail?, link?, lat?, lon? }
```

### SSE protocol: `GET /api/stream`
- `event: hello`, `data: { now, sources: [ /api/sources rows ] }`
- `event: source`, `data: <envelope as /api/<id>>`. A snapshot for every cached source is sent right after hello. After that it is sent on every refresh (success, or an error-state change).
- `event: activity`, `data: <activity item>` (new items only).
- `event: metric`, `data: { key, t, v }`.
- `event: ping`, `data: { now }`, every 25 s.

Other endpoints: `GET /api/activity?limit=200&since=<t>` returns `{ items: [newest first] }`. `GET /api/history?keys=a,b&hours=24` returns `{ series: { key: [[t, v], ...] }, keys: [all known keys] }`.

### Metric keys (at least these)
`weather.tempF`, `stations.medianTempF`, `westpoint.windKt`, `westpoint.gustKt`, `purpleair.aqi`, `airnow.pm25aqi`, `tides.observedFt`, `lake.ft`, `traffic.downtown1991`, `traffic.downtown1990`, `lime.near`, `lockages.today`, `fire911.count24h`, `bridges.ballardUp` (0/1), `bridges.fremontUp`, `kp.kp`, `transit.delay.D`, `transit.delay.40`, `transit.delay.44` (mean schedule deviation in minutes, from `vehicles`), and `aircraft.count` (new source).

### New source shapes (sources/extra.mjs)
- `aircraft` (ttl 15, idleTtl 300): `{ t, radiusNm, aircraft: [ { hex, callsign?, reg?, type?, desc?, lat, lon, altFt?, gsKt?, track?, vrFpm?, squawk?, onGround, distKm, emergency?: string|null, category? } ], count, nearest? }`
- `wildlife` (ttl 1800): `{ observations: [ { id, t, observedOn, taxon: { name, common?, iconic? }, photo?, lat?, lon?, place?, url, user?, quality } ], counts: { total, species } }`, last 14 days, Ballard bbox + 1 km.
- `bridge-odds` (ttl 3600): `{ windowDays, basis, hourly: [ { dow, hour, avgOpenings, avgMinutes } ], now: { expectedPerHour, chanceNext30Min, typicalMinutes, restricted: bool } }`, from gm8h-9449 over about 8-12 weeks (Ballard). `restricted` is true during the weekday rush-hour no-opening windows, if they are verified.
- Stretch sources, included only if they are verified live with no key: `iss` (visible ISS passes), `businesses` (new business licenses in Ballard), and others the agent finds high-value.

### Frontend
- `public/core.js`: the store, transport (SSE with polling fallback), event bus, render scheduling, registries and `setHTML`.
- `public/app.js`: the entry point.
- `public/map.js`: the map and its layer registry.
- `public/cards.js`: built-in cards.
- `public/util.js`: helpers, including flash/tween.
- `public/features/*.js`: feature modules. `features/index.js` loads a fixed list and tolerates missing modules. Each feature may ship its own `features/<name>.css`. The core API is documented in `FRONTEND.md`, which the Phase 1 frontend agent writes.

## Phases and file ownership
| Phase | Agent | Owns |
|---|---|---|
| 1 Foundation | A1 backend core | server.mjs, lib.mjs, core/*, sources/index.mjs, tests/core/* |
| 1 | A2 frontend foundation | public/app.js, core.js, map.js (extracted), util.js, public/features/index.js, FRONTEND.md |
| 1 | A3 test harness | sources/*.mjs (only `_test` exports), tests/sources/*, tests/fixtures/*, tests/lib.test.mjs, package.json scripts |
| 2 Features | B1 detectors and metrics | sources/weather, water, move, civic .mjs |
| 2 | B2 new sources | sources/extra.mjs, tests/sources/extra.test.mjs |
| 2 | B3 live UX | public/features/activity.js, summary.js, notify.js (+ .css) |
| 2 | B4 map dynamism | public/map.js |
| 2 | B5 personalization, kiosk, PWA | public/features/prefs.js, kiosk.js, shortcuts.js (+ .css), public/manifest.webmanifest, public/sw.js, icons |
| 2 | B6 cards and trends | public/cards.js, util.js, style.css, index.html |
| 3 Integrate | me | everything, plus the fixes that cross owners |
| 4 Review | reviewers | disjoint ownership, then fixes |
| 5 Verify | me | tests, soak, headless QA, final summary |

## Progress (updated 2026-09-26)
- [x] Backed up v1 to `.backup/v1-20260925-1836.tar.gz`.
- [x] Phase 1 foundation:
  - SSE stream, proactive scheduler with idleTtl, history, activity, snapshot, gzip/ETag (CORE.md).
  - The frontend plugin architecture (FRONTEND.md).
  - The `npm test` harness.
- [x] Phase 2 features:
  - `sources/intel.mjs`: metrics and detectors for the v1 sources.
  - `sources/extra.mjs`: aircraft, wildlife, bridge-odds.
  - Map dynamism: gliding buses, dead-reckoned aircraft with trails, the radar loop, wildlife pins, new-911 pulses, chip counts, and the `?layers=` deep link.
  - Features: the activity feed, the summary line, the timeline and sky strip, notifications, settings and favorites, kiosk, shortcuts and deep links, trends, and the extra cards.
  - PWA: manifest, icons, service worker.
- [x] Phase 3 integration, done in-session. The Workflow tool was unavailable, so it was built directly.
  - 370 tests pass.
  - QA at 1440, 768 and 400 px in light and dark, plus settings, kiosk and the map layers: 0 console errors, no horizontal scroll.
  - A 10-minute soak: 4,752 requests, 41/41 feeds, RSS 77-123 MB, no crash.
- [x] Review (self-review; no subagents were available). Fixed:
  - bridge events after sleep gaps
  - animated-layer re-targeting on hourly redraws
  - the lime canvas renderer leak
  - the photo URL CSS-injection hardening
  - the keep-alive race
  - the daily-count trend deltas
  - the timeline NOW/label layout
  - bus arrow visibility
  - the tile grid

---

# v3 "Ballard, alive": goal and outcome

## Goal
The ask was "be ingenious, like Apple, Google, Meta and Netflix combined". The aim was to turn a very complete dashboard into something that feels alive and personal, taking the best idea from each:
- **Apple**: an emotional, ambient first screen. A living scene drawn from real data, a Dynamic-Island-style live pill, one consistent icon language, and phone-first polish.
- **Google**: answers instead of cards. Ask Ballard (⌘K, typed or spoken) over live data, a spoken brief, and knowing what's *usual* so it can say what's unusual.
- **Meta**: shareable and social formats. Stories generated from live data (with camera time-lapses the server records itself), and a designed "Ballard right now" share image.
- **Netflix**: personalization and highlights. Moments (a ranked "worth your attention now"), a For you row that learns your routine in the browser, and Replay of the last 24 hours.

## Acceptance criteria (v3)
1. The first screen is a canvas scene whose sun/moon/stars, clouds, rain/fog, tide, bridge state, wind and aircraft all come from live data. It runs at ≤30 fps only while visible and draws a static frame under reduced motion. A legend explains it.
2. A live pill in the header cycles what's live now, with ticking timers.
3. Moments are ranked, deduplicated and clean. They include "unusual right now" items once baselines exist (at least 2 past days).
4. Ask Ballard routes 30+ everyday questions to the right intent. Every answer has no `undefined`/`NaN`. Voice in and out work where the browser supports them, and answers stay live while open.
5. Stories: Today, Bridges, Cameras (server-recorded 3-hour time-lapses), Wildlife, Weather, Locks, Events/Tonight and 911, with keyboard, touch and pause, and a focus trap.
6. For you learns per hour of day, only in localStorage.
7. Replay plays the last 24 h on the map with a readout from history.
8. Share renders a 1080×1350 image in the browser, with Web Share, download and clipboard.
9. Baselines: the server learns hourly norms (4 weeks) and exposes `/api/baseline`. The UI shows "vs usual" / "vs yesterday", honestly labeled.
10. Quality:
    - `npm test` passes, including new tests for the stores and the insight engine.
    - Interactive headless QA (click-through of every v3 feature) at desktop, tablet and phone in light and dark shows 0 console errors and no horizontal scroll.
    - A soak shows flat memory.

## Progress (2026-09-26)
- [x] `icons.js`: a line icon set that replaces the UI emoji (header, activity feed, chips, map controls, digest, timeline, aircraft kinds).
- [x] `insight.js`, the pure engine: astronomy, summaries, live activities, moments, NL intents and answers, suggestions, the brief, `vsUsual`.
- [x] `hero.js`: the living scene, overlay, legend, Share button, Moments, the Ask box, and the live pill. It has a `hero:render` hook to draw the scene at any size (used by Share and Stories).
- [x] `ask.js`: the ⌘K palette, voice in and out, recents, live answers, `?ask=`.
- [x] Server: `core/camstore.mjs` (time-lapse frames, `/api/cams`, `/cam/<id>/<t>.jpg`) and `core/baseline.mjs` (`/api/baseline`), both persisted.
- [x] `stories.js`: the ring bar, the viewer, time-lapses, the Bridges story built from the opening log, and portrait scene renders.
- [x] `foryou.js`, `replay.js` (`?panel=replay`) and `share.js` (`?panel=share`).
- [x] `baseline.js` (client) and "vs usual" in trends, Moments, Ask and the brief.
- [x] Phone header: one compact row that isn't sticky, so there's no overflow at 390 px. Share is on the scene. A compact Replay bar. Keyboard hints are hidden on touch.
- [x] The service worker is at v3-2 and precaches the v3 modules. `/cam/*` is never intercepted.
- [x] Tests: 387 pass, 17 of them new. `tests/frontend/insight.test.mjs` runs against a frozen 41-feed snapshot.
- [x] `tools/cdp.mjs`: a headless Chrome DevTools driver (click, type, keys, eval, request mocking, phone and touch emulation, light and dark, screenshots, console errors). It's used for the click-through QA of Share, Stories, Replay, Ask, For you and "vs usual", the latter with a mocked baseline.
- [x] QA: 1440 dark, 768 light, and 390 phone in light and dark all show 0 console errors and no horizontal overflow. The 5-minute soak with interactions had a JS heap of 5.0 to 5.6 MB after GC, server RSS of 65 to 89 MB, the connection live throughout, and no errors.
- [x] Fixes found by QA:
  - Phone header overflow (422 px on a 390 px screen).
  - A feature stylesheet re-applying the sticky header.
  - Stories JPEG-encoding the hero twice per ring refresh (now lazy).
  - A per-open `visibilitychange` listener in Stories.
  - The For you 3 + 1 grid.
  - The bridge scaling at share size.
  - The sunset icon.
  - The Replay start time and live-layer dimming.
  - The Moments scroll fade.
  - The `mobile-web-app-capable` meta tag.
- [ ] Waits on time: baselines become visible after a day of history (vs yesterday) and after two days (vs usual). Hour-of-week needs two weeks.
