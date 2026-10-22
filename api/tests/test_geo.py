import pytest

from floodscope.geo import (
    copernicus_tile_name,
    haversine_km,
    in_great_britain,
    pixel_size_m,
    point_in_bbox,
    ring_offsets,
)


@pytest.mark.parametrize(
    ("lat", "lon", "expected"),
    [
        (51.5, -0.12, "Copernicus_DSM_COG_10_N51_00_W001_00_DEM"),
        (6.45, 3.39, "Copernicus_DSM_COG_10_N06_00_E003_00_DEM"),
        (29.95, -90.07, "Copernicus_DSM_COG_10_N29_00_W091_00_DEM"),
        (-0.5, 0.0, "Copernicus_DSM_COG_10_S01_00_E000_00_DEM"),
        (0.0, -0.0001, "Copernicus_DSM_COG_10_N00_00_W001_00_DEM"),
        (-33.9, 151.2, "Copernicus_DSM_COG_10_S34_00_E151_00_DEM"),
    ],
)
def test_copernicus_tile_name(lat: float, lon: float, expected: str) -> None:
    assert copernicus_tile_name(lat, lon) == expected


def test_haversine_london_to_paris() -> None:
    assert haversine_km(51.5074, -0.1278, 48.8566, 2.3522) == pytest.approx(343.5, abs=1.0)


def test_haversine_zero() -> None:
    assert haversine_km(10, 10, 10, 10) == 0


def test_ring_offsets_has_eight_neighbours_and_skips_centre() -> None:
    ring = ring_offsets(10.0, 20.0, 0.05)
    assert len(ring) == 8
    assert (10.0, 20.0) not in ring
    assert (9.95, 19.95) in ring and (10.05, 20.05) in ring


def test_ring_offsets_wraps_dateline_and_clamps_pole() -> None:
    ring = ring_offsets(89.98, 179.98, 0.05)
    assert all(-180 <= lo < 180 for _, lo in ring)
    assert all(la <= 90 for la, _ in ring)
    assert any(lo < -179 for _, lo in ring)


def test_pixel_size_shrinks_east_west_with_latitude() -> None:
    w_eq, h_eq = pixel_size_m(0, 1 / 3600, 1 / 3600)
    w_60, h_60 = pixel_size_m(60, 1 / 3600, 1 / 3600)
    assert w_eq == pytest.approx(30.9, abs=0.1)
    assert h_eq == pytest.approx(h_60)
    assert w_60 == pytest.approx(w_eq / 2, rel=0.01)


def test_in_great_britain() -> None:
    assert in_great_britain(51.5, -0.12)
    assert not in_great_britain(6.45, 3.39)
    assert not in_great_britain(48.85, 2.35)  # Paris


def test_point_in_bbox_edges_inclusive() -> None:
    assert point_in_bbox(0, 0, (0, 0, 10, 10))
    assert point_in_bbox(10, 10, (0, 0, 10, 10))
    assert not point_in_bbox(10.01, 5, (0, 0, 10, 10))
