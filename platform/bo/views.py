"""Typed SQL views over the lake (DuckDB), and the unified views the engines use.

    con = views.connect()          # every dataset present in the lake is registered as a typed view
    con.sql("SELECT kind, count(*) FROM events GROUP BY 1")

Unified views
  events(src, id, t, kind, subkind, detail, lat, lon, address, h3_9, h3_8, beat, attrs)
      one row per located or timed happening, across all event datasets
  places_raw(src, id, t, address, addr_key, lat, lon, name, attrs)
      records tied to a street address, for place-level joins
Addresses are normalized to `addr_key` (upper case, standard suffixes and directionals, no unit) so records from
different agencies about the same building line up.
"""
import duckdb

from .config import LAKE

# Each dataset view: SELECT over `cur` (its current.parquet, active rows only), typed.
TYPED = {
    "spd_calls": """
        SELECT cad_event_number AS id,
               TRY_CAST(cad_event_original_time_queued AS TIMESTAMP) AS t,
               TRY_CAST(cad_event_arrived_time AS TIMESTAMP) AS t_arrived,
               initial_call_type, final_call_type, call_type, TRY_CAST(priority AS INT) AS priority,
               cad_event_clearance_description AS clearance, dispatch_precinct AS precinct, dispatch_sector AS sector,
               dispatch_beat AS beat,
               CASE WHEN dispatch_latitude = 'REDACTED' THEN NULL ELSE TRY_CAST(dispatch_latitude AS DOUBLE) END AS lat,
               CASE WHEN dispatch_longitude = 'REDACTED' THEN NULL ELSE TRY_CAST(dispatch_longitude AS DOUBLE) END AS lon,
               TRY_CAST(first_spd_call_sign_response_time_s_ AS DOUBLE) AS response_s,
               TRY_CAST(first_spd_call_sign_dispatch_delay_time_s_ AS DOUBLE) AS dispatch_delay_s,
               TRY_CAST(spd_call_sign_total_service_time_s_ AS DOUBLE) AS service_s,
               cad_event_response_category AS response_category
        FROM cur""",
    "spd_crime": """
        SELECT offense_id AS id, report_number,
               TRY_CAST(offense_date AS TIMESTAMP) AS t, TRY_CAST(report_date_time AS TIMESTAMP) AS t_reported,
               nibrs_crime_against_category AS against, offense_sub_category AS sub_category,
               nibrs_offense_code_description AS offense, nibrs_offense_code AS offense_code, nibrs_group_a_b AS nibrs_group,
               shooting_type_group, beat, precinct, sector, neighborhood, block_address AS address,
               CASE WHEN latitude = 'REDACTED' THEN NULL ELSE TRY_CAST(latitude AS DOUBLE) END AS lat,
               CASE WHEN longitude = 'REDACTED' THEN NULL ELSE TRY_CAST(longitude AS DOUBLE) END AS lon
        FROM cur""",
    "sfd_911": """
        SELECT incident_number AS id, TRY_CAST(datetime AS TIMESTAMP) AS t, type, address,
               TRY_CAST(latitude AS DOUBLE) AS lat, TRY_CAST(longitude AS DOUBLE) AS lon
        FROM cur""",
    "building_permits": """
        SELECT permitnum AS id, permitclass, permitclassmapped, permittypemapped, permittypedesc, description,
               TRY_CAST(housingunits AS DOUBLE) AS units, TRY_CAST(housingunitsadded AS DOUBLE) AS units_added,
               TRY_CAST(housingunitsremoved AS DOUBLE) AS units_removed, TRY_CAST(estprojectcost AS DOUBLE) AS cost,
               TRY_CAST(applieddate AS TIMESTAMP) AS t, TRY_CAST(issueddate AS TIMESTAMP) AS t_issued,
               TRY_CAST(completeddate AS TIMESTAMP) AS t_completed, TRY_CAST(expiresdate AS TIMESTAMP) AS t_expires,
               statuscurrent AS status, relatedmup, originaladdress1 AS address, zoning, housingcategory,
               TRY_CAST(totaldaysplanreview AS DOUBLE) AS days_plan_review, TRY_CAST(numberreviewcycles AS DOUBLE) AS review_cycles,
               TRY_CAST(latitude AS DOUBLE) AS lat, TRY_CAST(longitude AS DOUBLE) AS lon, link
        FROM cur""",
    "land_use_permits": """
        SELECT permitnum AS id, permitclass, permitclassmapped, permittypemapped, permittypedesc, description,
               TRY_CAST(housingunits AS DOUBLE) AS units, TRY_CAST(housingunitsadded AS DOUBLE) AS units_added,
               TRY_CAST(housingunitsremoved AS DOUBLE) AS units_removed, TRY_CAST(estprojectcost AS DOUBLE) AS cost,
               TRY_CAST(applieddate AS TIMESTAMP) AS t, TRY_CAST(issueddate AS TIMESTAMP) AS t_issued,
               TRY_CAST(decisiondate AS TIMESTAMP) AS t_decision, statuscurrent AS status, originaladdress1 AS address,
               TRY_CAST(latitude AS DOUBLE) AS lat, TRY_CAST(longitude AS DOUBLE) AS lon, link
        FROM cur""",
    "code_complaints": """
        SELECT recordnum AS id, recordtype, recordtypemapped, recordtypedesc, description,
               TRY_CAST(opendate AS TIMESTAMP) AS t, TRY_CAST(lastinspdate AS TIMESTAMP) AS t_last_inspection,
               lastinspresult, statuscurrent AS status, originaladdress1 AS address,
               TRY_CAST(latitude AS DOUBLE) AS lat, TRY_CAST(longitude AS DOUBLE) AS lon, link
        FROM cur""",
    "csr": """
        SELECT servicerequestnumber AS id, TRY_CAST(createddate AS TIMESTAMP) AS t, webintakeservicerequests AS request_type,
               departmentname AS department, methodreceivedname AS channel, servicerequeststatusname AS status,
               location AS address, TRY_CAST(latitude AS DOUBLE) AS lat, TRY_CAST(longitude AS DOUBLE) AS lon,
               zipcode, councildistrict, policeprecinct, community_reporting_area
        FROM cur""",
    "encampment_reports": """
        SELECT servicerequestnumber AS id, TRY_CAST(createddate AS TIMESTAMP) AS t, servicerequeststatusname AS status,
               location AS address, TRY_CAST(latitude AS DOUBLE) AS lat, TRY_CAST(longitude AS DOUBLE) AS lon,
               aretherepeoplepresent AS people_present, aretheretentsstructuresortarps AS tents,
               aretherervscarsmiscvehicles AS vehicles, istheencampmentblockingaccess AS blocking, istheretrashordebris AS debris
        FROM cur""",
    "illegal_dumping": """
        SELECT servicerequestnumber AS id, TRY_CAST(createddate AS TIMESTAMP) AS t, servicerequeststatusname AS status,
               location AS address, TRY_CAST(latitude AS DOUBLE) AS lat, TRY_CAST(longitude AS DOUBLE) AS lon,
               whereistheillegaldumping AS dumping_where, descriptionoftheillegaldumping AS dumping_description
        FROM cur""",
    "business_licenses": """
        SELECT city_account_number AS id, trade_name, business_legal_name, ownership_type, naics_code, naics_description,
               TRY_CAST(license_start_date AS DATE) AS start_date, street_address AS address, zip,
               TRY_CAST(_first_seen AS TIMESTAMP) AS first_seen, TRY_CAST(_last_seen AS TIMESTAMP) AS last_seen, _active AS active
        FROM cur_all""",
    "short_term_rentals": """
        SELECT licenseid AS id, unitid, licensestatus AS status, unitstatus, TRY_CAST(licenseexpirationdate AS TIMESTAMP) AS t_expires,
               addressline AS address, propertytype, bedroomcount, primaryresidence,
               TRY_CAST(latitude AS DOUBLE) AS lat, TRY_CAST(longitude AS DOUBLE) AS lon,
               TRY_CAST(_first_seen AS TIMESTAMP) AS first_seen, _active AS active
        FROM cur_all""",
    "liquor_applications": """
        SELECT license AS id, l_a_type AS notice_type, licenseename, tradename,
               TRY_STRPTIME(applicationdate, '%Y%m%d') AS t, TRY_CAST(la_posted_date AS DATE) AS posted,
               streetaddress AS address, zipcode,
               concat_ws('; ', privdesc01, privdesc02, privdesc03, privdesc04, privdesc05, privdesc06, privdesc07, privdesc08) AS privileges,
               TRY_CAST(json_extract_string(location, '$.latitude') AS DOUBLE) AS lat,
               TRY_CAST(json_extract_string(location, '$.longitude') AS DOUBLE) AS lon,
               TRY_CAST(_first_seen AS TIMESTAMP) AS first_seen, _active AS active
        FROM cur_all""",
    "liquor_licensees": """
        SELECT license AS id, tradename, l_a_type, TRY_STRPTIME(renewaldate, '%Y%m%d') AS renewal, streetaddress AS address, zipcode,
               concat_ws('; ', privdesc01, privdesc02, privdesc03) AS privileges,
               TRY_CAST(json_extract_string(location, '$.latitude') AS DOUBLE) AS lat,
               TRY_CAST(json_extract_string(location, '$.longitude') AS DOUBLE) AS lon,
               TRY_CAST(_first_seen AS TIMESTAMP) AS first_seen, TRY_CAST(_last_seen AS TIMESTAMP) AS last_seen, _active AS active
        FROM cur_all""",
    "food_inspections": """
        SELECT inspection_serial_num AS id, name, program_identifier, business_id, parcel_number,
               TRY_CAST(inspection_date AS TIMESTAMP) AS t, classification, address, zip_code, inspection_type,
               TRY_CAST(inspection_score AS DOUBLE) AS score, inspection_result AS result, inspection_closed_business AS closed,
               risk_category, violation_type, violation_description, TRY_CAST(violation_points AS DOUBLE) AS violation_points, grade
        FROM cur""",
    "bridge_openings": """
        SELECT entityid || '|' || opendatetime AS id, entityname AS bridge, TRY_CAST(opendatetime AS TIMESTAMP) AS t,
               TRY_CAST(closedatetime AS TIMESTAMP) AS t_closed, TRY_CAST(minutesopen AS DOUBLE) AS minutes,
               TRY_CAST(latitude AS DOUBLE) AS lat, TRY_CAST(longitude AS DOUBLE) AS lon
        FROM cur""",
    "parking_hourly": """
        SELECT elementkey AS blockface_id, blockface_name, TRY_CAST(d AS TIMESTAMP) + to_hours(TRY_CAST(h AS INT)) AS t,
               TRY_CAST(payments AS DOUBLE) AS payments, TRY_CAST(paid_minutes AS DOUBLE) AS paid_minutes,
               TRY_CAST(paid_usd AS DOUBLE) AS paid_usd, TRY_CAST(lat AS DOUBLE) AS lat, TRY_CAST(lon AS DOUBLE) AS lon
        FROM cur""",
    "fremont_bridge_bikes": """
        SELECT TRY_CAST(date AS TIMESTAMP) AS t, TRY_CAST(fremont_bridge AS DOUBLE) AS total,
               TRY_CAST(fremont_bridge_nb AS DOUBLE) AS northbound, TRY_CAST(fremont_bridge_sb AS DOUBLE) AS southbound
        FROM cur""",
    "wastewater_covid": """
        SELECT record_id AS id, site, counties_served, TRY_CAST(population_served AS DOUBLE) AS population,
               TRY_CAST(sample_collect_date AS DATE) AS d, pcr_target, TRY_CAST(pcr_target_flowpop_lin AS DOUBLE) AS flowpop,
               TRY_CAST(pcr_target_avg_conc_lin AS DOUBLE) AS conc, pcr_target_detect AS detected
        FROM cur""",
    "wastewater_flu": """
        SELECT record_id AS id, site, counties_served, TRY_CAST(population_served AS DOUBLE) AS population,
               TRY_CAST(sample_collect_date AS DATE) AS d, pcr_target, TRY_CAST(pcr_target_flowpop_lin AS DOUBLE) AS flowpop,
               TRY_CAST(pcr_target_avg_conc_lin AS DOUBLE) AS conc, pcr_target_detect AS detected
        FROM cur""",
    "wastewater_levels": """
        SELECT site, pathogen_target AS pathogen, TRY_CAST(week_end AS DATE) AS week_end, TRY_CAST(site_wval AS DOUBLE) AS wval,
               site_wval_category AS level, counties_served, TRY_CAST(population_served AS DOUBLE) AS population
        FROM cur""",
    "weather_hourly": """
        SELECT TRY_CAST(t AS TIMESTAMP) AS t, TRY_CAST(temperature_2m AS DOUBLE) AS temp_f,
               TRY_CAST(apparent_temperature AS DOUBLE) AS feels_f, TRY_CAST(precipitation AS DOUBLE) AS precip_in,
               TRY_CAST(rain AS DOUBLE) AS rain_in, TRY_CAST(snowfall AS DOUBLE) AS snow_in,
               TRY_CAST(wind_speed_10m AS DOUBLE) AS wind_mph, TRY_CAST(wind_direction_10m AS DOUBLE) AS wind_dir,
               TRY_CAST(wind_gusts_10m AS DOUBLE) AS gust_mph, TRY_CAST(cloud_cover AS DOUBLE) AS cloud_pct,
               TRY_CAST(relative_humidity_2m AS DOUBLE) AS humidity, TRY_CAST(pressure_msl AS DOUBLE) AS pressure_hpa,
               TRY_CAST(shortwave_radiation AS DOUBLE) AS solar_wm2
        FROM cur""",
    "tides_hourly": """
        SELECT TRY_CAST(t AS TIMESTAMP) AS t, TRY_CAST(observed_ft AS DOUBLE) AS observed_ft,
               TRY_CAST(predicted_ft AS DOUBLE) AS predicted_ft, TRY_CAST(surge_ft AS DOUBLE) AS surge_ft
        FROM cur""",
    "pageviews_daily": "SELECT article, TRY_CAST(d AS DATE) AS d, TRY_CAST(views AS DOUBLE) AS views FROM cur",
    "council_matters": """
        SELECT TRY_CAST(MatterId AS BIGINT) AS id, MatterGuid AS guid, MatterFile AS file, MatterName AS name, MatterTitle AS title,
               MatterTypeName AS type, MatterStatusName AS status, MatterBodyName AS body,
               TRY_CAST(MatterIntroDate AS TIMESTAMP) AS t, TRY_CAST(MatterPassedDate AS TIMESTAMP) AS t_passed,
               TRY_CAST(MatterEnactmentDate AS TIMESTAMP) AS t_enacted, MatterEnactmentNumber AS enactment
        FROM cur""",
    "council_events": """
        SELECT TRY_CAST(EventId AS BIGINT) AS id, EventBodyName AS body, TRY_CAST(EventDate AS TIMESTAMP) AS t, EventTime AS time_text,
               EventLocation AS location, EventAgendaFile AS agenda_url, EventMinutesFile AS minutes_url, EventInSiteURL AS url,
               EventVideoPath AS video_url
        FROM cur""",
}

# Unified events: (src, id, t, kind, subkind, detail, lat, lon, address, attrs)
EVENT_PARTS = {
    "spd_calls": "SELECT 'spd_calls', id, t, 'police_call', initial_call_type, final_call_type, lat, lon, NULL, "
                 "json_object('priority', priority, 'beat', beat, 'response_s', response_s, 'call_type', call_type, 'clearance', clearance) FROM spd_calls",
    "spd_crime": "SELECT 'spd_crime', id, t, 'crime', sub_category, offense, lat, lon, address, "
                 "json_object('against', against, 'beat', beat, 'neighborhood', neighborhood, 'reported', t_reported) FROM spd_crime",
    "sfd_911": "SELECT 'sfd_911', id, t, 'fire_ems', type, NULL, lat, lon, address, NULL FROM sfd_911",
    "building_permits": "SELECT 'building_permits', id, t, 'building_permit', permittypemapped, permittypedesc, lat, lon, address, "
                        "json_object('class', permitclassmapped, 'units_added', units_added, 'units_removed', units_removed, 'cost', cost, 'status', status) FROM building_permits",
    "land_use_permits": "SELECT 'land_use_permits', id, t, 'land_use_permit', permittypemapped, permittypedesc, lat, lon, address, "
                        "json_object('units_added', units_added, 'status', status, 'description', left(description, 300)) FROM land_use_permits",
    "code_complaints": "SELECT 'code_complaints', id, t, 'code_complaint', recordtypedesc, left(description, 200), lat, lon, address, "
                       "json_object('status', status) FROM code_complaints",
    "csr": "SELECT 'csr', id, t, '311', request_type, department, lat, lon, address, json_object('status', status, 'channel', channel) FROM csr",
    "encampment_reports": "SELECT 'encampment_reports', id, t, 'encampment_report', NULL, NULL, lat, lon, address, "
                          "json_object('people', people_present, 'tents', tents, 'vehicles', vehicles) FROM encampment_reports",
    "illegal_dumping": "SELECT 'illegal_dumping', id, t, 'illegal_dumping', dumping_where, left(dumping_description, 200), lat, lon, address, NULL FROM illegal_dumping",
    "food_inspections": "SELECT 'food_inspections', id, t, 'food_inspection', inspection_type, result, NULL, NULL, address, "
                        "json_object('name', name, 'score', score) FROM (SELECT DISTINCT ON (id) * FROM food_inspections)",
    "bridge_openings": "SELECT 'bridge_openings', id, t, 'bridge_opening', bridge, NULL, lat, lon, NULL, json_object('minutes', minutes) FROM bridge_openings",
    "liquor_applications": "SELECT 'liquor_applications', id, t, 'liquor_application', notice_type, tradename, lat, lon, address, "
                           "json_object('privileges', privileges) FROM liquor_applications",
    "council_matters": "SELECT 'council_matters', CAST(id AS VARCHAR), t, 'council_matter', type, title, NULL, NULL, NULL, "
                       "json_object('status', status, 'file', file) FROM council_matters",
}

ADDR_NORM = r"""
    trim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
      upper(coalesce({col}, '')),
      '\s+(#|UNIT|STE|SUITE|APT|BLDG|FL|SPC|RM)\s*[A-Z0-9-]*\s*$', ''),
      '\bNORTHWEST\b', 'NW'), '\bAVENUE\b', 'AVE'), '\bSTREET\b', 'ST'), '\bPLACE\b', 'PL'),
      '[.,]', ''), '\s+', ' ', 'g'))"""


def lake_files(ds):
    p = LAKE / ds / "current.parquet"
    return p if p.exists() else None


def connect(extensions=True):
    con = duckdb.connect()
    if extensions:
        try:
            con.execute("LOAD h3")
        except duckdb.Error:
            con.execute("INSTALL h3 FROM community; LOAD h3")
    present = []
    for ds, sql in TYPED.items():
        p = lake_files(ds)
        if not p:
            continue
        cols = {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{p}')").fetchall()}
        base_all = f"(SELECT * FROM read_parquet('{p}'))"
        base = f"(SELECT * FROM read_parquet('{p}') WHERE _active)"
        body = sql.replace("FROM cur_all", f"FROM {base_all} AS cur_all").replace("FROM cur", f"FROM {base} AS cur")
        try:
            con.execute(f"CREATE OR REPLACE VIEW {ds} AS {body}")
            present.append(ds)
        except duckdb.Error as e:
            missing = [c for c in _referenced(sql) if c not in cols]
            raise RuntimeError(f"view {ds}: {e}; columns not in data: {missing[:8]}") from None
    parts = [EVENT_PARTS[d] for d in EVENT_PARTS if d in present]
    if parts:
        ok = "lat BETWEEN 47.4 AND 47.9 AND lon BETWEEN -122.6 AND -122.1"
        h3 = (f", CASE WHEN {ok} THEN h3_latlng_to_cell_string(lat, lon, 9) END AS h3_9"
              f", CASE WHEN {ok} THEN h3_latlng_to_cell_string(lat, lon, 8) END AS h3_8") if extensions else ", NULL AS h3_9, NULL AS h3_8"
        union = "\nUNION ALL ".join(parts)
        con.execute(f"""CREATE OR REPLACE VIEW events AS
            SELECT src, id, t, kind, subkind, detail,
                   CASE WHEN {ok} THEN lat END AS lat, CASE WHEN {ok} THEN lon END AS lon, address, attrs{h3}
            FROM ({union}) AS u(src, id, t, kind, subkind, detail, lat, lon, address, attrs)
            WHERE t IS NOT NULL""")
    addr_parts = []
    for ds, name in (("building_permits", "NULL"), ("land_use_permits", "NULL"), ("code_complaints", "NULL"),
                     ("liquor_applications", "tradename"), ("liquor_licensees", "tradename"), ("food_inspections", "name"),
                     ("business_licenses", "trade_name"), ("short_term_rentals", "NULL"), ("spd_crime", "NULL"), ("sfd_911", "NULL")):
        if ds in present:
            has_ll = ds not in ("food_inspections", "business_licenses")
            addr_parts.append(f"SELECT '{ds}' AS src, CAST(id AS VARCHAR) AS id, "
                              f"{'t' if ds not in ('business_licenses', 'short_term_rentals', 'liquor_licensees') else 'NULL::TIMESTAMP'} AS t, "
                              f"address, {ADDR_NORM.format(col='address')} AS addr_key, "
                              f"{'lat, lon' if has_ll else 'NULL::DOUBLE, NULL::DOUBLE'}, {name} AS name FROM {ds}")
    if addr_parts:
        con.execute("CREATE OR REPLACE VIEW places_raw AS " + "\nUNION ALL ".join(addr_parts))
    return Conn(con, present)


class Conn:
    """A DuckDB connection plus the list of dataset views present (delegates everything else)."""

    def __init__(self, con, present):
        self._con = con
        self.present = present

    def __getattr__(self, name):
        return getattr(self._con, name)


def _referenced(sql):
    import re
    return re.findall(r"\b([a-z_][a-z0-9_]*)\b", sql)
