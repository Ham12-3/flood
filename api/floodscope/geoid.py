"""EGM2008 geoid height, to turn DEM heights into ellipsoid heights for Cesium.

Copernicus DEM heights are above the EGM2008 geoid (roughly mean sea level); Cesium
places geometry by height above the WGS84 ellipsoid. The difference (N) is -107 m to
+86 m worldwide and changes by well under a metre across a 10 km window, so one value
at the window centre is used.

PROJ downloads only the grid tiles it needs from cdn.proj.org (network mode).
"""

import os
from functools import lru_cache

# Must be set before PROJ initialises.
os.environ.setdefault("PROJ_NETWORK", "ON")

from pyproj import Transformer


@lru_cache(maxsize=1)
def _transformer() -> Transformer:
    return Transformer.from_crs("EPSG:4326+3855", "EPSG:4979", always_xy=True)


@lru_cache(maxsize=4096)
def _undulation(lat_r: float, lon_r: float) -> float:
    _, _, h = _transformer().transform(lon_r, lat_r, 0.0)
    if h == float("inf") or h != h:
        raise RuntimeError("Geoid grid unavailable (PROJ could not fetch EGM2008)")
    return float(h)


def geoid_height_m(lat: float, lon: float) -> float:
    """N such that ellipsoid height = EGM2008 height + N."""
    return round(_undulation(round(lat, 3), round(lon, 3)), 2)
