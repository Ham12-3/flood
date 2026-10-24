"""End-to-end check of the training -> ONNX -> onnxruntime chain on a tiny synthetic
dataset (test fixture only; the real model trains on Caravan in Colab).

Run with: uv run pytest -m train
"""

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from floodscope_ml.features import DYNAMIC_INPUTS, FORCINGS, LEADS
from floodscope_ml.prepare import prepare_basin, split_basins

pytestmark = pytest.mark.train


def synthetic_basin(seed: int, start: str = "1989-01-01", end: str = "1996-12-31") -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    idx = pd.date_range(start, end, freq="D")
    n = len(idx)
    rain = rng.gamma(0.6, 4.0, n)
    temp = 10 + 8 * np.sin(2 * np.pi * idx.dayofyear / 365)
    store = np.zeros(n)
    for t in range(1, n):  # toy linear reservoir so flow follows rain
        store[t] = 0.9 * store[t - 1] + rain[t]
    df = pd.DataFrame(index=idx)
    for f in FORCINGS:
        df[f.caravan] = rng.normal(0.3, 0.05, n)
    df["total_precipitation_sum"] = rain
    df["temperature_2m_mean"] = temp
    df["temperature_2m_min"] = temp - 4
    df["temperature_2m_max"] = temp + 4
    df["streamflow"] = 0.1 * store + 0.05
    return df


def test_prepare_basin_and_split() -> None:
    out = prepare_basin(synthetic_basin(0, "1989-01-01", "2012-12-31"), "fake_1")
    assert out is not None
    frame, mean_flow = out
    assert mean_flow > 0
    assert set(DYNAMIC_INPUTS) <= set(frame.columns)
    train, test = split_basins([f"b{i}" for i in range(10)], 0.2, seed=1)
    assert len(test) == 2 and not set(train) & set(test)
    assert split_basins([f"b{i}" for i in range(10)], 0.2, seed=1) == (train, test)


def test_prepare_basin_rejects_missing_variable() -> None:
    df = synthetic_basin(0).drop(columns=[FORCINGS[-1].caravan])
    with pytest.raises(KeyError, match="Available variables"):
        prepare_basin(df, "fake_2")


def test_train_export_and_serve_match(tmp_path: Path) -> None:
    pytest.importorskip("neuralhydrology")
    from floodscope_ml.export import export_run, nh_reference_prediction
    from floodscope_ml.infer import ForecastModel
    from floodscope_ml.train import train, write_config

    data = tmp_path / "prepared"
    (data / "time_series").mkdir(parents=True)
    basins = [f"syn_{i}" for i in range(3)]
    for i, b in enumerate(basins):
        df = synthetic_basin(i)
        mean_flow = float(df["streamflow"].mean())
        from floodscope_ml.features import add_derived

        add_derived(df, df["streamflow"], mean_flow).rename_axis("date").to_xarray().to_netcdf(
            data / "time_series" / f"{b}.nc"
        )
    (data / "train_basins.txt").write_text("\n".join(basins) + "\n")
    (data / "test_basins.txt").write_text(basins[0] + "\n")

    cfg = write_config(
        data,
        tmp_path / "runs",
        tmp_path / "config.yml",
        overrides={
            "train_start_date": "01/01/1990",
            "train_end_date": "31/12/1993",
            "validation_start_date": "01/01/1994",
            "validation_end_date": "31/12/1994",
            "test_start_date": "01/01/1995",
            "test_end_date": "30/11/1996",
            "epochs": 1,
            "seq_length": 30,
            "hidden_size": 8,
            "batch_size": 64,
            "device": "cpu",
            "num_workers": 0,
            "validate_every": 5,
            "save_weights_every": 1,
            "learning_rate": {0: 1e-3},
        },
    )
    run_dir = train(cfg)
    onnx_path, meta_path = export_run(
        run_dir, tmp_path / "model", evaluation={"log_ratio_quantiles": [[-0.2, 0.2]] * LEADS}
    )
    assert onnx_path.exists() and meta_path.exists()

    model = ForecastModel(tmp_path / "model")
    frame = pd.DataFrame(
        np.random.default_rng(7).normal(0.5, 0.2, (40, len(DYNAMIC_INPUTS))),
        columns=list(DYNAMIC_INPUTS),
    )
    fc = model.predict(frame)
    ref = nh_reference_prediction(run_dir, frame.to_numpy()[None, -30:, :])[0]
    np.testing.assert_allclose(fc.q_ratio, np.maximum(ref, 0), rtol=1e-4, atol=1e-5)
    assert fc.low is not None and fc.high is not None
    assert (fc.low <= fc.q_ratio).all() and (fc.q_ratio <= fc.high).all()

    with pytest.raises(ValueError, match="Need 30"):
        model.predict(frame.iloc[:10])
