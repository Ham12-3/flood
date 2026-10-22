"""Single-pixel windowed reads from local or remote GeoTIFFs.

Remote files are opened through GDAL's /vsicurl/, which uses HTTP range requests,
so we only fetch the file header and the one internal tile that holds the pixel.
rasterio is blocking; callers run this in a worker thread.
"""

from dataclasses import dataclass

import numpy as np
import rasterio
from rasterio.errors import RasterioIOError
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
