"""All-pairs relationship discovery across every series in the matrix.

For each pair it tests whether day-to-day deviations of one series move with deviations of another, at a lag
of up to ±7 days, beyond what each series' own rhythms explain. The steps:

  1. residuals: counts are variance-stabilized (Anscombe); a centered 57-day moving average (slow drift,
     seasons, regime changes such as 2020) and the day-of-week pattern are removed; the result is standardized
  2. lagged cross-correlation with a circular-shift null (bo.engines.stats.lagged_xcorr_test)
  3. Benjamini–Hochberg FDR over every pair tested
  4. replication: the same sign and significance in both halves of the overlapping record
  5. common drivers: partial correlation after removing weather (temperature, rain, cloud) and holidays;
     relationships that weather fully explains are labeled as such, not hidden
  6. effect in real units: the slope of raw deviations at the best lag ("+2.1 calls per extra inch of rain")

Trivial pairs (a total vs its own parts, two weather variables, a bridge's openings vs its minutes open) are
never tested, so they can't crowd out real discoveries.
"""
import numpy as np

from . import stats

WEATHER_DRIVERS = ("wx.temp_max", "wx.precip", "wx.cloud", "wx.solar", "wx.wind_mean", "wx.rain_hours")
TOTALS = {"police.calls": "police.", "crime.all": "crime.", "fire.all": "fire.", "311.all": "311."}
PHYSICAL = ("wx.", "tide.")


# The same real-world event recorded by two agencies or two systems. These pairs are kept out of discovery and
# reported separately as cross-agency concordance (a data-quality check), never as findings.
CONCORDANT = [
    ("crime.car_prowl", "police.vehicle_theft"), ("crime.car_prowl", "police.theft"), ("crime.vehicle_theft", "police.vehicle_theft"),
    ("crime.burglary", "police.burglary"), ("crime.shoplifting", "police.theft"), ("crime.larceny_other", "police.theft"),
    ("crime.assault", "police.violence"), ("crime.robbery", "police.violence"), ("crime.vandalism", "police.theft"),
    ("crime.trespass", "police.disturbance"), ("crime.drugs", "police.disturbance"), ("fire.collision", "police.traffic_collision"),
    ("fire.medical", "police.crisis_welfare"), ("fire.all", "police.crisis_welfare"), ("311.all", "code.complaints"),
    ("311.all", "311.encampment"), ("311.all", "311.dumping"), ("fire.all", "fire.medical"),
]
CONCORDANT = {frozenset(p) for p in CONCORDANT}


def concordant(a, b):
    if frozenset((a, b)) in CONCORDANT:
        return True
    # a crime total vs any police category (and vice versa) measures the same incidents
    return ({a.split(".")[0], b.split(".")[0]} == {"crime", "police"}) and ("crime.all" in (a, b) or "police.calls" in (a, b))


def trivial(a, b):
    fa, fb = a.split(".")[0], b.split(".")[0]
    for tot, prefix in TOTALS.items():
        if (a == tot and b.startswith(prefix)) or (b == tot and a.startswith(prefix)):
            return True
    if a.startswith(PHYSICAL) and b.startswith(PHYSICAL):
        return True                                         # weather/tide physics is not a discovery
    if fa == fb == "bridge" and a.split(".")[1].split("_")[0] == b.split(".")[1].split("_")[0]:
        return True                                         # one bridge's openings vs its minutes open
    if {a, b} & {"police.response_p1_min"} and {a, b} & {"police.response_p2_min"}:
        return True
    return False


# Mechanisms everyone already knows (weather changes how many people are outside). They are still tested and
# kept, but ranked well below non-obvious findings.
def known_mechanism(a, b):
    da, db = a.split(".")[0], b.split(".")[0]
    env = {"wx", "tide"}
    if (da in env and db in {"bikes", "attention", "parking"}) or (db in env and da in {"bikes", "attention", "parking"}):
        return True
    if da == db == "attention":
        return True
    return False


def _rolling_mean(v, w=57, min_n=28):
    ok = np.isfinite(v)
    x = np.where(ok, v, 0.0)
    c = np.concatenate([[0.0], np.cumsum(x)])
    k = np.concatenate([[0.0], np.cumsum(ok.astype(float))])
    h = w // 2
    i = np.arange(len(v))
    lo, hi = np.clip(i - h, 0, len(v)), np.clip(i + h + 1, 0, len(v))
    n = k[hi] - k[lo]
    m = np.where(n >= min_n, (c[hi] - c[lo]) / np.maximum(n, 1), np.nan)
    return m


def _rolling_linear(v, w=57, min_n=28):
    """Local linear smoother (moving least-squares line, evaluated at the center). Unlike a moving average it
    follows seasonal slopes without lag or flattening, so seasonal structure can't leak into residuals."""
    v = np.asarray(v, float)
    ok = np.isfinite(v)
    t = np.arange(len(v), dtype=float)
    y = np.where(ok, v, 0.0)
    o = ok.astype(float)

    def csum(x):
        return np.concatenate([[0.0], np.cumsum(x)])

    S0, S1, S2 = csum(o), csum(o * t), csum(o * t * t)
    Sy, Sty = csum(y), csum(y * t)
    h = w // 2
    lo = np.clip(np.arange(len(v)) - h, 0, len(v))
    hi = np.clip(np.arange(len(v)) + h + 1, 0, len(v))
    s0, s1, s2 = S0[hi] - S0[lo], S1[hi] - S1[lo], S2[hi] - S2[lo]
    sy, sty = Sy[hi] - Sy[lo], Sty[hi] - Sty[lo]
    den = s0 * s2 - s1 * s1
    beta = np.where(den > 0, (s0 * sty - s1 * sy) / np.where(den > 0, den, 1), 0.0)
    alpha = np.where(s0 > 0, (sy - beta * s1) / np.maximum(s0, 1), np.nan)
    out = alpha + beta * t
    return np.where(s0 >= min_n, out, np.nan)


def residuals(dates, v, kind, hol=None, clip=4.0):
    """High-pass, weekday- and holiday-adjusted, standardized residuals (NaN where unknown), winsorized at
    +-clip SD so a handful of extreme days (snowstorms, the March 2020 shutdown) can't drive a correlation.
    Also returns raw deviations (same units as v) for effect sizes."""
    v = np.asarray(v, float)
    x = 2.0 * np.sqrt(np.maximum(v, 0) + 0.375) if kind == "count" else v.copy()
    dev_raw = v - _rolling_linear(v)
    dev = x - _rolling_linear(x)
    dow = (dates.astype("datetime64[D]").astype("int64") + 3) % 7
    if hol is not None:                                   # holidays: remove their average effect
        for arr in (dev, dev_raw):
            m = (hol == 1) & np.isfinite(arr)
            if m.sum() > 10:
                arr[hol == 1] -= np.nanmean(arr[m])
    # weekday effects that drift with the season: subtract, for each day, the mean of the same weekday over the
    # surrounding +-8 weeks (every 7th day), so "Saturday in July" and "Saturday in January" are adjusted separately
    for arr in (dev, dev_raw):
        adj = np.full_like(arr, np.nan)
        for k in range(7):
            idx = np.flatnonzero(dow == k)
            sub = arr[idx]
            if hol is not None:
                sub = np.where(hol[idx] == 1, np.nan, sub)
            adj[idx] = _rolling_linear(sub, w=17, min_n=8)
        arr -= np.where(np.isfinite(adj), adj, 0.0)
    sd = np.nanstd(dev)
    z = dev / sd if sd > 0 else dev * 0
    return np.clip(z, -clip, clip), dev_raw


def us_holidays(dates):
    """Federal holidays (observed), New Year's Eve and the day after Thanksgiving, as a 0/1 array."""
    d = dates.astype("datetime64[D]")
    years = np.unique(d.astype("datetime64[Y]").astype(int) + 1970)
    hol = set()

    def nth(y, m, wd, n):  # n-th weekday (0=Mon) of month; n=-1 last
        days = np.arange(np.datetime64(f"{y}-{m:02d}-01"), np.datetime64(f"{y}-{m:02d}-01") + np.timedelta64(31, "D"))
        days = days[(days.astype("datetime64[M]") == np.datetime64(f"{y}-{m:02d}"))]
        wds = (days.astype("int64") + 3) % 7
        cand = days[wds == wd]
        return cand[n] if n >= 0 else cand[-1]

    for y in years:
        for md in ("01-01", "06-19", "07-04", "11-11", "12-25", "12-31"):
            if md == "06-19" and y < 2021:
                continue
            hol.add(np.datetime64(f"{y}-{md}"))
        hol.add(nth(y, 1, 0, 2))      # MLK
        hol.add(nth(y, 2, 0, 2))      # Presidents
        hol.add(nth(y, 5, 0, -1))     # Memorial
        hol.add(nth(y, 9, 0, 0))      # Labor
        hol.add(nth(y, 10, 0, 1))     # Columbus / Indigenous Peoples
        tg = nth(y, 11, 3, 3)         # Thanksgiving
        hol.add(tg)
        hol.add(tg + np.timedelta64(1, "D"))
    return np.isin(d, np.array(sorted(hol), dtype="datetime64[D]")).astype(float)


def discover(dates, values, meta, max_lag=7, min_overlap=730, q_max=0.01):
    names = sorted(values)
    hol = us_holidays(dates)
    res = {}
    raw = {}
    for n in names:
        res[n], raw[n] = residuals(dates, values[n], meta[n]["kind"], hol)
    drivers = [res[w] for w in WEATHER_DRIVERS if w in res]
    tests = []
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            if trivial(a, b) or concordant(a, b):
                continue
            ok = np.isfinite(res[a]) & np.isfinite(res[b])
            if ok.sum() < min_overlap:
                continue
            idx = np.flatnonzero(ok)
            lo, hi = idx[0], idx[-1] + 1
            ra, rb = res[a][lo:hi], res[b][lo:hi]
            t = stats.lagged_xcorr_test(ra, rb, max_lag=max_lag, period=7)
            t.update(a=a, b=b, lo=int(lo), hi=int(hi), overlap=int(ok.sum()))
            tests.append(t)
    if not tests:
        return [], 0
    q = stats.bh([t["p"] for t in tests])
    out = []
    for t, qq in zip(tests, q):
        t["q"] = float(qq)
        if qq > q_max:
            continue
        a, b, lag, lo, hi = t["a"], t["b"], t["lag"], t["lo"], t["hi"]
        # align at the best lag: lag > 0 means a leads b
        xa, xb = res[a][lo:hi], res[b][lo:hi]
        ya, yb = raw[a][lo:hi], raw[b][lo:hi]
        if lag > 0:
            xa, xb, ya, yb = xa[:-lag], xb[lag:], ya[:-lag], yb[lag:]
        elif lag < 0:
            xa, xb, ya, yb = xa[-lag:], xb[:lag], ya[-lag:], yb[:lag]
        # replication in both halves
        mid = len(xa) // 2
        halves = []
        for s in (slice(0, mid), slice(mid, None)):
            h = stats.lagged_xcorr_test(xa[s], xb[s], max_lag=0, min_shift=30)
            halves.append(h)
        t["replicated"] = bool(all(h["p"] < 0.05 and np.sign(h["r"]) == np.sign(t["r"]) for h in halves))
        t["halves"] = [{"r": h["r"], "p": h["p"]} for h in halves]
        # common drivers (weather + holidays) at the same alignment
        Z = []
        for d in drivers + [hol]:
            dd = d[lo:hi]
            dd = dd[:-lag] if lag > 0 else dd[-lag:] if lag < 0 else dd
            Z.append(dd)
        if Z and not (a.startswith("wx.") or b.startswith("wx.")):
            pr, _ = stats.partial_corr(xa, xb, np.column_stack(Z))
            t["partial_r"] = pr
            t["weather_explained"] = bool(np.isfinite(pr) and abs(pr) < 0.5 * abs(t["r"]))
        else:
            t["partial_r"], t["weather_explained"] = None, False
        # effect in raw units
        ok = np.isfinite(ya) & np.isfinite(yb)
        if ok.sum() > 30 and np.nanstd(ya[ok]) > 0 and np.nanstd(yb[ok]) > 0:
            # robust slopes both ways on winsorized raw deviations (b per unit a, and a per unit b)
            wa = np.clip(ya[ok], *np.percentile(ya[ok], [1, 99]))
            wb = np.clip(yb[ok], *np.percentile(yb[ok], [1, 99]))
            t["slope"] = float(np.polyfit(wa, wb, 1)[0])
            t["slope_ba"] = float(np.polyfit(wb, wa, 1)[0])
            t["sd_a"] = float(np.std(wa))
            t["sd_b"] = float(np.std(wb))
        da, db = meta[a]["domain"], meta[b]["domain"]
        t["cross_domain"] = da != db
        t["known_mechanism"] = known_mechanism(a, b)
        t["domains"] = [da, db]
        t["first"] = str(dates[lo])
        t["last"] = str(dates[hi - 1])
        out.append(t)
    for t in out:
        t["score"] = abs(t["r"]) * min(-np.log10(max(t["q"], 1e-300)), 30) * (0.25 if t["known_mechanism"] else 1.0)
    out.sort(key=lambda t: (not t["replicated"], -t["score"]))
    return out, len(tests)
