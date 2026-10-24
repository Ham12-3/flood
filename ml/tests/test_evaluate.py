import numpy as np
import pandas as pd
import pytest

from floodscope_ml.evaluate import persistence, score_basin, summarise
from floodscope_ml.features import LEADS


def frame(n: int = 200, noise: float = 0.0) -> tuple[pd.DataFrame, pd.Series]:
    idx = pd.date_range("2000-01-01", periods=n + LEADS, freq="D")
    q = pd.Series(1 + np.sin(np.arange(n + LEADS) / 9), index=idx)
    rng = np.random.default_rng(0)
    cols = {}
    for k in range(1, LEADS + 1):
        obs = q.shift(-k).iloc[:n].to_numpy()
        cols[f"obs_{k}"] = obs
        cols[f"sim_{k}"] = obs + rng.normal(0, noise, n)
    return pd.DataFrame(cols, index=idx[:n]), q


def test_perfect_model_beats_persistence() -> None:
    df, q = frame()
    rows = score_basin(df, today_q=q)
    assert len(rows) == LEADS
    assert all(r["nse"] == pytest.approx(1.0) for r in rows)
    # Persistence decays with lead time.
    assert rows[0]["nse_persistence"] > rows[-1]["nse_persistence"]
    assert rows[-1]["nse_persistence"] < 1


def test_glofas_comparison_is_aligned_to_the_target_day() -> None:
    df, q = frame()
    rows = score_basin(df, glofas_q=q)  # GloFAS identical to truth -> perfect at every lead
    assert all(r["nse_glofas"] == pytest.approx(1.0) for r in rows)


def test_summarise_takes_median_across_basins() -> None:
    a = score_basin(frame(noise=0.0)[0])
    b = score_basin(frame(noise=0.5)[0])
    c = score_basin(frame(noise=0.2)[0])
    med = summarise(a + b + c)
    assert list(med.index) == [float(k) for k in range(1, LEADS + 1)]
    assert med.loc[1.0, "nse"] == pytest.approx(score_basin(frame(noise=0.2)[0])[0]["nse"])


def test_persistence_reindexes() -> None:
    q = pd.Series([1.0, 2.0, 3.0], index=pd.date_range("2000-01-01", periods=3))
    out = persistence(q, pd.date_range("2000-01-02", periods=3))
    assert out[:2].tolist() == [2.0, 3.0] and np.isnan(out[2])
