from pathlib import Path

import numpy as np
import pytest

from floodscope.raster import RasterReadError, gdal_path, read_pixel

from .conftest import write_geotiff


@pytest.fixture
def grid(tmp_path: Path) -> str:
    # 4x4 degree raster, 1 degree pixels, north-west corner at (lon 0, lat 4).
    data = np.arange(16, dtype="float32").reshape(4, 4)
    data[0, 0] = -9999
    data[3, 3] = np.nan
    path = tmp_path / "grid.tif"
    write_geotiff(path, data, west=0, north=4, res=1, nodata=-9999)
    return str(path)


def test_gdal_path_adds_vsicurl_for_http() -> None:
    assert gdal_path("https://x.org/a/", "/b.tif") == "/vsicurl/https://x.org/a/b.tif"
    assert gdal_path("/data/a", "b.tif") == "/data/a/b.tif"


def test_reads_value_at_point(grid: str) -> None:
    # lat 2.5 is row 1, lon 1.5 is col 1 -> value 5
    px = read_pixel(grid, 2.5, 1.5)
    assert px.inside and px.value == 5.0
    assert px.res_x_deg == 1 and px.res_y_deg == 1


def test_nodata_is_none(grid: str) -> None:
    px = read_pixel(grid, 3.5, 0.5)
    assert px.inside and px.value is None


def test_nan_is_none(grid: str) -> None:
    assert read_pixel(grid, 0.5, 3.5).value is None


def test_outside_raster(grid: str) -> None:
    px = read_pixel(grid, 10, 10)
    assert not px.inside and px.value is None


def test_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(RasterReadError):
        read_pixel(str(tmp_path / "nope.tif"), 0, 0)
