"""Builds the /api/point response by querying every source in parallel."""

import asyncio
from datetime import UTC, datetime

import httpx

from floodscope.cache import ResponseCache
from floodscope.config import Settings
from floodscope.models import Elevation, FloodHazard, PointResponse, RiverDischarge, UKLive
from floodscope.sources import dem, ea, flood, hazard

# 1/1200 degree is the JRC 3 arc-second grid, so this key is one hazard pixel.
JRC_GRID = 1200


def _ok(block: Elevation | RiverDischarge | FloodHazard | UKLive) -> bool:
    # Cache real answers ("ok" or a genuine "no_data"), never transient errors.
    return block.status != "error"


async def build_point(
    lat: float, lon: float, client: httpx.AsyncClient, cache: ResponseCache, settings: Settings
) -> PointResponse:
    today = datetime.now(UTC).date().isoformat()
    ua = settings.user_agent

    elevation_task = cache.get_or_fetch(
        f"dem:glo30:{lat:.4f}:{lon:.4f}",
        Elevation,
        lambda: dem.get_elevation(
            client, settings.copernicus_dem_url, cache, lat, lon, settings.ttl_static, ua
        ),
        settings.ttl_static,
        _ok,
    )
    river_task = cache.get_or_fetch(
        f"flood:glofas:{lat:.3f}:{lon:.3f}:{today}",
        RiverDischarge,
        lambda: flood.get_river_discharge(client, settings.open_meteo_flood_url, lat, lon),
        settings.ttl_forecast,
        _ok,
    )
    hazard_task = cache.get_or_fetch(
        f"jrc:{hazard.JRC_VERSION}:{round(lat * JRC_GRID)}:{round(lon * JRC_GRID)}",
        FloodHazard,
        lambda: hazard.get_hazard(
            client, settings.jrc_hazard_url, cache, lat, lon, settings.ttl_static, ua
        ),
        settings.ttl_static,
        _ok,
    )
    uk_task = cache.get_or_fetch(
        f"ea:{lat:.3f}:{lon:.3f}",
        UKLive,
        lambda: ea.get_uk_live(client, settings.ea_flood_url, lat, lon),
        settings.ttl_ea,
        _ok,
    )
    elevation, river, hazard_block, uk_live = await asyncio.gather(
        elevation_task, river_task, hazard_task, uk_task
    )
    return PointResponse(
        lat=lat,
        lon=lon,
        generated_at=datetime.now(UTC),
        elevation=elevation,
        river=river,
        hazard=hazard_block,
        uk_live=uk_live,
    )
