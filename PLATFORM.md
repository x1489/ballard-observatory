# Ballard Observatory: research brief and platform design

Written 2026-09-26. Everything marked **verified** was tested against the live API or official documentation that day. Items marked *to verify* come from search results only.

## 1. The ask, restated

This isn't about a better dashboard. It's about a platform that:
1. **Funnels every piece of available information about Ballard into one place**: real-time feeds, years of civic records, place and business data, public-health signals, government decisions, and public social chatter. It keeps it permanently, linked together, and queryable.
2. **Builds value on top**: advanced, useful capabilities, above all the discovery of **patterns nobody has looked for**. It works across all the dimensions at once (time, place, source and kind), with enough statistical rigor that a discovery can be trusted.
3. **Is hosted** (not local-only) and built entirely from **free** components.

## 2. What best-in-class looks like (and what to take from each)

| System | What it is | What Ballard should take from it |
|---|---|---|
| [Newcastle Urban Observatory](https://www.infraportal.org.uk/infrastructure/newcastle-urban-observatory) | The UK's largest urban sensing programme: 3,500+ live streams and 60+ indicators, with every reading archived since 2017 (change-only, at most one value per 30 s) and an open streaming and REST API ([API v2](https://api.v2.urbanobservatory.ac.uk/)). | **Archive everything, forever, change-only, open by default.** Ballard Live keeps 48 h today. |
| [NYC Mayor's Office of Data Analytics](https://www.nyc.gov/site/operations/research/mayor-office-of-data-analytics.page) (MODA and DataBridge) | Joined 40+ agencies' records at the building level. Combining 311 complaints, permits, utility and census data found illegally subdivided, fire-prone buildings. Matching grease-hauler contracts to sewer backups found illegal dumpers, with a 95 % hit rate ([GCN](https://gcn.com/data-analytics/2013/10/how-analytics-is-making-nycs-streets-and-buildings-safer/281525/)). | **Link every record to a place** (address, parcel, block face, business). The high-value patterns appear where datasets that were never meant to meet are joined. |
| [Data Polygamy](https://arxiv.org/abs/1610.06978) (NYU VIDA, SIGMOD 2016; [code](https://github.com/VIDA-NYU/data-polygamy)) | Automatically finds statistically significant relationships among *hundreds* of urban spatio-temporal datasets, at multiple spatial and temporal resolutions. It notes that relationships often hold only in certain places or times, and it separates real relationships from spurious ones. | The core of "patterns nobody thought about": **search all pairs systematically, test significance, report where and when.** |
| [Urban computing / cross-domain fusion](https://www.microsoft.com/en-us/research/wp-content/uploads/2015/09/Methods-for-Cross-Domain-Data-fusion.pdf) (Yu Zheng, MSR) | Infers what isn't measured by fusing what is. U-Air infers air quality from traffic, POIs and weather. NYC noise was diagnosed from 311 complaints, POIs, roads and check-ins. | **Estimate the unmeasured** (for example, crowding, noise or beach risk) from the measured. |
| [PCMCI / Tigramite](https://www.science.org/doi/10.1126/sciadv.aau4996) (Runge et al., *Science Advances* 2019) | Causal discovery for many time series. It finds *time-lagged* links while controlling for autocorrelation and common drivers. | **Lag-aware, confounder-aware** links ("rain → sewer overflow 2 h later → beach bacteria next day"), not naive correlations. |
| [Matrix Profile / STUMPY](https://github.com/stumpy-dev/stumpy) | Motifs (recurring shapes), discords (anomalies), regime changes and AB-joins between series, all exact and parameter-light. | Find **recurring rhythms and truly unusual days** in every series without hand-tuned thresholds. |
| [Prospective space-time scan statistics](https://pubmed.ncbi.nlm.nih.gov/15719066/) (Kulldorff; SaTScan) | The disease-outbreak surveillance standard. It detects *emerging* clusters of cases in space and time with significance, using counts only. | **Emerging hotspots** of 911 calls, crime, 311, dumping and graffiti, flagged when they appear, with p-values. |
| [QuickInsights / Top-K insights](https://www.microsoft.com/en-us/research/publication/extracting-top-k-insights-multi-dimensional-data/) (MSR, SIGMOD 2017/2019) | Enumerates insight types (outliers, trends, change points, shares, rank shifts) across all subspaces of the data and ranks them by significance and impact. | **Rank discoveries** so the ten that matter surface first. |
| [Dataminr](https://www.dataminr.com/resources/blog/multi-modal-fusion-ai-for-real-time-event-detection/) | Real-time event detection that fuses social, sensor, audio and news signals, often ahead of official channels. | **Multi-source incident fusion**: several weak signals corroborating each other become one confident "situation". |
| [Council Data Project](https://councildataproject.github.io/seattle/) (started in Seattle) | Searchable council videos, transcripts, votes and legislation. | **What government is deciding about Ballard**, linked to the places affected. |
| [Correlation Sketches](https://arxiv.org/abs/2104.03353) (NYU, SIGMOD 2021) | Estimates correlations between columns of different tables *without* joining them. | Makes all-pairs discovery **cheap enough for free hardware**. |
| [Overture Maps](https://docs.overturemaps.org/guides/places/) | Free monthly GeoParquet of places, buildings, addresses and transportation. | The **backbone of the place graph**: every business and building in Ballard. |

**The synthesis.** No single one of these exists for a neighborhood. The aspirational system combines them:
- Urban Observatory completeness and permanence.
- MODA's place-level joins.
- Data Polygamy and PCMCI's rigorous all-pairs, lag-aware discovery.
- SaTScan's emerging-cluster surveillance.
- Dataminr's multi-source fusion.
- QuickInsights ranking.

Everything is delivered as plain-language insights with evidence.

## 3. Where Ballard Live stands today (honestly)

**It has:**
- 41 real-time feeds, a 48 h metric history and a 4-week hourly baseline.
- An activity log (500 items) and a local Node server.
- A strong UI, and simple rules and templates (moments, anomaly "vs usual").

**Missing for the platform:**
- A permanent archive.
- Historical backfills (Seattle has records back to 2008).
- The civic record datasets: crime, police 911, permits, code complaints, business and liquor licenses, inspections, parking, collisions, council.
- A place graph and entity resolution.
- Any cross-source statistics.
- Hosting.

## 4. Data inventory (new sources, verified unless noted)

Coordinates for "Ballard" are 47.655 to 47.700 N and 122.355 to 122.415 W. SPD sector B (beats **B1, B2**) and the SPD neighborhoods **BALLARD NORTH / BALLARD SOUTH** were verified. In the last 365 days those neighborhoods had 1,235 and 2,930 crime reports, of which about 13 % have redacted locations.

### Real-time (seconds to minutes)

| Source | Access | Notes |
|---|---|---|
| The existing 41 feeds (weather, tides, bridges, Locks, 911 fire/medical, buses via OBA, aircraft, AQI, cameras, scooters, …) | as today | Keep them all. The platform adds a permanent archive. |
| **King County Metro GTFS-realtime**: `vehiclepositions.pb` and `tripupdates.pb` on `s3.amazonaws.com/kcm-alerts-realtime-prod/` | **verified**: public, no key; 37 KB and 868 KB protobuf | Every Metro bus in the county, live. It enables network-wide delay propagation, not just stop arrivals. |
| **Bluesky Jetstream** | **verified** (docs): no auth, and the cursor replays within a bounded window | Public social signal. It can be collected in periodic catch-up runs (no always-on process needed). |
| **AIS vessels** via [aisstream.io](https://aisstream.io/documentation) | free API key, WebSocket, beta (no SLA) | Vessels approaching the Ballard Bridge, Locks and Ship Canal. Opens **minutes-ahead bridge-opening prediction**. |
| Wikipedia pageviews (`Ballard,_Seattle`) | **verified** | An attention signal. |

### Civic records (daily updates, years of history): Seattle Open Data (Socrata, no key)

| Dataset (id) | Why it matters |
|---|---|
| **SPD Call Data** `33kz-ixgy` | Every police 911 call: type, priority, beat, dispatch coordinates (some REDACTED), and **response times**. About 3 days behind. **Verified**: 2,200 calls in the Ballard box in 30 days. |
| **SPD Crime Data** `tazs-3rd5` (2008–) | Offenses by NIBRS code and neighborhood. **Verified.** |
| SPD Arrests `9bjs-7a7w`, Terry Stops `28ny-9ts8` | Enforcement patterns. |
| Building Permits `76t5-zqzr`, **Land Use Permits** `ht3q-kdvx`, Certificates of Occupancy `axkr-2p68`, Plan Review `tqk8-y2z5` | The development pipeline, from proposal to occupancy. |
| **Code Complaints & Violations** `ez4a-iug7` | Nuisance and condition signals, tied to addresses. |
| Customer Service Requests (311) `5ngg-rpne` plus tracking `43nw-pkdq`, Graffiti `a2k6-wwdn`, **Encampment reports** `k7ra-jqqe`, **Illegal dumping** `bpvk-ju3y`, 72-hour parking `74ix-6xdj` | Quality-of-life signals with resolution times. |
| **Active Business Licenses** `wnbq-64tb`, Short-Term Rental Licenses `s7df-xba4` | Openings, closures and STR density. |
| Street Use permit notices `eyde-ia6x`, Street closures `ium9-iqtc` | Construction on the street. |
| **Paid Parking Transactions** `gg89-k5p6` | Every meter payment, about 1 day behind. **Verified**: Ballard Ave, Market St and Tallman block faces run about 600 transactions per block face in 3 days. Gives occupancy by block and hour. |
| Traffic counts `xucb-vzhc` (plus hourly and 15-min bins), Fremont Bridge bike/scooter counter `65db-xm6k` | Flows. **Verified**: the NW 58th St Greenway counter in Ballard is *out of service* (quarterly counts only). |
| SDOT Collisions All Years (ArcGIS, daily) | *To verify*: the endpoint URL was rejected in the test. |

### Other public records

| Source | Access | Why it matters |
|---|---|---|
| **Seattle City Council, Legistar Web API** (`webapi.legistar.com/v1/seattle/events`, `/matters`, votes) | **verified**: no key | Legislation and meetings that mention Ballard. |
| **WA Liquor & Cannabis Board**, Local Authority Letters `vgcw-qfjm` (data.wa.gov) | **verified**: new license applications with coordinates. The raw data includes applicant names and birthdates, which are **dropped at ingest**. | A **leading indicator of bars and restaurants opening** weeks to months ahead. |
| **King County food inspections** `r878-4sxa` | **verified**: scores, violations, **parcel numbers** | Restaurant health, linkable to parcels. |
| **CDC wastewater surveillance**: SARS-CoV-2 `j9g8-acpt`, Influenza A `ymmh-divb`, activity levels `atcp-73re`, measles `akvg-8vrb`, H5 `mtpu-urpp`, mpox `xpxn-rzgz` | **verified**: WA site `2046` ("Snohomish, King", 789,000 people) is consistent with West Point, the plant serving Ballard (*to confirm*). Weekly, about 10 days behind. | A community-health signal. |
| King County water quality `vwmt-pvjw`; WA Ecology BEACH (Golden Gardens, weekly in season) | catalog / *to verify* the data access | Swim safety, alongside rain and sewer overflows. |

### Context (slow, bulk)

- Overture places, buildings and addresses (monthly GeoParquet, DuckDB-readable).
- OpenStreetMap (Overpass; the main server returned 504 in the test, so use a mirror).
- King County parcels and assessor extracts (*to verify*).
- Census ACS tracts (*to verify*: the API redirected).
- Open-Meteo historical hourly weather (*to verify*).
- Metro GTFS static.

## 5. The value layer: ten engines

Each engine writes **Insight** objects:

```
{ type, statement, evidence: { effect, CI, p, q (FDR), n, windows }, scope: { where, when },
  novelty, stability, sources, provenance: { datasets, code version, query } }
```

These are ranked QuickInsights-style and narrated from templates. An LLM is optional and never the source of a fact.

1. **Archive and replay**: every raw payload is archived permanently (content-addressed), plus normalized `observations`, `events`, `entities` and `documents` tables in Parquet. Any past moment can be replayed.
2. **Place graph**: addresses → parcels → buildings → businesses → block faces → beats, tracts and H3 cells. Every record is resolved to places, which gives MODA-style joins.
3. **Baselines and change points**: hour-of-week expectations for every metric and every event-count series (by kind and area), robust anomaly scores, and online change-point detection (BOCPD/CUSUM). Examples: "SPD response times in beat B1 are 4.1 min slower since June". "D Line reliability shifted at the service change."
4. **Relationship discovery, all pairs**: deseasonalize, then lagged cross-correlation, then surrogate tests that preserve autocorrelation, then Benjamini–Hochberg FDR, then PCMCI to prune confounded links. The output is where, when, lag and effect size. Examples:
   - bridge openings → D Line delay (+Δ min, lag 10–25 min)
   - rain → sewer overflow → beach bacteria
   - heat or smoke → 911 medical calls
   - SEA runway flow (from wind) → aircraft over Ballard
   - festivals → parking, scooters and 911
   - wastewater virus levels → 911 medical calls (lagged)
5. **Event cascades**: the lift of event B within Δt and Δd after event A, against a permutation baseline. Examples: street-use permits → Metro reroutes; fire calls → traffic incidents.
6. **Emerging hotspots**: a prospective space-time permutation scan (Kulldorff 2005) over crime by offense type, 911 by type, encampments, dumping and graffiti. Example: "9 car prowls within 200 m in 6 days, expected 2.1, recurrence once in 3 years".
7. **Place intelligence**, per block and business:
   - an *opening-soon pipeline*: liquor application + new business license + tenant-improvement permit + plan review
   - a *likely-closed* signal: license lapses, inspections stop
   - a development pipeline: land use → permit → occupancy, in housing units
   - nuisance persistence: code complaints, 311 and 911
   - STR density
8. **Situational fusion**: space-time clustering of signals from different sources (911, traffic incidents, Metro alerts, outages, AQI, Bluesky posts, closures) into one "situation", with a confidence score and all the evidence.
9. **Nowcasts**:
   - bridge opening within the next N minutes (historical odds plus AIS vessels approaching)
   - D Line arrival reliability given the bridge state
   - block-level parking availability by hour
   - beach-bacteria risk after rain
   - sewer-overflow risk from the rain forecast
10. **Civic watch**: Legistar matters and meetings that mention Ballard places, land-use decisions and wastewater health trends, with alerts.

**Rigor rules** (every insight must pass them):
- Deseasonalize before comparing, so everything doesn't simply "correlate with daytime".
- Use surrogate or permutation nulls that preserve autocorrelation.
- Apply FDR across everything tested.
- Report effect sizes with confidence intervals.
- The finding must replicate in at least two disjoint time windows.
- Check for common drivers (PCMCI).
- Keep a registry of trivial or definitional pairs so they're never "discovered".
- Keep full provenance.
- **Privacy**: public records only; personal fields (names, birthdates, phone numbers) are dropped at ingest; redacted locations stay redacted.

## 6. Architecture ($0, verified free tiers)

```
 real-time feeds ──► Cloudflare Worker + Durable Object (cron every 1 min; DO alarms for 15 s feeds)
                      │ hot state, 72 h ring buffer in DO SQLite; serves the API, SSE and the web app (Pages)
                      ▼
 GitHub Actions (public repo: 4 vCPU / 16 GB runners, unlimited minutes)
   hourly: drain the edge buffer → Parquet; incremental civic pulls (Socrata :updated_at cursors, Legistar, LCB, CDC)
   daily:  engines 3–7 and 9–10 (Python: DuckDB, statsmodels, stumpy, tigramite); publish insights → edge
   weekly/monthly: Overture, parcels, ACS; model retraining; the "Ballard Pulse" report
                      ▼
 Hugging Face Dataset (public): the permanent, open data lake (Parquet, partitioned by source and day),
   queryable directly by DuckDB (hf://…) by anyone
```

**Free-tier facts** that shaped this (all checked 2026-09-26):

| Service | Free allowance | Consequence for the design |
|---|---|---|
| [Cloudflare Workers](https://developers.cloudflare.com/workers/platform/limits/) | 100k requests/day, **10 ms CPU per invocation** (cron too), **5 cron triggers per account** | The Worker only routes. Parsing happens in a Durable Object. |
| [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/limits/) | SQLite storage **5 GB per account**, **30 s CPU per request** (configurable up to 5 min), 100k requests/day, **3,000 GB-s/day**, 100k rows written/day | Parsing fits comfortably. Writes must be batched (per-series hourly blocks). Always-on WebSockets would exceed the duration budget, so streams use catch-up bursts. |
| [D1](https://developers.cloudflare.com/d1/platform/pricing/) | 5 GB, 100k writes/day, 5M reads/day, **hard-enforced since 2026-09-01** | Optional. The DO covers hot storage. |
| [Queues](https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/) | free since 2026-02-04: 10k operations/day, 24 h retention | Available for fan-out if needed. |
| R2 | 10 GB free, but **needs a payment method** | Avoided. Hugging Face is the lake. |
| [GitHub Actions](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) | public repos: **free, unlimited minutes, 4 CPU / 16 GB / 14 GB SSD**. Schedules at least every 5 min and often delayed. **Scheduled workflows are disabled after 60 days without repo activity.** | Batch and analytics run here. Hourly commits of insights count as activity. |
| [Hugging Face datasets](https://huggingface.co/docs/hub/en/storage-limits) | public storage "best effort", usually up to TBs; repos ≤ 300 GB without asking | The permanent lake, free. |
| Hugging Face Spaces | 2 vCPU / 16 GB but **sleeps after 48 h without visitors**, ephemeral disk, and HF says "upgrade to paid hardware" to run indefinitely | **Not** used as an always-on host. |
| [Oracle Always Free](https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/) | Arm VM **cut to 2 OCPU / 12 GB on 2026-06-15** (free-tier accounts). Credit card needed to sign up. Idle instances are reclaimed. | The alternative "one box" option. |
| Google Cloud e2-micro | 1 GB RAM, 30 GB disk, **1 GB egress/month** | Too small to serve a public site. |
| Supabase / Neon / MotherDuck | 500 MB (pauses after 7 idle days) / small / 10 GB + 10 compute-hours per month | Not needed. DuckDB on Actions and Hugging Face covers analytics. |

**Why this split.** The edge handles what must be instant, and it is designed to run always-on under free limits. GitHub supplies 4-core runners free for heavy batch analytics. Hugging Face gives free, permanent, openly queryable storage. None of the three needs a credit card.

## 7. Roadmap

| Phase | Deliverable | Done when |
|---|---|---|
| **1. Lake and backfill** | `platform/`: the connector framework with incremental cursors and PII scrubbing; Parquet lake; catalog; backfill of Ballard history for the top datasets | 25+ new datasets land daily, with a documented schema, lineage and freshness |
| **2. Place graph** | Address normalization; parcel and business resolution; H3 cells; zones | ≥ 90 % of located records resolve to a place |
| **3. Engines** | 3–7 on real Ballard data; Insight objects with evidence; ranking | A reviewed list of statistically sound discoveries, each reproducible from the lake |
| **4. Hosted** | Edge Worker and DO real-time layer; the Actions pipelines; the HF lake; web app with Insights, place pages, Discoveries and the API | A public URL, $0 cost, and a runbook |
| **5. Fusion and nowcasts** | Engines 8–10: AIS bridge prediction, beach and sewer risk, situation fusion, alerts (ntfy / web push) | Measured precision and lead time |

## 8. Decisions that are yours

- **Accounts**: GitHub, Cloudflare and Hugging Face (all free, no card). Alternatively, an Oracle Cloud free VM (needs a card).
- **Public or private**: the unlimited free Actions minutes and free lake storage need a **public** repo and dataset. All the inputs are public records; personal fields are dropped.
- **Tooling on this Mac**: `gh`, and `wrangler` 4.141, which **requires Node ≥ 22** (verified from the npm registry; this Mac has 18.18, and Homebrew offers `node@22` 22.23.3). Also a Python virtual environment with DuckDB.
