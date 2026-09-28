# Ballard Live frontend: core API

This is the contract for everything in `public/`. Phase 2 feature work builds only on what is written here. If you need something the core doesn't offer, ask for it; don't reach into another module's internals.

## Files

| File | Role |
|---|---|
| `index.html` | Static shell: header, `#headsup`, `#glance`, `#map-section`, the section grids (`#weather`, `#water`, `#move`, `#safety`, `#community`), `#health`. Loads Leaflet (unpkg) and `app.js`. |
| `app.js` | Entry point. Registers the built-in cards (`cards.js` `CARDS`), sets up the clock, theme and camera lightbox, builds the feature `api`, calls `core.start()` and `loadFeatures(api)`. |
| `core.js` | Store, event bus, transport (SSE with a polling fallback), render scheduling, card / tile / heads-up registries, metric history, activity list, UI prefs, header controls, masonry packing. Injects `core.css`. |
| `core.css` | Core styles: value flash, the LIVE indicator, layer-chip counts, the "new" badge. |
| `cards.js` | Built-in cards (`CARDS`) and their helpers (`etaText`, `routeBadge`, `liveGroups`, `tideAt`, ...). |
| `glance.js` | Built-in glance tiles (`registerTile`). Exports `etaHtml`. |
| `headsup.js` | Built-in heads-up items (`registerHeadsup`). |
| `health.js` | Feed-health pill, summary and table. |
| `map.js` | Leaflet map, basemap, and the layer registry with the 15 built-in layers. |
| `util.js` | Formatting and DOM helpers, including `flash`, `tween`, live-value markers and countdowns. |
| `features/index.js` | Loads the optional feature modules. |
| `features/<name>.js` (+ `.css`) | Feature modules. v2: `activity`, `summary`, `notify`, `prefs`, `kiosk`, `shortcuts`, `trends`, `extra-cards`. v3: `hero`, `ask`, `stories`, `foryou`, `replay`, `share`. |
| `insight.js` | The v3 insight engine: pure functions over `D` (no DOM, runs under Node; see the v3 section). |
| `icons.js` | Line icon set: `icon(name, { size, cls, title })` returns inline SVG in `currentColor`; `KIND` maps activity kinds to icons. |
| `baseline.js` | Client cache of `/api/baseline`: `usualOf(key)`, `onBaselines(fn)`, `learnedCount()`. |

Boot order: `app.js` imports `core.js`, `cards.js`, `map.js`, `glance.js`, `headsup.js` and `health.js`; the built-ins register themselves. `app.js` then calls `initMap()` and starts `loadFeatures(api)`, and right after that `core.start()`. `start()` renders once (skeletons), packs the card grid, loads `/api/sources` (retrying while the server is down) and opens the stream. Feature `init(api)` usually runs **before any data has arrived**, so register things and subscribe to events; don't read `D()` once at init and stop there.

For debugging, `window.ballard` is the same `api` object (for example `ballard.transport()` or `ballard.D('weather')` in the console).

## Feature modules

```js
// public/features/trends.js
export default function init(api) {
  // register cards / tiles / heads-up items / layers, subscribe to events, add header buttons
}
// Optional. Without it, core also links features/trends.css (a missing file is dropped quietly, but still costs a 404).
export const css = false;
```

- `features/index.js` imports the fixed list `activity, summary, notify, prefs, kiosk, shortcuts, trends, extra-cards` in parallel. It then calls each module's `init(api)` **in that order**, so a later feature can rely on an earlier one's registrations. It resolves with the names that initialized and emits `'features'` (names).
- A module that is missing, throws on import, has no default export, or throws in `init` is logged with `console.info('[features] <name>: ...')` and skipped. The page keeps working. If `init` returns a Promise, a rejection is logged the same way.
- After a successful import, `features/<name>.css` is added as a `<link>` (after `style.css` and `core.css`, so it wins ties). Export `css = false` if you ship no stylesheet.
- Prefix your CSS classes and ids with your feature name (`.act-…`, `#kiosk-…`) and your `ui` keys likewise (`'notify.kinds'`).

## The `api` object

```js
api = {
  version: 2,
  store, D, env, meta,                       // data
  on, off, emit, connection, transport,      // events and connection state
  registerCard, getCard, cardNames,          // cards
  registerTile, registerHeadsup,             // glance tiles, heads-up strip
  registerLayer,                             // = map.registerLayer
  invalidate, notify, renderCard, renderAll, setHTML, tile, hu, asOf, observeCard,
  history, activity,                         // metric time series, activity feed
  ui, saveUI, setUI, addHeaderButton, openLightbox,
  util,                                      // everything exported by util.js
  cards,                                     // everything exported by cards.js (CARDS, etaText, routeBadge, ...)
  map: { instance /* getter: the L.Map or null */, getMap, registerLayer, layer, layers, setLayerOn,
         drawLayer, redrawLayer, dotIcon, labelIcon, setBasemap },
}
```

Built-in modules can import the same things directly: `import { on, registerCard } from './core.js'`.

## Store

Every source's latest envelope is kept in memory. Envelopes arrive from the stream, from polls, or (for errors) from failed polls.

| Call | Returns |
|---|---|
| `D(id)` | the source's `data` (shape in `CONTRACT.md`), or `null` before the first data |
| `env(id)` | the envelope `{ id, title, ttl, fetchedAt, expiresAt, stale, error, data }`, or `null`. `error` is set when the last refresh failed; `data` is then the last good data (or `null`). |
| `meta(id)` | the `/api/sources` row `{ id, title, group, ttl, daily, fetchedAt, expiresAt, error, ms, ok, fail, ... }`, or `null` |
| `store.ids()` | source ids in server order |
| `store.sources()` | all rows in server order (kept current by every envelope) |
| `store.server()` | `{ now, loadErrors }` from the last `/api/sources` or `hello` |
| `store.ttl(id)` | refresh interval in seconds |
| `store.isStale(id)` | data older than 3×ttl, or daily data from an earlier Pacific day (also true when the server says so) |
| `asOf(...ids)` | `' · as of 7:05 pm'` (warning-colored HTML) when any of those sources is older than 2×ttl, else `''` |

Treat `D()` data as **read-only**: the same objects are shared by every card, tile and layer.

## Events

`on(event, fn)` returns an unsubscribe function. `off(event, fn)` also works. `emit(event, ...args)` is synchronous; a handler that throws is logged and never stops the others. Features may emit their own events: use a `feature:` prefix, e.g. `'prefs:changed'`.

| Event | Arguments | When |
|---|---|---|
| `source` | `(id, env, { changed })` | an envelope was applied (stream push, poll, or a failed poll). `changed` is false when `data` is identical to the previous data (only `fetchedAt`/`error`/`stale` differ). |
| `activity` | `(item)` | a **new** activity item arrived (stream, catch-up after a reconnect, or activity polling). Not emitted for the initial list; use `activity.ready` for that. |
| `metric` | `({ key, t, v })` | a streamed metric sample (already appended to the history cache) |
| `connection` | `('live' \| 'polling' \| 'down')` | the connection state changed |
| `tick` | `(now)` | every second |
| `minute` | `(now)` | when the wall-clock minute changes |
| `render` | `({ ids, changed, targets })` | after each render batch. `ids`: source ids updated in this batch; `changed`: those whose data changed; `targets`: what was invalidated. Also after `renderAll()`. |
| `sources` | `(rows)` | after `/api/sources` or `hello` replaced the source rows |
| `ui` | `(key, value)` | after `setUI()` or a `[data-set]` click |
| `theme` | `('light' \| 'dark')` | after the theme toggle (the map swaps its basemap on this) |
| `features` | `(names)` | after every feature's `init` has run |

Prefer `tick`/`minute` to your own `setInterval` for anything on the wall clock.

## Cards

```js
api.registerCard('aircraft', {
  deps: ['aircraft'],             // source ids: the card re-renders whenever one of them updates
  title: 'Overhead now',          // header text (used only when core creates the element)
  section: 'live',                // where core creates it: 'live' (default), 'weather', 'water', 'move', 'safety', 'community', or a new id
  wide: false,                    // span two columns (from 761 px up)
  order: 5,                       // position among the section's cards (see below); omit to append
  clock: false,                   // true: also re-render every 30 s (time-dependent text)
  render(D, ctx) {
    const a = D('aircraft');
    if (!a) return null;          // null: skeleton while loading, or "Couldn't load" when a dep has an error
    return `<div class="big">${api.util.liveNum('n', a.count)}</div>`;
  },
  after(el, ctx) { /* optional: runs after every render; ctx.changed = the body HTML changed */ },
});
```

- `render(D, ctx)` returns an HTML string or `null`. Escape everything that comes from data with `util.esc` (links: `util.href`). If it throws, the card shows "This card hit a display error" and the error goes to `console.error`; that counts as a QA failure, so guard against missing fields.
- `ctx = { ui, now, env, meta, D, card, series(key, hours = 24) }`. `ctx.now` is the render time; use it rather than `Date.now()` so a render is consistent. See History for `ctx.series`.
- The body is written with `setHTML`, which skips identical HTML. Re-rendering with unchanged data is therefore cheap and doesn't reload images or drop focus. Inner `.scroll` elements keep their scroll position.
- Automatic chrome: the header's meta line (age of the oldest dep + status dot) appears when `deps` is non-empty. When a dep has an error but data exists, "Showing last good data. The latest refresh failed." is appended.
- **Where the element comes from.** If the page already has `[data-card="<name>"]` (all built-ins do), it's used. Otherwise core creates `<article class="card [wide]" data-card="<name>"><header><h3>title</h3><span class="meta"></span></header><div class="body"></div></article>` in `#<section> .cards`. The `live` section is created on first use as `<section id="live" class="section">` titled "Live", between the glance tiles and the map, and gets a "Live" link in the jump nav. Any other unknown section id is created before Feed health (title: `def.sectionTitle`, or the capitalized id).
- **Order.** When core first touches a section, its existing cards get `data-order` 0, 10, 20, …. A new card with `order: 15` goes between the 2nd and 3rd; without `order` it goes last. Cards are ordinary DOM children of the grid, so a prefs feature can reorder or hide them (`el.hidden = true`) itself. The masonry packing follows automatically. If you add a card element yourself, call `observeCard(el)`.
- **Replacing or wrapping a card.** Registering an existing name replaces its definition and keeps its element:
  ```js
  const base = api.getCard('now');
  api.registerCard('now', { ...base, render: (D, ctx) => { const h = base.render(D, ctx); return h && h + myTrendRow(ctx); } });
  ```
- `renderCard(name)` renders one card synchronously. Normally use `invalidate(name)` instead.
- **Card-local UI state.** Any element with `data-set="key=value"` inside the page toggles `ui[key]` on click, saves it and re-renders everything; focus moves to the replacement control. Built-in keys: `nwsAll`, `afdMore`, `busDir`, `fireActive`, `evSrc`, `newsMode` (plus `layers`, `layersSeen` for the map).

## Glance tiles and heads-up items

```js
const unregister = api.registerTile({
  id: 'aircraft', order: 250,                       // built-ins: weather 100, bridge 200, transit 300, tide 400, air 500, sun 600, locks 700, fire 800
  render: (D, ctx) => {
    const a = D('aircraft');
    if (!a) return null;                            // null / '' = no tile
    return api.tile({ href: '#live', k: 'Overhead', v: `${a.count} <small>aircraft</small>`, s: a.nearest ? api.util.esc(a.nearest.callsign || '') : '', key: 'aircraft' });
  },
});

api.registerHeadsup({
  id: 'bridge-odds', order: 250,                    // built-ins: server-down 0, alerts 100, bridges 200, rain 300, fire 400, outages 500, cso 600, stoppages 700, metro-alerts 800, quakes 900, air 1000
  render: (D, ctx) => {
    const o = D('bridge-odds');
    return o && o.now.chanceNext30Min > 0.5 ? api.hu({ cls: 'info', href: '#water', b: 'Bridge opening likely', small: 'in the next 30 min' }) : null;
  },
});
```

- Both registries take `{ id, order?, render(D, ctx) }`. `render` returns an HTML string, an array of strings, or `null`. Items are sorted by `order`, then registration order. Registering an existing `id` replaces it. Each call returns an unregister function.
- Tiles and heads-up items re-render in **every** render batch (any source update) and every 30 s, so keep them cheap. The heads-up strip hides itself when nothing renders.
- `tile({ href, k, v, s, cls, key })` gives exactly the built-in markup: `k` label, `v` big value, `s` subline, `cls` `''`/`'alert'`/`'good'`. With `key`, `v` gets `data-live-key` and flashes when its text changes. `hu({ cls: 'info'|'warn'|'danger', href?, title?, b, small })` gives a link item when `href` is set, otherwise a `<div>`. The `k`, `v`, `s`, `b` and `small` arguments are HTML (escape data yourself). `href` is inserted as-is, so pass `#section` anchors or `util.href(url)`.

## Map layers (`map.js`)

```js
api.registerLayer({
  key: 'aircraft', label: 'Aircraft', color: '#7c3aed', on: true, deps: ['aircraft'],
  draw(group, ctx) {                                   // group is an L.LayerGroup, already cleared
    const a = ctx.D('aircraft');
    for (const x of (a && a.aircraft) || []) {
      ctx.add(L.marker([x.lat, x.lon], { icon: api.map.labelIcon(api.util.esc(x.callsign || x.hex)) })
        .bindPopup(`<b>${api.util.esc(x.callsign || x.hex)}</b>`), x.hex);   // 2nd arg: stable id, so an open popup survives redraws
    }
  },
  count: (D) => { const a = D('aircraft'); return a ? a.count : null; },    // optional: number on the chip (null hides it)
});
```

- `ctx = { D, env, ui, now, map, L, key, add(leafletLayer, featureId) }`. Use `ctx.add` for anything with a popup. Plain `group.addLayer()` is fine for decoration.
- **When draw runs:** on registration (if the map exists), when the chip is turned on, whenever the **data** of one of its deps changes (identical re-sends don't redraw), hourly, and on `drawLayer(key)`. It never runs while the layer is off (the group is cleared). Animation (interpolated buses, a radar loop) belongs in the layer: keep your own state and `requestAnimationFrame`/`tick` loop, and stop it when the layer is off.
- Chips appear in registration order; a feature layer's chip is appended. The on/off choice is saved in `ui.layers` (keys that are on) and `ui.layersSeen` (keys this browser has offered). A layer the user has never seen starts at its `on` default, even when older saved prefs exist.
- Helpers: `api.map.instance` / `getMap()` (the `L.Map`, `null` if Leaflet failed to load), `layer(key)`, `layers()`, `setLayerOn(key, on?)` (like a chip click; saved), `drawLayer(key)`/`redrawLayer(key)`, `dotIcon(color, size, cls)`, `labelIcon(html, cls, style)`, `setBasemap()`. Leaflet itself is the global `L`.
- `map.js` is Phase 2 B4's file. Keep this interface stable, or extend it.

## Rendering

- `notify(id, changed = true)`: mark a source updated (the transport does this; you rarely need it).
- `invalidate(...targets)`: re-render in the next animation frame. Targets are card names, `'cards'`/`'all'` (every card), `'clock'` (cards with `clock: true`), `'glance'`, `'headsup'`, `'health'`. The glance strip, heads-up strip and feed health are re-rendered in every batch anyway.
- `renderAll()`: every card, tile and heads-up item now, synchronously.
- `setHTML(el, html)`: `el.innerHTML = html`, skipped when identical to the last write; keyboard focus inside `el` moves to the same-index focusable. Returns true if it wrote. Use it for any region you re-render.
- Batches run in `requestAnimationFrame`, so nothing renders while the tab is hidden. Events still fire; the page catches up when shown.

## Live values: flash, tween, countdowns

Mark values in your markup; core compares them across renders of the same card (and of the glance strip) and highlights changes.

```js
const { live, liveNum, liveAttr, countdownEl, newBadge } = api.util;
`<b>${live('gust', r0(g) + ' mph')}</b>`                  // flashes when the text changes
`<div class="big">${liveNum('temp', c.tempF, 1)}°</div>`  // tweens from the old number to the new one (1 decimal), then flashes
`<b ${liveAttr('state')}>${x.up ? 'UP' : 'down'}</b>`     // the attribute alone, on your own element
`Next opening ${countdownEl(t)}`                            // <time data-countdown> updated every second by core: '4:05', '2h 05m', 'now'
`${esc(item.title)} ${newBadge()}`                          // <span class="bl-new">new</span>
```

- Keys only need to be unique within one card. A key that appears for the first time, such as the render after the skeleton, never flashes.
- For regions you render yourself: `const before = util.liveSnapshot(el); setHTML(el, html); util.liveFlash(el, before);`.
- Direct use: `util.flash(el)` (about 1.2 s highlight, restartable), `util.tween(el, from, to, fmt = Math.round, ms = 700)` (returns a stop function). Both do nothing visible when the OS asks for reduced motion (`util.reducedMotion()`), and `style.css` also disables all animations in that case.
- Existing tickers: `util.relEl(t)` (`<time data-rel>`, "5m ago") refreshes every 5 s; bus ETAs (`data-eta`) every 5 s.

## Metric history

```js
const s = await api.history(['weather.tempF', 'tides.observedFt'], 24);  // { 'weather.tempF': [[t, v], ...], ... }
```

- `history(keys, hours = 24)` returns a Promise of `{ key: [[t, v], ...] }`, oldest first, covering the last `hours` (clamped to 1-48). Keys without data are omitted. On a server without `/api/history` (404) it resolves to `{}` and never asks again, until a stream `hello` shows a newer server.
- Results are cached per key, and each `metric` event from the stream appends to the cache, so repeated calls are free and the series stay live. After a reconnect, cached keys are refetched to fill the gap.
- `history.cached(key, hours)` gives the cached series synchronously, or `null`. `history.keys()` lists every metric key seen. `history.supported()` is true, false or null (unknown).
- **In a render**, use `ctx.series(key, hours = 24)`. It returns the cached series or `null` while loading; the first call starts the fetch, and the card (or tile / heads-up strip) re-renders when it lands and again on every new `metric` sample for that key. Example (sparkline and "vs 1 h ago"):
  ```js
  render(D, ctx) {
    const s = ctx.series('weather.tempF', 24);
    const spark = s && s.length > 1 ? api.util.sparkline(s.map(([x, y]) => ({ x, y }))) : '';
    const hourAgo = s && s.find(([t]) => t >= ctx.now - 3600e3);
    ...
  }
  ```
- Metric keys are listed in `GOAL.md` ("Metric keys").

## Activity feed

```js
api.activity.ready.then((items) => renderFeed(items));                // initial list, newest first ([] on old servers)
api.on('activity', (item) => { prependWithAnimation(item); });        // each new item after that
```

- `activity.items()` gives all known items, newest first (up to 500). `activity.supported()` is true, false (404) or null.
- Item shape (`GOAL.md`): `{ id, key, t, source, kind, severity: 'info'|'notice'|'warn'|'alert', title, detail?, link?, lat?, lon? }`. Deduplicated by `id` and `key`.
- Sources of new items: the stream; after a reconnect, a catch-up fetch that emits only unseen items (oldest first); in polling mode on a new server, `/api/activity?limit=50` every 30 s.

## Connection and transport

- `connection()` is `'live'` (stream up), `'polling'` (no stream; per-source polling), `'down'` (server unreachable), or `null` before the first answer. The `connection` event reports changes. The header shows it next to the clock (`#bl-conn`): a pulsing dot with "LIVE", "polling" or "offline"; under 600 px only the dot, with the text kept for screen readers and in the tooltip. While `'down'`, the heads-up strip shows "Can't reach the dashboard server" and the health pill says "Server offline".
- How it works: `/api/sources` first (retried with backoff while the server is down), then `EventSource('/api/stream')`. On `hello` the stream is live, polling stops, and the snapshots that follow refresh the store. On an error the stream is closed and polling starts at once, then the stream is retried with backoff (1 s … 30 s). If the page never got a `hello` and the stream fails with an HTTP error (a v1 server without `/api/stream`), it only retries every 2-10 min. The stream is also treated as dead after 90 s without any message (the server pings every 25 s). While `'down'`, `/api/sources` is probed every 5 s; on recovery the stream reconnects immediately and failed polls are retried.
- Polling (fallback): each source is fetched at its `expiresAt` (at least 10 s apart), errors retry after `min(ttl, 60 s)`, and an unreachable server after 15 s. Requests revalidate with ETags. Returning to the tab (or coming back online) checks freshness: a dead stream is reconnected and overdue sources are fetched.
- `transport()` gives `{ mode, connection, streamOpen, failures, lastFailure: { why, at }, lastMessageAt }` for debugging.
- `?transport=polling` in the page URL skips the stream entirely.

## UI prefs

- `ui` is a plain object persisted in `localStorage['bl-ui']`. Mutate it and call `saveUI()`, or call `setUI(key, value, { render = true })`, which saves, emits `ui` and re-renders everything (`null`/`undefined` deletes the key).
- Namespace feature keys: `'prefs.hidden'`, `'notify.kinds'`, `'kiosk.on'`. Reserved: `layers`, `layersSeen`, `nwsAll`, `afdMore`, `busDir`, `fireActive`, `evSrc`, `newsMode`. The theme is stored separately (`localStorage['bl-theme']`, set by the ◐ button and read by an inline script in `index.html` before first paint).

## Header buttons

```js
const btn = api.addHeaderButton({ id: 'kiosk-btn', label: '⛶', title: 'Kiosk mode (k)', onClick: () => toggleKiosk() });
btn.setAttribute('aria-pressed', 'false');
```

- The button is inserted before the theme toggle, with class `icon-btn` (32×32, 40×40 on touch screens). Calling it again with the same `id` updates the label, title and click handler. `html` (trusted markup) replaces `label` when given. `title` also becomes the `aria-label`.
- The header is tight at 400 px: keep labels to one glyph.

## Styling

- Use the theme variables from `style.css` (`--bg`, `--panel`, `--panel-2`, `--ink`, `--muted`, `--faint`, `--line`, `--accent`, `--accent-ink`, `--accent-soft`, `--blue`, `--warn`, `--warn-soft`, `--danger`, `--danger-soft`, `--ok`, `--ok-soft`, `--chip`, `--shadow`, `--radius`, `--font`, `--mono`). They switch for dark mode (`[data-theme="dark"]`, or the OS preference when unset). Existing building blocks: `.kv`, `.list`/`li`/`.grow`/`.t`/`.sub`, `.tag` (`.accent`, `.warn`, `.danger`, `.ok`), `.seg`, `.label`, `.big`, `.divider`, `.empty`, `.err-note`, `.small`, `.tiny`, `.muted`, `.faint`, `.mono`, `.num`, `.scroll`.
- `core.css` provides `.bl-flash`, `.bl-new`, `#bl-conn.bl-conn[data-state]`, and `.chip .n` (layer count).
- Everything must work at 400 px without horizontal scroll, in light and dark.

## Testing

- `node --check public/**/*.js`. The browser code is plain ES modules; there is no build step.
- `tests/frontend/insight.test.mjs` runs the insight engine under Node against `tests/fixtures/frontend/snapshot.json` (all 41 feeds frozen at Sat Sep 26 2026 11:10 PDT): intent routing, every answer clean of `undefined`/`NaN`, moments ranking, `vsUsual`, the brief, summaries, and the sun position against the almanac. Refresh the fixture from `data/snapshot.json` when source shapes change.
- Interactive QA: `tools/cdp.mjs` drives headless Chrome over the DevTools protocol (click, type, keys, `eval`, `mock` requests, phone emulation with touch, light/dark, screenshots, console errors). Example scripts: open Stories and step through, play Replay, ask a question, or mock `/api/baseline` to see the "vs usual" UI before a day of history exists.
- Headless Chrome: `--virtual-time-budget` **never finishes while an EventSource is open** (virtual time waits for pending network requests). Either capture with `?transport=polling` (polling path, virtual time works), or test the stream in real time. For real-time capture, use `--timeout=<ms>` together with something that holds the page's `load` event until the capture time, because `--timeout` captures at `load` if that comes first. Headless Chrome may also not exit after `--screenshot`/`--dump-dom`, so wrap it in `timeout`.
- The masonry grid can't produce "ResizeObserver loop" errors (span writes are deferred a frame). If you add your own `ResizeObserver`, never change the observed elements' layout inside its callback.
- Service worker (B5): do not intercept `/api/stream` (no `respondWith` for it) and don't cache `/api/*` responses as if they were static.
- Known limit: every open tab holds one stream connection, and browsers allow about 6 HTTP/1.1 connections per host, so many dashboard tabs in one browser can starve each other.

## v2 features (public/features)

| Module | What it adds | ui keys | Events |
|---|---|---|---|
| `activity.js` | the "Live activity" card (live section, order 10), the "Recent activity" map layer, toasts for warn/alert items and Ballard/Fremont bridge openings, an unread count in the tab title, "since you were last here" (`localStorage['bl-activity-seen']`) | `activity.hidden`, `activity.min` | listens: `activity`, `activity:locate` (pan the map to an item) |
| `summary.js` | the "Now in Ballard" line (`#summary-line`), the "Today in Ballard" timeline card (live, order 0) with a last-hour digest, the sky strip under the top bar | — | listens: `activity`, `minute`, `render` |
| `notify.js` | 🔔 panel with opt-in browser notifications per rule, minimum importance, background-only, quiet hours, WebAudio chime, throttling (1 per 20 s, batched) | `notify.on`, `notify.rules`, `notify.hiddenOnly`, `notify.sound`, `notify.quiet` | listens: `notify:open`; emits `notify:changed`, `activity:locate` |
| `prefs.js` | ⚙ settings: favorite buses (glance tile `mybus` + optional heads-up), hide/pin/reorder cards (a "Pinned" section), compact density, summary/glance toggles, install, SW registration and an "Offline" heads-up | `prefs.buses`, `prefs.busAlert`, `prefs.hidden`, `prefs.pinned`, `prefs.order`, `prefs.compact`, `prefs.noSummary`, `prefs.noGlance` | listens: `prefs:open`, `features`; emits `prefs:changed` |
| `kiosk.js` | ⛶ kiosk mode: bigger type, no chrome, section cycling, Wake Lock, idle cursor. Enter with `?kiosk=1`, `k` or the button. Not persisted, so a reload exits it. | `kiosk.interval` | listens: `kiosk:toggle`; emits `kiosk:changed` |
| `shortcuts.js` | keyboard shortcuts (`?` help), the `/` card filter, and the `?panel=settings|notifications|shortcuts` deep links | — | emits `kiosk:toggle`, `notify:open`, `prefs:open` |
| `trends.js` | wraps the built-in cards with 24 h sparklines and "vs 1 h" deltas from `ctx.series`, per-route delay chips on Buses, and the 24 h bridge up/down strip | — | — |
| `extra-cards.js` | the "Overhead now" card and glance tile (`aircraft`), "Wildlife sightings" (community, wide), bridge-opening odds in the Drawbridges card, and the `bridge-odds` heads-up | `wildlife.group` | — |

Other v2 additions:
- `util.openDialog({ id, title, html, wide, onClose })` opens an accessible modal (focus trap, Esc, backdrop click, focus returned) and returns `{ el, body, close }`. Calling it again with an open `id` closes that dialog.
- `map.js`:
  - `persistent: true` layers keep their markers between draws, and `stop()` runs when such a layer is turned off.
  - `addAnimator(fn)` runs `fn(now)` on the shared rAF loop (about 30 fps, only while the map is on screen and the tab visible). Return `false` from it to stop.
  - `mapVisible()` tells whether the map is currently on screen.
  - Built-in animated layers: `bus` (glides at constant speed over the real fetch gap), `aircraft` (dead reckoning from gs/track, capped at 20 s, with a 1.5 s correction blend and trails) and `radar` (frame loop with play/pause/scrub controls).
- `sw.js`: network-first for page code, network-first with the last good copy for `/api/*` (it posts `bl-offline`/`bl-online` to clients), and cache-first for unpkg and Google Fonts. It never touches `/api/stream` or `/img`.

## v3 features: "Ballard, alive"

| Module | What it adds | Storage | Events |
|---|---|---|---|
| `hero.js` | `section#hero` before the glance tiles. It holds the **living scene**, a canvas drawn from live data (solar/lunar position and phase, cloud cover and wind drift, rain and fog, the tide height on a marked piling, the Ballard Bridge leaves raised when it's really up, West Point wind heeling the sailboats, aircraft lights, gulls). It runs at about 30 fps only while on screen and visible, and draws one static frame under reduced motion. It also has the overlay (place, time, temperature, facts), the (i) legend, a Share button, **Moments** (a vertical list at ≥1101 px, otherwise a carousel that rotates every 8 s) and the **Ask** box with suggestion chips. The **live pill** (`button#island`) in the header cycles `liveActivities` every 5 s with live timers. | — | listens `hero:render` ({ canvas, w, h }: draws the scene onto another canvas synchronously, sets `done`); emits `ask:open`, `share:open` |
| `ask.js` | The ⌘K / Ctrl+K palette (`#ask-btn` in the header): answers from `insight.answer()` as you type, kept live while open, with voice in (SpeechRecognition), voice out (speechSynthesis) and recent questions. Deep link `?ask=`. | `bl-ask-recent`; ui `ask.speak` | listens `ask:open` (q); emits `ask:asked` ({ q, intent }) |
| `stories.js` | The ring bar under the hero and the full-screen viewer (progress, tap/keys/swipe, hold to pause, time-lapse playback). Stories are Today (a portrait render of the scene via `hero:render`), Bridges, Cameras (frames from `/api/cams`), Wildlife, Weather, Locks, Tonight/Events and 911. The Cameras card gets a "Play 3-hour time-lapses" button. Deep link `?story=<id>`. | `bl-stories-seen` | listens `stories:open` ({ id, at }) |
| `foryou.js` | The "For you / Suggested for …" row: dwell time (≥2.5 s at ≥55 % visible), clicks, and Ask intents per card, bucketed by Pacific hour with a 7-day half-life. It uses time-of-day defaults until 25 points are learned. | `bl-engage` | listens `ask:asked` |
| `replay.js` | "Replay last 24 h" on the map: a transport bar (play/pause, 1×/3×/10×, scrubber with event ticks). Located activity items appear at their times and fade over 90 min, with a readout from `api.history` at each moment. Live layers dim while it plays, and it starts where the record starts. Deep link `?panel=replay`. | — | listens `replay:open` |
| `share.js` | A 1080×1350 "Ballard right now" PNG: the scene rendered at size via `hero:render`, the temperature and conditions, six live stats with icons. It offers Web Share (files), download and clipboard. Deep link `?panel=share`. | — | listens `share:open` |

**`insight.js`** (pure; callers pass `now`):
- `sunPosition(t)` and `moonPosition(sky, t)`.
- `SUMMARY[topic](D, now)` returns `{ icon, label, value, sub, href, tone }`. `CARD_SUMMARY` maps card to topic.
- `liveActivities(D, now, { favorites, activity })` feeds the pill.
- `moments(D, now, { series, favorites, baseline })` returns a list ranked by `score`.
- `intentOf(q)`, `whenOf(q)`.
- `answer(q, D, now, { activity, series, favorites, baseline })` returns `{ intent, title, icon, html, speak, actions }` or null.
- `suggestions(D, now)`.
- `brief(D, now, { activity, baseline })` returns `{ title, text, html }`.
- `vsUsual(u, value, now, { better, unit, dp, minDiff })` returns `{ dir, tone, vs, usual, usualText, text, title }`. It compares with the middle half of past values at this hour plus a tolerance; with a single past day it's honestly "vs yesterday".
- `usualBasis(u, now)`.

Answer markup uses the `.ans-*` classes (styled in `ask.css`).

**Baselines in the UI.** `trends.js` adds a "+N vs usual" / "≈ usual" line under each trend's hourly delta; the tooltip explains the basis. Moments get `usual-*` anomaly items (traffic, air, West Point wind, a busy day at the Locks, 911 volume, temperature), which need at least 2 past days. The traffic answer and the spoken brief mention unusual values. Everything is silent until `/api/baseline` has data.

**Icons.** UI chrome uses `icons.js` line icons: the header buttons, activity kinds and chips, the map radar control and camera pins, the digest, the timeline sun marks, aircraft kinds and warnings. Weather conditions and moon phases stay as color glyphs, and so do wildlife groups on the map.

**Phones (≤480 px).** The header is one row (brand, status dot, bell, gear, search, theme) that scrolls away. The clock, feed pill, kiosk and share buttons are hidden, since Share lives on the scene. Replay's bar is a single control row with a sideways-scrolling readout. Keyboard hints are hidden on touch screens.

**Service worker.** `VERSION` is `v3-2`, and the v3 modules are precached. Time-lapse frames (`/cam/*`) are never intercepted: they're immutable, so the HTTP cache keeps them, and they never fill the offline cache.
