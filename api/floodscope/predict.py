"""Builds /api/predict: the AI discharge forecast for days 1-7 and its flood maps.

The model is optional. If no trained model is installed (ml/artifacts by default) the
endpoint says so and how to train one; it never invents a forecast.
"""

import asyncio
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import pandas as pd
from floodscope_ml.features import FORCINGS, LEADS, serving_frame
from floodscope_ml.infer import ForecastModel, ModelUnavailable

from floodscope.cache import ResponseCache
from floodscope.config import Settings
from floodscope.models import (
    LeadSkill,
    ModelInfo,
    PredictionDay,
    PredictResponse,
    SourceInfo,
)
from floodscope.scene import gumbel_from, river_and_fit, scenario_for
from floodscope.sources import flood, soil

HISTORY_DAYS = 400  # covers the 365-day sequence plus slack for ERA5's ~6 day lag
WEATHER_VARS = tuple(f.open_meteo for f in FORCINGS)


@lru_cache(maxsize=2)
def load_model(model_dir: str) -> ForecastModel:
    return ForecastModel(Path(model_dir))


def model_info(meta: dict[str, Any]) -> ModelInfo:
    ev = meta.get("evaluation") or {}
    tr = meta.get("training") or {}
    glofas = {int(r["lead"]): r for r in ev.get("glofas_reanalysis_sample", []) if "lead" in r}
    skill = [
        LeadSkill(
            lead=int(r["lead"]),
            nse=r.get("nse"),
            kge=r.get("kge"),
            nse_persistence=r.get("nse_persistence"),
            nse_glofas=glofas.get(int(r["lead"]), {}).get("nse_glofas"),
        )
        for r in ev.get("median_by_lead", [])
    ]
    return ModelInfo(
        run=str(meta.get("run", "unknown")),
        dataset=tr.get("dataset"),
        train_basins=tr.get("train_basins"),
        held_out_basins=ev.get("held_out_basins"),
        skill=skill,
        note=ev.get("note"),
    )


def weather_frame(archive: dict[str, Any], forecast: dict[str, Any]) -> pd.DataFrame:
    """ERA5 for the past, IFS where ERA5 has not arrived yet and for the next 7 days."""

    def frame(payload: dict[str, Any]) -> pd.DataFrame:
        daily = payload.get("daily") or {}
        idx = pd.to_datetime(daily.get("time") or [])
        return pd.DataFrame({v: daily.get(v) for v in WEATHER_VARS}, index=idx, dtype="float64")

    past = frame(archive)
    future = frame(forecast)
    return past.combine_first(future).sort_index()


def flow_series(payload: dict[str, Any]) -> pd.Series:
    daily = payload.get("daily") or {}
    return pd.Series(
        daily.get("river_discharge") or [],
        index=pd.to_datetime(daily.get("time") or []),
        dtype="float64",
    )


def build_days(
    issue: date,
    q_ratio: np.ndarray,
    low: np.ndarray | None,
    high: np.ndarray | None,
    mean: float,
    glofas_by_date: dict[date, float | None],
    fit: Any,
) -> list[PredictionDay]:
    days = []
    for k in range(LEADS):
        on = issue + timedelta(days=k + 1)
        q = round(float(q_ratio[k] * mean), 3)
        lo = round(float(low[k] * mean), 3) if low is not None else None
        hi = round(float(high[k] * mean), 3) if high is not None else None
        sc = scenario_for(k + 1, on, q, lo, hi, fit)
        days.append(PredictionDay(**sc.model_dump(), glofas_discharge=glofas_by_date.get(on)))
    return days


def _sources() -> list[SourceInfo]:
    era5 = soil.climatology_source()
    era5.name = "ERA5 weather and soil (past year)"
    ifs = soil.forecast_source()
    ifs.name = "ECMWF IFS weather and soil forecast (next 7 days)"
    caravan = SourceInfo(
        name="Caravan (training data)",
        provider="Kratzert et al. 2023, Zenodo",
        url="https://doi.org/10.5281/zenodo.6522634",
        resolution="Catchment-average daily series",
        data_date="v1.6",
        licence="CC BY 4.0",
        retrieved_at=datetime.now(UTC),
    )
    return [flood.source_info(), era5, ifs, caravan]


async def build_prediction(
    lat: float, lon: float, client: httpx.AsyncClient, cache: ResponseCache, settings: Settings
) -> PredictResponse:
    now = datetime.now(UTC)
    today = now.date()
    base: dict[str, Any] = {"lat": lat, "lon": lon, "generated_at": now, "sources": _sources()}

    try:
        model = load_model(str(settings.model_dir))
    except ModelUnavailable as exc:
        return PredictResponse(status="no_data", reason=str(exc), **base)

    river, fit_block = await river_and_fit(lat, lon, client, cache, settings, today)
    if river.status != "ok" or river.grid_lat is None or river.grid_lon is None:
        return PredictResponse(
            status="no_data",
            reason=river.reason or "No modelled river here, so there is nothing to forecast.",
            model=model_info(model.meta),
            **base,
        )
    mean = fit_block.mean_flow
    if not mean or mean <= 0:
        return PredictResponse(
            status="no_data",
            reason="This river cell has no GloFAS flow record for 1997-2010, which the "
            "model needs to scale its forecast.",
            grid_lat=river.grid_lat,
            grid_lon=river.grid_lon,
            model=model_info(model.meta),
            **base,
        )

    start = today - timedelta(days=HISTORY_DAYS)
    params = {"latitude": f"{lat:.4f}", "longitude": f"{lon:.4f}", "timezone": "GMT"}
    daily = ",".join(WEATHER_VARS)
    try:
        archive, forecast, glofas = await asyncio.gather(
            soil._get(
                client,
                settings.open_meteo_archive_url,
                params
                | {
                    "daily": daily,
                    "start_date": start.isoformat(),
                    "end_date": today.isoformat(),
                    "models": "era5",
                },
            ),
            soil._get(
                client,
                settings.open_meteo_forecast_url,
                params
                | {
                    "daily": daily,
                    "past_days": "14",
                    "forecast_days": str(LEADS + 1),
                    "models": "ecmwf_ifs025",
                },
            ),
            soil._get(
                client,
                settings.open_meteo_flood_url,
                {
                    "latitude": f"{river.grid_lat:.5f}",
                    "longitude": f"{river.grid_lon:.5f}",
                    "daily": "river_discharge",
                    "start_date": start.isoformat(),
                    "end_date": today.isoformat(),
                    "timezone": "GMT",
                },
            ),
        )
        frame = serving_frame(
            weather_frame(archive, forecast), flow_series(glofas), mean, pd.Timestamp(today)
        )
        fc = model.predict(frame)
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        return PredictResponse(
            status="error",
            reason=f"AI forecast unavailable: {exc}",
            grid_lat=river.grid_lat,
            grid_lon=river.grid_lon,
            model=model_info(model.meta),
            **base,
        )

    glofas_by_date = {d.date: d.ensemble_mean for d in river.forecast}
    days = build_days(
        today, fc.q_ratio, fc.low, fc.high, mean, glofas_by_date, gumbel_from(fit_block)
    )
    return PredictResponse(
        status="ok",
        issue_date=today,
        grid_lat=river.grid_lat,
        grid_lon=river.grid_lon,
        days=days,
        model=model_info(model.meta),
        **base,
    )
