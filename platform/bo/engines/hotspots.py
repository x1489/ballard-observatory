"""Emerging hotspots: the prospective space-time permutation scan statistic (Kulldorff et al., PLoS Med 2005),
the method health departments use to spot disease outbreaks from case counts alone.

For one kind of event over the last `days` days (default 365):
  cells      H3 resolution-9 hexagons (~0.1 km², ~175 m across)
  regions    each cell with its k-ring neighbors, k = 0, 1, 2 (~0.2, ~0.5, ~0.9 km across)
  windows    the most recent 3, 7, 14 and 28 days (prospective: a cluster must be alive now)
  expected   mu = C_region * C_window / C  (space and time marginals; no population data needed)
  statistic  Poisson log-likelihood ratio for c > mu
  p-value    Monte Carlo: event dates are shuffled among events (each keeps its cell), which preserves both
             marginals; the maximum statistic over all regions and windows is recorded for each replicate

Only the most significant non-overlapping clusters are reported. The recurrence interval, 1/p in days, is how
often a cluster this strong would appear by chance if the scan runs daily.
"""
import numpy as np
import scipy.sparse as sp

WINDOWS = (3, 7, 14, 28)


def _llr(c, mu, C):
    c = np.asarray(c, float)
    mu = np.asarray(mu, float)
    out = np.zeros_like(c)
    m = (c > mu) & (mu > 0)
    cm, mm = c[m], mu[m]
    out[m] = cm * np.log(cm / mm) + np.where(C - cm > 0, (C - cm) * np.log((C - cm) / np.maximum(C - mm, 1e-12)), 0.0)
    return out


def scan(cells, days, last_day, h3mod, n_rep=199, k_max=2, rng=None, max_clusters=5, min_cases=4):
    """cells: array of H3 cell strings per event; days: integer day index per event (last_day = most recent).
    Returns a list of cluster dicts sorted by p."""
    rng = rng or np.random.default_rng(12345)
    cells = np.asarray(cells)
    days = np.asarray(days, int)
    ok = (cells != None) & (days <= last_day) & (days > last_day - 365)    # noqa: E711
    cells, days = cells[ok], days[ok]
    C = len(cells)
    if C < 50:
        return []
    uniq, cidx = np.unique(cells, return_inverse=True)
    ncell = len(uniq)
    pos = {c: i for i, c in enumerate(uniq)}
    # regions: (center, k) -> member cells present in data
    rows, cols, meta = [], [], []
    for i, c in enumerate(uniq):
        for k in range(k_max + 1):
            members = [pos[m] for m in h3mod.grid_disk(c, k) if m in pos]
            r = len(meta)
            meta.append((i, k, members))
            rows.extend([r] * len(members))
            cols.extend(members)
    A = sp.csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(len(meta), ncell))
    Cz = np.bincount(cidx, minlength=ncell).astype(float)
    CR = A @ Cz                                               # events per region over the whole period
    day_counts = np.bincount(last_day - days, minlength=366)  # 0 = last day
    CW = np.array([day_counts[:w].sum() for w in WINDOWS], float)

    def counts(dvec):
        age = last_day - dvec
        E = np.zeros((ncell, len(WINDOWS)))
        for j, w in enumerate(WINDOWS):
            m = age < w
            E[:, j] = np.bincount(cidx[m], minlength=ncell)
        return A @ E                                          # regions x windows

    obs = counts(days)
    MU = np.outer(CR, CW) / C
    L = _llr(obs, MU, C)
    L[obs < min_cases] = 0.0
    maxes = np.empty(n_rep)
    for r in range(n_rep):
        L0 = _llr(counts(rng.permutation(days)), MU, C)
        maxes[r] = L0.max()
    found, used = [], set()
    order = np.dstack(np.unravel_index(np.argsort(-L, axis=None), L.shape))[0]
    for ri, wj in order:
        llr = L[ri, wj]
        if llr <= 0 or len(found) >= max_clusters:
            break
        center, k, members = meta[ri]
        if used & set(members):
            continue                                          # overlaps a stronger cluster
        p = (1 + np.sum(maxes >= llr)) / (n_rep + 1)
        if p > 0.05:
            break
        used |= set(members)
        found.append({"center": str(uniq[center]), "k": int(k), "cells": [str(uniq[m]) for m in members],
                      "window_days": int(WINDOWS[wj]), "observed": int(obs[ri, wj]), "expected": float(MU[ri, wj]),
                      "relative_risk": float(obs[ri, wj] / MU[ri, wj]) if MU[ri, wj] > 0 else None,
                      "llr": float(llr), "p": float(p), "recurrence_days": float(1 / p), "total_events": int(C)})
    return found
