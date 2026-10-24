"""Hydrological skill scores. Pure numpy; NaNs in either series are dropped pairwise."""

import numpy as np
from numpy.typing import ArrayLike


def _pair(obs: ArrayLike, sim: ArrayLike) -> tuple[np.ndarray, np.ndarray]:
    o = np.asarray(obs, dtype="float64")
    s = np.asarray(sim, dtype="float64")
    if o.shape != s.shape:
        raise ValueError(f"Shapes differ: {o.shape} vs {s.shape}")
    keep = np.isfinite(o) & np.isfinite(s)
    return o[keep], s[keep]


def nse(obs: ArrayLike, sim: ArrayLike) -> float:
    """Nash-Sutcliffe efficiency: 1 is perfect, 0 is no better than the observed mean."""
    o, s = _pair(obs, sim)
    if o.size < 2:
        return float("nan")
    denom = float(np.sum((o - o.mean()) ** 2))
    if denom == 0:
        return float("nan")
    return 1.0 - float(np.sum((s - o) ** 2)) / denom


def kge(obs: ArrayLike, sim: ArrayLike) -> float:
    """Kling-Gupta efficiency (Gupta et al. 2009): 1 is perfect."""
    o, s = _pair(obs, sim)
    if o.size < 2 or o.std() == 0 or o.mean() == 0:
        return float("nan")
    r = float(np.corrcoef(o, s)[0, 1]) if s.std() > 0 else 0.0
    alpha = float(s.std() / o.std())
    beta = float(s.mean() / o.mean())
    return 1.0 - float(np.sqrt((r - 1) ** 2 + (alpha - 1) ** 2 + (beta - 1) ** 2))


def log_ratio_quantiles(
    obs: ArrayLike, sim: ArrayLike, quantiles: tuple[float, float] = (0.1, 0.9)
) -> tuple[float, float]:
    """Quantiles of log(obs/sim) on positive pairs, used for the empirical forecast band."""
    o, s = _pair(obs, sim)
    keep = (o > 0) & (s > 0)
    if keep.sum() < 10:
        return (float("nan"), float("nan"))
    r = np.log(o[keep] / s[keep])
    lo, hi = np.quantile(r, quantiles)
    return float(lo), float(hi)
