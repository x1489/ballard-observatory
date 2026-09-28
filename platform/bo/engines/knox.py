"""Space-time interaction (Knox test): near-repeats within one kind of event, and cascades between kinds.

Question answered: after an event of kind A, is an event of kind B more likely than chance nearby (within
`d_m` meters) and soon after (within `t_days` days)? For A = B this is the criminology "near-repeat" effect
(one burglary raises the risk on the same block for days).

  pairs      every (a, b) with distance in (d_min_m, d_m] is found once with a KD-tree; for one kind, pairs
             closer than d_min_m within 2 days are dropped as likely duplicate reports of the same thing
  observed   pairs with 0 < day_b - day_a <= t_days
  null       Monte Carlo: dates are shuffled among B events (locations fixed), which keeps where things
             happen and when things happen but breaks any link between the two
  p-value    normal tail from the permutation mean and spread, or the empirical rate when that is larger
  report     Knox ratio = observed / expected, with the permutation 95 % interval
"""
import numpy as np
from scipy import stats as st
from scipy.spatial import cKDTree

M_PER_DEG_LAT = 111_320.0


def _xy(lat, lon, lat0):
    return np.column_stack([(lon * M_PER_DEG_LAT * np.cos(np.radians(lat0))), lat * M_PER_DEG_LAT])


def interaction(a, b=None, d_m=150, t_days=7, d_min_m=30, dup_days=2, n_rep=199, rng=None, max_pairs=20_000_000):
    """a, b: dicts with numpy arrays lat, lon, day (int days on a shared origin). b=None tests near-repeats of a.
    Returns dict or None when there is too little data."""
    rng = rng or np.random.default_rng(2024)
    same = b is None
    b = a if same else b
    if len(a["day"]) < 30 or len(b["day"]) < 30:
        return None
    lat0 = float(np.mean(a["lat"]))
    ta, tb = cKDTree(_xy(a["lat"], a["lon"], lat0)), cKDTree(_xy(b["lat"], b["lon"], lat0))
    pairs = ta.query_ball_tree(tb, r=d_m)
    ia = np.repeat(np.arange(len(pairs)), [len(p) for p in pairs])
    ib = np.concatenate([np.asarray(p, dtype=np.int64) for p in pairs]) if len(ia) else np.zeros(0, np.int64)
    if len(ia) > max_pairs:
        return None
    if same:
        keep = ia != ib
        ia, ib = ia[keep], ib[keep]
    if d_min_m and same and len(ia):
        dxy = _xy(a["lat"][ia], a["lon"][ia], lat0) - _xy(b["lat"][ib], b["lon"][ib], lat0)
        dist = np.hypot(dxy[:, 0], dxy[:, 1])
        dt = np.abs(b["day"][ib] - a["day"][ia])
        keep = ~((dist < d_min_m) & (dt <= dup_days))          # likely duplicate reports of one incident
        ia, ib = ia[keep], ib[keep]
    da = a["day"][ia]
    bd = b["day"]

    def count(days_b):
        dt = days_b[ib] - da
        return int(np.count_nonzero((dt > 0) & (dt <= t_days)))

    obs = count(bd)
    null = np.array([count(rng.permutation(bd)) for _ in range(n_rep)], float)
    mu, sd = null.mean(), null.std(ddof=1)
    exceed = int(np.sum(null >= obs))
    p_emp = (1 + exceed) / (1 + n_rep)
    p_par = float(st.norm.sf((obs - mu) / sd)) if sd > 0 else (0.0 if obs > mu else 1.0)
    p = max(p_par, p_emp) if exceed > 0 else p_par
    lo, hi = np.percentile(null, [2.5, 97.5])
    return {"observed": obs, "expected": float(mu), "ratio": float(obs / mu) if mu > 0 else None,
            "p": float(min(1.0, p)), "z": float((obs - mu) / sd) if sd > 0 else None, "null_95": [float(lo), float(hi)],
            "d_m": d_m, "t_days": t_days, "n_a": int(len(a["day"])), "n_b": int(len(bd)), "spatial_pairs": int(len(ia))}
