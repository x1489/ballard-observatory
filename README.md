# Ballard Observatory

Ballard, Seattle, live in 3D, plus an open data lake of the neighborhood's public records and the patterns found in
them. Everything runs on free tiers (Cloudflare Workers, Hugging Face, GitHub) with free public data.

- **Live site:** https://ballard-observatory.ballard-observatory-edge.workers.dev (phones too: "Add to Home Screen")
- **Analyst console:** `/pro` · **Open data:** https://huggingface.co/datasets/x1489/ballard-observatory

## What it does

| | |
|---|---|
| **The place, in 3D** | King County's 2025 aerial photography on real terrain, lit by the actual sun (golden hour, dusk, a dark city with glowing streets at night). Buildings of three storeys and up rise as massing; 182,000 trees from Seattle's 2021 LiDAR survey stand at their measured heights in the colours of the season. |
| **Everything that moves** | Every aircraft within 20 nm as a 3D model of its type, scaled to the real length and wingspan, at its real altitude, banking into turns, with altitude-coloured trails, navigation lights and strobes at night and a ground shadow by day. Every King County Metro bus as a 3D bus of its real type and livery (articulated buses bend, trolleybuses have poles), driving its route at the pace of the predicted stop times. Amtrak trains on the shore line. The Ballard and Fremont bridges' leaves rise when SDOT reports them up. 911 fire and medical calls as beacons. Rain radar. |
| **Tap anything** | Flighty-style tracking cards: a flight's route with progress and estimated arrival, altitude, speed, closest approach to Ballard, the airframe and a photo; a bus's next stops with live predictions; a train's station timeline and when it passes Ballard; a bridge's opening statistics, odds and live camera; the ISS's visible passes; the weather, tide and air. |
| **Follow & alerts** | Follow anything and its live status rides in the island at the top. Phone alerts (Web Push) arrive with the app closed: a bridge going up or down, a fire or rescue call nearby, an aircraft emergency overhead. |
| **God's-eye tools** | Director (a hands-off cinematic tour of what's live), chase and cockpit cameras, night-vision / thermal / mono looks with a targeting HUD, and a sky view of planes, satellites, the Sun and Moon above Ballard. |
| **Briefing** | What the observatory found in years of public records, in plain language: what's unusual this week, statistically checked patterns, new businesses, housing projects, City Hall decisions, and a dossier for any address. |

## Architecture

```
browser  public/live/        the 3D app (MapLibre GL + deck.gl, vendored; no build step)
            │  /api/live, /api/flight, /api/push/*, /api/obs/*
edge     edge/               Cloudflare Worker + one Durable Object ("Hub"): runs the 44 live sources on an alarm
            │                scheduler, serves the live API, sends push alerts, proxies analytics from Hugging Face
            ▲  POST /api/_push   (aircraft + satellite element sets: community ADS-B aggregators block Cloudflare)
relay    server.mjs + core/relay.mjs on an always-on machine (the local server)
lake     platform/           Python: ingest ~25 public datasets into a Parquet lake, discovery engines, publish to
                             Hugging Face (hourly: tools/run-pipeline.sh here, or .github/workflows/pipeline.yml)
```

The same source modules (`sources/*.mjs`) run in Node (the local server) and on the edge (`edge/build.mjs` copies them).

## Run, test, deploy

```sh
node server.mjs                     # local server + app at http://127.0.0.1:4177 (Node 18+, no npm dependencies)
npm test                            # ~400 tests, no network
node tools/qa-live.mjs out/         # visual QA in headless Chrome (injects test traffic; add scenario names)
tools/deploy.sh                     # edge deploy: tests, deploy, smoke test the live site, auto-rollback on failure
node tools/smoke.mjs [--http]       # smoke test the hosted site
```

Keeping things running on this machine: `tools/run-local.sh` (restarts the local server and its relay if it exits),
`tools/run-pipeline.sh` (hourly data pipeline, publishes to Hugging Face), `caffeinate -dimsu` (no sleep).
`.github/workflows/uptime.yml` checks the hosted site hourly and fails (emailing the owner) if it's down.

Secrets (never in the repo): the edge's `PUSH_TOKEN` and `VAPID_PRIVATE_JWK` (`wrangler secret put`), mirrored
locally in `data/edge-push.json` and `data/vapid.json` (`data/` is gitignored). The GitHub pipeline needs an
`HF_TOKEN` secret (a Hugging Face write token); until it's set the workflow skips.

Regenerating static data: `node tools/build-geo.mjs transit|rail` (Metro GTFS, US DOT rail lines),
`node tools/build-trees.mjs` (LiDAR tree inventory), `node tools/models/build.mjs` (bus, train and bridge models).

## Free-tier notes

Workers free plan: 100k requests/day; the app polls moving things every 10 s and everything else every 60 s, pauses
when hidden and slows when idle. Durable Object: ~13,000 GB-s/day and 100k rows written/day; fast-changing feeds
(aircraft, buses, trains) are never written to storage. Hosted aircraft depend on the relay: when the local server
is off, the app says live aircraft are paused (everything else stays live). Removing that dependency needs one of:
a free OpenSky account, access from airplanes.live, or a small ADS-B receiver feeding adsb.lol.

## Credits

Aerial imagery © EagleView / King County. Terrain: Mapzen terrain tiles on AWS Open Data. Map data © OpenStreetMap
contributors (OpenFreeMap). Aircraft positions: adsb.lol (ODbL) and adsb.fi; routes: adsbdb; photos:
planespotters.net. Buses: King County Metro GTFS and GTFS-realtime. Trains: Amtrak via Amtraker. Satellites:
CelesTrak. Trees: City of Seattle 2021 LiDAR tree inventory. Rail lines: US DOT NTAD. Plus the City of Seattle,
King County, NOAA, NWS, USACE, USGS, Open-Meteo and others listed in the analyst console. 3D aircraft models:
CC BY 4.0, see `public/models/README.md`.

More: `PLATFORM.md` (data platform and discovery engines), `CORE.md` (the real-time core), `CONTRACT.md` (source
shapes). `FRONTEND.md` documents the earlier dashboard, still at `/classic.html`.
