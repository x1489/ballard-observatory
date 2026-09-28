"""The relationship test must find planted lagged effects and must NOT find relationships between
independent series that share seasonality and persistence (the classic source of spurious urban 'patterns')."""
import numpy as np

from bo.engines import stats


def _ar1(n, phi, rng):
    x = np.zeros(n)
    e = rng.normal(size=n)
    for t in range(1, n):
        x[t] = phi * x[t - 1] + e[t]
    return x


def test_finds_planted_lag():
    rng = np.random.default_rng(1)
    n = 3000
    a = _ar1(n, 0.6, rng)
    b = 0.25 * np.roll(a, 2) + _ar1(n, 0.6, rng)        # b follows a two steps later
    a, b = (a - a.mean()) / a.std(), (b - b.mean()) / b.std()
    res = stats.lagged_xcorr_test(a, b, max_lag=7)
    assert res["lag"] == 2
    assert res["p"] < 1e-4


def test_false_positive_rate_is_controlled_for_persistent_independent_series():
    rng = np.random.default_rng(7)
    n, trials, hits = 2000, 200, 0
    t = np.arange(n)
    season = np.sin(2 * np.pi * t / 365.25)
    for _ in range(trials):
        a = _ar1(n, 0.9, rng) + 3 * season            # strongly persistent, same seasonality
        b = _ar1(n, 0.9, rng) + 3 * season
        X = np.column_stack([np.ones(n), np.sin(2 * np.pi * t / 365.25), np.cos(2 * np.pi * t / 365.25)])
        ra, _ = stats.ols_resid(a, X)
        rb, _ = stats.ols_resid(b, X)
        res = stats.lagged_xcorr_test(ra / ra.std(), rb / rb.std(), max_lag=7)
        hits += res["p"] < 0.05
    assert hits / trials < 0.09, hits / trials            # nominal 5%; allow sampling noise


def test_naive_correlation_would_have_failed():
    # Sanity check that the scenario above really is a trap: a naive Pearson test on the raw persistent series
    # rejects far more often than 5%.
    from scipy import stats as st
    rng = np.random.default_rng(3)
    n, rej = 2000, 0
    for _ in range(100):
        a, b = _ar1(n, 0.95, rng), _ar1(n, 0.95, rng)
        rej += st.pearsonr(a, b).pvalue < 0.05
    assert rej > 30


def test_bh_monotone_and_bounded():
    q = stats.bh([0.01, 0.04, 0.03, 0.5])
    assert np.all((q >= 0) & (q <= 1))
    assert q[0] <= q[2] <= q[1] <= q[3]


def test_quasi_poisson_recovers_weekday_effect():
    rng = np.random.default_rng(0)
    dates = np.arange(np.datetime64("2020-01-01"), np.datetime64("2023-01-01"))
    X = stats.design_daily(dates)
    dow = (dates.astype("int64") + 3) % 7
    mu = np.where(dow == 5, 20.0, 10.0)                  # Saturdays double
    y = rng.poisson(mu)
    beta, fit, phi = stats.fit_quasi_poisson(y, X)
    assert abs(fit[dow == 5].mean() / fit[dow != 5].mean() - 2.0) < 0.15
    assert phi < 1.3


def test_shared_weekday_seasonal_pattern_is_not_a_relationship():
    """Two independent series that share a weekday pattern whose strength changes with the season must not be
    reported as related once residuals are weekday-adjusted locally and the null keeps weekday alignment."""
    from bo.engines import relations
    rng = np.random.default_rng(11)
    dates = np.arange(np.datetime64("2015-01-01"), np.datetime64("2023-01-01"))
    n = len(dates)
    dow = (dates.astype("int64") + 3) % 7
    season = 1 + 0.8 * np.sin(2 * np.pi * np.arange(n) / 365.25)
    weekend = (dow >= 5).astype(float)
    hits = 0
    for _ in range(80):
        a = rng.poisson(20 + 15 * weekend * season)
        b = rng.poisson(30 + 20 * weekend * season)
        ra, _ = relations.residuals(dates, a, "count")
        rb, _ = relations.residuals(dates, b, "count")
        res = stats.lagged_xcorr_test(ra, rb, max_lag=7, period=7)
        hits += res["p"] < 0.05
    assert hits / 80 <= 0.10, hits
