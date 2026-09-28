"""The lake: every pull is kept as an immutable Parquet batch (change-only), and each dataset is compacted into
`current.parquet` (the latest version of every record). A manifest records lineage and freshness.

    lake/
      manifest.json                    { dataset: { source, key, rows, batches, cursor, last_run, ... } }
      <dataset>/batches/<id>.parquet   raw rows as strings + _ingested_at, _batch, _op ('upsert' | 'delete')
      <dataset>/current.parquet        latest row per key (+ _first_seen, _last_seen, _active)

Raw values are stored as strings exactly as received (objects as JSON), so nothing is lost and schema drift
upstream never breaks ingestion. Types are applied later, in views (bo/views.py).
"""
import datetime as dt
import fcntl
import json
import os
import tempfile
from pathlib import Path

import duckdb

from .config import LAKE

META_COLS = ("_ingested_at", "_batch", "_op")


def now_iso():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _s(v):
    if v is None:
        return None
    if isinstance(v, (dict, list)):
        return json.dumps(v, separators=(",", ":"), sort_keys=True)
    return str(v)


def _q(name):
    return '"' + name.replace('"', '""') + '"'


class Lake:
    def __init__(self, root=LAKE):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._manifest_path = self.root / "manifest.json"

    # ------------------------------------------------------------ manifest
    def manifest(self):
        try:
            return json.loads(self._manifest_path.read_text())
        except FileNotFoundError:
            return {}

    def update_manifest(self, ds, **fields):
        """Merge fields into one dataset's manifest entry (under a lock: several ingest jobs may run at once)."""
        with open(self.root / ".manifest.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            m = self.manifest()
            m.setdefault(ds, {}).update(fields)
            tmp = self._manifest_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(m, indent=1, sort_keys=True, default=str))
            os.replace(tmp, self._manifest_path)
        return m[ds]

    def cursor(self, ds, default=None):
        return self.manifest().get(ds, {}).get("cursor", default)

    # ------------------------------------------------------------ paths
    def dir(self, ds):
        d = self.root / ds
        (d / "batches").mkdir(parents=True, exist_ok=True)
        return d

    def batches(self, ds):
        return sorted((self.root / ds / "batches").glob("*.parquet"))

    def current_path(self, ds):
        return self.root / ds / "current.parquet"

    # ------------------------------------------------------------ writing
    def write_batch(self, ds, rows, op="upsert"):
        """Append rows (list of dicts) as one immutable batch. Returns the batch path, or None when empty."""
        rows = list(rows)
        if not rows:
            return None
        batch = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        ing = now_iso()
        cols = sorted({k for r in rows for k in r} - set(META_COLS))
        out = self.dir(ds) / "batches" / f"{batch}.parquet"
        with tempfile.NamedTemporaryFile("w", suffix=".ndjson", delete=False) as f:
            for r in rows:
                rec = {c: _s(r.get(c)) for c in cols}
                rec.update({"_ingested_at": ing, "_batch": batch, "_op": r.get("_op", op)})
                f.write(json.dumps(rec, separators=(",", ":")) + "\n")
            tmp = f.name
        try:
            spec = ", ".join(f"{_q(c)}: 'VARCHAR'" for c in (*cols, *META_COLS))
            con = duckdb.connect()
            con.execute(f"COPY (SELECT * FROM read_json('{tmp}', format='newline_delimited', columns={{{spec}}})) "
                        f"TO '{out}' (FORMAT parquet, COMPRESSION zstd)")
            con.close()
        finally:
            os.unlink(tmp)
        return out

    # ------------------------------------------------------------ compaction
    def compact(self, ds, key, order=("_updated_at", "_ingested_at"), incremental=True):
        """Rebuild current.parquet: the latest row per key (by `order`), with first/last seen times and whether
        the record is still active (its latest op is not a delete).

        Incremental (default): merge only batches newer than those already reflected in current.parquet, so a
        run that has just the current tables (for example a CI job that downloaded them from the published
        lake) still compacts correctly. Full: rebuild from every batch."""
        cur = self.current_path(ds)
        files = self.batches(ds)
        con = duckdb.connect()
        keys = [key] if isinstance(key, str) else list(key)
        part = ", ".join(_q(k) for k in keys)
        if incremental and cur.exists():
            last = con.execute(f"SELECT max(_batch) FROM read_parquet('{cur}')").fetchone()[0] or ""
            new = [f for f in files if f.stem > last]
            if not new:
                n = con.execute(f"SELECT count(*) FROM read_parquet('{cur}')").fetchone()[0]
                con.close()
                return n
            newsrc = f"read_parquet({[str(f) for f in new]}, union_by_name=true)"
            con.execute(f"CREATE TEMP VIEW prev AS SELECT * FROM read_parquet('{cur}')")
            con.execute(f"CREATE TEMP VIEW nw AS SELECT * FROM {newsrc}")
            con.execute("CREATE TEMP VIEW allv AS SELECT * EXCLUDE (_first_seen, _last_seen, _active) FROM prev UNION ALL BY NAME SELECT * FROM nw")
            seen = f"""SELECT {part}, min(fs) AS _first_seen, max(ls) AS _last_seen FROM (
                         SELECT {part}, _first_seen AS fs, _last_seen AS ls FROM prev
                         UNION ALL SELECT {part}, _ingested_at AS fs, _ingested_at AS ls FROM nw) GROUP BY {part}"""
            cols = [r[0] for r in con.execute("DESCRIBE SELECT * FROM allv").fetchall()]
            ords = ", ".join(f"{_q(o)} DESC NULLS LAST" for o in order if o in cols) or "_ingested_at DESC"
            body = f"""SELECT a.* EXCLUDE (_rn), s._first_seen, s._last_seen, (a._op <> 'delete') AS _active
                       FROM (SELECT *, row_number() OVER (PARTITION BY {part} ORDER BY {ords}, _batch DESC) AS _rn FROM allv) a
                       JOIN ({seen}) s USING ({part}) WHERE a._rn = 1"""
        else:
            if not files:
                return 0
            src = f"read_parquet({[str(f) for f in files]}, union_by_name=true)"
            cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()]
            missing = [k for k in keys if k not in cols]
            if missing:
                raise ValueError(f"{ds}: key column(s) {missing} not in data")
            ords = ", ".join(f"{_q(o)} DESC NULLS LAST" for o in order if o in cols) or "_ingested_at DESC"
            body = f"""SELECT * EXCLUDE (_rn), (_op <> 'delete') AS _active FROM (
                         SELECT *, min(_ingested_at) OVER w AS _first_seen, max(_ingested_at) OVER w AS _last_seen,
                                row_number() OVER (PARTITION BY {part} ORDER BY {ords}, _batch DESC) AS _rn
                         FROM {src} WINDOW w AS (PARTITION BY {part})) WHERE _rn = 1"""
        tmp = cur.with_suffix(".tmp.parquet")
        con.execute(f"COPY ({body}) TO '{tmp}' (FORMAT parquet, COMPRESSION zstd)")
        n = con.execute(f"SELECT count(*) FROM read_parquet('{tmp}')").fetchone()[0]
        con.close()
        os.replace(tmp, cur)
        return n

    def keys(self, ds, key):
        """{key tuple: {"_hash": ...}} for the active records in current.parquet (for change detection).
        Only the key and hash columns are read, so this stays small even for large datasets."""
        p = self.current_path(ds)
        if not p.exists():
            return {}
        keys = [key] if isinstance(key, str) else list(key)
        con = duckdb.connect()
        cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{p}')").fetchall()]
        h = "_hash" if "_hash" in cols else "NULL"
        rows = con.execute(f"SELECT {', '.join(_q(k) for k in keys)}, {h} FROM read_parquet('{p}') WHERE _active").fetchall()
        con.close()
        return {tuple(r[:len(keys)]): {"_hash": r[-1]} for r in rows}
