"""Held-out evaluation: NSE and KGE per lead time, against persistence and GloFAS.

Reads NeuralHydrology's test results (run_dir/test/model_epochXXX/test_results.p) for
basins that were never trained on.

Comparisons, all on the q_ratio scale (flow / long-term mean):
- persistence: tomorrow = today, a hard baseline at short leads;
- GloFAS: the GloFAS v4 *reanalysis* at the gauge (Open-Meteo Flood API). Archived
  GloFAS *forecasts* need a Copernicus CDS account, so this compares against GloFAS
  driven by observed weather, which flatters GloFAS. Say so wherever it is reported.
"""

import pickle
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from floodscope_ml.features import FLOW, LEADS, target_name
from floodscope_ml.metrics import kge, log_ratio_quantiles, nse


def load_test_results(run_dir: Path) -> dict[str, Any]:
    files = sorted((run_dir / "test").glob("model_epoch*/test_results.p"))
    if not files:
        raise FileNotFoundError(f"No test results under {run_dir / 'test'}; run eval_run first")
    with files[-1].open("rb") as f:
        results: dict[str, Any] = pickle.load(f)
    return results


def basin_series(results: dict[str, Any], basin: str) -> pd.DataFrame:
    """obs/sim per lead for one basin, indexed by the issue date."""
    xr = results[basin]["1D"]["xr"]
    cols = {}
    for k in range(1, LEADS + 1):
        name = target_name(k)
        cols[f"obs_{k}"] = xr[f"{name}_obs"].values.reshape(-1)
        cols[f"sim_{k}"] = xr[f"{name}_sim"].values.reshape(-1)
    return pd.DataFrame(cols, index=pd.to_datetime(xr["date"].values))


def persistence(q_ratio: pd.Series, index: pd.Index) -> np.ndarray:
    """Persistence forecast: every lead equals today's flow ratio."""
    out: np.ndarray = q_ratio.reindex(index).to_numpy()
    return out


def score_basin(
    df: pd.DataFrame, today_q: pd.Series | None = None, glofas_q: pd.Series | None = None
) -> list[dict[str, float]]:
    rows = []
    for k in range(1, LEADS + 1):
        obs = df[f"obs_{k}"].to_numpy()
        sim = df[f"sim_{k}"].to_numpy()
        row = {"lead": float(k), "nse": nse(obs, sim), "kge": kge(obs, sim)}
        if today_q is not None:
            p = persistence(today_q, df.index)
            row["nse_persistence"] = nse(obs, p)
            row["kge_persistence"] = kge(obs, p)
        if glofas_q is not None:
            g = glofas_q.reindex(df.index + pd.Timedelta(days=k)).to_numpy()
            row["nse_glofas"] = nse(obs, g)
            row["kge_glofas"] = kge(obs, g)
        rows.append(row)
    return rows


def summarise(scores: Iterable[dict[str, float]]) -> pd.DataFrame:
    """Median skill across basins, per lead."""
    df = pd.DataFrame(list(scores))
    return df.groupby("lead").median(numeric_only=True)


def error_band(results: dict[str, Any], basins: Iterable[str]) -> list[tuple[float, float]]:
    """10th/90th percentile of log(obs/sim) per lead, pooled over held-out basins."""
    frames = [basin_series(results, b) for b in basins]
    band = []
    for k in range(1, LEADS + 1):
        obs = np.concatenate([f[f"obs_{k}"].to_numpy() for f in frames])
        sim = np.concatenate([f[f"sim_{k}"].to_numpy() for f in frames])
        band.append(log_ratio_quantiles(obs, sim))
    return band


def today_flow(prepared_dir: Path, basin: str) -> pd.Series:
    import xarray as xr

    ds = xr.open_dataset(prepared_dir / "time_series" / f"{basin}.nc")
    return ds[FLOW].to_series()
