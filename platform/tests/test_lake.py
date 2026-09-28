"""The lake must compact identically whether it rebuilds from every batch or merges only new batches into the
current table (the CI path, which downloads only current tables)."""
import duckdb

from bo.lake import Lake


def _rows(p):
    con = duckdb.connect()
    return sorted(con.execute(f"SELECT id, v, _active FROM read_parquet('{p}')").fetchall())


def test_incremental_equals_full(tmp_path):
    a = Lake(tmp_path / "a")
    a.write_batch("t", [{"id": "1", "v": "x"}, {"id": "2", "v": "y"}])
    a.compact("t", ("id",))
    a.write_batch("t", [{"id": "2", "v": "y2"}, {"id": "3", "v": "z"}])
    a.write_batch("t", [{"id": "1"}], op="delete")
    inc = a.compact("t", ("id",), incremental=True)
    rows_inc = _rows(a.current_path("t"))
    full = a.compact("t", ("id",), incremental=False)
    rows_full = _rows(a.current_path("t"))
    assert inc == full == 3
    assert rows_inc == rows_full == [("1", None, False), ("2", "y2", True), ("3", "z", True)]


def test_incremental_without_old_batches(tmp_path):
    """CI case: only current.parquet exists locally, then a new batch arrives."""
    import shutil
    a = Lake(tmp_path / "a")
    a.write_batch("t", [{"id": "1", "v": "x"}])
    a.compact("t", ("id",))
    shutil.rmtree(tmp_path / "a" / "t" / "batches")           # simulate a fresh CI checkout of current tables only
    a.write_batch("t", [{"id": "1", "v": "x2"}, {"id": "9", "v": "n"}])
    assert a.compact("t", ("id",)) == 2
    assert _rows(a.current_path("t")) == [("1", "x2", True), ("9", "n", True)]
