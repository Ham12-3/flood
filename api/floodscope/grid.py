"""The terrain window used by the 3D flood view.

The grid follows the Copernicus GLO-30 native spacing so DEM pixels are used as-is:
1 arc-second north-south everywhere, and east-west 1" below 50 deg, widening towards
the poles (1.5", 2", 3", 5", 10"), which keeps cells roughly 30 m square.
"""

import math
from dataclasses import dataclass

import numpy as np

from floodscope.geo import pixel_size_m

ARCSEC = 1.0 / 3600.0
KM_PER_DEG_LAT = 111.32
MIN_SIZE_KM = 1.0
MAX_SIZE_KM = 10.0


def dem_lon_spacing_arcsec(lat: float) -> float:
    a = abs(lat)
    if a < 50:
        return 1.0
    if a < 60:
        return 1.5
    if a < 70:
        return 2.0
    if a < 80:
        return 3.0
    if a < 85:
        return 5.0
    return 10.0


@dataclass(frozen=True)
class WindowGrid:
    west: float
    south: float
    east: float
    north: float
    nx: int
    ny: int
    dx: float  # degrees per column
    dy: float  # degrees per row

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        return (self.west, self.south, self.east, self.north)

    @property
    def key(self) -> str:
        return f"{self.west:.6f}:{self.south:.6f}:{self.nx}x{self.ny}"

    def cell_size_m(self) -> tuple[float, float]:
        return pixel_size_m((self.south + self.north) / 2, self.dx, self.dy)

    def cell_centres(self) -> tuple[np.ndarray, np.ndarray]:
        """(lon, lat) of every cell centre as 2-D arrays, row 0 at the north edge."""
        lons = self.west + (np.arange(self.nx) + 0.5) * self.dx
        lats = self.north - (np.arange(self.ny) + 0.5) * self.dy
        return np.meshgrid(lons, lats)


def window_grid(lat: float, lon: float, size_km: float) -> WindowGrid:
    """A square window of roughly size_km on each side, snapped to DEM pixel edges.

    GLO-30 pixel centres sit on whole multiples of the spacing, so pixel edges sit
    half a pixel off them.
    """
    if not MIN_SIZE_KM <= size_km <= MAX_SIZE_KM:
        raise ValueError(f"size_km must be between {MIN_SIZE_KM:g} and {MAX_SIZE_KM:g}")
    dy = ARCSEC
    dx = dem_lon_spacing_arcsec(lat) * ARCSEC
    half_lat = size_km / 2 / KM_PER_DEG_LAT
    half_lon = size_km / 2 / (KM_PER_DEG_LAT * max(math.cos(math.radians(lat)), 0.01))

    def edge(value: float, step: float, fn: object) -> float:
        k = math.floor(value / step - 0.5) if fn is math.floor else math.ceil(value / step - 0.5)
        return (k + 0.5) * step

    west = edge(lon - half_lon, dx, math.floor)
    east = edge(lon + half_lon, dx, math.ceil)
    south = edge(max(lat - half_lat, -90.0), dy, math.floor)
    north = edge(min(lat + half_lat, 90.0), dy, math.ceil)
    nx = round((east - west) / dx)
    ny = round((north - south) / dy)
    return WindowGrid(west, south, west + nx * dx, south + ny * dy, nx, ny, dx, dy)


def dem_tiles_for(bounds: tuple[float, float, float, float]) -> list[tuple[int, int]]:
    """(lat, lon) south-west corners of every 1x1 degree tile touching the bounds."""
    west, south, east, north = bounds
    return [
        (la, lo)
        for la in range(math.floor(south), math.floor(north - 1e-12) + 1)
        for lo in range(math.floor(west), math.floor(east - 1e-12) + 1)
    ]


def sample_at(
    data: np.ndarray, transform: tuple[float, ...], lons: np.ndarray, lats: np.ndarray
) -> np.ndarray:
    """Nearest-pixel sample of a north-up raster at the given coordinates (NaN outside)."""
    a, _, c, _, e, f = transform[:6]
    cols = np.floor((lons - c) / a).astype(np.int64)
    rows = np.floor((lats - f) / e).astype(np.int64)
    inside = (rows >= 0) & (rows < data.shape[0]) & (cols >= 0) & (cols < data.shape[1])
    out = np.full(lons.shape, np.nan, dtype="float32")
    out[inside] = data[rows[inside], cols[inside]]
    return out
