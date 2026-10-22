"""JRC CEMS-GloFAS global river flood hazard maps (v2.1.2).

Verified live 2026-10-21: 10x10 degree tiles, 3 arc-second (~90 m), float32 depth in
metres, nodata -9999 where the cell stays dry. Tiles are internally tiled (256 px) so
HTTP range reads work, though they are not formal COGs. tile_extents.geojson maps
tile ids to extents; file names look like ID106_N60_W10_RP100_depth.tif.
Permanent water and spurious-depth masks are uint8 with 255 as nodata.
"""

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from typing import Any

import httpx

from floodscope.cache import ResponseCache
from floodscope.geo import point_in_bbox
from floodscope.models import RETURN_PERIODS, FloodHazard, HazardDepth, SourceInfo
from floodscope.raster import RasterReadError, gdal_path, read_pixel

JRC_VERSION = "2.1.2"
EXTENTS_KEY = f"jrc:{JRC_VERSION}:tile_extents"

# Ten files per point; read them in parallel without starving the default pool.
_POOL = ThreadPoolExecutor(max_workers=10, thread_name_prefix="jrc")


def source_info() -> SourceInfo:
    return SourceInfo(
        name="JRC CEMS-GloFAS global river flood hazard maps",
        provider="European Commission Joint Research Centre",
        url="https://data.jrc.ec.europa.eu/collection/id-0054",
        resolution="3 arc-seconds (about 90 m)",
        data_date=f"v{JRC_VERSION} (2026-01-12)",
        licence="CC BY 4.0",
        retrieved_at=datetime.now(UTC),
    )


Tile = tuple[str, tuple[float, float, float, float]]  # (name, (west, south, east, north))


def parse_tile_extents(geojson: dict[str, Any]) -> list[Tile]:
    tiles: list[Tile] = []
    for feature in geojson.get("features", []):
        props = feature["properties"]
        ring = feature["geometry"]["coordinates"][0]
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        tiles.append((f"ID{props['id']}_{props['name']}", (min(xs), min(ys), max(xs), max(ys))))
    return tiles


def find_tile(tiles: list[Tile], lat: float, lon: float) -> str | None:
    for name, bbox in tiles:
        if point_in_bbox(lat, lon, bbox):
            return name
    return None


def hazard_paths(base_url: str, tile: str) -> dict[str, str]:
    paths = {
        f"rp{rp}": gdal_path(base_url, f"RP{rp}/{tile}_RP{rp}_depth.tif") for rp in RETURN_PERIODS
    }
    paths["permanent"] = gdal_path(base_url, f"Permanent_WaterBodies/{tile}_permanent_water.tif")
    paths["spurious"] = gdal_path(base_url, f"Spurious_Depths/{tile}_spurious_depth_areas.tif")
    return paths


def build_hazard(tile: str, values: dict[str, float | None]) -> FloodHazard:
    """Combine raw pixel values into the typed response. Pure, so it is unit tested."""
    depths = []
    for rp in RETURN_PERIODS:
        v = values.get(f"rp{rp}")
        depth = round(v, 2) if v is not None and v > 0 else None
        depths.append(HazardDepth(return_period=rp, depth_m=depth, flooded=depth is not None))
    perm = values.get("permanent")
    spur = values.get("spurious")
    return FloodHazard(
        status="ok",
        tile=tile,
        depths=depths,
        permanent_water=perm is not None and perm > 0,
        spurious_depth_area=spur is not None and spur > 0,
        source=source_info(),
    )


async def get_tiles(
    client: httpx.AsyncClient, base_url: str, cache: ResponseCache, ttl_s: int
) -> list[Tile]:
    text = cache.get_text(EXTENTS_KEY)
    if text is None:
        resp = await client.get(f"{base_url.rstrip('/')}/tile_extents.geojson")
        resp.raise_for_status()
        text = resp.text
        cache.set_text(EXTENTS_KEY, text, ttl_s)
    return parse_tile_extents(json.loads(text))


async def get_hazard(
    client: httpx.AsyncClient,
    base_url: str,
    cache: ResponseCache,
    lat: float,
    lon: float,
    extents_ttl_s: int,
    user_agent: str = "",
) -> FloodHazard:
    try:
        tile = find_tile(await get_tiles(client, base_url, cache, extents_ttl_s), lat, lon)
        if tile is None:
            return FloodHazard(
                status="no_data",
                reason="Outside the JRC flood hazard maps, which only cover land.",
                source=source_info(),
            )
        loop = asyncio.get_running_loop()
        paths = hazard_paths(base_url, tile)
        reads = await asyncio.gather(
            *(
                loop.run_in_executor(_POOL, read_pixel, p, lat, lon, user_agent)
                for p in paths.values()
            )
        )
        values = {key: px.value for key, px in zip(paths, reads, strict=True)}
        return build_hazard(tile, values)
    except (httpx.HTTPError, RasterReadError, ValueError, KeyError) as exc:
        return FloodHazard(
            status="error", reason=f"Flood hazard maps unavailable: {exc}", source=source_info()
        )
