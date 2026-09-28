# Source contract

Every source module in `sources/<group>.mjs` has a default export: an array of source definitions.

```js
import { get, limiter, fromPacific, ... } from '../lib.mjs';
export default [
  { id: 'weather', title: 'Weather (Open-Meteo)', ttl: 600, background: false, fetch: async ({ prev, fetchedAt }) => ({ ... }) },
];
```

- `ttl` is in seconds. The server caches the result for `ttl`. Set `daily: true` on sources that describe the current Pacific day (today's counts, sun times, today's closures): their cache also expires at the next Pacific midnight.
- The envelope served at `/api/<id>` is `{ id, title, ttl, fetchedAt, expiresAt, stale, error, data }`. The browser schedules its next poll at `expiresAt`. `stale` is true when the data is more than 3×ttl old, or when it is daily data from an earlier Pacific day.
- `fetch()` returns the normalized object described below. On total failure it **throws**. The server keeps serving the last good data and flags the error. On partial failure (for example, one of 3 stations is down), return what you have and add a `warnings: [string]` array.
- **All timestamps in output are epoch milliseconds (numbers)**, converted correctly from each upstream's zone. `lib.mjs` has `fromPacific`, `fromUTC`, `pacificDate`, `toPacificFloating` and `pacificParts`. Missing values are `null`, never `'MM'`, `''` or `NaN`. Numbers are numbers, not strings.
- Keep payloads small (well under 200 KB). Filter and trim server-side.
- Use `get()` from lib.mjs for HTTP. It adds the UA, timeout and retries. Honor the rate-limit notes in `tools/research-*.md`.
- Module-level state is fine (for rate limiters and sub-caches). Persist state that must survive restarts with `readState`/`writeState` (files go in `data/`).
- Test live with `node tools/probe.mjs <id>` or `node tools/probe.mjs --group <group>`.
- `CENTER` = 47.6687,-122.3847. `BBOX` = n 47.700, s 47.655, w -122.410, e -122.360. `inBbox(lat, lon, padKm)` and `haversineKm(lat, lon)` (distance to CENTER) are in lib.

Field names below are exact. `t` always means epoch ms. `?` marks a nullable field.

---

## group `weather` → sources/weather.mjs

### `weather` (ttl 600) Open-Meteo forecast with the minutely_15 nowcast merged into ONE call
```
{ current: { t, tempF, feelsF, humidity, precipIn, code, cloud, windMph, gustMph, windDir, isDay: bool, visMi, uv, pressureHpa },
  hourly: [ { t, tempF, feelsF, pop, precipIn, code, windMph, gustMph, windDir, uv, cloud } ],   // next 24 hours, starting at the current hour
  daily:  [ { date: 'YYYY-MM-DD', t, code, hiF, loF, pop, precipIn, windMph, gustMph, windDir, uvMax, sunrise, sunset } ], // 7 days; t = local midnight
  nowcast: [ { t, precipIn, code } ],       // 15-min slots, next 3h (12)
  rainStartsAt?: t, rainEndsAt?: t }        // from the nowcast: first slot with precip > 0.001 (if not raining now) / first dry slot (if raining now)
```
`code` = WMO weather code (int). Open-Meteo local times: convert with `utc_offset_seconds` (or fromPacific).

### `nws-forecast` (ttl 1800) NWS gridpoint SEW/124,71 forecast
`{ updated: t, periods: [ { name, start: t, end: t, isDay, tempF, pop?, wind: '5 to 10 mph', windDir, short, detail, icon } ] }`, first 8 periods.

### `alerts` (ttl 120) NWS active alerts for zones WAZ315, WAC033, PZZ135
`{ alerts: [ { id, event, severity, urgency, headline, description, instruction?, area, onset?: t, ends?: t, expires?: t, marine: bool } ] }`. `marine` = true if the UGC list includes PZZ135 only. Sort by severity (Extreme, Severe, Moderate, Minor), then by onset.

### `stations` (ttl 300) Hyperlocal Ballard citizen stations (CWOP via NWS): AW337, E7826, F8372, AS437
`{ stations: [ { id, lat, lon, distKm, t, tempF?, humidity?, windMph?, gustMph?, windDir?, pressureHpa?, stale: bool, inBallard: bool } ], medianTempF?, medianOf }`. stale = older than 90 min. medianTempF uses non-stale in-Ballard stations (falling back to all non-stale stations), and medianOf is how many were used. Get lat/lon from the observation's geometry or the station endpoint (cache it).

### `westpoint` (ttl 600) NDBC WPOW1 West Point: measured wind at the water
`{ lat: 47.662, lon: -122.435, t, windDir?, windKt?, windMph?, gustKt?, gustMph?, peakGustKt?, peakGustMph?, peakGustT?, pressureHpa?, pressureTendencyHpa?, airTempF?, history: [ { t, windKt?, gustKt?, windDir?, pressureHpa? } ] }`. Latest wind comes from .cwind (10-min). gustKt is the gust AT the observation time (from .txt), and it is null otherwise. The .cwind hourly peak gust is peakGust*, with peakGustT from GTIME. history = last 24 hourly rows from .txt, oldest first. Read only the head of the .txt file (it's 45 days).

### `marine` (ttl 1800) NWS coastal waters forecast PZZ135 (tgftp text)
`{ issued: 'text like 132 PM PDT Thu Sep 24 2026', issuedT?: t, expires?: t, headlines: [ 'SMALL CRAFT ADVISORY IN EFFECT ...' ], periods: [ { name: 'TONIGHT', text } ] }`. Unwrap line breaks within a period.

### `afd` (ttl 3600) NWS Seattle Area Forecast Discussion
`{ issued: t, synopsis: string, shortTerm?: string }`. synopsis = the .SYNOPSIS... section up to '&&', whitespace-normalized. shortTerm = the .SHORT TERM... section, if present (max 1500 chars).

### `sky` (ttl 3600) USNO sun and moon for today's Pacific date
`{ date: 'YYYY-MM-DD', sun: { civilDawn?, rise?, noon?, set?, civilDusk? }, moon: { rise?, set?, phase, illum /*0-100*/ }, nextPhase?: { phase, t }, tomorrowSun: { rise?, set? } }`. All times are epoch ms. Make a second call for tomorrow's date for tomorrowSun. If the date changed since the last fetch, refetch regardless.

### `kp` (ttl 600) NOAA SWPC planetary K index
`{ t, kp /*estimated_kp float*/, kpIndex /*int*/, recent: [ { t, kp } ] /* last 8 official 3-hour values, oldest first */ }`

### `radar` (ttl 300) IEM NEXRAD composite metadata
`{ valid: t, tileUrl: 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png', frames: [ { label: '-50m', tileUrl } … { label: 'now', tileUrl } ], loopGif: 'https://radar.weather.gov/ridge/standard/KATX_loop.gif' }`. frames has 11 entries (m50m … m05m, then now), oldest first.

### `airnow` (ttl 1800) AirNow reporting area Seattle-Bellevue-Kent Valley (official)
`{ observed: [ { param: 'PM2.5'|'OZONE'|'PM10', aqi, category, t, primary: bool } ], forecast: [ { date: 'YYYY-MM-DD', param, aqi?, category, primary } ], discussion? }`. Use If-Modified-Since with the previous Last-Modified (keep it in module state; on 304 return prev). The file is about 1.8 MB, so filter lines as a stream or split and filter. Keep only today's and future forecasts.

### `purpleair` (ttl 1200) PurpleAir sensors in Ballard via the AirFire export
`{ sensors: [ { id, lat, lon, t, pm25, aqi } ], medianAqi?, medianPm25?, count, t? /*newest utc_ts*/ }`. Use the bbox, drop rows older than 3h, and compute aqi = pm25ToAqi(epa_nowcast). Use a conditional GET as with airnow.

---

## group `water` → sources/water.mjs

### `tides` (ttl 1800)
```
{ station: 'Shilshole Bay (Meadow Point)',
  hilo: [ { t, ft, type: 'H'|'L' } ],          // 9447265, from local midnight today, range 48h
  curve: [ { t, ft } ],                          // 9447130 6-min predictions from min(local midnight, now-7h) to max(midnight+36h, now+26h), for the chart
  observed: [ { t, ft } ],                       // 9447130 observed water_level, last 24h (range=24)
  latest?: { t, ft, predictedFt?, anomalyFt? },  // latest observed vs the prediction at the same t
  next: [ { t, ft, type } ],                     // next 4 hilo events after now
  trend: 'rising'|'falling' }                    // from the curve at now
```
Use `application=ballard_live` and **time_zone=gmt** (lst_ldt prints the fall-back hour ambiguously). Parse with fromUTC. NOAA returns errors as 200 with an `error` key, so throw on it.

### `currents` (ttl 21600) West Point current predictions PUG1515 bin 1
`{ station: 'West Point', events: [ { t, type: 'slack'|'flood'|'ebb', knots } ] }` from local midnight today, range 48h.

### `lake` (ttl 900) USACE LWSC lake level above the Locks (nwd-wc dataquery, timezone=GMT)
`{ t, ft, history: [ { t, ft } ] /* last 48h, hourly-thinned */, outflowCfs?, outflowT? /* START (Pacific midnight) of the day the daily average covers */ }`

### `lockages` (ttl 300) USACE LPMS Chittenden Locks queue (in_river=WS&in_lock=01)
```
{ recent: [ { name, direction: 'up'|'down', arrival: t, start?: t, end?: t, waitMin?, commercial: bool, mmsi? } ],  // newest 30 by arrival
  today: { up, down, total, commercial },   // lockages with arrival on today's Pacific date
  queued: n,                                 // entries with end == null and arrival within the last 3h
  avgWaitMin?,                               // mean (start - arrival) today
  lastEnd?: t }
```
Times are Pacific wall-clock despite the 'PST' label, so use fromPacific. Rate limit: 5 req/min shared across LPMS endpoints (see stoppages). Use one module-level limiter with a gap of at least 15s.

### `stoppages` (ttl 1800) USACE LPMS stall/stoppage, riverCode WS only
`{ active: [ { chamber, begin: t, end?: t, reason, scheduled: bool, trafficStopped: bool } ], upcoming: [ ...same ], recent: [ ...same /* ended in the last 7 days */ ] }`

### `bridges` (ttl 20, background: true) SDOT live drawbridge status
```
{ bridges: [ { id: 2, name: 'Ballard', lat, lon, up: bool, since?: t, sinceKnown: bool } ],   // all bridges in the feed; Ballard first, Fremont second
  log: [ { bridge: 'Ballard', upAt: t, downAt?: t, minutes? } ],                                  // observed openings, newest first, max 50
  observingSince: t }
```
`up` = Status !== 'Closed'. Track transitions in module state and persist them with writeState('bridges.json') so `since` and `log` survive restarts. On first observation, since = null and sinceKnown = false. The body is double-encoded JSON.

### `bridge-history` (ttl 3600) Seattle open data gm8h-9449 (about 1 day behind)
`{ openings: [ { bridge, open: t, close?: t, minutes? } ] /* Ballard and Fremont, last 7 days, newest first, max 100 */, stats: { Ballard: { last24h, last7d, avgMin?, latest?: t }, Fremont: { ... } }, newest?: t }`. last24h is counted relative to `newest`, not to now, because the dataset lags.

### `salmon` (ttl 21600) WDFW Lake Washington (Ballard Locks) counts, HTML tables
`{ year, species: [ { name: 'Sockeye'|'Chinook'|'Coho', latestDate?: 'M/D', latestT?: t, latestCount?, total?, recent: [ { date: 'M/D', count } ] /* last 7 counted days */ } ], source: url }`. Latest = the last row with a non-empty daily count.

### `cso` (ttl 600) King County and Seattle combined sewer overflow status, Ballard area
`{ sites: [ { tag, name, lat, lon, status: 'overflowing'|'recent'|'none'|'nodata', t } ], overflowing, recent, t? }`. Use the bbox lat 47.64-47.71, lon -122.43 to -122.34 and drop the dummy legend rows.

---

## group `move` → sources/move.mjs

All OneBusAway calls share ONE module-level limiter (gap of at least 1500 ms) and retry 429 with a 2-4 s backoff, up to 3 times.

### `transit` (ttl 45) OBA arrivals-and-departures-for-location (lat 47.6680, lon -122.3805, radius 650, minutesBefore=0, minutesAfter=45)
```
{ now: t /*OBA currentTime*/,
  groups: [ { route: 'D Line', routeId, headsign, dir: 'to Downtown'|…, stopId, stopName, stopDir,
              arrivals: [ { t, predicted: bool, min /*float, minutes from now*/, vehicleId?, stopsAway?, distM?, occupancy?, deviationSec?, confidence: 'live'|'scheduled'|'low' } ] } ],
  situations: [ { id, summary, description?, severity?, routes: [shortName] } ] }
```
Make one group per (route, headsign), at its primary stop. Primary stop preference order: 1_13721, 1_14230, 1_18120, 1_18740, 1_18145, 1_18720, 1_29215, 1_29700; otherwise the stop closest to CENTER. Keep the next 4 arrivals (t >= now - 30s), and dedupe the same trip that appears at duplicate stopIds. `dir` is a short human label, e.g. D Line 'Downtown Seattle Uptown' → 'to Downtown', 'Crown Hill' → 'to Crown Hill'. Otherwise use a cleaned-up headsign. Sort groups by route (D Line, 40, 44, 17, 28, then others) and then by headsign. confidence: 'low' for vehicleIds of 7+ digits after the '1_' prefix with deviation 0; 'live' if predicted; otherwise 'scheduled'.

### `vehicles` (ttl 90) OBA trips-for-route for D Line 1_102581, 40 1_102574, 44 1_100224
`{ vehicles: [ { route: 'D Line', headsign, vehicleId, lat, lon, heading? /*compass deg*/, deviationSec?, t } ] }`. Keep only trips whose activeTripId's routeId matches the route, and only within 6 km of CENTER. Skip placeholder vehicles (7+ digit ids) and statuses without a real GPS fix. t = lastLocationUpdateTime.

### `metro-alerts` (ttl 300) KCM GTFS-rt alerts_enhanced.json filtered to Ballard
`{ alerts: [ { id, header, description?, effect, severity?, start?: t, end?: t, routes: ['D Line','40',…], stops: [ids], url? } ], total /*citywide count*/ }`. Match route_id in {102581:'D Line',102574:'40',100224:'44',100062:'17',100169:'28'} or any Ballard stop id (see research-move.md; strip the '1_' prefix). Keep only alerts whose active_period covers now or starts in the next 7 days.

### `cameras` (ttl 120) SDOT traffic cameras, Ballard set
`{ cameras: [ { id: 'CMR-0011', label, lat, lon, url, lastModified?: t, ok: bool } ] }`. Use the 8 working cameras from research-move.md. HEAD each one (in parallel is fine; it's CloudFront). ok = 200 + image/jpeg + Last-Modified within 30 min. `url` is the direct image URL; the browser adds a cache-buster.

### `traffic` (ttl 120) SDOT arterial travel times for sites 1991 and 1990
`{ sites: [ { id: '1991', name: '15th Ave NW & NW 61st St', links: [ { name: 'DOWNTOWN', minutes? } ] }, … ] }`. minutes = round(Value/60), or 1 if under 30 s, or null if Status !== 1.

### `incidents` (ttl 180) SDOT Travelers incidents (type=1)
`{ incidents: [ { id, type, description, start?: t, end?: t, direction?, location?, lat, lon, url?, distKm } ], citywide: n }`. Keep only those within bbox + 1.5 km. Fix mojibake. The Start/EndDateTime values are Pacific 'M/D/YYYY h:mm:ss AM'.

### `lime` (ttl 90) Lime GBFS free_bike_status
`{ t /*last_updated*/, near: { total, scooters, ebikes, bikes } /*within 800 m of CENTER*/, inBbox, points: [ [lat, lon, kind] ] /*kind 's'|'e'|'b'; bbox only; max 1000*/ }`. Exclude disabled and reserved vehicles. The feed is about 3 MB, so reduce it server-side.

---

## group `civic` → sources/civic.mjs

### `fire911` (ttl 90) Seattle Fire 911: Socrata kzjm-xkqj (2 km, last 24h) joined with the live realtime911 HTML page
```
{ incidents: [ { id, type, address, t, lat?, lon?, units?: 'E18 L8', level?, active?: bool, distKm?, located: bool } ],
  activeKnown: bool,       // false when SFD's live page is unavailable, so the active flags are unknown
  activeCount?,            // null when !activeKnown
  newest?: t }
```
Enrichment uses both today's and the previous Pacific day's realtime911 pages. Take the Socrata rows (within_circle 2000 m, datetime > now-24h as floating Pacific, newest first, limit 100) and enrich them with the HTML page (units, level, active flag) by incident number. Also add HTML rows NOT yet in Socrata whose address looks like Ballard (for example /\bNw\b/i plus a Ballard street pattern, or 'Ballard', 'Leary', 'Shilshole', 'Market St'), with located: false. Sort newest first. Fetch the HTML at most every 60 s (module sub-cache). If the HTML fails, still return the Socrata rows with a warning.

### `crime` (ttl 3600) SPD crime data tazs-3rd5, BALLARD NORTH and BALLARD SOUTH, last 7 days by report_date_time
`{ reports: [ { id /*report_number*/, t /*report_date_time*/, offenseT?, offenses: [string], category?, block?, lat?, lon?, beat? } ], byCategory: { PROPERTY: n, PERSON: n, SOCIETY: n }, newest?: t, lagHours? }`. Group rows by report_number. Max 80.

### `quakes` (ttl 180) USGS
`{ recent: [ { id, mag, place, t, depthKm, lat, lon, url, felt?, distKm } ] /*150 km, 7 days, M>=1.0, max 30*/, notable: [ ...same ] /*300 km, 30 days, M>=2.5, max 10*/ }`

### `outages` (ttl 120) Seattle City Light (DataCapable)
`{ ballard: [ { id, start: t, updated?: t, etr?: t, customers, status, cause, lat, lon, ring?: [[lat,lon],…] } ] /*bbox + 1 km*/, citywide: { count, customers }, updated?: t }`. Convert ring coords from [lon,lat] to [lat,lon] and use only the first ring.

### `news` (ttl 900) Merged RSS: My Ballard, Google News "Ballard" Seattle (7 days), Seattle Times local, SPD Blotter, SFD Fireline, PhinneyWood, SDOT blog, Seattle Parks
`{ items: [ { source, title, link, t, summary?, ballard: bool } ] /*newest first, max 60*/, feeds: [ { name, ok, count, error? } ] }`. `ballard` = mentions Ballard (or Golden Gardens, Shilshole, Crown Hill, Loyal Heights, Sunset Hill, Whittier Heights, 'Nordic Museum', 'Ballard Locks') in the title or summary. My Ballard items are always ballard:true. For the citywide feeds (Seattle Times, Blotter, Fireline, SDOT, Parks), keep only ballard:true items plus the newest 3 per feed. Dedupe by normalized title (Google News titles end in ' - Source'; strip that and set source from it). Drop MaxPreps and NFHS noise. Fetch the feeds in parallel. Individual feed failures only show up in `feeds`.

### `reddit` (ttl 1800) r/Ballard new (.rss) and r/Seattle search "ballard" (.rss)
`{ items: [ { sub: 'r/Ballard'|'r/Seattle', title, link, t, author? } ] /*newest first, max 30*/ }`. Fetch sequentially with a gap of at least 4 s. On 429/403 return prev (with a warning) if available.

### `events` (ttl 3600) Visit Ballard (The Events Calendar REST API) and SPL Ballard Branch (Trumba kalendaro)
`{ events: [ { id, title, start: t, end?: t, allDay, venue?, address?, cost?, url, source: 'Visit Ballard'|'SPL Ballard', canceled: bool, category? } ] }`. Visit Ballard: start_date = today (Pacific), end_date = +7 days, per_page 50, up to 4 pages. SPL: days=14, keep only location 'Ballard Branch'. Keep events whose end (or start + 2h) is >= now. Sort by start. Max 150.

### `closures` (ttl 21600) Seattle Street Closures ium9-iqtc in the bbox, active today
`{ closures: [ { permit, type, name, street, from?, to?, todayHours?, days: { sun?: '6AM-5PM', … }, start: t, end: t, segments: [ { street, from, to, line: [[lat,lon],…] } ] } ] }`. The browser recomputes today's hours from `days`. Group by permit_number. todayHours = the hours text for the current Pacific weekday. Ignore rows with absurd dates (year > now + 5).

### `requests311` (ttl 3600) Seattle customer service requests 5ngg-rpne within 2 km
`{ requests: [ { id, type, status, t, address?, lat?, lon?, area? } ] /*max 40*/, newest?: t }`

### `permits` (ttl 21600) Seattle building permits 76t5-zqzr within 2 km
`{ permits: [ { id, type, description, address, issued: t, status, cost?, units?, lat?, lon?, url? } ] /*max 25, issued within the last 30 days, statuscurrent 'Issued' preferred*/ }`

### (frontend-only) Opening hours
Farmers market, library and Nordic Museum hours are hard-coded in the frontend. There is no server source for them.

---

## group `extra` → sources/extra.mjs (v2)

### `aircraft` (ttl 15, idleTtl 300) ADS-B aircraft within 8 nm (adsb.lol, fallback adsb.fi)
`{ t, radiusNm, provider, aircraft: [ { hex, callsign?, reg?, type?, desc?, lat, lon, altFt? /*0 on ground*/, gsKt?, track?, vrFpm?, squawk?, onGround, emergency?: string|null, category?, operator?, kind: 'airliner'|'seaplane'|'helicopter'|'military'|'light'|'unknown', distKm, posAgeS, t } ] /*nearest first*/, count, airborne, nearest? }`

### `wildlife` (ttl 1800) iNaturalist observations, Ballard bbox + 1 km, last 14 days, wild only, with photos
`{ observations: [ { id, t?, timeKnown, observedOn, created?, taxon: { name, common?, iconic?, rank? }, photo? /*https medium*/, photoCredit?, lat?, lon?, obscured, place?, url, user?, quality } ] /*newest upload first*/, counts: { total, species, byIconic: { Aves: n, ... } }, days: 14 }`

### `bridge-odds` (ttl 900, daily) Opening odds from 12 weeks of gm8h-9449 and 33 CFR 117.1051(d)
`{ windowDays, basis, hourly: [ { dow /*0=Sun*/, hour, avgOpenings, avgMinutes? } ] /*168*/, now: { expectedPerHour, chanceNext30Min /*0-1*/, typicalMinutes?, restricted /*weekday 7-9 am, 4-6 pm, not federal holidays except Columbus Day*/, night /*11 pm-7 am: 1 h notice*/, holiday? }, next? /*t of the next rush-hour rule change*/, nextStarts?, restrictionText?, newest, fremont: { now, basis }, rule }`

## Metrics (history series, `GET /api/history`)

Metrics are sampled after each successful refresh, at most one per minute per key, and kept for 48 h. They are defined in `sources/intel.mjs` (v1 sources) and `sources/extra.mjs`.

| Key | Meaning |
|---|---|
| `weather.tempF`, `.feelsF`, `.windMph`, `.gustMph`, `.humidity`, `.pressureHpa`, `.cloud`, `.pop1h` | Open-Meteo current conditions (next-hour chance of rain) |
| `stations.medianTempF` | median of the in-Ballard backyard stations |
| `westpoint.windKt`, `.gustKt` (gust at obs time, else hourly peak), `.pressureHpa`, `.airTempF` | NDBC West Point |
| `purpleair.aqi`, `.pm25`, `.sensors`; `airnow.pm25aqi`, `.ozoneaqi` | air quality |
| `tides.observedFt`, `tides.anomalyFt` | Seattle gauge vs prediction |
| `lake.ft`, `lake.outflowCfs` | Ship Canal above the Locks |
| `lockages.today`, `.up`, `.down`, `.commercial`, `.queued` | Ballard Locks (the today counts reset at local midnight) |
| `bridges.ballardUp`, `bridges.fremontUp` (0/1), `bridges.up` (count) | drawbridge state |
| `transit.delay.D`, `.40`, `.44` (mean minutes late, + = late), `transit.vehicles` | from live bus positions |
| `traffic.downtown1991`, `traffic.downtown1990`, `traffic.<site>.<link>` | SDOT drive minutes |
| `lime.near`, `.scooters`, `.ebikes`, `.inBbox` | Lime availability |
| `fire911.count24h`, `fire911.active` | Seattle Fire 911 |
| `outages.ballard`, `outages.citywideCustomers`; `cso.overflowing`, `cso.recent` | power, sewer overflows |
| `kp.kp`; `aircraft.count`, `.airborne`; `wildlife.count14d`, `.species14d`; `bridgeOdds.chance30` | sky, aircraft, wildlife, bridge odds |

## Activity (the live feed, `GET /api/activity`)

Detectors compare each refresh with the previous data. They never emit on a first load, and their keys come from stable identity, so the 7-day dedupe holds across restarts. Threshold detectors use hysteresis so they don't flap. Kinds and events:

- **bridge**: a bridge goes up or back down (Ballard and Fremont up = notice). Skipped right after a polling gap, when the time of the change is unknown.
- **fire**: a new 911 call within 2 km from the last 2 h. Fire, rescue and hazmat = warn; MVI = notice; aid and alarms = info.
- **alert**: a new NWS alert (Extreme = alert, Severe = warn, Moderate or Minor = notice) and its end.
- **weather**: rain starting within the hour, rain easing, gusts crossing 35 mph.
- **water**: gusts of 30+ kt at West Point, a minus tide or a very high tide today, a surge of 1.5+ ft, a sewer overflow starting or stopping.
- **air**: PurpleAir AQI bands (with hysteresis) and official AirNow category changes.
- **transit**: a route running 5+ min late on average, and back near schedule; new Metro alerts on Ballard routes and stops.
- **traffic**: new SDOT incidents near Ballard, a slow drive downtown (1.6x the 48 h median), new street closures.
- **locks**: named commercial vessels locking through, queues of 3+, chamber closures and reopenings.
- **power**: a Ballard outage (warn) and its restoration.
- **quake**: M1.5+ within 50 km or M2.5+ within 300 km (M4+ = warn, M5.5+ = alert).
- **sky**: Kp crossing 5 or 7 (aurora chances).
- **news** and **social**: new Ballard news items and new Reddit posts from the last day.
- **event**: events starting within the hour.
- **wildlife**: notable iNaturalist sightings (mammals, raptors, herons, seals, …) and a new salmon count at the Locks.
- **aircraft**: an emergency squawk (alert), or a helicopter or other aircraft below 1,000 ft within 2 km (not floatplanes).
- **civic**: new SPD reports in the PERSON category (lagged about a day).
