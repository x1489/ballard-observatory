"""Non-Socrata connectors: long time series and civic records.

  weather_hourly    Open-Meteo historical archive (ERA5-based reanalysis) at NW Market St, hourly since 2009
  tides_hourly      NOAA CO-OPS Seattle (9447130): observed and predicted hourly water level; surge = obs - pred
  pageviews_daily   Wikipedia daily pageviews for Ballard articles (attention signal)
  council_matters   Seattle City Council legislation whose title mentions Ballard (Legistar Web API)
  council_events    Seattle City Council meetings (Legistar), last 2 years and upcoming
"""
import datetime as dt
import hashlib
import json
import sys
import urllib.parse

from ..config import CENTER
from ..lake import Lake
from ..net import get_json


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def _hash(row):
    return hashlib.sha1(json.dumps(row, sort_keys=True, default=str).encode()).hexdigest()


def store(lake: Lake, name, key, rows, **manifest):
    """Store rows whose content changed since the current version; compact; record lineage."""
    rows = [dict(r, _hash=_hash(r)) for r in rows]
    current = lake.keys(name, key)
    keyf = (lambda r: tuple(str(r.get(k)) if r.get(k) is not None else None for k in key))
    new = [r for r in rows if (current.get(keyf(r)) or {}).get("_hash") != r["_hash"]]
    if new:
        lake.write_batch(name, new)
    n = lake.compact(name, key) if lake.batches(name) else 0
    lake.update_manifest(name, key=list(key), rows=n, stored_last_run=len(new),
                         last_run=dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), **manifest)
    log(f"  {name}: {len(rows)} rows, {len(new)} new/changed, {n} total")
    return len(new)


# --------------------------------------------------------------------------- weather
WX_VARS = ("temperature_2m", "apparent_temperature", "precipitation", "rain", "snowfall", "wind_speed_10m",
           "wind_direction_10m", "wind_gusts_10m", "cloud_cover", "relative_humidity_2m", "pressure_msl",
           "shortwave_radiation")


def weather_hourly(lake: Lake, start="2009-01-01", today=None):
    today = today or dt.date.today()
    done = lake.manifest().get("weather_hourly", {}).get("through")
    y0 = int((done or start)[:4])
    end = today - dt.timedelta(days=6)                 # the archive trails real time by ~5 days
    total = 0
    for y in range(y0, end.year + 1):
        a = max(dt.date(y, 1, 1), dt.date.fromisoformat(start))
        b = min(dt.date(y, 12, 31), end)
        j = get_json("https://archive-api.open-meteo.com/v1/archive", {
            "latitude": CENTER[0], "longitude": CENTER[1], "start_date": a.isoformat(), "end_date": b.isoformat(),
            "hourly": ",".join(WX_VARS), "timezone": "America/Los_Angeles", "temperature_unit": "fahrenheit",
            "wind_speed_unit": "mph", "precipitation_unit": "inch"}, timeout=120)
        h = j["hourly"]
        rows = [{"t": t, **{v: h[v][i] for v in WX_VARS}} for i, t in enumerate(h["time"])]
        total += store(lake, "weather_hourly", ("t",), rows, title="Hourly weather at NW Market St (Open-Meteo archive, ERA5-based)",
                       source="https://open-meteo.com/en/docs/historical-weather-api", topic="environment",
                       units={"temperature_2m": "°F", "precipitation": "in", "wind_speed_10m": "mph"}, through=b.isoformat())
    return total


# --------------------------------------------------------------------------- tides
def tides_hourly(lake: Lake, start_year=2009, today=None):
    today = today or dt.date.today()
    done = lake.manifest().get("tides_hourly", {}).get("through")
    y0 = int(done[:4]) if done else start_year
    total = 0
    for y in range(y0, today.year + 1):
        a, b = dt.date(y, 1, 1), min(dt.date(y, 12, 31), today)
        base = {"station": "9447130", "begin_date": a.strftime("%Y%m%d"), "end_date": b.strftime("%Y%m%d"), "datum": "MLLW",
                "units": "english", "time_zone": "lst_ldt", "format": "json", "application": "BallardObservatory"}
        obs = get_json("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter", {**base, "product": "hourly_height"}, timeout=120)
        pred = get_json("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter", {**base, "product": "predictions", "interval": "h"}, timeout=120)
        o = {d["t"]: d["v"] for d in obs.get("data", [])}
        p = {d["t"]: d["v"] for d in pred.get("predictions", [])}
        rows = []
        for t in sorted(set(o) | set(p)):
            ov = float(o[t]) if o.get(t) not in (None, "") else None
            pv = float(p[t]) if p.get(t) not in (None, "") else None
            rows.append({"t": t, "observed_ft": ov, "predicted_ft": pv, "surge_ft": round(ov - pv, 3) if ov is not None and pv is not None else None})
        total += store(lake, "tides_hourly", ("t",), rows, title="Seattle tide gauge 9447130: observed vs predicted (NOAA CO-OPS)",
                       source="https://tidesandcurrents.noaa.gov/stationhome.html?id=9447130", topic="environment",
                       through=b.isoformat())
    return total


# --------------------------------------------------------------------------- attention
ARTICLES = ("Ballard,_Seattle", "Hiram_M._Chittenden_Locks", "Golden_Gardens_Park", "Ballard_Bridge",
            "National_Nordic_Museum", "Shilshole_Bay_Marina")


def pageviews_daily(lake: Lake, today=None):
    today = today or dt.date.today()
    rows = []
    for a in ARTICLES:
        url = ("https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/"
               f"{urllib.parse.quote(a, safe='')}/daily/20150701/{today:%Y%m%d}")
        try:
            items = get_json(url).get("items", [])
        except Exception as e:                                   # noqa: BLE001
            log(f"  pageviews {a}: {e}")
            continue
        rows += [{"article": a, "d": f"{i['timestamp'][:4]}-{i['timestamp'][4:6]}-{i['timestamp'][6:8]}", "views": i["views"]} for i in items]
    return store(lake, "pageviews_daily", ("article", "d"), rows, title="Wikipedia daily pageviews for Ballard articles",
                 source="https://wikimedia.org/api/rest_v1/", topic="attention")


# --------------------------------------------------------------------------- council
LEGISTAR = "https://webapi.legistar.com/v1/seattle"


def council(lake: Lake, today=None):
    today = today or dt.date.today()
    matters = []
    for field in ("MatterTitle", "MatterName"):
        skip = 0
        while True:
            page = get_json(f"{LEGISTAR}/matters", {"$filter": f"substringof('Ballard', {field})", "$orderby": "MatterId", "$top": 1000, "$skip": skip})
            matters += page
            if len(page) < 1000:
                break
            skip += 1000
    seen, rows = set(), []
    for m in matters:
        if m["MatterId"] in seen:
            continue
        seen.add(m["MatterId"])
        rows.append({k: m.get(k) for k in ("MatterId", "MatterGuid", "MatterFile", "MatterName", "MatterTitle", "MatterTypeName", "MatterStatusName",
                                              "MatterBodyName", "MatterIntroDate", "MatterAgendaDate", "MatterPassedDate",
                                              "MatterEnactmentDate", "MatterEnactmentNumber", "MatterLastModifiedUtc")})
    n = store(lake, "council_matters", ("MatterId",), rows, title="Seattle City Council legislation mentioning Ballard (Legistar)",
              source="https://seattle.legistar.com/", topic="civic")
    since = (today - dt.timedelta(days=730)).isoformat()
    events = get_json(f"{LEGISTAR}/events", {"$filter": f"EventDate ge datetime'{since}'", "$orderby": "EventDate", "$top": 1000})
    erows = [{k: e.get(k) for k in ("EventId", "EventBodyName", "EventDate", "EventTime", "EventLocation", "EventAgendaFile",
                                      "EventMinutesFile", "EventInSiteURL", "EventVideoPath", "EventLastModifiedUtc")} for e in events]
    n += store(lake, "council_events", ("EventId",), erows, title="Seattle City Council meetings (Legistar)",
               source="https://seattle.legistar.com/Calendar.aspx", topic="civic")
    return n


ALL = {"weather_hourly": weather_hourly, "tides_hourly": tides_hourly, "pageviews_daily": pageviews_daily, "council": council}
