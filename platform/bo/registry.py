"""Declarative specs for every Socrata dataset in the lake.

Modes
  window     events: backfilled month by month from `start`, then each run re-pulls the last `window_days` by the
             event time and stores only rows whose content changed (records are revised for a while after they
             are created, e.g. 911 call dispositions).
  full       state: the whole filtered set is pulled each run; new or changed rows are stored, and records that
             disappeared upstream are stored as deletes (e.g. a business license that is no longer active).
  aggregate  large transaction tables summarized server-side (e.g. parking payments per block face per hour),
             backfilled and refreshed by day.

`where` may use {s} {n} {w} {e} for the study-area box. `drop` lists fields never stored (personal data).
"""
from dataclasses import dataclass, field

from .config import BBOX


@dataclass
class Dataset:
    name: str
    domain: str
    id: str
    title: str
    key: tuple
    mode: str = "window"
    time: str | None = None          # event time field (window/aggregate modes)
    start: str | None = None         # first day to backfill (YYYY-MM-DD)
    where: str | None = None
    select: str | None = None        # aggregate mode: $select
    group: str | None = None         # aggregate mode: $group
    window_days: int = 30
    drop: tuple = ()
    cadence: str = "daily"
    notes: str = ""
    topic: str = ""
    extra: dict = field(default_factory=dict)

    @property
    def source_url(self):
        return f"https://{self.domain}/d/{self.id}"

    def where_sql(self):
        return self.where.format(s=BBOX["south"], n=BBOX["north"], w=BBOX["west"], e=BBOX["east"]) if self.where else None


BOX_NUM = "latitude BETWEEN {s} AND {n} AND longitude BETWEEN {w} AND {e}"
BOX_POINT = "within_box({col}, {{n}}, {{w}}, {{s}}, {{e}})"
ZIP = "(starts_with({col}, '98107') OR starts_with({col}, '98117'))"

SEATTLE = "data.seattle.gov"

DATASETS = [
    # ----------------------------------------------------------------- public safety
    Dataset("spd_calls", SEATTLE, "33kz-ixgy", "SPD 911 calls for police service", key=("cad_event_number",),
            time="cad_event_original_time_queued", start="2009-01-01", window_days=21, topic="safety",
            where="((dispatch_latitude != 'REDACTED' AND dispatch_latitude::number BETWEEN {s} AND {n} "
                  "AND dispatch_longitude::number BETWEEN {w} AND {e}) "
                  "OR (dispatch_latitude = 'REDACTED' AND dispatch_beat IN ('B1','B2','B3')))",
            notes="Dispatch coordinates are block-level; sensitive calls are REDACTED and kept by beat only."),
    Dataset("spd_crime", SEATTLE, "tazs-3rd5", "SPD crime reports (NIBRS offenses)", key=("offense_id",),
            time="offense_date", start="2008-01-01", window_days=60, topic="safety",
            where="neighborhood IN ('BALLARD NORTH','BALLARD SOUTH')",
            notes="SPD MCPP neighborhoods Ballard North/South; some locations REDACTED upstream."),
    Dataset("sfd_911", SEATTLE, "kzjm-xkqj", "Seattle Fire 911 dispatches", key=("incident_number",),
            time="datetime", start="2003-11-01", window_days=7, topic="safety", where=BOX_NUM),
    # ----------------------------------------------------------------- development and the built environment
    Dataset("building_permits", SEATTLE, "76t5-zqzr", "SDCI building permits", key=("permitnum",), mode="full",
            topic="development", where=BOX_NUM, drop=("contractorcompanyname",)),
    Dataset("land_use_permits", SEATTLE, "ht3q-kdvx", "SDCI land use permits (MUPs, design review)", key=("permitnum",),
            mode="full", topic="development", where=BOX_NUM, drop=("contractorcompanyname",)),
    Dataset("code_complaints", SEATTLE, "ez4a-iug7", "SDCI code complaints and violations", key=("recordnum",),
            mode="full", topic="quality-of-life",
            where="longitude BETWEEN {w} AND {e} AND latitude::number BETWEEN {s} AND {n}"),
    # ----------------------------------------------------------------- 311 and quality of life
    Dataset("csr", SEATTLE, "5ngg-rpne", "Customer service requests (311)", key=("servicerequestnumber",),
            time="createddate", start="2018-01-01", window_days=30, topic="quality-of-life", where=BOX_NUM),
    Dataset("encampment_reports", SEATTLE, "k7ra-jqqe", "Unauthorized encampment reports", key=("servicerequestnumber",),
            time="createddate", start="2018-01-01", window_days=30, topic="quality-of-life", where=BOX_NUM),
    Dataset("illegal_dumping", SEATTLE, "bpvk-ju3y", "Illegal dumping reports", key=("servicerequestnumber",),
            time="createddate", start="2018-01-01", window_days=30, topic="quality-of-life", where=BOX_NUM),
    # ----------------------------------------------------------------- businesses and housing
    Dataset("business_licenses", SEATTLE, "wnbq-64tb", "Active business license tax certificates",
            key=("city_account_number", "street_address"), mode="full", topic="economy",
            where=ZIP.format(col="zip"), drop=("business_phone",),
            notes="Snapshot of active licenses: appearances are openings, disappearances are closures or lapses. "
                  "Owner names of sole proprietors are dropped."),
    Dataset("short_term_rentals", SEATTLE, "s7df-xba4", "Short-term rental licenses", key=("licenseid", "unitid"),
            mode="full", topic="housing", where=BOX_NUM),
    Dataset("liquor_applications", "data.wa.gov", "vgcw-qfjm", "WSLCB notices to local authority (new liquor license applications, changes)",
            key=("license", "applicationdate", "l_a_type"), mode="full", topic="economy",
            where="upper(cityname) = 'SEATTLE' AND " + ZIP.format(col="zipcode"),
            drop=("designatedsignee", "dayphone", "contact", "applicants", "mailaddress", "mailroom", "mailcity",
                  "mailstate", "mailzip", "ubi"),
            notes="Only notices currently open are published, so history exists only from the daily pulls. "
                  "Applicant names, birthdates and phone numbers are dropped at ingest."),
    Dataset("liquor_licensees", "data.wa.gov", "9dee-kzm5", "WSLCB liquor licenses (renewal roster)",
            key=("license",), mode="full", topic="economy", where=ZIP.format(col="zipcode"),
            drop=("dayphone", "ubi", "mailaddress", "mailcity", "mailstate", "mailzip"),
            notes="Every licensed liquor business with its renewal date; appearances and disappearances over time."),
    Dataset("food_inspections", "data.kingcounty.gov", "r878-4sxa", "King County food establishment inspections",
            key=("inspection_serial_num", "violation_description"), mode="full", topic="economy",
            where="upper(city) = 'SEATTLE' AND " + ZIP.format(col="zip_code")),
    # ----------------------------------------------------------------- mobility
    Dataset("bridge_openings", SEATTLE, "gm8h-9449", "SDOT movable bridge openings (all bridges)",
            key=("entityid", "opendatetime"), time="opendatetime", start="2024-01-01", window_days=10, topic="mobility"),
    Dataset("parking_hourly", SEATTLE, "gg89-k5p6", "Paid parking payments per block face per hour (Ballard)",
            key=("elementkey", "d", "h"), mode="aggregate", time="transactiondatetime", start=None,
            window_days=7, topic="mobility", where=BOX_NUM,
            notes="Upstream keeps only the last ~7 days of transactions, so history exists only from the daily pulls.",
            select="elementkey, blockface_name, date_trunc_ymd(transactiondatetime) AS d, "
                   "date_extract_hh(transactiondatetime) AS h, count(*) AS payments, "
                   "sum(durationinminutes) AS paid_minutes, sum(amount_paid) AS paid_usd, "
                   "avg(latitude) AS lat, avg(longitude) AS lon",
            group="elementkey, blockface_name, d, h"),
    Dataset("fremont_bridge_bikes", SEATTLE, "65db-xm6k", "Fremont Bridge bicycle and scooter counter (hourly)",
            key=("date",), time="date", start="2012-10-01", window_days=45, topic="mobility",
            notes="The Ballard counter (NW 58th St Greenway) is out of service; Fremont is the nearest continuous one."),
    # ----------------------------------------------------------------- public health
    Dataset("wastewater_covid", "data.cdc.gov", "j9g8-acpt", "CDC wastewater: SARS-CoV-2 (King County sewersheds)",
            key=("record_id",), mode="full", topic="health",
            where="state_territory = 'wa' AND site IN ('2045','2046','2058')",
            notes="Site 2046 serves 789k people in King and Snohomish counties, consistent with West Point."),
    Dataset("wastewater_flu", "data.cdc.gov", "ymmh-divb", "CDC wastewater: influenza A (King County sewersheds)",
            key=("record_id",), mode="full", topic="health",
            where="state_territory = 'wa' AND site IN ('2045','2046','2058')"),
    Dataset("wastewater_levels", "data.cdc.gov", "atcp-73re", "CDC wastewater viral activity levels (SARS-CoV-2, flu A, RSV)",
            key=("site", "pathogen_target", "week_end"), mode="full", topic="health",
            where="state_territory = 'Washington' AND site IN ('ID:2045','ID:2046','ID:2058')"),
]
BY_NAME = {d.name: d for d in DATASETS}
