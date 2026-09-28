"""Statistics shared by the engines (numpy/scipy only).

  design_daily(dates)            calendar design matrix: day-of-week, annual harmonics, linear trend
  fit_quasi_poisson(y, X)        Poisson GLM by IRLS with a Pearson dispersion estimate (overdispersion-safe)
  deseasonalize(y, X, counts)    residuals after removing calendar structure (Anscombe transform for counts)
  lagged_xcorr_test(a, b, K)     best lag in [-K, K] and a p-value from circular-shift surrogates (FFT, exact)
  bh(pvals)                      Benjamini–Hochberg q-values
  poisson_tail(o, e, phi)        upper/lower tail p for an observed count vs an overdispersed expectation
"""
import numpy as np
from scipy import stats as st

# ------------------------------------------------------------------ design matrices


def design_daily(dates, harmonics=2, trend=True):
    """dates: numpy datetime64[D] array. Columns: intercept, trend (years), dow dummies (Mon..Sat vs Sun),
    and annual sin/cos harmonics."""
    d = dates.astype("datetime64[D]")
    n = len(d)
    t = (d - d[0]).astype(float) / 365.25
    dow = (d.astype("int64") + 3) % 7                     # 1970-01-01 was a Thursday -> Monday = 0
    doy = (d - d.astype("datetime64[Y]")).astype(float)
    cols = [np.ones(n)]
    if trend:
        cols.append(t - t.mean())
    for k in range(6):
        cols.append((dow == k).astype(float))
    for h in range(1, harmonics + 1):
        cols.append(np.sin(2 * np.pi * h * doy / 365.25))
        cols.append(np.cos(2 * np.pi * h * doy / 365.25))
    return np.column_stack(cols)


def design_hourly(times, harmonics=2):
    """times: datetime64[h]. Hour-of-week dummies (167) + annual harmonics + intercept."""
    h = times.astype("datetime64[h]").astype("int64")
    how = ((h // 24 + 3) % 7) * 24 + (h % 24)
    n = len(h)
    cols = [np.ones(n)]
    for k in range(1, 168):
        cols.append((how == k).astype(float))
    doy = (h / 24.0) % 365.25
    for k in range(1, harmonics + 1):
        cols.append(np.sin(2 * np.pi * k * doy / 365.25))
        cols.append(np.cos(2 * np.pi * k * doy / 365.25))
    return np.column_stack(cols)


# ------------------------------------------------------------------ models


def fit_quasi_poisson(y, X, iters=50, tol=1e-8):
    """Poisson GLM with log link fitted by IRLS. Returns (beta, mu, phi) where phi is the Pearson dispersion
    (>= 1), so tests use Var(y) = phi * mu (quasi-Poisson)."""
    y = np.asarray(y, float)
    mu = np.maximum(y.mean(), 1e-3) * np.ones_like(y)
    eta = np.log(mu)
    beta = np.zeros(X.shape[1])
    for _ in range(iters):
        z = eta + (y - mu) / mu
        w = mu
        WX = X * w[:, None]
        try:
            new = np.linalg.solve(X.T @ WX + 1e-8 * np.eye(X.shape[1]), WX.T @ z)
        except np.linalg.LinAlgError:
            new = np.linalg.lstsq(X.T @ WX, WX.T @ z, rcond=None)[0]
        eta = np.clip(X @ new, -20, 20)
        mu = np.exp(eta)
        if np.max(np.abs(new - beta)) < tol:
            beta = new
            break
        beta = new
    dof = max(1, len(y) - X.shape[1])
    phi = max(1.0, float(np.sum((y - mu) ** 2 / np.maximum(mu, 1e-9)) / dof))
    return beta, mu, phi


def ols_resid(y, X):
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    return y - X @ beta, beta


def deseasonalize(y, X, counts=False):
    """Standardized residuals after removing the calendar structure in X. Counts are variance-stabilized
    (Anscombe) first. NaNs are kept as NaN."""
    y = np.asarray(y, float)
    ok = np.isfinite(y)
    out = np.full_like(y, np.nan)
    if ok.sum() < X.shape[1] + 10:
        return out
    v = 2.0 * np.sqrt(np.maximum(y[ok], 0) + 3.0 / 8.0) if counts else y[ok]
    r, _ = ols_resid(v, X[ok])
    sd = r.std()
    out[ok] = r / sd if sd > 0 else 0.0
    return out


# ------------------------------------------------------------------ cross-correlation with an exact circular null


def _circ_xcorr(a, b):
    """Circular cross-correlation c[s] = mean(a[t] * b[t + s]) for all shifts s (a, b standardized)."""
    n = len(a)
    fa = np.fft.rfft(a, n)
    fb = np.fft.rfft(b, n)
    return np.fft.irfft(np.conj(fa) * fb, n) / n


def lagged_xcorr_test(a, b, max_lag=7, min_shift=None, period=None):
    """Test whether a and b co-move beyond their own rhythms, at some lag in [-max_lag, max_lag].
    a, b: standardized residual series on the same index (NaN allowed: those points are set to 0 = mean).

    The null comes from circular shifts far from zero (>= min_shift). Each shift keeps both series' full
    autocorrelation, so seasonality and persistence can't manufacture a relationship. The spread of the null
    correlations (sigma) is the effective standard error under autocorrelation. The p-value of the best lag
    is 1 - (1 - 2*Phi(-|r|/sigma))^(2K+1), a Sidak correction for trying 2K+1 lags. When the empirical
    exceedance rate of the windowed null maximum is resolvable, the larger (more conservative) p is used.
    Returns dict(r, lag, p, sigma, n) where lag > 0 means a leads b by `lag` steps."""
    a = np.nan_to_num(np.asarray(a, float))
    b = np.nan_to_num(np.asarray(b, float))
    n = len(a)
    min_shift = min_shift or max(30, 4 * max_lag)
    c = _circ_xcorr(a, b)
    lags = np.arange(-max_lag, max_lag + 1)
    obs = c[lags % n]
    i = int(np.argmax(np.abs(obs)))
    r = float(obs[i])
    width = 2 * max_lag + 1
    far = c[min_shift:n - min_shift]
    if len(far) < 100:
        return {"r": r, "lag": int(lags[i]), "p": 1.0, "sigma": float("nan"), "n": n}
    sigma = float(np.std(far))
    p_single = 2 * st.norm.sf(abs(r) / sigma) if sigma > 0 else 1.0
    p_param = 1 - (1 - p_single) ** width
    if period:
        # null windows centered on shifts that are multiples of `period` (e.g. 7 for daily data), so every null
        # window has the same weekday alignment as the observed window around zero
        centers = np.arange(((min_shift + max_lag) // period + 1) * period, n - min_shift - max_lag, period)
        absc = np.abs(c)
        null = np.array([absc[(ctr + np.arange(-max_lag, max_lag + 1)) % n].max() for ctr in centers])
        far = np.concatenate([c[(ctr + np.arange(-max_lag, max_lag + 1)) % n] for ctr in centers]) if len(centers) else far
        sigma = float(np.std(far))
        p_single = 2 * st.norm.sf(abs(r) / sigma) if sigma > 0 else 1.0
        p_param = 1 - (1 - p_single) ** width
    else:
        from numpy.lib.stride_tricks import sliding_window_view
        null = sliding_window_view(np.abs(far), width).max(axis=1)[::max(1, width // 2)]
    exceed = int(np.sum(null >= abs(r)))
    p_emp = (1 + exceed) / (1 + len(null))
    p = max(p_param, p_emp) if exceed > 0 else p_param
    return {"r": r, "lag": int(lags[i]), "p": float(min(1.0, p)), "sigma": sigma, "n": n, "null_n": int(len(null))}


def bh(pvals):
    """Benjamini–Hochberg adjusted q-values (same order as input)."""
    p = np.asarray(pvals, float)
    n = len(p)
    if n == 0:
        return p
    order = np.argsort(p)
    ranked = p[order] * n / (np.arange(n) + 1)
    q = np.minimum.accumulate(ranked[::-1])[::-1]
    out = np.empty(n)
    out[order] = np.minimum(q, 1.0)
    return out


def poisson_tail(o, e, phi=1.0):
    """Two one-sided tail p-values for an observed count o vs expected e with dispersion phi (normal
    approximation on the Anscombe scale for large e, exact Poisson when phi≈1 and e small)."""
    if e <= 0:
        return (0.0 if o > 0 else 1.0), 1.0
    if phi <= 1.05 and e < 50:
        return float(st.poisson.sf(o - 1, e)), float(st.poisson.cdf(o, e))
    z = (o - e) / np.sqrt(phi * e)
    return float(st.norm.sf(z)), float(st.norm.cdf(z))


def partial_corr(x, y, Z):
    """Correlation of x and y after regressing both on Z (common drivers). NaNs dropped pairwise."""
    ok = np.isfinite(x) & np.isfinite(y) & np.all(np.isfinite(Z), axis=1)
    if ok.sum() < 30:
        return np.nan, 0
    Zc = np.column_stack([np.ones(ok.sum()), Z[ok]])
    rx, _ = ols_resid(x[ok], Zc)
    ry, _ = ols_resid(y[ok], Zc)
    return float(np.corrcoef(rx, ry)[0, 1]), int(ok.sum())
