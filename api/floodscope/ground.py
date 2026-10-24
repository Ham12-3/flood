"""Builds /api/ground: soil moisture by layer and the nearest groundwater level."""

import asyncio
import json
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from floodscope.cache import ResponseCache
from floodscope.config import Settings
from floodscope.models import GroundResponse, GroundwaterBlock, SoilBlock
from floodscope.sources import ea, soil


async def _cached_json(
    cache: ResponseCache, key: str, ttl_s: int, fetch: Callable[[], Awaitable[Any]]
) -> Any:
    text = cache.get_text(key)
    if text is not None:
        return json.loads(text)
    value = await fetch()
    cache.set_text(key, json.dumps(value), ttl_s)
    return value


async def _soil(
    lat: float, lon: float, client: httpx.AsyncClient, cache: ResponseCache, settings: Settings
) -> SoilBlock:
    today = datetime.now(UTC).date()
    cell = f"{round(lat * 4) / 4}:{round(lon * 4) / 4}"  # ERA5 / IFS 0.25 degree cell
    archive = settings.open_meteo_archive_url
    try:
        recent = await _cached_json(
            cache,
            f"soil:era5:recent:{cell}:{today}",
            settings.ttl_forecast,
            lambda: soil.fetch_archive(
                client, archive, lat, lon, today - timedelta(days=soil.RECENT_DAYS), today
            ),
        )
        latest_day, _ = soil.latest_values(recent)
        if latest_day is None:
            return soil.build_soil(None, recent, [], today)
        # Earlier years' windows, centred on the Monday of the latest day's week so the
        # cache holds for a week.
        centre = latest_day - timedelta(days=latest_day.weekday())
        seasons = await _cached_json(
            cache,
            f"soil:era5:seasons:{cell}:{centre}",
            settings.ttl_static,
            lambda: soil.fetch_seasons(client, archive, lat, lon, centre),
        )
    except (httpx.HTTPError, ValueError) as exc:
        return SoilBlock(
            status="error",
            reason=f"Soil moisture unavailable: {exc}",
            forecast_source=soil.forecast_source(),
            climatology_source=soil.climatology_source(),
        )
    try:
        forecast = await _cached_json(
            cache,
            f"soil:ifs:{cell}:{today}",
            settings.ttl_forecast,
            lambda: soil.fetch_forecast(client, settings.open_meteo_forecast_url, lat, lon),
        )
    except (httpx.HTTPError, ValueError):
        forecast = None  # the trend is optional; the ERA5 ranking still stands
    return soil.build_soil(forecast, recent, seasons, today)


async def build_ground(
    lat: float, lon: float, client: httpx.AsyncClient, cache: ResponseCache, settings: Settings
) -> GroundResponse:
    groundwater_task = cache.get_or_fetch(
        f"ea:groundwater:{lat:.3f}:{lon:.3f}",
        GroundwaterBlock,
        lambda: ea.get_groundwater(client, settings.ea_flood_url, lat, lon),
        settings.ttl_ea * 6,
        lambda b: b.status != "error",
    )
    soil_block, groundwater = await asyncio.gather(
        _soil(lat, lon, client, cache, settings), groundwater_task
    )
    return GroundResponse(
        lat=lat,
        lon=lon,
        generated_at=datetime.now(UTC),
        soil=soil_block,
        groundwater=groundwater,
    )
