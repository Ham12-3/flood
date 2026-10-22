from pathlib import Path

import httpx
import numpy as np
import pytest
import respx

from floodscope.cache import ResponseCache
from floodscope.sources.dem import elevation_from_tile, get_elevation, tile_exists

from .conftest import write_geotiff

BASE = "https://dem.example"
LONDON_TILE = "Copernicus_DSM_COG_10_N51_00_W001_00_DEM"


@respx.mock
async def test_missing_tile_is_no_data_and_cached(cache: ResponseCache) -> None:
    route = respx.head(url__startswith=BASE).mock(return_value=httpx.Response(404))
    async with httpx.AsyncClient() as client:
        first = await get_elevation(client, BASE, cache, 30.0, -40.0, 60)
        second = await get_elevation(client, BASE, cache, 30.5, -39.5, 60)
    assert first.status == "no_data" and second.status == "no_data"
    assert first.reason is not None and "sea" in first.reason
    assert route.call_count == 1  # second lookup used the cached answer


@respx.mock
async def test_head_server_error_is_error(cache: ResponseCache) -> None:
    respx.head(url__startswith=BASE).mock(return_value=httpx.Response(503))
    async with httpx.AsyncClient() as client:
        result = await get_elevation(client, BASE, cache, 51.5, -0.12, 60)
    assert result.status == "error"


@respx.mock
async def test_tile_exists_true(cache: ResponseCache) -> None:
    respx.head(f"{BASE}/{LONDON_TILE}/{LONDON_TILE}.tif").mock(return_value=httpx.Response(200))
    async with httpx.AsyncClient() as client:
        assert await tile_exists(client, BASE, LONDON_TILE, cache, 60)


def test_elevation_from_local_tile(tmp_path: Path) -> None:
    res = 1 / 3600 * 100  # coarse grid keeps the test file tiny
    data = np.full((36, 36), 12.345, dtype="float32")
    data[0, 0] = -9999
    write_geotiff(tmp_path / LONDON_TILE / f"{LONDON_TILE}.tif", data, -1.0, 52.0, res, -9999)
    result = elevation_from_tile(str(tmp_path), LONDON_TILE, 51.5, -0.12)
    assert result.status == "ok"
    assert result.elevation_m == pytest.approx(12.35, abs=0.01)
    assert result.cell_size_m is not None
    w, h = result.cell_size_m
    assert w < h  # east-west pixels are narrower at 51.5 N

    edge = elevation_from_tile(str(tmp_path), LONDON_TILE, 51.999, -0.999)
    assert edge.status == "no_data"
