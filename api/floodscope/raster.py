"""Windowed reads from local or remote GeoTIFFs: single pixels and small mosaics.

Remote files are opened through GDAL's /vsicurl/, which uses HTTP range requests,
so we only fetch the file header and the one internal tile that holds the pixel.
rasterio is blocking; callers run this in a worker thread.
"""

from dataclasses import dataclass

import numpy as np
import rasterio
from affine import Affine
from rasterio.enums import Resampling
from rasterio.errors import RasterioIOError
from rasterio.merge import merge
from rasterio.windows import Window

GDAL_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
    "GDAL_HTTP_MAX_RETRY": "3",
    "GDAL_HTTP_RETRY_DELAY": "1",
    "GDAL_HTTP_TIMEOUT": "30",
    "VSI_CACHE": "TRUE",
    "VSI_CACHE_SIZE": str(64 * 1024 * 1024),
}


class RasterReadError(RuntimeError):
    pass


@dataclass(frozen=True)
class PixelRead:
    value: float | None  # None when the pixel is nodata
    inside: bool  # False when the point falls outside the raster
    res_x_deg: float
    res_y_deg: float


def gdal_path(base: str, relative: str) -> str:
    """Join a base URL or directory with a file path, adding /vsicurl/ for HTTP."""
    joined = f"{base.rstrip('/')}/{relative.lstrip('/')}"
    return f"/vsicurl/{joined}" if joined.startswith(("http://", "https://")) else joined


def read_pixel(path: str, lat: float, lon: float, user_agent: str = "") -> PixelRead:
    env = dict(GDAL_ENV)
    if user_agent:
        env["GDAL_HTTP_USERAGENT"] = user_agent
    try:
        with rasterio.Env(**env), rasterio.open(path) as ds:
            res_x, res_y = ds.res
            row, col = ds.index(lon, lat)
            if not (0 <= row < ds.height and 0 <= col < ds.width):
                return PixelRead(None, False, res_x, res_y)
            arr = ds.read(1, window=Window(col, row, 1, 1), masked=True)
            if np.ma.is_masked(arr) and bool(np.ma.getmaskarray(arr)[0, 0]):
                return PixelRead(None, True, res_x, res_y)
            value = float(arr[0, 0])
            if not np.isfinite(value):
                return PixelRead(None, True, res_x, res_y)
            return PixelRead(value, True, res_x, res_y)
    except RasterioIOError as exc:
        raise RasterReadError(f"Could not read {path.removeprefix('/vsicurl/')}: {exc}") from exc


Bounds = tuple[float, float, float, float]  # west, south, east, north


@dataclass(frozen=True)
class WindowRead:
    data: np.ndarray  # 2-D float32, NaN where there is no data; row 0 is north
    transform: Affine


def read_window(
    paths: list[str], bounds: Bounds, res: tuple[float, float], user_agent: str = ""
) -> WindowRead:
    """Mosaic a lat/lon window from one or more rasters at the given resolution.

    Pixels missing from every source (or equal to a source's nodata) come back as NaN.
    """
    env = dict(GDAL_ENV)
    if user_agent:
        env["GDAL_HTTP_USERAGENT"] = user_agent
    try:
        with rasterio.Env(**env):
            sources = [rasterio.open(p) for p in paths]
            try:
                arr, transform = merge(
                    sources,
                    bounds=bounds,
                    res=res,
                    nodata=np.nan,
                    dtype="float32",
                    resampling=Resampling.nearest,
                )
            finally:
                for s in sources:
                    s.close()
    except RasterioIOError as exc:
        raise RasterReadError(f"Could not read window: {exc}") from exc
    return WindowRead(arr[0].astype("float32"), transform)
