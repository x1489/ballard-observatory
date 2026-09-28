# Ballard Live

A live dashboard for the Ballard neighborhood of Seattle. It's one local Node server with no npm dependencies. It pulls 41 free public feeds (no API keys), refreshes them on its own schedule, and pushes every change to the browser over a live stream. It keeps history for trend lines, learns what's usual for each hour, records camera time-lapses, and turns changes into a live activity feed.

```sh
cd ~/ballard-live
node server.mjs          # then open http://localhost:4177 (or http://127.0.0.1:4177)
npm test                 # 387 automated tests, no network
```

Needs Node 18 or newer. `PORT=8080 node server.mjs` changes the port. The server only listens on 127.0.0.1. Set `HOST=0.0.0.0` to open it to other devices on your network, for example a wall tablet at `http://<your-mac>.local:4177/?kiosk=1`. To keep it running in the background: `nohup node server.mjs >> ballard.log 2>&1 &`.

## Ballard, alive (v3)

| | |
|---|---|
| **The living scene** | The page opens on a drawing of Ballard that is driven entirely by live data. The sun, moon (with its real phase) and stars sit where they really are. Clouds match the real cover and drift with the wind. Rain and fog show when they're happening. The water stands at today's actual tide on a marked piling. The Ballard Bridge leaves rise when the bridge is really up, while cars queue at the gates. Sailboats heel with the West Point wind, and the lights crossing the sky are the aircraft overhead. Press (i) on the scene for the legend. |
| **Live pill** | A pill in the header (like a Dynamic Island) cycles through what's live right now: the bridge up (with a running timer), your next bus counting down, a 911 call nearby, rain starting, or sunset. Hover or tap it to expand, and click it to jump to the card. |
| **Moments** | Smart suggestions ranked for right now: a clear sunset worth walking to Golden Gardens for, a minus tide for tide-pooling, the salmon run at the Locks, calm water for paddling, a full moon rising, events tonight, a bridge opening, and "unusual right now" moments such as traffic heavier than usual. |
| **Ask Ballard** | Press ⌘K / Ctrl+K, the search button, or the Ask box, and type or say a question: "when's my bus?", "is the bridge up?", "good time to kayak?", "why are there sirens?", "what plane is that?", "what's happening tonight?", "brief me". Answers come from the live data as you type and stay live while open. It takes voice input, can read answers aloud, and remembers your recent questions. |
| **Stories** | A ring of stories under the scene: Today, Bridges (the last 24 hours, each Ballard opening paired with the camera frame closest to it), Cameras (3-hour time-lapses this server records), Wildlife, Weather (radar loop), the Locks, Tonight/Events and 911. Tap or use the arrow keys to move, hold to pause, swipe, and press Esc to close. |
| **For you** | A row that learns which cards you check at each time of day, entirely in your browser, and shows them first. It uses sensible defaults until it has learned. |
| **Replay** | "Replay last 24 h" on the map plays the day back. Located events appear at their real times, conditions at each moment show below, and the scrubber has event ticks. It plays at 1×, 3× or 10×. |
| **Share** | The share button (on the scene, and in the header on larger screens) makes a 1080×1350 image of Ballard right now. It combines the living scene with the temperature and six live stats, ready to share, download or copy. It's generated in the browser, and nothing is uploaded. |
| **Usual for this hour** | The server learns every metric's typical value for each hour of the day, and for each hour of the week once it has two or more weeks. Trend rows then show "+6 min vs usual" or "≈ usual". Ask and the spoken brief mention anything unusual, and Moments call it out. After one day it compares against "yesterday". |

## What's on it

| Area | Live data |
|---|---|
| Top | The living scene, Moments and the Ask box. Stories. A **Now in Ballard** summary line and the For you row. Glance tiles for weather, Ballard Bridge, the next D Line, tide, AQI, sunset, the Locks, 911 and aircraft overhead (plus your favorite buses). A heads-up strip for NWS warnings, bridge openings, imminent rain, outages, sewer overflows, Metro alerts, felt quakes and likely bridge openings. |
| Live | The **Today in Ballard** timeline: daylight, tides, rain, bridge openings (seen and typical, plus the rush-hour no-opening windows), open hours, events and alerts, with a moving "now" line and a last-hour digest. The **Live activity** feed: bridge openings, new 911 calls, alerts, rain starting, bus delays, outages, sewer overflows, quakes, notable vessels, wildlife, low aircraft, new Ballard news and more. It has filters, a "since you were last here" marker, toasts and click-to-locate. **Overhead now**: live ADS-B aircraft. |
| Map | 18 layers: 911 calls (new ones pulse), buses that glide along their routes with heading arrows, aircraft moving by dead reckoning with trails, bridges, recent activity, traffic incidents, outages, an animated radar loop (play/pause/scrub), cameras, air sensors, temperatures, wildlife photos, scooters, street closures, sewer outfalls, police reports, 311 and permits. Every chip shows a live count. Replay plays back the last 24 hours. |
| Weather and sky | Conditions with 24 h trend lines (and "vs usual"), a 3-hour nowcast, the 24 h and 7-day forecasts, the NWS forecast and forecaster notes, West Point wind (with trends), the marine forecast, AirNow and PurpleAir AQI (with trend), sun and moon, the radar loop, and aurora Kp. |
| Water and the Locks | The Shilshole tide chart (predicted and measured), West Point currents, Ballard and Fremont bridge status. The bridges card has a 24 h up/down strip and opening odds from 12 weeks of city data under 33 CFR 117.1051's rush-hour rule. Also Locks lockages (with a trend) and closures, the Ship Canal level, salmon counts and sewer overflows. |
| Getting around | OneBusAway arrivals (D Line, 40, 44, 17, 28) with per-route "running late" chips, Metro alerts, SDOT drive times against their usual values, cameras (with time-lapses), incidents and Lime scooters (with a trend). |
| Safety and community | Fire and medical 911 (live active flags), outages, SPD reports, quakes, open-now places, events, news, Reddit, iNaturalist **wildlife sightings** with photos, street closures, 311 and permits. |

**Header controls** (line icons):
- Search opens **Ask Ballard** (⌘K).
- Share makes the **Ballard right now** image.
- Bell sets up **Notifications**: opt-in, per kind, with quiet hours and a chime.
- Gear opens **Settings**. Favorite buses become a glance tile with a "due now" heads-up. You can also hide, pin or reorder cards, use compact density, and install the app.
- Expand turns on **Kiosk mode**, a wall display that cycles sections and keeps the screen awake. Open it with `?kiosk=1` or `k`.
- The half circle is the **Theme** toggle.

On phones the header shrinks to one row that scrolls away with the page. Share moves onto the scene, and the Feeds section shows feed health.

Keyboard shortcuts: press `?`. **Deep links:**
- `/?ask=next+bus` opens Ask with that question.
- `/?story=bridges` opens a story.
- `/?panel=share|replay|settings|notifications|shortcuts` opens that panel.
- `/?layers=radar,aircraft,bus` shows exactly those map layers.
- `/?kiosk=1` starts kiosk mode.

It installs as an app (manifest plus service worker) and still opens offline with the last data it saved, clearly labeled as old.

## How it works

- `server.mjs`: HTTP, gzip and ETags, the SSE stream (`/api/stream`), `/api/<id>`, `/api/sources`, `/api/history`, `/api/activity`, `/api/baseline`, `/api/cams`, camera frames at `/cam/<id>/<t>.jpg`, and the `/img` camera proxy.
- `core/`: the scheduler, SSE hub, history store, activity log, baselines, camera frame store, snapshot and persistence (see `CORE.md`).
  - The scheduler refreshes every source on its `ttl` while someone is watching, and on a slower `idleTtl` otherwise.
  - The history store keeps 48 h of per-minute samples.
  - Baselines keep 4 weeks of hourly rollups.
  - The camera store keeps each traffic camera's last 90 distinct frames, about 3 hours.
  - The activity log keeps the last 500 items, deduplicated.
- `sources/`: the data sources, whose shapes are in `CONTRACT.md`.
  - `weather`, `water`, `move` and `civic` are the v1 feeds.
  - `extra` adds aircraft, wildlife and bridge odds.
  - `intel.mjs` attaches metrics (history series) and detectors (activity items) to the v1 sources.
- `public/`: the page (vanilla ES modules, Leaflet from unpkg; see `FRONTEND.md`).
  - `core.js`: store and live transport.
  - `map.js`: the map, its layers and the animation loop.
  - `cards.js`: the built-in cards.
  - `insight.js`: the pure insight engine behind the scene, the pill, Moments, Ask, the brief, Stories, For you and Share. It covers astronomy, summaries, ranking, natural-language answers and "vs usual".
  - `icons.js`: the line icon set.
  - `baseline.js`: the client cache of `/api/baseline`.
  - `features/*.js`: the v2 features (activity, summary and timeline, notify, prefs, kiosk, shortcuts, trends, extra cards) and the v3 ones (hero, ask, stories, foryou, replay, share).
  - `sw.js`: the service worker.
- `data/`: state the server keeps: snapshot, history, baselines, camera frames, activity and the bridge log.
- `tests/`: server and source tests, plus `tests/frontend/` for the insight engine, run against a frozen snapshot of all 41 feeds.
- `tools/`:
  - `probe.mjs` live-tests a source: `node tools/probe.mjs aircraft`.
  - `cdp.mjs` is a tiny headless-Chrome driver for interactive QA. It can click, type, run JS in the page, mock requests, emulate phones and light or dark mode, capture screenshots, and collect console errors.
  - `qa.mjs` takes a one-shot screenshot.
  - `pngcrop.mjs` crops screenshots.
  - `make-icons.mjs` generates the app icons.
  - `research-*.md` records the verified upstream endpoints and their quirks.
- `GOAL.md` describes the v2 and v3 plans and their acceptance criteria. `.backup/` holds a v1 snapshot.

## Notes

- Some sources are official but not instant, and the dashboard labels them: SPD reports and 311 (about a day behind), bridge history (about a day), salmon counts (a few days). The newest 911 calls come from SFD's live page. The open-data copy lags about 10 minutes.
- Buses use OneBusAway's shared public `TEST` key, which is sometimes rate limited. The server spaces out its calls and keeps showing the last good data.
- Bridge "since" times, the opening log and the 24 h strip are observed by this server while it runs. SDOT's feed has no timestamps. When the Mac sleeps, the bridge tracking restarts, and changes it missed are not announced as new.
- Aircraft come from community ADS-B networks (adsb.lol, with adsb.fi as a fallback). Seaplanes on Lake Union approaches are expected, so they don't trigger "low aircraft" items.
- "Usual" needs history. On the first day nothing is compared. After a day, values are compared with yesterday. From the second day on, they're compared with the usual for that hour, and after two weeks, the usual for that weekday and hour.
- Nothing personal leaves your browser. For you, recent questions, story "seen" state and settings live in localStorage. Voice input uses the browser's own speech recognition.
