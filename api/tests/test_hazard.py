import json
from pathlib import Path

import httpx
import numpy as np
import pytest

from floodscope.cache import ResponseCache
from floodscope.models import RETURN_PERIODS
from floodscope.sources.hazard import (
    EXTENTS_KEY,
    build_hazard,
    find_tile,
    get_hazard,
    hazard_paths,
    parse_tile_extents,
)

from .conftest import load_fixture, write_geotiff

TILE = "ID1_N10_E0"


def test_parse_real_tile_extents_and_find_test_cities() -> None:
    tiles = parse_tile_extents(load_fixture("jrc_tile_extents.geojson"))
    assert len(tiles) == 271
    assert find_tile(tiles, 51.5, -0.12) == "ID106_N60_W10"
    assert find_tile(tiles, 6.45, 3.39) == "ID118_N10_W0"
    assert find_tile(tiles, 23.81, 90.41) == "ID200_N30_E90"
    assert find_tile(tiles, 29.95, -90.07) == "ID38_N30_W100"
    assert find_tile(tiles, 30.0, -40.0) is None  # mid-Atlantic


def test_hazard_paths_follow_jrc_naming() -> None:
    paths = hazard_paths("https://jrc.example/flood_hazard", "ID106_N60_W10")
    assert paths["rp100"] == (
        "/vsicurl/https://jrc.example/flood_hazard/RP100/ID106_N60_W10_RP100_depth.tif"
    )
    assert paths["permanent"].endswith("Permanent_WaterBodies/ID106_N60_W10_permanent_water.tif")
    assert paths["spurious"].endswith("Spurious_Depths/ID106_N60_W10_spurious_depth_areas.tif")
    assert len(paths) == len(RETURN_PERIODS) + 2


def test_build_hazard_marks_dry_cells_and_flags() -> None:
    values: dict[str, float | None] = {f"rp{rp}": None for rp in RETURN_PERIODS}
    values.update(rp100=0.4567, rp200=1.2, rp500=2.0, permanent=None, spurious=1.0)
    result = build_hazard(TILE, values)
    by_rp = {d.return_period: d for d in result.depths}
    assert not by_rp[10].flooded and by_rp[10].depth_m is None
    assert by_rp[100].flooded and by_rp[100].depth_m == 0.46
    assert by_rp[500].depth_m == 2.0
    assert result.permanent_water is False
    assert result.spurious_depth_area is True


def test_build_hazard_zero_depth_counts_as_dry() -> None:
    result = build_hazard(TILE, {"rp10": 0.0})
    assert not result.depths[0].flooded


def _write_tile(base: Path) -> None:
    """A 10x10 degree tile with 1 degree pixels, north-west corner (0, 10)."""
    for rp in RETURN_PERIODS:
        depth = np.full((10, 10), -9999, dtype="float32")
        if rp >= 50:
            depth[4, 2] = rp / 100  # point (lat 5.5, lon 2.5)
        write_geotiff(base / f"RP{rp}" / f"{TILE}_RP{rp}_depth.tif", depth, 0, 10, 1, -9999)
    perm = np.full((10, 10), 255, dtype="uint8")
    perm[4, 2] = 1
    write_geotiff(
        base / "Permanent_WaterBodies" / f"{TILE}_permanent_water.tif", perm, 0, 10, 1, 255
    )
    spur = np.full((10, 10), 255, dtype="uint8")
    write_geotiff(
        base / "Spurious_Depths" / f"{TILE}_spurious_depth_areas.tif", spur, 0, 10, 1, 255
    )


def _extents() -> str:
    ring = [[0, 10], [10, 10], [10, 0], [0, 0], [0, 10]]
    return json.dumps(
        {
            "features": [
                {
                    "properties": {"id": 1, "name": "N10_E0"},
                    "geometry": {"type": "Polygon", "coordinates": [ring]},
                }
            ]
        }
    )


@pytest.mark.parametrize(
    ("lat", "lon", "flooded_rps"), [(5.5, 2.5, {50, 75, 100, 200, 500}), (1.5, 8.5, set())]
)
async def test_get_hazard_reads_local_tiles(
    tmp_path: Path, cache: ResponseCache, lat: float, lon: float, flooded_rps: set[int]
) -> None:
    _write_tile(tmp_path)
    cache.set_text(EXTENTS_KEY, _extents(), 60)
    async with httpx.AsyncClient() as client:
        result = await get_hazard(client, str(tmp_path), cache, lat, lon, 60)
    assert result.status == "ok"
    assert result.tile == TILE
    assert {d.return_period for d in result.depths if d.flooded} == flooded_rps
    assert result.permanent_water is (lat == 5.5)
    assert result.spurious_depth_area is False


async def test_get_hazard_outside_tiles_is_no_data(cache: ResponseCache) -> None:
    cache.set_text(EXTENTS_KEY, _extents(), 60)
    async with httpx.AsyncClient() as client:
        result = await get_hazard(client, "/nowhere", cache, -40, -40, 60)
    assert result.status == "no_data"


async def test_get_hazard_missing_file_is_error(tmp_path: Path, cache: ResponseCache) -> None:
    cache.set_text(EXTENTS_KEY, _extents(), 60)
    async with httpx.AsyncClient() as client:
        result = await get_hazard(client, str(tmp_path), cache, 5.5, 2.5, 60)
    assert result.status == "error"
    assert result.reason is not None
