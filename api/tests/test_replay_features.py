import gzip
import math

import numpy as np
import pytest
import shapely

from floodscope.grid import WindowGrid
from floodscope.replay.build import replay_grid
from floodscope.replay.features import (
    ROAD_CLASSES,
    cell_index,
    count_hour,
    encode_buildings,
    encode_roads,
    features_blob,
)

# 4 x 2 cells of 0.01 degrees, north-west corner at (lon 0, lat 1).
G = WindowGrid(west=0.0, south=0.98, east=0.04, north=1.0, nx=4, ny=2, dx=0.01, dy=0.01)


def box(x0: float, y0: float, size: float = 0.002) -> shapely.Polygon:
    return shapely.box(x0, y0, x0 + size, y0 + size)


def test_cell_index_is_row_major_from_the_north() -> None:
    idx = cell_index(
        G, np.array([0.005, 0.035, 0.005, 0.05]), np.array([0.995, 0.995, 0.985, 0.99])
    )
    assert idx.tolist() == [0, 3, 4, -1]


def test_buildings_keep_largest_part_drop_outside_and_ring_repeats() -> None:
    small, big = box(0.0101, 0.9851, 0.001), box(0.012, 0.986, 0.004)
    geoms = np.array(
        [
            box(0.001, 0.991),  # cell 0
            shapely.MultiPolygon([small, big]),  # cell 5, counted once
            box(0.2, 0.99),  # outside the grid
            box(0.001, 0.992),  # cell 0 again
        ],
        dtype=object,
    )
    b = encode_buildings(geoms, G)
    assert len(b.cells) == 3
    assert sorted(b.cells.tolist()) == [0, 0, 5]
    assert b.per_cell[0] == 2 and b.per_cell[5] == 1 and b.per_cell.sum() == 3
    # Boxes have 4 corners once the closing repeat is dropped.
    assert np.diff(b.offsets).tolist() == [4, 4, 4]
    assert len(b.coords) == 2 * 12
    # The multipolygon kept its big part: its outline spans 0.004 degrees.
    k = b.cells.tolist().index(5)
    xs = b.coords[2 * b.offsets[k] : 2 * b.offsets[k + 1] : 2].astype(float) / 65535 * 0.04
    assert xs.max() - xs.min() == pytest.approx(0.004, abs=1e-5)


def test_roads_are_clipped_split_and_measured() -> None:
    line = shapely.LineString([(-0.01, 0.995), (0.05, 0.995)])  # crosses the top row
    r = encode_roads(np.array([line], dtype=object), np.array(["primary"], dtype=object), G)
    assert r.classes.tolist() == [ROAD_CLASSES.index("primary")]
    # Clipped to 0.04 degrees and split into pieces no longer than half a cell.
    n_vertices = len(r.coords) // 2
    assert n_vertices >= 9
    expected_km = 0.04 * 111.32 * math.cos(math.radians(0.99))
    assert r.km_per_cell.sum() == pytest.approx(expected_km, rel=0.01)
    assert r.km_per_cell[:4].min() > 0 and r.km_per_cell[4:].sum() == 0


def test_unknown_road_classes_are_kept_as_unknown() -> None:
    line = shapely.LineString([(0.001, 0.981), (0.002, 0.982)])
    r = encode_roads(np.array([line], dtype=object), np.array(["something_new"], dtype=object), G)
    assert r.classes.tolist() == [ROAD_CLASSES.index("unknown")]


def test_features_blob_layout() -> None:
    b = encode_buildings(np.array([box(0.001, 0.991)], dtype=object), G)
    r = encode_roads(
        np.array([shapely.LineString([(0.0, 0.99), (0.01, 0.99)])], dtype=object),
        np.array(["residential"], dtype=object),
        G,
    )
    raw = gzip.decompress(features_blob(b, r))
    nb, nbv, nr, nrv = np.frombuffer(raw[:16], "<u4").tolist()
    assert (nb, nbv, nr) == (1, 4, 1)
    expected = 16 + 4 * ((nb + 1) + nb + (nr + 1)) + 2 * (2 * nbv + 2 * nrv) + nr
    assert len(raw) == expected
    assert raw[-1] == ROAD_CLASSES.index("residential")


def test_empty_inputs_encode_cleanly() -> None:
    b = encode_buildings(np.array([], dtype=object), G)
    r = encode_roads(np.array([], dtype=object), np.array([], dtype=object), G)
    raw = gzip.decompress(features_blob(b, r))
    assert np.frombuffer(raw[:16], "<u4").tolist() == [0, 0, 0, 0]


def test_count_hour_uses_10_and_30_cm_and_skips_the_sea() -> None:
    b = encode_buildings(np.array([box(0.001, 0.991), box(0.021, 0.991)], dtype=object), G)
    r = encode_roads(
        np.array([shapely.LineString([(0.0, 0.995), (0.04, 0.995)])], dtype=object),
        np.array(["primary"], dtype=object),
        G,
    )
    h = np.array([[0.35, 0.05, 0.12, 0.0], [2.0, 0.0, 0.0, 0.0]])
    sea = np.zeros_like(h, dtype=bool)
    sea[1, 0] = True  # deep, but sea
    c = count_hour(h, sea, 1_000_000.0, b, r)
    assert c.flooded_km2 == pytest.approx(2.0)  # cells 0 and 2
    assert c.buildings_wet == 2
    assert c.max_depth_m == pytest.approx(0.35)
    per_cell = r.km_per_cell[0]
    assert c.roads_km_10cm == pytest.approx(r.km_per_cell[0] + r.km_per_cell[2])
    assert c.roads_km_30cm == pytest.approx(per_cell)


@pytest.mark.parametrize("lat", [0.0, 6.45, 53.96, 64.0, -33.9])
def test_replay_grid_has_roughly_square_60m_cells(lat: float) -> None:
    g = replay_grid(lat, 10.0, 10.0)
    w, h = g.cell_size_m()
    assert 50 < h < 65 and 0.75 < w / h < 1.35
    assert g.west < 10.0 < g.east and g.south < lat < g.north
    assert 9.9 < g.ny * h / 1000 < 10.3
    # Edges sit on whole cells, so nearby requests share a grid.
    assert (g.west / g.dx) == pytest.approx(round(g.west / g.dx))
