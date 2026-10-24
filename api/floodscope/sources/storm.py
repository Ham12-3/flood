"""Hourly rain and sea level for storm replays, from Open-Meteo.

Verified live 2026-10-24:
- Historical Forecast API: archived hourly forecasts (best model for the place), with
  values from 2022 onwards; earlier hours come back null. Lagos 28 Jun-1 Jul 2026:
  75.6 mm in 96 h, wettest hour 6.4 mm.
- Archive API (ERA5 reanalysis, about 25 km) back to 1940, a few days behind.
- Forecast API for the coming 16 days (and the last few weeks).
- Marine API sea_level_height_msl (includes tides) for points at sea; null inland.
Hourly `precipitation` is the rain in the hour before each timestamp. `timezone=auto`
gives local times, so a storm on "28 June" means the local day.
"""

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx
import numpy as np

from floodscope.models import SourceInfo

FORECAST_DAYS_AHEAD = 15
FORECAST_DAYS_BACK = 30  # the Forecast API has values from about 44 days back
HISTORICAL_FORECAST_FROM = date(2022, 1, 1)


@dataclass(frozen=True)
class RainSeries:
    times: list[str]  # local ISO hours, start 00:00 .. day after end 00:00
    values: np.ndarray  # (hours + 1, n_lat, n_lon) mm in the hour before each time
    timezone: str
    utc_offset_seconds: int
    source: SourceInfo


@dataclass(frozen=True)
class SeaLevelSeries:
    values: np.ndarray  # (hours + 1,) metres relative to mean sea level
    lat: float
    lon: float
    source: SourceInfo


class StormDataError(RuntimeError):
    pass


def choose_rain_api(start: date, end: date, today: date) -> str:
    """'forecast' near today, 'historical' from 2022, else 'archive' (ERA5)."""
    if end > today + timedelta(days=FORECAST_DAYS_AHEAD):
        raise StormDataError(f"Rain forecasts only reach {FORECAST_DAYS_AHEAD} days ahead.")
    if end >= today - timedelta(days=2):
        if start < today - timedelta(days=FORECAST_DAYS_BACK):
            raise StormDataError(
                "Pick dates that are either all in the recent past or all within the last "
                f"{FORECAST_DAYS_BACK} days and the coming {FORECAST_DAYS_AHEAD}."
            )
        return "forecast"
    if start >= HISTORICAL_FORECAST_FROM:
        return "historical"
    return "archive"


def rain_source(api: str) -> SourceInfo:
    now = datetime.now(UTC)
    if api == "archive":
        return SourceInfo(
            name="ERA5 hourly rain (Open-Meteo Historical Weather API)",
            provider="ECMWF Copernicus Climate Change Service, via Open-Meteo",
            url="https://open-meteo.com/en/docs/historical-weather-api",
            resolution="0.25 degrees (about 25 km), hourly",
            data_date="ERA5 reanalysis",
            licence="CC BY 4.0",
            retrieved_at=now,
        )
    label = "archived forecasts" if api == "historical" else "current forecast"
    return SourceInfo(
        name=f"Hourly rain, {label} (Open-Meteo, best model for the place)",
        provider="National weather services (ECMWF IFS, DWD ICON, NOAA GFS/HRRR, ...), "
        "via Open-Meteo",
        url="https://open-meteo.com/en/docs/historical-forecast-api"
        if api == "historical"
        else "https://open-meteo.com/en/docs",
        resolution="1-25 km depending on the model, hourly",
        data_date="Archived forecast runs" if api == "historical" else f"Issued {now:%Y-%m-%d}",
        licence="CC BY 4.0",
        retrieved_at=now,
    )


def sea_level_source() -> SourceInfo:
    return SourceInfo(
        name="Sea level with tides (Open-Meteo Marine API)",
        provider="Open-Meteo marine models",
        url="https://open-meteo.com/en/docs/marine-weather-api",
        resolution="About 8 km, hourly",
        data_date="Model sea level height above mean sea level",
        licence="CC BY 4.0",
        retrieved_at=datetime.now(UTC),
    )


def _as_list(payload: Any) -> list[dict[str, Any]]:
    return payload if isinstance(payload, list) else [payload]


def parse_rain(payload: Any, n_lat: int, n_lon: int) -> tuple[list[str], np.ndarray, str, int]:
    """(times, values (hours, n_lat, n_lon) with NaN for nulls, timezone, offset)."""
    locs = _as_list(payload)
    if len(locs) != n_lat * n_lon:
        raise StormDataError(f"Expected {n_lat * n_lon} rain locations, got {len(locs)}")
    times = locs[0]["hourly"]["time"]
    series = [
        [np.nan if v is None else float(v) for v in loc["hourly"]["precipitation"]] for loc in locs
    ]
    values = np.array(series, dtype="float64").T.reshape(len(times), n_lat, n_lon)
    return (
        times,
        values,
        str(locs[0].get("timezone", "UTC")),
        int(locs[0].get("utc_offset_seconds", 0)),
    )


async def get_rain(
    client: httpx.AsyncClient,
    urls: dict[str, str],
    lats: list[float],
    lons: list[float],
    start: date,
    end: date,
    today: date,
) -> RainSeries:
    """Hourly rain on a grid of points (lats north to south, lons west to east).

    Asks for the day after `end` too, so the last hour of `end` has its value.
    Falls back from archived forecasts to ERA5 when the archive has gaps (before 2022).
    """
    api = choose_rain_api(start, end, today)
    grid_lat = [la for la in lats for _ in lons]
    grid_lon = [lo for _ in lats for lo in lons]
    params = {
        "latitude": ",".join(f"{v:.4f}" for v in grid_lat),
        "longitude": ",".join(f"{v:.4f}" for v in grid_lon),
        "hourly": "precipitation",
        "start_date": start.isoformat(),
        "end_date": (end + timedelta(days=1)).isoformat(),
        "timezone": "auto",
    }
    order = [api] if api != "historical" else ["historical", "archive"]
    last_reason = "no data"
    for which in order:
        resp = await client.get(urls[which], params=params)
        if resp.status_code == 400:
            last_reason = str(resp.json().get("reason", resp.text))
            continue
        resp.raise_for_status()
        times, values, tz, offset = parse_rain(resp.json(), len(lats), len(lons))
        # The final timestamp (00:00 after `end`) is all that is needed from the extra day.
        hours = (end - start).days * 24 + 24
        times, values = times[: hours + 1], values[: hours + 1]
        if np.isnan(values[1:]).any():
            last_reason = f"{which} rain has gaps for these dates"
            continue
        return RainSeries(times, values, tz, offset, rain_source(which))
    raise StormDataError(f"No hourly rain for these dates: {last_reason}")


async def get_sea_level(
    client: httpx.AsyncClient,
    url: str,
    points: list[tuple[float, float]],
    start: date,
    end: date,
) -> SeaLevelSeries | None:
    """Hourly sea level at the first point (lat, lon) where the marine model has values."""
    for lat, lon in points:
        resp = await client.get(
            url,
            params={
                "latitude": f"{lat:.4f}",
                "longitude": f"{lon:.4f}",
                "hourly": "sea_level_height_msl",
                "start_date": start.isoformat(),
                "end_date": (end + timedelta(days=1)).isoformat(),
                "timezone": "auto",
            },
        )
        if resp.status_code == 400:
            continue
        resp.raise_for_status()
        raw = resp.json()["hourly"]["sea_level_height_msl"]
        hours = (end - start).days * 24 + 24
        vals = np.array([np.nan if v is None else float(v) for v in raw[: hours + 1]])
        if len(vals) == hours + 1 and np.isfinite(vals).all():
            return SeaLevelSeries(vals, lat, lon, sea_level_source())
    return None
