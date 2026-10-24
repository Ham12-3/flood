from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import pandas as pd
import pytest
import respx
from floodscope_ml.features import FORCINGS, LEADS

from floodscope import predict
from floodscope.cache import ResponseCache
from floodscope.config import Settings
from floodscope.models import (
    DischargeDay,
    DischargeForRP,
    ReturnPeriodFitInfo,
    RiverDischarge,
)
from floodscope.scene import gumbel_from
from floodscope.sources import flood

MODEL_DIR = Path(__file__).parent / "fixtures" / "test_model"  # synthetic test model
TODAY = datetime.now(UTC).date()


def daily(start: date, end: date, values: dict[str, float]) -> dict[str, Any]:
    days = pd.date_range(start, end, freq="D")
    return {
        "daily": {
            "time": [d.date().isoformat() for d in days],
            **{k: [v] * len(days) for k, v in values.items()},
        }
    }


def river() -> RiverDischarge:
    forecast = [
        DischargeDay(date=TODAY + timedelta(days=k), discharge=100.0, ensemble_mean=110.0 + k)
        for k in range(LEADS + 1)
    ]
    return RiverDischarge(
        status="ok", grid_lat=51.5, grid_lon=-0.1, forecast=forecast, source=flood.source_info()
    )


def fit(mean_flow: float | None = 100.0) -> ReturnPeriodFitInfo:
    return ReturnPeriodFitInfo(
        status="ok",
        location=100.0,
        scale=30.0,
        first_year=1997,
        last_year=2025,
        n_years=29,
        mean_flow=mean_flow,
        thresholds=[DischargeForRP(return_period=10, discharge=167.5)],
        source=flood.source_info(),
    )


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    predict.load_model.cache_clear()
    return Settings(
        cache_dir=tmp_path / "cache",
        model_dir=MODEL_DIR,
        open_meteo_archive_url="https://archive.example/v1/archive",
        open_meteo_forecast_url="https://forecast.example/v1/forecast",
        open_meteo_flood_url="https://flood.example/v1/flood",
    )


def mock_upstream(
    monkeypatch: pytest.MonkeyPatch, mean_flow: float | None = 100.0, gap: bool = False
) -> None:
    async def fake_river_and_fit(*_: object, **__: object) -> tuple[RiverDischarge, Any]:
        return river(), fit(mean_flow)

    monkeypatch.setattr(predict, "river_and_fit", fake_river_and_fit)
    weather = {f.open_meteo: 1.0 for f in FORCINGS}
    start = TODAY - timedelta(days=predict.HISTORY_DAYS)
    archive = daily(start, TODAY - timedelta(days=6), weather)
    if gap:
        # 25 days ago: inside the test model's 30-day window and before the IFS data starts.
        archive["daily"]["precipitation_sum"][-20] = None
    respx.get("https://archive.example/v1/archive").mock(
        return_value=httpx.Response(200, json=archive)
    )
    respx.get("https://forecast.example/v1/forecast").mock(
        return_value=httpx.Response(
            200, json=daily(TODAY - timedelta(days=14), TODAY + timedelta(days=LEADS), weather)
        )
    )
    respx.get("https://flood.example/v1/flood").mock(
        return_value=httpx.Response(200, json=daily(start, TODAY, {"river_discharge": 80.0}))
    )


async def test_without_a_model_says_how_to_train(tmp_path: Path, cache: ResponseCache) -> None:
    predict.load_model.cache_clear()
    settings = Settings(cache_dir=tmp_path / "c", model_dir=tmp_path / "empty")
    async with httpx.AsyncClient() as client:
        r = await predict.build_prediction(51.5, -0.1, client, cache, settings)
    assert r.status == "no_data"
    assert r.reason is not None and "train_colab.ipynb" in r.reason
    assert r.days == []


@respx.mock
async def test_forecast_with_test_model(
    settings: Settings, cache: ResponseCache, monkeypatch: pytest.MonkeyPatch
) -> None:
    mock_upstream(monkeypatch)
    async with httpx.AsyncClient() as client:
        r = await predict.build_prediction(51.5, -0.1, client, cache, settings)
    assert r.status == "ok", r.reason
    assert r.issue_date == TODAY
    assert [d.day for d in r.days] == list(range(1, LEADS + 1))
    first = r.days[0]
    assert first.date == TODAY + timedelta(days=1)
    assert first.discharge is not None and first.discharge >= 0
    assert first.discharge_low is not None and first.discharge_high is not None
    assert first.discharge_low <= first.discharge <= first.discharge_high
    assert first.glofas_discharge == 111.0
    assert first.return_period is not None
    assert r.model is not None and "synthetic" in (r.model.dataset or "")
    assert {s.name for s in r.sources} >= {"Caravan (training data)"}


@respx.mock
async def test_gap_in_weather_is_an_error(
    settings: Settings, cache: ResponseCache, monkeypatch: pytest.MonkeyPatch
) -> None:
    mock_upstream(monkeypatch, gap=True)
    async with httpx.AsyncClient() as client:
        r = await predict.build_prediction(51.5, -0.1, client, cache, settings)
    assert r.status == "error"
    assert r.reason is not None and "total_precipitation_sum" in r.reason
    assert r.days == []


@respx.mock
async def test_no_mean_flow_is_no_data(
    settings: Settings, cache: ResponseCache, monkeypatch: pytest.MonkeyPatch
) -> None:
    mock_upstream(monkeypatch, mean_flow=None)
    async with httpx.AsyncClient() as client:
        r = await predict.build_prediction(51.5, -0.1, client, cache, settings)
    assert r.status == "no_data" and r.reason is not None and "1997-2010" in r.reason


def test_weather_frame_uses_forecast_where_era5_is_missing() -> None:
    archive = {"daily": {"time": ["2026-01-01", "2026-01-02"], "precipitation_sum": [1.0, None]}}
    fc = {"daily": {"time": ["2026-01-02", "2026-01-03"], "precipitation_sum": [5.0, 6.0]}}
    w = predict.weather_frame(archive, fc)
    assert w["precipitation_sum"].tolist() == [1.0, 5.0, 6.0]


def test_build_days_scales_and_maps() -> None:
    q = np.full(LEADS, 2.0)
    days = predict.build_days(TODAY, q, q * 0.5, q * 1.5, 100.0, {}, gumbel_from(fit()))
    assert days[0].discharge == 200.0
    assert days[0].discharge_low == 100.0 and days[0].discharge_high == 300.0
    # 200 m3/s with mu=100, beta=30 is about a 1-in-29 year flow -> blend 20 and 50 maps.
    assert days[0].maps is not None and (days[0].maps.lower, days[0].maps.upper) == (20, 50)


def test_model_info_reads_sidecar() -> None:
    info = predict.model_info(
        {
            "run": "r1",
            "training": {"dataset": "Caravan", "train_basins": 1800},
            "evaluation": {
                "held_out_basins": 450,
                "median_by_lead": [{"lead": 1.0, "nse": 0.8, "kge": 0.75, "nse_persistence": 0.7}],
                "glofas_reanalysis_sample": [{"lead": 1.0, "nse_glofas": 0.5}],
            },
        }
    )
    assert info.held_out_basins == 450 and info.skill[0].nse_glofas == 0.5
