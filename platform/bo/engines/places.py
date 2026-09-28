"""Place intelligence: what is changing at specific addresses and blocks, joined across agencies.

pipeline()     development: land use applications in review, building permits issued, projects completed,
               with housing units, from SDCI
openings()     new business licenses (license start in the last 90 days) and liquor license roster changes
nuisance()     addresses and blocks where code complaints, illegal dumping, encampment reports and 311
               requests are persistent (most recent quarters) or newly emerging, with a Poisson test vs the
               location's own history
restaurants()  failed food inspections and health-department closures in the last 6 months
place_index()  every address seen in any dataset, with its record counts by source (for search)
"""
import numpy as np
from scipy import stats as st


def pipeline(con):
    out = {}
    if "land_use_permits" in con.present:
        out["in_review"] = con.execute("""
            SELECT id, address, coalesce(permittypedesc, permittypemapped, permitclassmapped) AS type, status, units_added, CAST(t AS DATE) AS applied, lat, lon,
                   left(description, 240) AS description, link
            FROM land_use_permits
            WHERE status NOT IN ('Completed','Withdrawn','Canceled','Cancelled','Closed','Denied','Expired','Issued')
              AND t >= now() - INTERVAL 4 YEAR
            ORDER BY coalesce(units_added, 0) DESC, t DESC LIMIT 60""").fetchall()
        out["in_review_cols"] = ["id", "address", "type", "status", "units_added", "applied", "lat", "lon", "description", "link"]
    if "building_permits" in con.present:
        out["issued_12m"] = con.execute("""
            SELECT id, address, coalesce(permittypedesc, permittypemapped, permitclassmapped) AS type, status, units_added, units_removed, cost, CAST(t_issued AS DATE) AS issued,
                   lat, lon, left(description, 240) AS description, link
            FROM building_permits WHERE t_issued >= now() - INTERVAL 12 MONTH AND (coalesce(units_added, 0) > 0 OR cost >= 250000)
            ORDER BY coalesce(units_added, 0) DESC, cost DESC NULLS LAST LIMIT 80""").fetchall()
        out["issued_cols"] = ["id", "address", "type", "status", "units_added", "units_removed", "cost", "issued", "lat", "lon", "description", "link"]
        out["units_by_year"] = con.execute("""
            SELECT year(t_issued) AS y, sum(coalesce(units_added, 0)) AS added, sum(coalesce(units_removed, 0)) AS removed, count(*) AS permits
            FROM building_permits WHERE t_issued >= TIMESTAMP '2010-01-01' GROUP BY 1 ORDER BY 1""").fetchall()
        out["completed_12m"] = con.execute("""
            SELECT count(*), sum(coalesce(units_added, 0)) FROM building_permits WHERE t_completed >= now() - INTERVAL 12 MONTH""").fetchone()
    return out


def openings(con):
    out = {}
    if "business_licenses" in con.present:
        out["new_licenses"] = con.execute("""
            SELECT trade_name, naics_description, address, zip, start_date
            FROM business_licenses WHERE active AND start_date >= current_date - INTERVAL 90 DAY
            ORDER BY start_date DESC LIMIT 100""").fetchall()
        out["new_by_sector"] = con.execute("""
            SELECT coalesce(naics_description, 'Unclassified') AS sector, count(*) AS n
            FROM business_licenses WHERE active AND start_date >= current_date - INTERVAL 365 DAY
            GROUP BY 1 ORDER BY 2 DESC LIMIT 15""").fetchall()
        out["cohorts"] = con.execute("""
            SELECT year(start_date) AS y, count(*) FROM business_licenses WHERE active AND start_date >= DATE '2000-01-01'
            GROUP BY 1 ORDER BY 1""").fetchall()
    if "liquor_licensees" in con.present:
        out["liquor"] = con.execute("SELECT tradename, address, privileges, renewal FROM liquor_licensees WHERE active ORDER BY tradename").fetchall()
    if "liquor_applications" in con.present:
        out["liquor_applications"] = con.execute(
            "SELECT tradename, notice_type, address, privileges, CAST(t AS DATE) FROM liquor_applications ORDER BY t DESC LIMIT 50").fetchall()
    return out


def nuisance(con, min_recent=6):
    """Per H3 resolution-10 cell (~150 m² ... ~0.015 km²): quarterly counts over the last 2 years."""
    if not {"code_complaints", "illegal_dumping", "encampment_reports"} & set(con.present):
        return []
    rows = con.execute("""
        WITH e AS (
          SELECT h3_latlng_to_cell_string(lat, lon, 10) AS cell, kind, t, address
          FROM events
          WHERE kind IN ('code_complaint', 'illegal_dumping', 'encampment_report') AND lat IS NOT NULL
            AND t >= (SELECT max(t) FROM events WHERE kind = 'illegal_dumping') - INTERVAL 2 YEAR
        ), q AS (
          SELECT cell, kind, datediff('day', t, (SELECT max(t) FROM e)) // 91 AS qago, count(*) AS n, any_value(address) AS addr
          FROM e GROUP BY 1, 2, 3
        )
        SELECT cell, kind, list(n ORDER BY qago), list(qago ORDER BY qago), any_value(addr) FROM q GROUP BY 1, 2""").fetchall()
    out = []
    for cell, kind, ns, qs, addr in rows:
        counts = np.zeros(8)
        for n, q in zip(ns, qs):
            if 0 <= q < 8:
                counts[q] = n
        recent, before = counts[0], counts[1:].mean()
        persistent = int((counts[:4] >= 3).sum())
        # emerging: last quarter vs the location's own previous 7-quarter average
        p = float(st.poisson.sf(recent - 1, max(before, 0.5))) if recent >= min_recent else 1.0
        if persistent >= 3 or (recent >= min_recent and p < 1e-3):
            out.append({"cell": cell, "kind": kind, "address": addr, "quarters": counts.tolist(), "recent": int(recent),
                        "baseline_per_quarter": float(before), "persistent_quarters": persistent, "p_emerging": p,
                        "status": "emerging" if (recent >= min_recent and p < 1e-3 and before < recent / 3) else "persistent"})
    out.sort(key=lambda x: (x["status"] != "emerging", x["p_emerging"], -x["recent"]))
    return out[:60]


def restaurants(con):
    if "food_inspections" not in con.present:
        return []
    return con.execute("""
        SELECT name, address, CAST(t AS DATE) AS d, max(score) AS score, any_value(result) AS result,
               bool_or(upper(closed) = 'YES') AS closed, sum(CASE WHEN violation_type = 'RED' THEN violation_points ELSE 0 END) AS red_points,
               list(DISTINCT left(violation_description, 90)) FILTER (WHERE violation_type = 'RED') AS red
        FROM food_inspections
        WHERE t >= now() - INTERVAL 6 MONTH
        GROUP BY 1, 2, 3
        HAVING any_value(result) = 'Unsatisfactory' OR bool_or(upper(closed) = 'YES')
        ORDER BY closed DESC, red_points DESC LIMIT 40""").fetchall()


def place_index(con, limit=20000):
    if "places_raw" not in [r[0] for r in con.execute("SELECT table_name FROM information_schema.tables").fetchall()]:
        return []
    return con.execute(f"""
        SELECT addr_key, any_value(address) AS address, avg(lat) AS lat, avg(lon) AS lon,
               count(*) AS records, count(DISTINCT src) AS sources, list(DISTINCT src) AS srcs,
               max(t) AS last_t, list(DISTINCT name) FILTER (WHERE name IS NOT NULL) AS names
        FROM places_raw WHERE addr_key <> '' AND regexp_matches(addr_key, '^[0-9]')
        GROUP BY 1 ORDER BY records DESC LIMIT {limit}""").fetchall()


def place_records(con, out_dir, shards=256):
    """Per-address dossiers: every address-exact record from each agency, plus counts of located incidents within
    ~100 m (the address's H3 res-10 cell and its neighbors) over the last 12 months. Written as
    out_dir/places/<2-hex-shard>.json so a static host can serve them."""
    import hashlib
    import json
    import h3
    from ..views import ADDR_NORM
    have = set(con.present)
    Q = {
        "building_permits": """SELECT address, lat, lon, 'Building permit' AS kind, CAST(t AS DATE) AS d, id AS ref,
              concat_ws(' · ', permittypedesc, status, CASE WHEN units_added > 0 THEN units_added || ' units' END) AS summary,
              left(description, 200) AS detail, link FROM building_permits""",
        "land_use_permits": """SELECT address, lat, lon, 'Land use permit' AS kind, CAST(t AS DATE) AS d, id AS ref,
              concat_ws(' · ', permittypedesc, status) AS summary, left(description, 200) AS detail, link FROM land_use_permits""",
        "code_complaints": """SELECT address, lat, lon, 'Code complaint' AS kind, CAST(t AS DATE) AS d, id AS ref,
              concat_ws(' · ', recordtypedesc, status) AS summary, left(description, 200) AS detail, link FROM code_complaints""",
        "food_inspections": """SELECT address, NULL::DOUBLE AS lat, NULL::DOUBLE AS lon, 'Food inspection' AS kind, CAST(t AS DATE) AS d, id AS ref,
              concat_ws(' · ', any_value(name), any_value(inspection_type), any_value(result), 'score ' || max(score)) AS summary,
              string_agg(DISTINCT left(violation_description, 80), '; ') FILTER (WHERE violation_type = 'RED') AS detail, NULL AS link
              FROM food_inspections GROUP BY address, id, t""",
        "business_licenses": """SELECT address, NULL::DOUBLE, NULL::DOUBLE, 'Business license' AS kind, start_date AS d, id AS ref,
              concat_ws(' · ', trade_name, naics_description) AS summary, CASE WHEN active THEN 'active' ELSE 'no longer active' END AS detail, NULL FROM business_licenses""",
        "liquor_licensees": """SELECT address, lat, lon, 'Liquor license' AS kind, CAST(renewal AS DATE) AS d, id AS ref,
              concat_ws(' · ', tradename, privileges) AS summary, 'renews ' || CAST(CAST(renewal AS DATE) AS VARCHAR) AS detail, NULL FROM liquor_licensees""",
        "liquor_applications": """SELECT address, lat, lon, 'Liquor license notice' AS kind, CAST(t AS DATE) AS d, id AS ref,
              concat_ws(' · ', tradename, notice_type) AS summary, privileges AS detail, NULL FROM liquor_applications""",
        "short_term_rentals": """SELECT address, lat, lon, 'Short-term rental' AS kind, NULL::DATE AS d, id AS ref,
              concat_ws(' · ', propertytype, bedroomcount || ' bedrooms', status) AS summary, NULL AS detail, NULL FROM short_term_rentals""",
    }
    places = {}
    for ds, sql in Q.items():
        if ds not in have:
            continue
        rows = con.execute(f"SELECT {ADDR_NORM.format(col='address')} AS k, * FROM ({sql})").fetchall()
        for k, addr, lat, lon, kind, d, ref, summary, detail, link in rows:
            if not k or not k[:1].isdigit():
                continue
            p = places.setdefault(k, {"address": addr, "lat": None, "lon": None, "records": []})
            if lat is not None and p["lat"] is None and 47.4 < lat < 47.9:
                p["lat"], p["lon"] = lat, lon
            p["records"].append({"kind": kind, "d": str(d) if d else None, "ref": ref, "summary": summary, "detail": detail, "link": link, "src": ds})
    # incidents near each address over the last 12 months
    cells = {}
    for kind, n, cell in con.execute("""SELECT kind, count(*), h3_latlng_to_cell_string(lat, lon, 10) FROM events
            WHERE lat IS NOT NULL AND kind IN ('police_call', 'crime', 'fire_ems', '311', 'encampment_report', 'illegal_dumping')
              AND t >= (SELECT max(t) FROM events WHERE kind = 'fire_ems') - INTERVAL 365 DAY GROUP BY 1, 3""").fetchall():
        cells.setdefault(cell, {})[kind] = n
    for p in places.values():
        if p["lat"] is None:
            continue
        near = {}
        for c in h3.grid_disk(h3.latlng_to_cell(p["lat"], p["lon"], 10), 1):
            for kind, n in cells.get(c, {}).items():
                near[kind] = near.get(kind, 0) + n
        p["nearby_12m"] = near
    for p in places.values():
        p["records"].sort(key=lambda r: r["d"] or "", reverse=True)
    # neighborhood distribution of nearby volumes, so a place can be compared with the rest of Ballard
    import numpy as np
    quant = {}
    for kind in ("police_call", "crime", "fire_ems", "311", "encampment_report", "illegal_dumping"):
        vals = np.array([p.get("nearby_12m", {}).get(kind, 0) for p in places.values() if p.get("lat") is not None], float)
        if len(vals):
            quant[kind] = [float(np.percentile(vals, q)) for q in range(0, 101, 5)]
    (out_dir / "nearby_quantiles.json").write_text(json.dumps(quant))
    out = out_dir / "places"
    out.mkdir(parents=True, exist_ok=True)
    buckets = {}
    for k, p in places.items():
        buckets.setdefault(hashlib.sha1(k.encode()).hexdigest()[:2], {})[k] = p
    for sh, obj in buckets.items():
        (out / f"{sh}.json").write_text(json.dumps(obj, separators=(",", ":"), default=str))
    return len(places)
