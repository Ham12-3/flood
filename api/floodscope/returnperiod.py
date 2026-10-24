"""Discharge to return period, via a Gumbel fit to annual maximum flows.

Used to turn a GloFAS forecast ("186 m3/s on 25 Oct") into a flood size ("about a
1-in-4 year flow") so the matching JRC hazard map can be shown. Pure functions only.

Gumbel parameters come from L-moments (Hosking 1990), which behave well for the
~30 years of GloFAS reanalysis that Open-Meteo serves (1997 onwards in our checks).
"""

import itertools
import math
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date

EULER_GAMMA = 0.5772156649015329
MIN_YEARS = 20
MIN_DAYS_PER_YEAR = 330


@dataclass(frozen=True)
class GumbelFit:
    location: float  # mu, m3/s
    scale: float  # beta, m3/s
    first_year: int
    last_year: int
    n_years: int

    def return_period(self, discharge: float) -> float:
        """Average years between flows at least this big (T >= 1)."""
        z = (discharge - self.location) / self.scale
        if z > 700:  # exp(-exp(-z)) is 1 within float precision
            return math.inf
        cdf = math.exp(-math.exp(-z))
        return math.inf if cdf >= 1.0 else 1.0 / (1.0 - cdf)

    def discharge_for(self, return_period: float) -> float:
        if return_period <= 1.0:
            raise ValueError("Return period must be greater than 1 year")
        return self.location - self.scale * math.log(-math.log(1.0 - 1.0 / return_period))


def annual_maxima(days: Iterable[tuple[date, float | None]]) -> dict[int, float]:
    """Highest daily flow per calendar year, keeping only years with enough data."""
    by_year: dict[int, list[float]] = defaultdict(list)
    for d, q in days:
        if q is not None and math.isfinite(q):
            by_year[d.year].append(q)
    return {y: max(v) for y, v in sorted(by_year.items()) if len(v) >= MIN_DAYS_PER_YEAR}


def fit_gumbel(maxima: dict[int, float]) -> GumbelFit:
    """L-moment Gumbel fit. Raises ValueError when the record is too short or flat."""
    if len(maxima) < MIN_YEARS:
        raise ValueError(f"Need at least {MIN_YEARS} complete years, got {len(maxima)}")
    x: Sequence[float] = sorted(maxima.values())
    n = len(x)
    b0 = sum(x) / n
    b1 = sum(i * xi for i, xi in enumerate(x)) / (n * (n - 1))
    l2 = 2 * b1 - b0
    if l2 <= 0:
        raise ValueError("Annual maxima do not vary, so no flood curve can be fitted")
    scale = l2 / math.log(2)
    location = b0 - EULER_GAMMA * scale
    years = sorted(maxima)
    return GumbelFit(location, scale, years[0], years[-1], n)


def bracket(return_period: float, available: Sequence[int]) -> tuple[int, int, float] | None:
    """Pick the two hazard maps around a return period and the log-scale weight between them.

    Returns (lower, upper, weight) where weight 0 means "use lower", 1 means "use upper".
    Returns None below the smallest map. Above the largest map, returns the largest map
    with weight 1 (the caller should flag that the flood may be bigger).
    """
    rps = sorted(available)
    if return_period < rps[0]:
        return None
    if return_period >= rps[-1]:
        return rps[-1], rps[-1], 1.0
    for lo, hi in itertools.pairwise(rps):
        if lo <= return_period < hi:
            w = (math.log(return_period) - math.log(lo)) / (math.log(hi) - math.log(lo))
            return lo, hi, w
    raise AssertionError("unreachable")
