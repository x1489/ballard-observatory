"""Recent anomalies and structural changes.

anomalies()   For every count series: is the last 7 or 28 days above or below what is expected for those
              specific dates? Expected comes from a quasi-Poisson model of the previous three years
              (day of week, annual harmonics, trend frozen at the end of training). Tails use the fitted
              overdispersion. BH-FDR across all series and windows.
changes()     For monthly aggregates over the last five years: the single most likely shift in level
              (after removing month-of-year effects), with a permutation p-value, reported only when
              recent (within 24 months), significant and material (>= 15 %).
"""
import numpy as np

from . import stats


def anomalies(dates, values, meta, windows=(7, 28), train_days=3 * 365, q_max=0.05, min_rel=0.25, delay_cdf=None, asof=None):
    """delay_cdf: {series_prefix: F} where F[k] = share of events reported within k days (reporting-delay
    nowcast); asof: numpy datetime64 of the last report date. Windows end at the last complete day (the most
    recent day in a dataset is usually partial)."""
    out = []
    for name, v in values.items():
        m = meta[name]
        if m["kind"] != "count":
            continue
        ok = np.flatnonzero(np.isfinite(v))
        if len(ok) < train_days // 2:
            continue
        end = ok[-1] - 1                                   # last complete day
        F = None
        for prefix, cdf in sorted((delay_cdf or {}).items(), key=lambda kv: len(kv[0])):
            if name.startswith(prefix):
                F = cdf                                   # the most specific matching curve wins
        for w in windows:
            ev = slice(end - w + 1, end + 1)
            tr = slice(max(ok[0], end - w + 1 - train_days), end - w + 1)
            y_tr = v[tr]
            if np.isnan(y_tr).mean() > 0.2 or np.nansum(y_tr) < 50:
                continue
            X = stats.design_daily(dates[tr.start:ev.stop])
            Xtr, Xev = X[: tr.stop - tr.start], X[tr.stop - tr.start:].copy()
            Xev[:, 1] = Xtr[-1, 1]                       # freeze the trend at the end of training
            good = np.isfinite(y_tr)
            beta, mu, phi = stats.fit_quasi_poisson(y_tr[good], Xtr[good])
            mu_ev = np.exp(np.clip(Xev @ beta, -20, 20))
            if F is not None and asof is not None:
                age = (asof - dates[ev]).astype(int)
                mu_ev = mu_ev * F[np.clip(age, 0, len(F) - 1)]   # only the share reported so far
            e = float(mu_ev.sum())
            o = float(np.nansum(v[ev]))
            p_hi, p_lo = stats.poisson_tail(o, e, phi)
            out.append({"series": name, "window_days": w, "observed": o, "expected": e, "ratio": o / e if e > 0 else None,
                        "phi": phi, "p": min(1.0, min(p_hi, p_lo) * 2), "direction": "above" if o > e else "below",
                        "end": str(dates[end]), "start": str(dates[end - w + 1]), "nowcast": F is not None})
    if not out:
        return []
    q = stats.bh([a["p"] for a in out])
    res = []
    for a, qq in zip(out, q):
        a["q"] = float(qq)
        if qq <= q_max and a["ratio"] is not None and abs(a["ratio"] - 1) >= min_rel and a["expected"] >= 3:
            res.append(a)
    res.sort(key=lambda a: a["q"])
    return res


def _monthly(dates, v, kind):
    months = dates.astype("datetime64[M]")
    um = np.unique(months)
    vals = []
    for mth in um:
        sel = (months == mth) & np.isfinite(v)
        n_days = int(((months == mth)).sum())
        if sel.sum() < 0.8 * n_days:
            vals.append(np.nan)
        elif kind == "count":
            vals.append(v[sel].sum() * n_days / sel.sum())
        else:
            vals.append(np.median(v[sel]))
    return um, np.array(vals, float)


def changes(dates, values, meta, years=5, min_side=6, n_perm=999, rng=None, recent_months=24, min_effect=0.15):
    rng = rng or np.random.default_rng(7)
    res = []
    for name, v in values.items():
        m = meta[name]
        um, mv = _monthly(dates, v, m["kind"])
        keep = np.isfinite(mv)
        um, mv = um[keep], mv[keep]
        if len(mv) < 36:
            continue
        um, mv = um[-12 * years:], mv[-12 * years:]
        # drop the current (partial) month if it's the last one
        if len(mv) < 30 or np.all(mv == 0):
            continue
        x = np.log(mv + 1.0) if m["kind"] == "count" else mv.copy()
        moy = um.astype("int64") % 12
        for k in range(12):
            s = moy == k
            if s.sum() >= 2:
                x[s] -= x[s].mean() - x.mean()        # remove month-of-year effects, keep the level
        n = len(x)

        def best_split(z):
            cs = np.cumsum(z)
            tot = cs[-1]
            best, at = 0.0, None
            for i in range(min_side, n - min_side + 1):
                m1 = cs[i - 1] / i
                m2 = (tot - cs[i - 1]) / (n - i)
                stat = abs(m2 - m1) * np.sqrt(i * (n - i) / n)
                if stat > best:
                    best, at = stat, i
            return best, at

        stat, at = best_split(x)
        if at is None:
            continue
        resid = x - np.where(np.arange(n) < at, x[:at].mean(), x[at:].mean())
        null = np.empty(n_perm)
        # permutation of residuals around the overall mean (no change); block shuffles keep short-range structure
        base = x - x.mean()
        blocks = [base[i:i + 3] for i in range(0, n, 3)]
        for r in range(n_perm):
            order = rng.permutation(len(blocks))
            null[r] = best_split(np.concatenate([blocks[j] for j in order]))[0]
        p = (1 + np.sum(null >= stat)) / (n_perm + 1)
        before = float(np.mean(mv[:at]))
        after = float(np.mean(mv[at:]))
        rel = (after - before) / before if before else None
        months_ago = n - at
        if p <= 0.01 and rel is not None and abs(rel) >= min_effect and months_ago <= recent_months:
            res.append({"series": name, "since": str(um[at]), "before": before, "after": after, "relative": rel,
                        "p": float(p), "months_after": int(months_ago), "months_before": int(at),
                        "residual_sd": float(np.std(resid))})
    res.sort(key=lambda c: c["p"])
    return res
