"""Buildings and roads on the replay grid: compact encoding for the browser, and the
per-cell totals used to count what is under water each hour.

Binary layout of features.bin (all little-endian), sized for a weak client:
  uint32 x4   building count, building vertex count, road count, road vertex count
  uint32      building vertex offsets (count + 1)
  uint32      building cell index (row * nx + col of the building's centre)
  uint32      road vertex offsets (count + 1)
  uint16      building vertices as x, y pairs
  uint16      road vertices as x, y pairs
  uint8       road class index (see ROAD_CLASSES)
Vertices are quantised to the grid bounds: x = (lon - west) / (east - west) * 65535,
y = (north - lat) / (north - south) * 65535. Building rings are not closed (the last
vertex is not repeated). Roads are split so no piece is longer than half a cell.
"""

import gzip
from dataclasses import dataclass

import numpy as np
import shapely

from floodscope.geo import pixel_size_m
from floodscope.grid import WindowGrid

ROAD_CLASSES = [
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",  # 0-4: main roads
    "residential",
    "living_street",
    "unclassified",
    "service",
    "pedestrian",
    "unknown",
]
Q = 65535


@dataclass
class EncodedBuildings:
    offsets: np.ndarray  # uint32 (n + 1)
    cells: np.ndarray  # uint32 (n)
    coords: np.ndarray  # uint16 (2 * vertices)
    per_cell: np.ndarray  # int64 (ny * nx): buildings whose centre is in each cell


@dataclass
class EncodedRoads:
    offsets: np.ndarray  # uint32 (n + 1)
    classes: np.ndarray  # uint8 (n)
    coords: np.ndarray  # uint16 (2 * vertices)
    km_per_cell: np.ndarray  # float64 (ny * nx): road length whose midpoint is in each cell


def cell_index(g: WindowGrid, lons: np.ndarray, lats: np.ndarray) -> np.ndarray:
    """Row-major cell index for each point; -1 outside the grid."""
    col = np.floor((lons - g.west) / g.dx).astype(np.int64)
    row = np.floor((g.north - lats) / g.dy).astype(np.int64)
    inside = (col >= 0) & (col < g.nx) & (row >= 0) & (row < g.ny)
    return np.where(inside, row * g.nx + col, -1)


def quantise(g: WindowGrid, xy: np.ndarray) -> np.ndarray:
    qx = np.round((xy[:, 0] - g.west) / (g.east - g.west) * Q)
    qy = np.round((g.north - xy[:, 1]) / (g.north - g.south) * Q)
    out: np.ndarray = np.clip(np.column_stack([qx, qy]), 0, Q).astype("<u2").ravel()
    return out


def _offsets(index: np.ndarray, n: int) -> np.ndarray:
    counts = np.bincount(index, minlength=n)
    out: np.ndarray = np.concatenate([[0], np.cumsum(counts)]).astype("<u4")
    return out


def encode_buildings(geoms: np.ndarray, g: WindowGrid) -> EncodedBuildings:
    """One outline per building (the largest part of multi-part ones), centre in the grid."""
    n_cells = g.nx * g.ny
    empty = EncodedBuildings(
        np.zeros(1, "<u4"), np.zeros(0, "<u4"), np.zeros(0, "<u2"), np.zeros(n_cells, np.int64)
    )
    if len(geoms) == 0:
        return empty
    parts, owner = shapely.get_parts(geoms, return_index=True)
    polys = shapely.get_type_id(parts) == 3
    parts, owner = parts[polys], owner[polys]
    if len(parts) == 0:
        return empty
    # Largest part per building: sort by owner then area, keep the last of each owner.
    area = shapely.area(parts)
    order = np.lexsort((area, owner))
    last = np.r_[owner[order][1:] != owner[order][:-1], True]
    parts = parts[order][last]
    centres = shapely.get_coordinates(shapely.centroid(parts))
    cells = cell_index(g, centres[:, 0], centres[:, 1])
    keep = cells >= 0
    parts, cells = parts[keep], cells[keep]
    if len(parts) == 0:
        return empty
    rings = shapely.get_exterior_ring(parts)
    xy, idx = shapely.get_coordinates(rings, return_index=True)
    # Drop each ring's closing vertex (a repeat of its first).
    is_last = np.r_[idx[1:] != idx[:-1], True]
    xy, idx = xy[~is_last], idx[~is_last]
    return EncodedBuildings(
        offsets=_offsets(idx, len(parts)),
        cells=cells.astype("<u4"),
        coords=quantise(g, xy),
        per_cell=np.bincount(cells, minlength=n_cells).astype(np.int64),
    )


def encode_roads(geoms: np.ndarray, classes: np.ndarray, g: WindowGrid) -> EncodedRoads:
    n_cells = g.nx * g.ny
    empty = EncodedRoads(
        np.zeros(1, "<u4"), np.zeros(0, "u1"), np.zeros(0, "<u2"), np.zeros(n_cells)
    )
    if len(geoms) == 0:
        return empty
    clipped = shapely.clip_by_rect(geoms, g.west, g.south, g.east, g.north)
    parts, owner = shapely.get_parts(clipped, return_index=True)
    lines = (shapely.get_type_id(parts) == 1) & ~shapely.is_empty(parts)
    parts, owner = parts[lines], owner[lines]
    if len(parts) == 0:
        return empty
    parts = shapely.segmentize(parts, min(g.dx, g.dy) / 2)
    xy, idx = shapely.get_coordinates(parts, return_index=True)
    cls_index = {c: i for i, c in enumerate(ROAD_CLASSES)}
    road_cls = np.array(
        [cls_index.get(str(c), cls_index["unknown"]) for c in classes[owner]], dtype="u1"
    )
    # Length of each piece, credited to the cell holding its midpoint.
    mx, my = pixel_size_m((g.south + g.north) / 2, 1.0, 1.0)  # metres per degree
    same = idx[1:] == idx[:-1]
    a, b = xy[:-1][same], xy[1:][same]
    length_km = np.hypot((b[:, 0] - a[:, 0]) * mx, (b[:, 1] - a[:, 1]) * my) / 1000
    mid = (a + b) / 2
    cells = cell_index(g, mid[:, 0], mid[:, 1])
    ok = cells >= 0
    km = np.bincount(cells[ok], weights=length_km[ok], minlength=n_cells)
    return EncodedRoads(_offsets(idx, len(parts)), road_cls, quantise(g, xy), km)


def features_blob(b: EncodedBuildings, r: EncodedRoads) -> bytes:
    header = np.array(
        [len(b.cells), len(b.coords) // 2, len(r.classes), len(r.coords) // 2], dtype="<u4"
    )
    raw = b"".join(
        np.ascontiguousarray(a).tobytes()
        for a in (header, b.offsets, b.cells, r.offsets, b.coords, r.coords, r.classes)
    )
    return gzip.compress(raw, compresslevel=6)


@dataclass(frozen=True)
class HourCounts:
    flooded_km2: float
    max_depth_m: float
    buildings_wet: int
    roads_km_10cm: float
    roads_km_30cm: float


WET_M = 0.10  # "water at the door", and a road worth avoiding
DEEP_M = 0.30  # most cars stop


def count_hour(
    h: np.ndarray, sea: np.ndarray, cell_area_m2: float, b: EncodedBuildings, r: EncodedRoads
) -> HourCounts:
    land = ~sea
    flat = h.ravel()
    wet = (flat >= WET_M) & land.ravel()
    deep = (flat >= DEEP_M) & land.ravel()
    return HourCounts(
        flooded_km2=float(wet.sum() * cell_area_m2 / 1e6),
        max_depth_m=float(h[land].max()) if land.any() else 0.0,
        buildings_wet=int(b.per_cell[wet].sum()),
        roads_km_10cm=float(r.km_per_cell[wet].sum()),
        roads_km_30cm=float(r.km_per_cell[deep].sum()),
    )
