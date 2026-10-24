import math
import random
from datetime import date, timedelta

import pytest

from floodscope.returnperiod import (
    EULER_GAMMA,
    GumbelFit,
    annual_maxima,
    bracket,
    fit_gumbel,
)

RPS = [10, 20, 50, 75, 100, 200, 500]


def test_annual_maxima_skips_short_years_and_nulls() -> None:
    days: list[tuple[date, float | None]] = []
    start = date(2000, 1, 1)
    for i in range(366 + 365):
        d = start + timedelta(days=i)
        days.append((d, float(i % 50) if d.year == 2000 else float(i % 7)))
    days.append((date(2002, 1, 1), 999.0))  # a single day is not a year
    days.append((date(2001, 6, 1), None))
    result = annual_maxima(days)
    assert result == {2000: 49.0, 2001: 6.0}


def test_gumbel_round_trip() -> None:
    fit = GumbelFit(location=100.0, scale=30.0, first_year=1997, last_year=2025, n_years=29)
    for t in (2, 10, 100, 500):
        assert fit.return_period(fit.discharge_for(t)) == pytest.approx(t, rel=1e-9)


def test_gumbel_known_values() -> None:
    fit = GumbelFit(location=0.0, scale=1.0, first_year=0, last_year=0, n_years=0)
    # Q100 of a standard Gumbel is -ln(-ln(0.99)) = 4.6001
    assert fit.discharge_for(100) == pytest.approx(4.6001, abs=1e-4)
    # The location parameter has a return period of 1/(1 - e^-1) = 1.582 years
    assert fit.return_period(0.0) == pytest.approx(1.582, abs=1e-3)
    assert fit.return_period(1e9) == math.inf
    with pytest.raises(ValueError):
        fit.discharge_for(1.0)


def test_fit_recovers_parameters_from_synthetic_gumbel_sample() -> None:
    rng = random.Random(42)
    mu, beta = 500.0, 120.0
    sample = {1000 + i: mu - beta * math.log(-math.log(rng.random())) for i in range(4000)}
    fit = fit_gumbel(sample)
    assert fit.location == pytest.approx(mu, rel=0.03)
    assert fit.scale == pytest.approx(beta, rel=0.05)
    assert fit.n_years == 4000


def test_fit_matches_hand_computed_l_moments() -> None:
    maxima = {2000 + i: v for i, v in enumerate([10.0, 20.0, 30.0, 40.0] * 5)}
    fit = fit_gumbel(maxima)
    x = sorted(maxima.values())
    n = len(x)
    b0 = sum(x) / n
    b1 = sum(i * v for i, v in enumerate(x)) / (n * (n - 1))
    scale = (2 * b1 - b0) / math.log(2)
    assert fit.scale == pytest.approx(scale)
    assert fit.location == pytest.approx(b0 - EULER_GAMMA * scale)


def test_fit_rejects_short_or_flat_records() -> None:
    with pytest.raises(ValueError, match="at least"):
        fit_gumbel({2000 + i: float(i) for i in range(10)})
    with pytest.raises(ValueError, match="do not vary"):
        fit_gumbel({2000 + i: 5.0 for i in range(25)})


@pytest.mark.parametrize(
    ("t", "expected"),
    [
        (5, None),
        (10, (10, 20, 0.0)),
        (500, (500, 500, 1.0)),
        (2000, (500, 500, 1.0)),
    ],
)
def test_bracket_edges(t: float, expected: tuple[int, int, float] | None) -> None:
    assert bracket(t, RPS) == expected


def test_bracket_interpolates_in_log_space() -> None:
    result = bracket(math.sqrt(10 * 20), RPS)  # geometric midpoint of 10 and 20
    assert result is not None
    lo, hi, w = result
    assert (lo, hi) == (10, 20)
    assert w == pytest.approx(0.5)
