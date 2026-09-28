"""Run every engine over the lake and write the platform outputs to lake/_out/.

    python -m bo engines            (see bo/commands.py)

Outputs
  insights.json        ranked, evidence-backed findings (all engines)
  relations.json       every significant pairwise relationship (for the network view)
  hotspots.geojson     active emerging clusters with their cells
  series.json          daily values of every series (for charts), plus metadata
  places.json          development pipeline, openings, nuisance locations, restaurant inspections
  place_index.json     address search index
  catalog.json         datasets: source, rows, coverage, freshness, lineage, dropped fields
  run.json             run metadata and timings
"""
import datetime as dt
import hashlib
import json
import math
import time

import numpy as np

from .. import views
from ..config import OUT
from ..lake import Lake
from . import anomalies as an
from . import hotspots as hs
from . import knox
from . import places as pl
from . import relations as rel
from . import series as ser

EXOG = {"environment": 3, "attention": 1}
STEP = {"°F": (10, "10°F"), "in": (0.5, "half an inch"), "mph": (10, "10 mph"), "%": (25, "25 points"),
        "W/m²": (100, "100 W/m²"), "ft": (1, "1 ft"), "hPa": (10, "10 hPa"), "hours": (3, "3 hours")}


def _id(*parts):
    return hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()[:12]


def _fmt(x, nd=1):
    if x is None or (isinstance(x, float) and not math.isfinite(x)):
        return "–"
    if abs(x) >= 100:
        return f"{x:,.0f}"
    return f"{x:,.{nd}f}"


def _pfmt(p):
    return "<1e-12" if p < 1e-12 else f"{p:.1e}" if p < 1e-3 else f"{p:.3f}"


# ------------------------------------------------------------------ narration
POLICE_PHRASE = {"violence": "violence", "traffic_collision": "traffic collisions", "traffic_other": "other traffic problems",
                 "proactive": "officer-initiated activity", "burglary": "burglaries", "vehicle_theft": "vehicle thefts",
                 "theft": "thefts and property damage", "crisis_welfare": "crises and welfare checks", "disturbance": "disturbances",
                 "suspicious": "suspicious activity", "alarm": "alarms", "parking": "parking problems", "other": "other matters"}
CRIME_PHRASE = {"car_prowl": "car prowls", "vehicle_theft": "vehicle thefts", "burglary": "burglaries", "shoplifting": "shoplifting offenses",
                "larceny_other": "other thefts", "vandalism": "vandalism offenses", "assault": "assaults", "robbery": "robberies",
                "fraud": "fraud offenses", "trespass": "trespass offenses", "drugs": "drug offenses"}
FIRE_PHRASE = {"medical": "medical dispatches", "collision": "vehicle-collision dispatches", "fire": "fire dispatches",
               "alarm": "fire-alarm dispatches", "rescue_water": "rescue and water dispatches", "hazmat_utility": "hazmat and utility dispatches"}
FIXED = {"fire.medical": "medical dispatches", "fire.fire": "fire dispatches",
         "police.calls": "public-initiated police calls", "police.response_p1_min": "the median police response time to priority-1 calls",
         "police.response_p2_min": "the median police response time to priority-2 calls", "crime.all": "reported crimes",
         "fire.all": "fire and medical dispatches", "311.all": "311 service requests", "311.encampment": "encampment reports",
         "311.dumping": "illegal-dumping reports", "code.complaints": "building and land-use code complaints",
         "dev.permit_applications": "building-permit applications", "dev.units_permitted": "housing units in issued permits",
         "dev.land_use_applications": "land-use applications", "bikes.fremont": "bike and scooter crossings of the Fremont Bridge",
         "parking.payments": "parking-meter payments", "wx.temp_max": "the daily high temperature", "wx.temp_min": "the overnight low",
         "wx.precip": "rainfall", "wx.gust_max": "peak wind gusts", "wx.wind_mean": "average wind speed", "wx.cloud": "cloud cover",
         "wx.solar": "sunshine", "wx.humidity": "humidity", "wx.pressure": "air pressure", "wx.rain_hours": "hours of rain",
         "tide.high": "the high tide", "tide.low": "the low tide", "tide.surge": "storm surge",
         "attention.wiki_ballard": "Wikipedia views of the Ballard article", "attention.wiki_locks": "Wikipedia views of the Ballard Locks article",
         "attention.wiki_golden_gardens": "Wikipedia views of the Golden Gardens article"}


def phrase(name):
    if name in FIXED:
        return FIXED[name]
    if name == "police.proactive":
        return "officer-initiated police activity"
    fam, _, key = name.partition(".")
    if fam == "police":
        return f"police calls about {POLICE_PHRASE.get(key, key.replace('_', ' '))}"
    if fam == "crime":
        return f"reported {CRIME_PHRASE.get(key, key.replace('_', ' '))}"
    if fam == "fire":
        return FIRE_PHRASE.get(key, key.replace("_", " ") + " dispatches")
    if fam == "bridge":
        b, _, what = key.partition("_")
        return f"{b.title()} Bridge openings" if what == "openings" else f"minutes the {b.title()} Bridge is open"
    return name


def _cap(x):
    return x[:1].upper() + x[1:]


def relation_insight(t, meta, values):
    a, b, lag, r = t["a"], t["b"], t["lag"], t["r"]
    s_ab, s_ba = t.get("slope"), t.get("slope_ba")                # b per unit a, a per unit b
    sd = {a: t.get("sd_a"), b: t.get("sd_b")}
    ra, rb = EXOG.get(meta[a]["domain"], 0), EXOG.get(meta[b]["domain"], 0)
    driver, resp, slope = a, b, s_ab
    if rb > ra or (rb == ra and lag < 0):                       # the plausible driver, or the leader, comes first
        driver, resp, slope, lag = b, a, s_ba, -lag
    if lag < 0:                                                  # an exogenous driver can't lag its response
        lag = -lag
    md, mr = meta[driver], meta[resp]
    mean_r = float(np.nanmean(values[resp]))
    if md["unit"] in STEP and md["kind"] == "metric":
        step, step_txt = STEP[md["unit"]]
        cond = f"On days when {phrase(driver)} is {step_txt} higher than usual for the time of year"
    else:
        step = sd[driver] or 1.0
        cond = f"On days with {_fmt(step)} more {phrase(driver)} than usual (one standard deviation)"
    eff = (slope or 0.0) * step
    pct = 100 * eff / mean_r if mean_r else None
    when = "the same day" if lag == 0 else f"{lag} day{'s' if lag > 1 else ''} later"
    unit = mr["unit"].replace("/day", " a day")
    verb = "rise" if eff >= 0 else "fall"
    if mr["kind"] == "metric":
        body = f"{phrase(resp)} is {_fmt(abs(eff), 2)} {mr['unit']} {'higher' if eff >= 0 else 'lower'}"
    else:
        body = f"{phrase(resp)} {verb} by {_fmt(abs(eff), 2)} {unit}"
    stmt = f"{cond}, {body} ({'+' if eff >= 0 else '−'}{_fmt(abs(pct or 0))} % of the daily average) {when}."
    conf = "high" if (t["replicated"] and t["q"] < 1e-4) else "medium" if t["replicated"] else "low"
    caveat = None
    if t.get("weather_explained"):
        caveat = f"Weather accounts for most of this association (partial r {_fmt(t['partial_r'], 3)} after removing temperature, rain, cloud and holidays)."
    elif t.get("known_mechanism"):
        caveat = "Expected mechanism (weather changes how many people are outdoors); kept as a calibration check."
    return {
        "id": _id("rel", driver, resp, lag), "type": "relationship",
        "title": f"{_cap(phrase(driver))} → {phrase(resp)}",
        "statement": _cap(stmt),
        "metrics": {"r": r, "lag_days": lag, "effect": eff, "effect_pct": pct, "partial_r": t.get("partial_r"), "halves": t.get("halves")},
        "confidence": conf,
        "evidence": {"test": "lagged cross-correlation of deseasonalized, winsorized residuals; circular-shift null; BH-FDR",
                     "p": t["p"], "q": t["q"], "n_days": t["overlap"], "replicated": t["replicated"],
                     "period": [t["first"], t["last"]], "sigma_null": t.get("sigma")},
        "caveat": caveat, "series": [driver, resp], "domains": sorted({md["domain"], mr["domain"]}),
        "sources": sorted(set(md["src"]) | set(mr["src"])), "known_mechanism": bool(t.get("known_mechanism")),
        "score": t["score"] * (1.5 if t["cross_domain"] else 1.0) * (0.5 if t.get("weather_explained") else 1.0),
    }


def anomaly_insight(a, meta):
    m = meta[a["series"]]
    pct = 100 * (a["ratio"] - 1)
    stmt = (f"{int(a['observed'])} {phrase(a['series'])} in the {a['window_days']} days to {a['end']}, versus "
            f"{_fmt(a['expected'])} expected for those dates ({'+' if pct >= 0 else '−'}{_fmt(abs(pct), 0)} %)"
            + (", after allowing for offenses not yet reported" if a.get("nowcast") else "") + ".")
    return {"id": _id("anom", a["series"], a["window_days"], a["end"]), "type": "anomaly",
            "title": f"{_cap(phrase(a['series']))} {'above' if pct > 0 else 'below'} expected ({a['window_days']} days)",
            "statement": stmt, "metrics": {"observed": a["observed"], "expected": a["expected"], "ratio": a["ratio"], "dispersion": a["phi"]},
            "caveat": ("A near-total drop like this usually means a reporting outage, a data-feed change or a physical closure; "
                       "check the source before acting on it.") if (a["ratio"] is not None and a["ratio"] < 0.15) else None,
            "confidence": "high" if a["q"] < 1e-3 else "medium",
            "evidence": {"test": "quasi-Poisson model of the prior 3 years (weekday, season, trend), overdispersion-adjusted tail, BH-FDR",
                         "p": a["p"], "q": a["q"], "period": [a["start"], a["end"]]},
            "series": [a["series"]], "domains": [m["domain"]], "sources": m["src"],
            "score": abs(math.log(max(a["ratio"], 1e-6))) * -math.log10(max(a["q"], 1e-300)) * 1.2}


def change_insight(c, meta, total_change=None):
    m = meta[c["series"]]
    unit = "a month" if m["kind"] == "count" else m["unit"]
    stmt = (f"{_cap(phrase(c['series']))} shifted from {_fmt(c['before'])} to {_fmt(c['after'])} {unit} "
            f"({'+' if c['relative'] >= 0 else '−'}{_fmt(abs(100 * c['relative']), 0)} %), starting around {c['since']}, "
            f"after adjusting for month-of-year effects.")
    caveat = None
    if total_change is not None and abs(total_change) < 0.3 * abs(c["relative"]):
        caveat = (f"The overall total changed only {'+' if total_change >= 0 else '−'}{_fmt(abs(100 * total_change), 0)} % over the same split, "
                  "so part of this shift may reflect how incidents are categorized or responded to (policy or coding changes), "
                  "not only how often they occur.")
    return {"id": _id("chg", c["series"], c["since"]), "type": "change", "caveat": caveat,
            "title": f"{_cap(phrase(c['series']))}: sustained {'increase' if c['relative'] > 0 else 'decrease'} since {c['since']}",
            "statement": stmt, "metrics": {k: c[k] for k in ("before", "after", "relative", "months_after")},
            "confidence": "high" if c["p"] <= 0.002 else "medium",
            "evidence": {"test": "single change-point in level (monthly, deseasonalized), block-permutation null", "p": c["p"],
                         "period": [c["since"], None]},
            "series": [c["series"]], "domains": [m["domain"]], "sources": m["src"],
            "score": abs(c["relative"]) * -math.log10(c["p"]) * 1.1}


# ------------------------------------------------------------------ hotspot and interaction kinds
def event_sets(con):
    """Kinds for hotspot scans and space-time tests: (key, label, SQL condition on the events view)."""
    police = " ".join(f"WHEN regexp_matches(upper(subkind), '{rx}') THEN '{g}'" for g, rx in ser.POLICE_GROUPS)
    kinds = [
        ("crime.car_prowl", "Car prowls", "kind = 'crime' AND detail = 'Theft From Motor Vehicle'"),
        ("crime.burglary", "Burglaries", "kind = 'crime' AND subkind LIKE 'BURGLARY%'"),
        ("crime.vehicle_theft", "Vehicle thefts", "kind = 'crime' AND subkind = 'MOTOR VEHICLE THEFT'"),
        ("crime.vandalism", "Vandalism", "kind = 'crime' AND subkind LIKE 'DESTRUCTION%'"),
        ("crime.assault", "Assaults", "kind = 'crime' AND subkind = 'ASSAULT OFFENSES'"),
        ("crime.shoplifting", "Shoplifting", "kind = 'crime' AND detail = 'Shoplifting'"),
        ("311.dumping", "Illegal dumping reports", "kind = 'illegal_dumping'"),
        ("311.encampment", "Encampment reports", "kind = 'encampment_report'"),
        ("code.complaints", "Code complaints", "kind = 'code_complaint'"),
        ("fire.medical", "Medical 911 dispatches", "kind = 'fire_ems' AND regexp_matches(upper(subkind), '^(AID|MEDIC|TRIAGED|LOW ACUITY)')"),
        ("fire.fire", "Fire dispatches", "kind = 'fire_ems' AND regexp_matches(upper(subkind), 'FIRE|SMOKE|RUBBISH|BRUSH') AND NOT regexp_matches(upper(subkind), 'ALARM')"),
    ]
    for g in ("violence", "disturbance", "suspicious", "crisis_welfare", "theft", "traffic_collision"):
        kinds.append((f"police.{g}", f"Police calls: {g.replace('_', ' ')}", f"kind = 'police_call' AND (CASE {police} ELSE 'other' END) = '{g}'"))
    return kinds


CASCADES = [("311.encampment", "311.dumping", 150, 14), ("311.dumping", "311.encampment", 150, 14),
            ("crime.vehicle_theft", "crime.car_prowl", 200, 7), ("crime.car_prowl", "crime.vehicle_theft", 200, 7),
            ("crime.burglary", "crime.car_prowl", 200, 7), ("police.disturbance", "police.violence", 150, 3),
            ("311.encampment", "fire.fire", 150, 14), ("311.encampment", "police.crisis_welfare", 150, 7),
            ("police.suspicious", "crime.burglary", 200, 7), ("police.suspicious", "crime.car_prowl", 200, 7),
            ("code.complaints", "311.dumping", 100, 30), ("fire.fire", "311.encampment", 150, 14),
            ("crime.vandalism", "crime.burglary", 200, 7), ("police.violence", "fire.medical", 100, 1)]


SINGULAR = {"crime.car_prowl": "a car prowl", "crime.burglary": "a burglary", "crime.vehicle_theft": "a vehicle theft",
            "crime.vandalism": "an act of vandalism", "crime.assault": "an assault", "crime.shoplifting": "a shoplifting offense",
            "311.dumping": "an illegal-dumping report", "311.encampment": "an encampment report", "code.complaints": "a code complaint",
            "fire.medical": "a medical 911 dispatch", "fire.fire": "a fire dispatch"}


def singular(key):
    if key in SINGULAR:
        return SINGULAR[key]
    if key.startswith("police."):
        return f"a police call about {POLICE_PHRASE.get(key.split('.', 1)[1], key)}"
    return key


def _short_addr(a):
    """'6011 24TH AVE NW, SEATTLE, WA 98107' -> '6011 24th Ave NW'; '22XX BLOCK OF NW MARKET ST' -> 'the 2200 block of NW Market St'."""
    import re
    if not a:
        return None
    a = a.split(",")[0].strip()
    m = re.match(r"^(\d+)X+ BLOCK OF (.+)$", a.upper())
    block = None
    if m:
        block, a = m.group(1), m.group(2)
    a = a.title()
    a = re.sub(r"\b(Nw|Ne|Sw|Se)\b", lambda x: x.group(1).upper(), a)
    a = re.sub(r"\b(\d+)(St|Nd|Rd|Th)\b", lambda x: x.group(1) + x.group(2).lower(), a)
    a = a.replace(" / ", " & ")
    return f"the {block}00 block of {a}" if block else a


KIND_SOURCES = {"crime": ["spd_crime"], "police": ["spd_calls"], "fire": ["sfd_911"], "311.dumping": ["illegal_dumping"],
                "311.encampment": ["encampment_reports"], "code": ["code_complaints"], "dev": ["building_permits"]}


def kind_sources(*keys):
    out = set()
    for k in keys:
        out.update(KIND_SOURCES.get(k) or KIND_SOURCES.get(k.split(".")[0]) or [])
    return sorted(out)


# ------------------------------------------------------------------ plain language (consumer app)
NOUN = {"crime.car_prowl": "car prowls", "crime.burglary": "burglaries", "crime.vehicle_theft": "car thefts", "crime.vandalism": "vandalism",
        "crime.assault": "assaults", "crime.shoplifting": "shoplifting", "crime.robbery": "robberies", "crime.larceny_other": "thefts",
        "crime.all": "reported crimes", "crime.fraud": "fraud reports", "crime.trespass": "trespass reports", "crime.drugs": "drug offenses",
        "311.dumping": "illegal dumping", "311.encampment": "encampment reports", "311.all": "311 requests", "code.complaints": "code complaints",
        "fire.medical": "medical emergencies", "fire.fire": "fire calls", "fire.all": "911 fire & medical calls", "fire.collision": "crash responses",
        "fire.alarm": "fire alarms", "fire.rescue_water": "rescue calls", "fire.hazmat_utility": "gas and hazard calls",
        "police.calls": "police calls", "police.disturbance": "disturbance calls", "police.theft": "theft calls", "police.violence": "violence calls",
        "police.suspicious": "suspicious-activity calls", "police.crisis_welfare": "crisis and welfare calls", "police.traffic_collision": "crash calls",
        "police.traffic_other": "traffic calls", "police.burglary": "burglary calls", "police.vehicle_theft": "car-theft calls", "police.alarm": "alarm calls",
        "police.parking": "parking complaints", "police.proactive": "officer-initiated stops and checks",
        "police.response_p1_min": "police response time to emergencies", "police.response_p2_min": "police response time to urgent calls",
        "bikes.fremont": "bike trips over the Fremont Bridge", "parking.payments": "parking-meter payments",
        "dev.permit_applications": "building-permit applications", "dev.units_permitted": "new homes permitted", "dev.land_use_applications": "land-use applications",
        "attention.wiki_ballard": "online interest in Ballard", "attention.wiki_locks": "online interest in the Locks", "attention.wiki_golden_gardens": "online interest in Golden Gardens"}
DRIVER = {"wx.temp_max": ("hot days", "hotter"), "wx.temp_min": ("warm nights", "warmer"), "wx.precip": ("rainy days", "rainier"),
          "wx.rain_hours": ("rainy days", "rainier"), "wx.solar": ("sunny days", "sunnier"), "wx.cloud": ("cloudy days", "cloudier"),
          "wx.wind_mean": ("windy days", "windier"), "wx.gust_max": ("gusty days", "gustier"), "wx.humidity": ("humid days", "more humid"),
          "wx.pressure": ("settled, high-pressure days", "higher-pressure"), "tide.surge": ("storm-surge days", "surgier"),
          "tide.high": ("high-tide days", "higher-tide"), "tide.low": ("low-tide days", "lower-tide")}
CATEGORY = {"crime": "safety", "police": "safety", "fire": "safety", "311": "neighborhood", "code": "neighborhood", "dev": "building",
            "bridge": "getting-around", "bikes": "getting-around", "parking": "getting-around", "wx": "weather", "tide": "weather", "attention": "community"}


UNCOUNTABLE = {"illegal dumping", "vandalism", "shoplifting", "online interest in Ballard", "online interest in the Locks",
               "online interest in Golden Gardens", "police response time to emergencies", "police response time to urgent calls"}


def verb(n, plural_form, singular_form):
    return singular_form if n in UNCOUNTABLE else plural_form


def noun(key):
    if key in NOUN:
        return NOUN[key]
    fam, _, k = key.partition(".")
    if fam == "bridge":
        b, _, what = k.partition("_")
        return f"{b.title()} Bridge openings" if what == "openings" else f"time the {b.title()} Bridge spends open"
    return phrase(key)


def _month(iso):
    import calendar
    try:
        y, m = iso[:7].split("-")
        return f"{calendar.month_name[int(m)]} {y}"
    except Exception:          # noqa: BLE001
        return iso


def plain_for(i):
    t, m, ev = i["type"], i.get("metrics") or {}, i.get("evidence") or {}
    series = i.get("series") or []
    key = i.get("_key") or (series[0] if series else "")
    cat = CATEGORY.get(key.split(".")[0], "neighborhood")
    out = {"category": cat}
    if t == "hotspot":
        where = i.get("_near") or "a small area of Ballard"
        n = noun(key)
        out.update(headline=f"{_cap(n)} up near {where}",
                   summary=f"{m['observed']} in the last {m['window_days']} days, where about {max(1, round(m['expected']))} would be normal.",
                   sure=f"A cluster this strong turns up by chance only about once every {round(ev.get('recurrence_days') or 20)} days.",
                   lat=(i.get("scope") or {}).get("lat"), lon=(i.get("scope") or {}).get("lon"), relevance=100 + i["score"])
    elif t == "anomaly":
        n = noun(key)
        up = (m.get("ratio") or 1) > 1
        pct = abs(100 * ((m.get("ratio") or 1) - 1))
        span = "this week" if "7 days" in i["title"] else "this month"
        if (m.get("ratio") or 1) < 0.15:
            out.update(headline=f"Possible reporting gap: {n}", summary=f"Almost none recorded {span}, far below normal. This usually means a data outage or a closure.",
                       sure="Flagged automatically; check the source before relying on it.", relevance=20)
        else:
            out.update(headline=f"{_cap(n)} {'up' if up else 'down'} {pct:.0f}% {span}",
                       summary=f"{int(m['observed'])} in the last {7 if 'week' in span else 28} days, versus about {round(m['expected'])} expected for this time of year.",
                       sure="Well outside the normal range, checked against three years of history.", relevance=85 + i["score"])
    elif t == "change":
        n = noun(key)
        rel = m.get("relative") or 0
        since = _month((ev.get("period") or [""])[0] or "")
        verb = ("doubled" if rel >= 0.95 else f"up {abs(rel) * 100:.0f}%") if rel > 0 else f"down {abs(rel) * 100:.0f}%"
        out.update(headline=f"{_cap(n)} {verb} since {since}", summary=f"From about {_fmt(m.get('before'))} to {_fmt(m.get('after'))} a month.",
                   sure="A lasting shift, not a blip: tested against five years of month-to-month variation." + (" It may partly reflect a change in how these calls are handled." if i.get("caveat") else ""),
                   relevance=60 + i["score"])
    elif t == "near_repeat":
        n = noun(i.get("_key") or "")
        out.update(headline=f"{_cap(n)} {verb(n, 'tend', 'tends')} to cluster", summary=f"After one, another within {m['d_m']} m over the next {m['t_days']} days is {m['ratio']:.1f}× as likely as chance.",
                   sure="Seen consistently across three years of reports.", relevance=55 + i["score"])
    elif t == "cascade":
        a, b = i.get("_key"), i.get("_key_b")
        out.update(headline=f"{_cap(noun(a))} {verb(noun(a), 'are', 'is')} often followed by {noun(b)}",
                   summary=f"Within {m['d_m']} m and {m['t_days']} days, {noun(b)} {verb(noun(b), 'are', 'is')} {m['ratio']:.1f}× as frequent as chance.",
                   sure="Seen consistently across three years of reports.", relevance=40 + i["score"])
    elif t == "relationship" and len(series) == 2:
        d, r = series
        eff, pct = m.get("effect") or 0, m.get("effect_pct") or 0
        if d in DRIVER:
            head = f"{_cap(DRIVER[d][0])} bring {'more' if eff > 0 else 'fewer'} {noun(r)}"
        else:
            head = f"More {noun(d)}, {'more' if eff > 0 else 'fewer'} {noun(r)}"
        cat = CATEGORY.get(r.split(".")[0], cat)
        h = m.get("halves") or []
        out.update(category=cat, headline=head, summary=i["statement"],
                   sure=("Holds independently in both halves of " + (ev.get("period") or ["", ""])[0][:4] + "–" + (ev.get("period") or ["", ""])[1][:4] + "." if len(h) == 2 and i.get("confidence") == "high" else "Statistically solid, but check the details."),
                   relevance=(15 if i.get("known_mechanism") else 30) + i["score"])
    return out


def run(out_dir=OUT, log=print):
    t_start = time.time()
    timings = {}
    out_dir.mkdir(parents=True, exist_ok=True)
    con = views.connect()
    t0 = time.time()
    dates, values, meta = ser.build_daily(con, start="2010-01-01")
    timings["series"] = time.time() - t0
    log(f"series: {len(values)} daily series ({timings['series']:.1f}s)")

    insights = []
    # relationships
    t0 = time.time()
    relations, n_tested = rel.discover(dates, values, meta)
    timings["relations"] = time.time() - t0
    log(f"relations: {n_tested} pairs tested, {len(relations)} significant ({timings['relations']:.1f}s)")
    insights += [relation_insight(t, meta, values) for t in relations]
    # anomalies and changes
    t0 = time.time()
    delay_cdf, asof = {}, None
    if "spd_crime" in con.present:
        rows = con.execute("""SELECT datediff('day', t, t_reported) AS k, count(*) FROM spd_crime
                              WHERE t >= (SELECT max(t) FROM spd_crime) - INTERVAL 730 DAY AND t_reported >= t
                              GROUP BY 1 ORDER BY 1""").fetchall()
        if rows:
            counts = np.zeros(366)
            for k, n in rows:
                counts[min(int(k), 365)] += n
            delay_cdf["crime."] = np.cumsum(counts) / counts.sum()
            # each crime group has its own reporting delay (car prowls are often reported online, days later)
            for g, cond in ser.CRIME_GROUPS:
                rows_g = con.execute(f"""SELECT datediff('day', t, t_reported) AS k, count(*) FROM spd_crime
                                         WHERE t >= (SELECT max(t) FROM spd_crime) - INTERVAL 730 DAY AND t_reported >= t AND ({cond})
                                         GROUP BY 1""").fetchall()
                cg = np.zeros(366)
                for k, n in rows_g:
                    cg[min(int(k), 365)] += n
                if cg.sum() >= 200:
                    delay_cdf[f"crime.{g}"] = np.cumsum(cg) / cg.sum()
            asof = np.datetime64(str(con.execute("SELECT max(CAST(t_reported AS DATE)) FROM spd_crime").fetchone()[0]))
    anoms = an.anomalies(dates, values, meta, delay_cdf=delay_cdf, asof=asof)
    chg = an.changes(dates, values, meta)
    timings["anomalies_changes"] = time.time() - t0
    log(f"anomalies: {len(anoms)}, changes: {len(chg)} ({timings['anomalies_changes']:.1f}s)")
    totals = {"police": "police.calls", "crime": "crime.all", "fire": "fire.all", "311": "311.all"}

    def total_change(c):
        fam = c["series"].split(".")[0]
        tot = totals.get(fam)
        if not tot or tot == c["series"] or tot not in values:
            return None
        um, mv = an._monthly(dates, values[tot], "count")
        keep = np.isfinite(mv)
        um, mv = um[keep], mv[keep]
        split = np.datetime64(c["since"])
        before = mv[(um < split) & (um >= split - np.timedelta64(c["months_before"], "M"))]
        after = mv[um >= split]
        return (after.mean() - before.mean()) / before.mean() if len(before) and len(after) and before.mean() else None

    insights += [anomaly_insight(a, meta) for a in anoms] + [change_insight(c, meta, total_change(c)) for c in chg]

    # hotspots
    import h3
    t0 = time.time()
    features = []
    kinds = event_sets(con)
    for key, label, cond in kinds:
        last = con.execute(f"SELECT max(CAST(t AS DATE)) FROM events WHERE {cond}").fetchone()[0]
        if last is None:
            continue
        rows = con.execute(f"SELECT h3_9, datediff('day', CAST(t AS DATE), DATE '{last}') FROM events WHERE {cond} AND h3_9 IS NOT NULL "
                           f"AND CAST(t AS DATE) BETWEEN DATE '{last}' - INTERVAL 364 DAY AND DATE '{last}'").fetchall()
        if len(rows) < 100:
            continue
        cells = np.array([r[0] for r in rows], dtype=object)
        days = 10000 - np.array([r[1] for r in rows], int)
        for c in hs.scan(cells, days, 10000, h3, n_rep=199):
            lat, lon = h3.cell_to_latlng(c["center"])
            shape = h3.cells_to_geo(c["cells"])
            addr = con.execute(f"SELECT address FROM events WHERE {cond} AND h3_9 IN ({','.join(repr(x) for x in c['cells'])}) "
                               f"AND address IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1").fetchone()
            if not addr:
                addr = con.execute(f"SELECT address FROM events WHERE h3_9 IN ({','.join(repr(x) for x in c['cells'])}) "
                                   f"AND address IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1").fetchone()
            near = addr[0] if addr else None
            iid = _id("hot", key, c["center"], c["window_days"], last)
            features.append({"type": "Feature", "geometry": shape,
                             "properties": {"id": iid, "kind": key, "label": label, "center": [lat, lon], "near": near, "as_of": str(last), **c}})
            near_txt = _short_addr(near)
            label = phrase(key)
            insights.append({
                "_key": key, "_near": near_txt,
                "id": iid, "type": "hotspot", "title": f"Emerging cluster: {label.lower()}{f' near {near_txt}' if near_txt else ''}",
                "statement": (f"{c['observed']} {label.lower()} within about {[175, 500, 850][c['k']]} m in the {c['window_days']} days to {last}, "
                              f"versus {_fmt(c['expected'])} expected given this area's usual share of Ballard's {label.lower()} and the pace "
                              f"across Ballard in those days (relative risk {_fmt(c['relative_risk'])})."),
                "metrics": {"observed": c["observed"], "expected": c["expected"], "relative_risk": c["relative_risk"], "window_days": c["window_days"]},
                "confidence": "high" if c["p"] <= 0.01 else "medium",
                "evidence": {"test": "prospective space-time permutation scan (Kulldorff 2005), 199 Monte Carlo replicates",
                             "p": c["p"], "recurrence_days": c["recurrence_days"], "period": [None, str(last)]},
                "scope": {"lat": lat, "lon": lon, "cells": c["cells"]}, "series": [], "domains": ["safety" if key.startswith(("crime", "police", "fire")) else "quality-of-life"],
                "sources": kind_sources(key), "score": math.log(max(c["relative_risk"] or 1, 1)) * -math.log10(c["p"]) * 1.4})
    timings["hotspots"] = time.time() - t0
    log(f"hotspots: {len(features)} clusters ({timings['hotspots']:.1f}s)")

    # density: events per H3 cell over the last 90 days, by kind (for the 3D density columns)
    dens = []
    for key, label, cond in kinds + [("dev.building_permits", "Building permits", "kind = 'building_permit'")]:
        rows = con.execute(f"""SELECT h3_9, count(*) FROM events WHERE {cond} AND h3_9 IS NOT NULL
                               AND t >= (SELECT max(t) FROM events WHERE {cond}) - INTERVAL 90 DAY GROUP BY 1""").fetchall()
        if not rows:
            continue
        mx = max(n for _, n in rows)
        for cell, n in rows:
            ring = [[lon, lat] for lat, lon in h3.cell_to_boundary(cell)]
            ring.append(ring[0])
            dens.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [ring]},
                         "properties": {"kind": key, "label": phrase(key) if key != "dev.building_permits" else "building permits", "n": n,
                                        "per_week": round(n / 90 * 7, 2), "z": round((n / mx) ** 0.6, 3)}})
    (out_dir / "density.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": dens}, separators=(",", ":")))

    # space-time interaction: near-repeats and cascades
    t0 = time.time()
    maxd = con.execute("SELECT max(CAST(t AS DATE)) FROM events WHERE kind IN ('crime','illegal_dumping','encampment_report')").fetchone()[0]
    cache = {}

    def load(key):
        if key not in cache:
            cond = dict((k, c) for k, _, c in kinds)[key]
            rows = con.execute(f"SELECT lat, lon, datediff('day', DATE '2000-01-01', CAST(t AS DATE)) FROM events WHERE {cond} "
                               f"AND lat IS NOT NULL AND t >= DATE '{maxd}' - INTERVAL 1095 DAY").fetchall()
            arr = np.array(rows, dtype=float)
            cache[key] = {"lat": arr[:, 0], "lon": arr[:, 1], "day": arr[:, 2].astype(int)} if len(arr) >= 30 else None
        return cache[key]

    labels = {k: phrase(k) for k, _, _ in kinds}
    tests = []
    qol = ("311.", "code.")
    for key in labels:
        A = load(key)
        # complaints: exclude same-spot repeats (the same problem reported again), measure spread to neighbors
        r = (knox.interaction(A, None, d_m=150, t_days=7, d_min_m=30, dup_days=10 ** 6 if key.startswith(qol) else 2)
             if A else None)
        if r:
            tests.append(("near_repeat", key, key, r))
    for ka, kb, d, t in CASCADES:
        A, B = load(ka), load(kb)
        r = knox.interaction(A, B, d_m=d, t_days=t) if (A and B) else None
        if r:
            tests.append(("cascade", ka, kb, r))
    from .stats import bh
    q = bh([x[3]["p"] for x in tests]) if tests else []
    interactions = []
    for (typ, ka, kb, r), qq in zip(tests, q):
        r["q"] = float(qq)
        interactions.append({"type": typ, "a": ka, "b": kb, **r})
        if qq > 0.01 or (r["ratio"] or 0) < 1.1:
            continue
        if typ == "near_repeat":
            title = f"Near-repeat pattern: {labels[ka]}"
            where = " at a different address" if ka.startswith(qol) else ""
            stmt = (f"After {singular(ka)} in Ballard, another{where} within {r['d_m']} m in the next {r['t_days']} days is "
                    f"{_fmt(r['ratio'], 2)}× as likely as chance ({r['observed']:,} such pairs vs {_fmt(r['expected'])} expected, last 3 years).")
        else:
            title = f"Cascade: {labels[ka]} → {labels[kb]}"
            stmt = (f"Within {r['d_m']} m and {r['t_days']} days after {singular(ka)}, {labels[kb]} are "
                    f"{_fmt(r['ratio'], 2)}× as frequent as chance ({r['observed']:,} pairs vs {_fmt(r['expected'])} expected, last 3 years).")
        insights.append({"_key": ka, "_key_b": kb, "id": _id(typ, ka, kb), "type": typ, "title": title, "statement": stmt,
                         "metrics": {"ratio": r["ratio"], "observed": r["observed"], "expected": r["expected"], "d_m": r["d_m"], "t_days": r["t_days"]},
                         "confidence": "high" if qq < 1e-4 else "medium",
                         "evidence": {"test": "Knox space-time interaction, 199 date permutations (locations fixed), BH-FDR",
                                      "p": r["p"], "q": r["q"], "z": r.get("z"), "n": [r["n_a"], r["n_b"]]},
                         "series": [], "domains": sorted({"safety" if k.startswith(("crime", "police", "fire")) else "quality-of-life" for k in (ka, kb)}),
                         "sources": kind_sources(ka, kb),
                         "score": math.log(r["ratio"]) * min(-math.log10(max(qq, 1e-300)), 40) * 1.3})
    timings["interactions"] = time.time() - t0
    log(f"space-time tests: {len(tests)} ({timings['interactions']:.1f}s)")

    # places
    t0 = time.time()
    places = {"pipeline": pl.pipeline(con), "openings": pl.openings(con), "nuisance": pl.nuisance(con), "restaurants": pl.restaurants(con)}
    index = pl.place_index(con)
    n_places = pl.place_records(con, out_dir)
    log(f"places: {n_places} address dossiers")
    timings["places"] = time.time() - t0

    insights.sort(key=lambda x: -x["score"])
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    for i in insights:
        i["generated"] = now
        try:
            i["plain"] = plain_for(i)
        except Exception as e:                                   # noqa: BLE001
            log(f"plain language failed for {i['id']}: {e}")
        i.pop("_key", None), i.pop("_key_b", None), i.pop("_near", None)
    lake = Lake()
    manifest = lake.manifest()
    catalog = [{"name": k, **v} for k, v in sorted(manifest.items())]

    def dump(name, obj):
        (out_dir / name).write_text(json.dumps(obj, default=_json_default, separators=(",", ":")))

    dump("insights.json", {"generated": now, "count": len(insights), "insights": insights})
    dump("relations.json", {"generated": now, "tested": n_tested, "relations": relations})
    conc = []
    for a_, b_ in [tuple(sorted(p)) for p in rel.CONCORDANT]:
        if a_ in values and b_ in values:
            ra_, _ = rel.residuals(dates, values[a_], meta[a_]["kind"], rel.us_holidays(dates))
            rb_, _ = rel.residuals(dates, values[b_], meta[b_]["kind"], rel.us_holidays(dates))
            ok = np.isfinite(ra_) & np.isfinite(rb_)
            if ok.sum() > 365:
                conc.append({"a": a_, "b": b_, "r_same_day": float(np.corrcoef(ra_[ok], rb_[ok])[0, 1]), "n_days": int(ok.sum())})
    dump("concordance.json", {"generated": now, "note": "Same incidents recorded by two agencies or systems: a data-quality check, not findings.",
                              "pairs": sorted(conc, key=lambda x: -x["r_same_day"])})
    dump("interactions.json", {"generated": now, "tests": interactions})
    dump("hotspots.geojson", {"type": "FeatureCollection", "generated": now, "features": features})
    dump("series.json", {"generated": now, "start": str(dates[0]), "end": str(dates[-1]),
                         "meta": meta, "values": {k: [None if not math.isfinite(x) else round(float(x), 3) for x in v] for k, v in values.items()}})
    dump("places.json", {"generated": now, **places})
    civic = {"generated": now, "matters": [], "meetings": []}
    if "council_matters" in con.present:
        civic["matters"] = [dict(zip(("id", "guid", "file", "title", "type", "status", "body", "introduced", "passed"), r)) for r in con.execute("""
            SELECT id, guid, file, title, type, status, body, CAST(t AS DATE), CAST(t_passed AS DATE) FROM council_matters
            WHERE t >= now() - INTERVAL 36 MONTH ORDER BY t DESC LIMIT 40""").fetchall()]
    if "council_events" in con.present:
        civic["meetings"] = [dict(zip(("id", "body", "date", "time", "location", "agenda_url", "url"), r)) for r in con.execute("""
            SELECT id, body, CAST(t AS DATE), time_text, location, agenda_url, url FROM council_events
            WHERE t >= current_date AND t < current_date + INTERVAL 30 DAY ORDER BY t LIMIT 30""").fetchall()]
    dump("civic.json", civic)
    dump("place_index.json", {"generated": now, "cols": ["addr_key", "address", "lat", "lon", "records", "sources", "srcs", "last_t", "names"], "rows": index})
    dump("catalog.json", {"generated": now, "datasets": catalog})
    timings["total"] = time.time() - t_start
    dump("run.json", {"generated": now, "timings": timings, "insights": len(insights), "series": len(values),
                      "pairs_tested": n_tested, "hotspots": len(features), "space_time_tests": len(tests)})
    log(f"done: {len(insights)} insights in {timings['total']:.0f}s -> {out_dir}")
    return insights


def _json_default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if not math.isfinite(o) else float(o)
    if isinstance(o, (dt.date, dt.datetime)):
        return o.isoformat()
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (set, tuple)):
        return list(o)
    return str(o)
