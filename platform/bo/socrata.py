"""Socrata (SODA 2.x) client: counts, paged pulls with stable ordering, and time-sliced backfills."""
from .net import get_json

PAGE = 50000


def url(domain, dataset):
    return f"https://{domain}/resource/{dataset}.json"


def query(domain, dataset, **params):
    return get_json(url(domain, dataset), {f"${k}": v for k, v in params.items() if v is not None}, timeout=120)


def count(domain, dataset, where=None):
    rows = query(domain, dataset, select="count(*) AS n", where=where)
    return int(rows[0]["n"]) if rows else 0


def pull(domain, dataset, where=None, select=None, order=":id", page=PAGE, system_fields=True):
    """Yield every row matching `where`, page by page, in a stable order. With system_fields, each row also
    carries Socrata's :id, :created_at and :updated_at (used for change capture)."""
    sel = select or ("*, :id, :created_at, :updated_at" if system_fields else None)
    offset = 0
    while True:
        rows = query(domain, dataset, select=sel, where=where, order=order, limit=page, offset=offset)
        yield from rows
        if len(rows) < page:
            return
        offset += page
