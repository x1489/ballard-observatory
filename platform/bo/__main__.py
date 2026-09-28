"""Command line: python -m bo <command>

  census [names…]         count upstream rows matching each dataset's Ballard filter (no download)
  ingest [names…]         backfill + refresh datasets into the lake (all when no names)
  status                  the lake manifest: rows, freshness, lineage
"""
import argparse
import json
import sys

from .lake import Lake
from .registry import BY_NAME, DATASETS


def main(argv=None):
    ap = argparse.ArgumentParser(prog="bo")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("census", "ingest"):
        p = sub.add_parser(name)
        p.add_argument("names", nargs="*")
        if name == "ingest":
            p.add_argument("--no-backfill", action="store_true")
    sub.add_parser("status")
    for extra in _extra_commands():
        extra(sub)
    a = ap.parse_args(argv)
    if a.cmd in ("census", "ingest"):
        targets = [BY_NAME[n] for n in a.names] if a.names else DATASETS
        unknown = [n for n in a.names if n not in BY_NAME]
        if unknown:
            ap.error(f"unknown datasets: {unknown}")
    if a.cmd == "census":
        from .connectors.socrata_ds import census
        for d in targets:
            print(json.dumps(census(d)), flush=True)
    elif a.cmd == "ingest":
        from .connectors.socrata_ds import run
        lake = Lake()
        failed = []
        for d in targets:
            print(f"== {d.name} ({d.id})", file=sys.stderr, flush=True)
            try:
                run(d, lake, backfill=not a.no_backfill)
            except Exception as e:                               # noqa: BLE001 - one bad source never stops the rest
                failed.append(d.name)
                print(f"  FAILED {d.name}: {e}", file=sys.stderr, flush=True)
                Lake().update_manifest(d.name, last_error=str(e)[:500])
        if failed:
            print(f"failed: {failed}", file=sys.stderr)
            return 1
    elif a.cmd == "status":
        print(json.dumps(Lake().manifest(), indent=1))
    elif hasattr(a, "func"):
        return a.func(a)
    return 0


def _extra_commands():
    """Commands registered by other modules (connectors, engines) without import cycles."""
    out = []
    try:
        from .commands import register_all
        out.extend(register_all())
    except ImportError:
        pass
    return out


if __name__ == "__main__":
    sys.exit(main())
