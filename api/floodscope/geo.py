"""Small geographic helpers. Pure functions, so they are easy to test."""

import math

EARTH_RADIUS_KM = 6371.0088

# Rough box around Great Britain. The EA API only covers England; points in Wales or
# Scotland get an empty station list, which the UI explains.
_GB_BOX = (49.8, 61.0, -8.7, 2.0)  # lat_min, lat_max, lon_min, lon_max


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def in_great_britain(lat: float, lon: float) -> bool:
    lat_min, lat_max, lon_min, lon_max = _GB_BOX
    return lat_min <= lat <= lat_max and lon_min <= lon <= lon_max


def copernicus_tile_name(lat: float, lon: float) -> str:
    """Name of the 1x1 degree Copernicus GLO-30 tile containing the point.

    Tiles are named by their south-west corner, e.g. N51_00_W001_00 covers
    lat 51..52, lon -1..0.
    """
    lat_i = math.floor(lat)
    lon_i = math.floor(lon)
    ns = "N" if lat_i >= 0 else "S"
    ew = "E" if lon_i >= 0 else "W"
    return f"Copernicus_DSM_COG_10_{ns}{abs(lat_i):02d}_00_{ew}{abs(lon_i):03d}_00_DEM"


def pixel_size_m(lat: float, res_x_deg: float, res_y_deg: float) -> tuple[float, float]:
    """Approximate pixel size in metres for a lat/lon grid at the given latitude."""
    m_per_deg_lat = math.pi * EARTH_RADIUS_KM * 1000 / 180
    m_per_deg_lon = m_per_deg_lat * math.cos(math.radians(lat))
    return (abs(res_x_deg) * m_per_deg_lon, abs(res_y_deg) * m_per_deg_lat)


def ring_offsets(lat: float, lon: float, step_deg: float) -> list[tuple[float, float]]:
    """The eight neighbours of a point at `step_deg`, clamped to valid coordinates."""
    out: list[tuple[float, float]] = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            la = max(-90.0, min(90.0, lat + dy * step_deg))
            lo = ((lon + dx * step_deg + 180.0) % 360.0) - 180.0
            out.append((round(la, 5), round(lo, 5)))
    return out


def point_in_bbox(lat: float, lon: float, bbox: tuple[float, float, float, float]) -> bool:
    """bbox is (west, south, east, north)."""
    west, south, east, north = bbox
    return west <= lon <= east and south <= lat <= north
