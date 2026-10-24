import math

import numpy as np
import pytest

from floodscope_ml.metrics import kge, log_ratio_quantiles, nse


def test_perfect_simulation() -> None:
    obs = np.array([1.0, 3.0, 2.0, 5.0])
    assert nse(obs, obs) == pytest.approx(1.0)
    assert kge(obs, obs) == pytest.approx(1.0)


def test_mean_simulation_scores_zero_nse() -> None:
    obs = np.array([1.0, 3.0, 2.0, 5.0])
    assert nse(obs, np.full(4, obs.mean())) == pytest.approx(0.0)


def test_kge_known_bias() -> None:
    obs = np.array([1.0, 2.0, 3.0, 4.0])
    # Doubling keeps r = 1 but alpha = beta = 2 -> KGE = 1 - sqrt(2)
    assert kge(obs, obs * 2) == pytest.approx(1 - math.sqrt(2))


def test_nan_pairs_are_dropped() -> None:
    obs = np.array([1.0, np.nan, 3.0, 2.0])
    sim = np.array([1.0, 5.0, np.nan, 2.0])
    assert nse(obs, sim) == pytest.approx(1.0)


def test_degenerate_inputs_are_nan() -> None:
    assert math.isnan(nse([1.0], [1.0]))
    assert math.isnan(nse([2.0, 2.0], [1.0, 3.0]))
    assert math.isnan(kge([0.0, 0.0], [1.0, 2.0]))
    with pytest.raises(ValueError):
        nse([1.0, 2.0], [1.0])


def test_log_ratio_quantiles() -> None:
    rng = np.random.default_rng(0)
    sim = rng.uniform(1, 10, 5000)
    obs = sim * np.exp(rng.normal(0, 0.2, 5000))
    lo, hi = log_ratio_quantiles(obs, sim)
    assert lo == pytest.approx(-0.256, abs=0.02)  # N(0, 0.2) 10th percentile
    assert hi == pytest.approx(0.256, abs=0.02)
    assert all(math.isnan(v) for v in log_ratio_quantiles([1.0], [1.0]))
