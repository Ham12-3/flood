"""Ground elevation from Copernicus DEM GLO-30 COGs on AWS Open Data.

Tiles are 1x1 degree. Ocean tiles do not exist, so we HEAD the tile first (result
cached) and report "no data" instead of treating a 404 as an error.

Internal blocks are 1024x1024 deflate, so one pixel read pulls roughly 1-3 MB the
first time a tile is touched; GDAL's in-process cache serves later reads.
"""

import asyncio
from datetime import UTC, datetime

import httpx

from floodscope.cache import ResponseCache
from floodscope.geo import copernicus_tile_name, pixel_size_m
from floodscope.models import Elevation, SourceInfo
from floodscope.raster import RasterReadError, gdal_path, read_pixel


def tile_url(base_url: str, tile: str) -> str:
    return f"{base_url.rstrip('/')}/{tile}/{tile}.tif"


def source_info() -> SourceInfo:
    return SourceInfo(
        name="Copernicus DEM GLO-30",
        provider="ESA / Copernicus, hosted on AWS Open Data",
        url="https://registry.opendata.aws/copernicus-dem/",
        resolution="1 arc-second (about 30 m)",
        data_date="2021 release (radar acquired 2011-2015)",
        licence="Copernicus DEM licence: free use with attribution "
        "(© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018)",
        retrieved_at=datetime.now(UTC),
    )


async def tile_exists(
    client: httpx.AsyncClient, base_url: str, tile: str, cache: ResponseCache, ttl_s: int
) -> bool:
    key = f"dem:glo30:exists:{tile}"
    known = cache.get_text(key)
    if known is not None:
        return known == "1"
    resp = await client.head(tile_url(base_url, tile))
    if resp.status_code in (403, 404):  # S3 answers 403 for missing keys without list rights
        exists = False
    else:
        resp.raise_for_status()
        exists = True
    cache.set_text(key, "1" if exists else "0", ttl_s)
    return exists


def elevation_from_tile(
    base_url: str, tile: str, lat: float, lon: float, user_agent: str = ""
) -> Elevation:
    path = gdal_path(base_url, f"{tile}/{tile}.tif")
    px = read_pixel(path, lat, lon, user_agent)
    if not px.inside or px.value is None:
        return Elevation(
            status="no_data",
            reason="The elevation tile has no value at this point.",
            tile=tile,
            source=source_info(),
        )
    w, h = pixel_size_m(lat, px.res_x_deg, px.res_y_deg)
    return Elevation(
        status="ok",
        elevation_m=round(px.value, 2),
        tile=tile,
        cell_size_m=(round(w, 1), round(h, 1)),
        source=source_info(),
    )


async def get_elevation(
    client: httpx.AsyncClient,
    base_url: str,
    cache: ResponseCache,
    lat: float,
    lon: float,
    tile_ttl_s: int,
    user_agent: str = "",
) -> Elevation:
    tile = copernicus_tile_name(lat, lon)
    try:
        if not await tile_exists(client, base_url, tile, cache, tile_ttl_s):
            return Elevation(
                status="no_data",
                reason="No Copernicus DEM tile here. The DEM only covers land, so this is "
                "probably open sea.",
                tile=tile,
                source=source_info(),
            )
        return await asyncio.to_thread(elevation_from_tile, base_url, tile, lat, lon, user_agent)
    except (httpx.HTTPError, RasterReadError) as exc:
        return Elevation(
            status="error", reason=f"Elevation unavailable: {exc}", tile=tile, source=source_info()
        )
