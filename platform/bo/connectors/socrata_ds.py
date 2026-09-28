"""Run any registry Dataset into the lake: backfill, incremental refresh, change-only storage."""
import datetime as dt
import hashlib
import json
import sys

from .. import socrata
from ..lake import Lake
from ..registry import Dataset

SYSTEM = (":id", ":created_at", ":updated_at")
SOLE = ("INDIVIDUAL", "SOLE PROP", "SOLE-PROP", "SOLE PROPRIETOR")


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def scrub(ds: Dataset, row: dict) -> dict:
    """Drop personal fields and normalize system fields. Content hash excludes system fields."""
    out = {k: v for k, v in row.items() if k not in ds.drop and k not in SYSTEM}
    if ds.name == "business_licenses" and any(s in str(row.get("ownership_type", "")).upper() for s in SOLE):
        out.pop("business_legal_name", None)          # a sole proprietor's legal name is a person's name
    content = json.dumps(out, sort_keys=True, separators=(",", ":"), default=str)
    out["_hash"] = hashlib.sha1(content.encode()).hexdigest()
    out["_updated_at"] = row.get(":updated_at")
    out["_source_id"] = row.get(":id")
    return out


def key_of(ds, row):
    return tuple(str(row.get(k)) if row.get(k) is not None else None for k in ds.key)


def _changed(ds, rows, current):
    """Rows whose content differs from the stored current version (by key + content hash)."""
    out = []
    for r in rows:
        cur = current.get(key_of(ds, r))
        if cur is None or cur.get("_hash") != r["_hash"]:
            out.append(r)
    return out


def _months(start, end):
    d = dt.date.fromisoformat(start).replace(day=1)
    while d <= end:
        nxt = (d.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
        yield d, nxt
        d = nxt


def _and(*parts):
    parts = [p for p in parts if p]
    return " AND ".join(f"({p})" for p in parts) if parts else None


def run(ds: Dataset, lake: Lake, backfill=True, today=None):
    today = today or dt.date.today()
    state = lake.manifest().get(ds.name, {})
    stored = 0
    if ds.mode in ("window", "aggregate"):
        done_through = state.get("backfilled_through")          # last fully backfilled month start (YYYY-MM-DD)
        current = lake.keys(ds.name, ds.key)
        # 1. backfill whole months not yet stored
        if backfill and ds.start:
            first = done_through or ds.start
            months = list(_months(first, today))
            if done_through:
                months = months[1:]                              # that month is complete
            for a, b in months:
                if b > today:
                    break                                        # the running month is handled by the window
                rows = _pull(ds, _and(ds.where_sql(), f"{ds.time} >= '{a.isoformat()}T00:00:00' AND {ds.time} < '{b.isoformat()}T00:00:00'"))
                new = _changed(ds, rows, current)
                if new:
                    lake.write_batch(ds.name, new)
                    for r in new:
                        current[key_of(ds, r)] = {"_hash": r["_hash"]}
                stored += len(new)
                lake.update_manifest(ds.name, backfilled_through=a.isoformat())
                log(f"  {ds.name} {a:%Y-%m}: {len(rows)} rows, {len(new)} new/changed")
        # 2. refresh the recent window
        # the window also covers the running month, which the month-by-month backfill skips until it is complete
        since = min(today - dt.timedelta(days=ds.window_days), today.replace(day=1)).isoformat()
        rows = _pull(ds, _and(ds.where_sql(), f"{ds.time} >= '{since}T00:00:00'"))
        new = _changed(ds, rows, current)
        if new:
            lake.write_batch(ds.name, new)
        stored += len(new)
        log(f"  {ds.name} window {since}..: {len(rows)} rows, {len(new)} new/changed")
    elif ds.mode == "full":
        current = lake.keys(ds.name, ds.key)
        rows = _pull(ds, ds.where_sql())
        new = _changed(ds, rows, current)
        seen = {key_of(ds, r) for r in rows}
        gone = [dict(zip(ds.key, k), _op="delete") for k in current if k not in seen]
        if rows and len(gone) > 0.5 * max(1, len(current)):
            log(f"  {ds.name}: {len(gone)} of {len(current)} records vanished at once; not recording deletes (upstream glitch?)")
            gone = []
        if new:
            lake.write_batch(ds.name, new)
        if gone:
            lake.write_batch(ds.name, gone, op="delete")
        stored += len(new) + len(gone)
        log(f"  {ds.name}: {len(rows)} rows, {len(new)} new/changed, {len(gone)} gone")
    else:
        raise ValueError(f"unknown mode {ds.mode}")
    n = lake.compact(ds.name, ds.key) if lake.batches(ds.name) else 0
    lake.update_manifest(ds.name, title=ds.title, source=ds.source_url, key=list(ds.key), mode=ds.mode, topic=ds.topic,
                         rows=n, last_run=dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                         stored_last_run=stored, notes=ds.notes, dropped_fields=list(ds.drop))
    return stored


def _pull(ds, where):
    if ds.mode == "aggregate":
        rows = []
        offset = 0
        while True:
            page = socrata.query(ds.domain, ds.id, select=ds.select, where=where, group=ds.group,
                                 order=", ".join(ds.key), limit=socrata.PAGE, offset=offset)
            rows += page
            if len(page) < socrata.PAGE:
                break
            offset += socrata.PAGE
        return [scrub(ds, r) for r in rows]
    return [scrub(ds, r) for r in socrata.pull(ds.domain, ds.id, where=where)]


def census(ds: Dataset):
    """How many upstream rows match the study-area filter (and the time span), without downloading them."""
    info = {"dataset": ds.name, "id": ds.id}
    try:
        info["rows"] = socrata.count(ds.domain, ds.id, ds.where_sql())
        if ds.time:
            r = socrata.query(ds.domain, ds.id, select=f"min({ds.time}) AS first, max({ds.time}) AS last", where=ds.where_sql())
            if r:
                info.update(first=r[0].get("first"), last=r[0].get("last"))
    except Exception as e:                                        # noqa: BLE001 - report and continue
        info["error"] = str(e)[:300]
    return info
