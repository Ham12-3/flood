import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from floodscope.cache import ResponseCache

FIXTURES = Path(__file__).parent / "fixtures"


def load_fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


@pytest.fixture
def cache(tmp_path: Path) -> Iterator[ResponseCache]:
    c = ResponseCache(tmp_path / "cache")
    yield c
    c.close()


def write_geotiff(
    path: Path,
    data: np.ndarray,
    west: float,
    north: float,
    res: float,
    nodata: float | None,
) -> None:
    """Write a small EPSG:4326 GeoTIFF for raster tests."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=data.shape[0],
        width=data.shape[1],
        count=1,
        dtype=data.dtype,
        crs="EPSG:4326",
        transform=from_origin(west, north, res, res),
        nodata=nodata,
    ) as ds:
        ds.write(data, 1)
