"""Extra CLI commands (registered into `python -m bo`)."""
import sys


def _series(a):
    from .connectors import series
    from .lake import Lake
    lake = Lake()
    names = a.names or list(series.ALL)
    failed = []
    for n in names:
        print(f"== {n}", file=sys.stderr, flush=True)
        try:
            series.ALL[n](lake)
        except Exception as e:                                   # noqa: BLE001
            failed.append(n)
            print(f"  FAILED {n}: {e}", file=sys.stderr, flush=True)
            lake.update_manifest(n, last_error=str(e)[:500])
    return 1 if failed else 0


def _engines(a):
    from .engines.run import run
    run()
    return 0


def register_all():
    def series_cmd(sub):
        p = sub.add_parser("series", help="weather, tides, pageviews, council")
        p.add_argument("names", nargs="*")
        p.set_defaults(func=_series)
    def engines_cmd(sub):
        p = sub.add_parser("engines", help="run every discovery engine and write lake/_out/")
        p.set_defaults(func=_engines)
    return [series_cmd, engines_cmd]
