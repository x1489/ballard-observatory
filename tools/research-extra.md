# New v2 sources: verified upstreams (2026-09-25)

## aircraft
- Primary: `https://api.adsb.lol/v2/point/47.6687/-122.3847/8` (8 nm radius). No key. readsb/tar1090 JSON: `{ ac: [...], now (ms), total }`.
- Fallback: `https://opendata.adsb.fi/api/v2/lat/47.6687/lon/-122.3847/dist/8`. No key, 1 req/s limit. `{ aircraft: [...], now (s) }`.
- Aircraft fields used: hex, flight (callsign, space padded), r (registration), t (ICAO type), desc, alt_baro (ft, or "ground"), alt_geom, gs (kt), track, baro_rate / geom_rate (fpm), squawk, emergency, category (A1-A7, B*), lat, lon, seen, seen_pos (s), dbFlags (bit 1 = military).
- Positions older than 60 s are dropped. The kind comes from category, type and callsign (A7 or helicopter type designators, then DHC-2/DHC-3 floatplanes, then military, then airliners).
- The `api.airplanes.live` endpoint returned 403 without a key when tested.

## wildlife (iNaturalist API v1, no key; keep it to about 1 req/s)
- `https://api.inaturalist.org/v1/observations?nelat&nelng&swlat&swlng&d1=YYYY-MM-DD&photos=true&captive=false&order_by=created_at&order=desc&per_page=80&locale=en`
- `…/observations/species_counts?…&per_page=1` gives the distinct species in `total_results`. `…/observations/iconic_taxa_counts?…` gives the counts per group.
- Photo URLs come back as `…/square.jpg`. Swapping in `medium.jpg` works (verified 200).
- Timestamps: `time_observed_at` is ISO with an offset; `observed_on` is a date. `obscured` or geoprivacy means randomized coordinates.

## bridge-odds
- Seattle open data `gm8h-9449` (drawbridge openings; floating Pacific times, about 1 day behind). The source pulls 84 days of Ballard and Fremont rows (about 1,800) and caches them for 6 h.
- Sensor events less than 3 min apart are merged into one opening. The averages are per (weekday, hour) in Pacific time over whole days.
- The regulation was checked in the eCFR, 33 CFR 117.1051(d), using `https://www.ecfr.gov/api/versioner/v1/full/<date>/title-33.xml?part=117&section=117.1051`. That endpoint requires `Accept-Encoding: gzip`.
  - The Ballard, Fremont and University bridges need not open from 7-9 a.m. or 4-6 p.m., Monday through Friday, for any vessel under 1,000 tons unless it is towing a vessel of 1,000 gross tons or more. All Federal holidays are exempt except Columbus Day.
  - From 11 p.m. to 7 a.m., an opening needs at least one hour's notice to the drawtender at the Fremont bridge.
  - The Montlake Bridge has different windows (not used here).
