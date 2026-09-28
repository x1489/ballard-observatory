"""The series matrix: every measurable stream about Ballard as an aligned daily (and hourly) time series.

Each series has a name, a domain, a kind ('count' or 'metric'), a unit, the datasets it comes from, and an
availability window. Outside that window values are NaN (unknown), never 0.
"""
import datetime as dt

import numpy as np

# Order matters (first match wins), and the patterns are RE2 (no lookaheads): officer-initiated activity is
# matched first so that "TRAFFIC STOP - OFFICER INITIATED" counts as proactive, not as a traffic incident.
POLICE_GROUPS = [
    ("proactive", r"OFFICER INITIATED|ONVIEW ONLY|DIRECTED PATROL|OFF DUTY|PREMISE CHECK|FOLLOW UP"),
    ("alarm", r"ALARM"),
    ("violence", r"ASLT|ASSAULT|THREAT|SHOOT|SHOTS|WEAPON|ROBB|DV |- DV|FIGHT - IP|HOMICIDE|STAB|KIDNAP"),
    ("traffic_collision", r"MVC|HIT AND RUN|COLLISION"),
    ("traffic_other", r"TRAFFIC|BLOCKING ROADWAY|DUI|RECKLESS"),
    ("burglary", r"BURG"),
    ("vehicle_theft", r"AUTO THEFT|AUTO RECOVERY|VEH THEFT|CAR PROWL|PROWL"),
    ("theft", r"THEFT|SHOPLIFT|FRAUD|FORGERY|PROPERTY - DAMAGE|VANDAL|GRAFFITI"),
    ("crisis_welfare", r"WELFARE|CRISIS|SUICIDE|PERSON DOWN|DOWN - CHECK|OVERDOSE|MISSING|HAZ - POTENTIAL"),
    ("disturbance", r"DISTURBANCE|NOISE|FIGHT|DISORDERLY|NUISANCE|TRESPASS|NARCOTICS|LIQUOR|PARTY"),
    ("suspicious", r"SUSPICIOUS|PROWLER"),
    ("parking", r"PARKING|ABANDONED"),
]

SFD_GROUPS = [
    ("medical", r"^(AID|MEDIC|TRANS TO AMR|LOW ACUITY|TRIAGED|SINGLE MEDIC|MULTIPLE MEDIC|AUTOMATIC MEDICAL|NURSELINE|BLS|ALS)"),
    ("collision", r"MOTOR VEHICLE|MVI|MVA|CAR ACCIDENT|VEHICLE ACCIDENT"),
    ("alarm", r"ALARM"),
    ("fire", r"FIRE|SMOKE|RUBBISH|BRUSH|BARK|ILLEGAL BURN|EXPLOSION"),
    ("rescue_water", r"RESCUE|WATER|MARINE|BOAT|DIVE|DROWN"),
    ("hazmat_utility", r"HAZ|GAS|ODOR|WIRES|ELECTRICAL|CO DETECTOR|CARBON MONOXIDE|SPILL"),
]

CRIME_GROUPS = [
    ("car_prowl", "offense = 'Theft From Motor Vehicle'"),
    ("vehicle_theft", "sub_category = 'MOTOR VEHICLE THEFT' OR offense = 'Motor Vehicle Theft'"),
    ("burglary", "sub_category LIKE 'BURGLARY%'"),
    ("shoplifting", "offense = 'Shoplifting'"),
    ("larceny_other", "sub_category = 'LARCENY-THEFT' AND offense NOT IN ('Theft From Motor Vehicle', 'Shoplifting')"),
    ("vandalism", "sub_category LIKE 'DESTRUCTION%' OR offense LIKE '%Vandalism%'"),
    ("assault", "sub_category = 'ASSAULT OFFENSES'"),
    ("robbery", "sub_category = 'ROBBERY'"),
    ("fraud", "sub_category LIKE 'FRAUD%' OR sub_category LIKE '%FORGERY%'"),
    ("trespass", "sub_category LIKE 'TRESPASS%'"),
    ("drugs", "sub_category LIKE 'DRUG%'"),
]


def _case(col, groups, other="other"):
    parts = " ".join(f"WHEN regexp_matches(upper({col}), '{rx}') THEN '{g}'" for g, rx in groups)
    return f"CASE {parts} ELSE '{other}' END"


def definitions(con):
    """(name, domain, kind, unit, label, sql -> (d, v)) for every daily series that the lake supports."""
    have = set(con.present)
    out = []

    def add(name, domain, kind, unit, label, sql, src):
        if all(s in have for s in src):
            out.append({"name": name, "domain": domain, "kind": kind, "unit": unit, "label": label, "sql": sql, "src": src})

    # police 911 calls (excluding officer-initiated activity, which measures policing rather than incidents)
    pc = _case("initial_call_type", POLICE_GROUPS)
    add("police.calls", "safety", "count", "calls/day", "Police calls (public-initiated)",
        "SELECT CAST(t AS DATE) d, count(*) v FROM spd_calls WHERE call_type IN ('911','TELEPHONE OTHER, NOT 911','TEXT MESSAGE') GROUP BY 1", ["spd_calls"])
    for g, _ in POLICE_GROUPS:
        add(f"police.{g}", "safety", "count", "calls/day", f"Police calls: {g.replace('_', ' ')}",
            f"SELECT CAST(t AS DATE) d, count(*) v FROM spd_calls WHERE {pc} = '{g}' GROUP BY 1", ["spd_calls"])
    add("police.response_p1_min", "safety", "metric", "minutes", "Police response time, priority 1 (median)",
        "SELECT CAST(t AS DATE) d, median(response_s) / 60 v FROM spd_calls WHERE priority = 1 AND response_s BETWEEN 0 AND 7200 GROUP BY 1", ["spd_calls"])
    add("police.response_p2_min", "safety", "metric", "minutes", "Police response time, priority 2 (median)",
        "SELECT CAST(t AS DATE) d, median(response_s) / 60 v FROM spd_calls WHERE priority = 2 AND response_s BETWEEN 0 AND 14400 GROUP BY 1", ["spd_calls"])
    # crime reports by NIBRS group
    add("crime.all", "safety", "count", "offenses/day", "Crime reports (all offenses)",
        "SELECT CAST(t AS DATE) d, count(*) v FROM spd_crime WHERE t >= TIMESTAMP '2008-01-01' GROUP BY 1", ["spd_crime"])
    for g, cond in CRIME_GROUPS:
        add(f"crime.{g}", "safety", "count", "offenses/day", f"Crime: {g.replace('_', ' ')}",
            f"SELECT CAST(t AS DATE) d, count(*) v FROM spd_crime WHERE t >= TIMESTAMP '2008-01-01' AND ({cond}) GROUP BY 1", ["spd_crime"])
    # fire and medical
    fc = _case("type", SFD_GROUPS)
    add("fire.all", "safety", "count", "dispatches/day", "Fire and medical dispatches",
        "SELECT CAST(t AS DATE) d, count(*) v FROM sfd_911 GROUP BY 1", ["sfd_911"])
    for g, _ in SFD_GROUPS:
        add(f"fire.{g}", "safety", "count", "dispatches/day", f"Fire dispatches: {g.replace('_', ' ')}",
            f"SELECT CAST(t AS DATE) d, count(*) v FROM sfd_911 WHERE {fc} = '{g}' GROUP BY 1", ["sfd_911"])
    # quality of life
    add("311.all", "quality-of-life", "count", "requests/day", "311 requests",
        "SELECT CAST(t AS DATE) d, count(*) v FROM csr GROUP BY 1", ["csr"])
    add("311.encampment", "quality-of-life", "count", "reports/day", "Encampment reports",
        "SELECT CAST(t AS DATE) d, count(*) v FROM encampment_reports GROUP BY 1", ["encampment_reports"])
    add("311.dumping", "quality-of-life", "count", "reports/day", "Illegal dumping reports",
        "SELECT CAST(t AS DATE) d, count(*) v FROM illegal_dumping GROUP BY 1", ["illegal_dumping"])
    add("code.complaints", "quality-of-life", "count", "complaints/day", "Code complaints",
        "SELECT CAST(t AS DATE) d, count(*) v FROM code_complaints GROUP BY 1", ["code_complaints"])
    # development
    add("dev.permit_applications", "development", "count", "applications/day", "Building permit applications",
        "SELECT CAST(t AS DATE) d, count(*) v FROM building_permits GROUP BY 1", ["building_permits"])
    add("dev.units_permitted", "development", "count", "units/day", "Housing units in issued permits",
        "SELECT CAST(t_issued AS DATE) d, sum(coalesce(units_added, 0)) v FROM building_permits WHERE t_issued IS NOT NULL GROUP BY 1", ["building_permits"])
    add("dev.land_use_applications", "development", "count", "applications/day", "Land use (MUP) applications",
        "SELECT CAST(t AS DATE) d, count(*) v FROM land_use_permits GROUP BY 1", ["land_use_permits"])
    # mobility
    for b in ("Ballard", "Fremont", "University", "Montlake"):
        add(f"bridge.{b.lower()}_openings", "mobility", "count", "openings/day", f"{b} Bridge openings",
            f"SELECT CAST(t AS DATE) d, count(*) v FROM bridge_openings WHERE bridge = '{b}' GROUP BY 1", ["bridge_openings"])
        add(f"bridge.{b.lower()}_minutes", "mobility", "metric", "minutes/day", f"{b} Bridge minutes open",
            f"SELECT CAST(t AS DATE) d, sum(minutes) v FROM bridge_openings WHERE bridge = '{b}' GROUP BY 1", ["bridge_openings"])
    add("bikes.fremont", "mobility", "count", "bikes/day", "Bikes and scooters over the Fremont Bridge",
        "SELECT CAST(t AS DATE) d, sum(total) v FROM fremont_bridge_bikes GROUP BY 1 HAVING count(*) >= 20", ["fremont_bridge_bikes"])
    add("parking.payments", "mobility", "count", "payments/day", "Parking meter payments (Ballard)",
        "SELECT CAST(t AS DATE) d, sum(payments) v FROM parking_hourly GROUP BY 1", ["parking_hourly"])
    # environment
    for col, name, label, unit, agg in (("temp_f", "wx.temp_max", "Daily high temperature", "°F", "max"),
                                        ("temp_f", "wx.temp_min", "Daily low temperature", "°F", "min"),
                                        ("precip_in", "wx.precip", "Precipitation", "in", "sum"),
                                        ("gust_mph", "wx.gust_max", "Peak wind gust", "mph", "max"),
                                        ("wind_mph", "wx.wind_mean", "Mean wind speed", "mph", "avg"),
                                        ("cloud_pct", "wx.cloud", "Cloud cover", "%", "avg"),
                                        ("solar_wm2", "wx.solar", "Sunshine (solar radiation)", "W/m²", "avg"),
                                        ("humidity", "wx.humidity", "Relative humidity", "%", "avg"),
                                        ("pressure_hpa", "wx.pressure", "Air pressure", "hPa", "avg")):
        add(name, "environment", "metric", unit, label,
            f"SELECT CAST(t AS DATE) d, {agg}({col}) v FROM weather_hourly GROUP BY 1 HAVING count(*) >= 20", ["weather_hourly"])
    add("wx.rain_hours", "environment", "count", "hours", "Hours with rain",
        "SELECT CAST(t AS DATE) d, sum(CASE WHEN precip_in >= 0.01 THEN 1 ELSE 0 END) v FROM weather_hourly GROUP BY 1 HAVING count(*) >= 20", ["weather_hourly"])
    add("tide.high", "environment", "metric", "ft", "Highest tide (observed)",
        "SELECT CAST(t AS DATE) d, max(observed_ft) v FROM tides_hourly GROUP BY 1 HAVING count(observed_ft) >= 20", ["tides_hourly"])
    add("tide.low", "environment", "metric", "ft", "Lowest tide (observed)",
        "SELECT CAST(t AS DATE) d, min(observed_ft) v FROM tides_hourly GROUP BY 1 HAVING count(observed_ft) >= 20", ["tides_hourly"])
    add("tide.surge", "environment", "metric", "ft", "Storm surge (observed minus predicted, daily max)",
        "SELECT CAST(t AS DATE) d, max(surge_ft) v FROM tides_hourly GROUP BY 1 HAVING count(surge_ft) >= 20", ["tides_hourly"])
    # attention
    for art, name in (("Ballard,_Seattle", "attention.wiki_ballard"), ("Hiram_M._Chittenden_Locks", "attention.wiki_locks"),
                      ("Golden_Gardens_Park", "attention.wiki_golden_gardens")):
        add(name, "attention", "count", "views/day", f"Wikipedia views: {art.replace('_', ' ')}",
            f"SELECT d, views v FROM pageviews_daily WHERE article = '{art}'", ["pageviews_daily"])
    return out


def build_daily(con, start="2010-01-01", end=None):
    """Returns (dates, {name: values}, {name: meta}). Values are NaN outside each series' coverage."""
    end = end or (dt.date.today() - dt.timedelta(days=1)).isoformat()
    dates = np.arange(np.datetime64(start), np.datetime64(end) + 1)
    index = {d: i for i, d in enumerate(dates.astype("datetime64[D]").astype(str))}
    values, meta = {}, {}
    for s in definitions(con):
        rows = con.execute(s["sql"]).fetchall()
        rows = [(str(d), v) for d, v in rows if d is not None and v is not None and str(d) in index]
        if len(rows) < 30:
            continue
        v = np.full(len(dates), np.nan)
        first = min(index[d] for d, _ in rows)
        last = max(index[d] for d, _ in rows)
        if s["kind"] == "count":
            v[first:last + 1] = 0.0                          # inside coverage a missing day is a zero count
        for d, x in rows:
            v[index[d]] = float(x)
        values[s["name"]] = v
        meta[s["name"]] = {k: s[k] for k in ("domain", "kind", "unit", "label", "src")} | {
            "first": str(dates[first]), "last": str(dates[last]), "n": int(np.isfinite(v).sum())}
    return dates, values, meta
