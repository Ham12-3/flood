import math

import numpy as np
import pytest

from floodscope.grid import (
    ARCSEC,
    dem_lon_spacing_arcsec,
    dem_tiles_for,
    sample_at,
    window_grid,
)


@pytest.mark.parametrize(
    ("lat", "expected"),
    [(0, 1.0), (49.9, 1.0), (51.5, 1.5), (-55, 1.5), (65, 2.0), (75, 3.0), (82, 5.0), (88, 10.0)],
)
def test_dem_lon_spacing(lat: float, expected: float) -> None:
    assert dem_lon_spacing_arcsec(lat) == expected


@pytest.mark.parametrize(("lat", "lon"), [(51.4938, -0.2288), (6.45, 3.39), (-33.9, 151.2)])
def test_window_is_roughly_square_and_snapped_to_pixel_edges(lat: float, lon: float) -> None:
    g = window_grid(lat, lon, 4)
    w_m, h_m = g.cell_size_m()
    assert g.nx * w_m == pytest.approx(4000, rel=0.03)
    assert g.ny * h_m == pytest.approx(4000, rel=0.03)
    assert g.west < lon < g.east and g.south < lat < g.north
    # Pixel edges sit half a pixel off whole multiples of the spacing.
    for edge, step in ((g.west, g.dx), (g.south, g.dy)):
        frac = (edge / step) % 1
        assert frac == pytest.approx(0.5, abs=1e-6)
    assert g.east == pytest.approx(g.west + g.nx * g.dx)


def test_window_size_limits() -> None:
    with pytest.raises(ValueError):
        window_grid(0, 0, 0.5)
    with pytest.raises(ValueError):
        window_grid(0, 0, 11)


def test_cell_centres_run_north_to_south() -> None:
    g = window_grid(10, 10, 1)
    lons, lats = g.cell_centres()
    assert lons.shape == lats.shape == (g.ny, g.nx)
    assert lats[0, 0] > lats[-1, 0]
    assert lats[0, 0] == pytest.approx(g.north - g.dy / 2)
    assert lons[0, 1] - lons[0, 0] == pytest.approx(g.dx)


def test_dem_tiles_for_crossing_boundaries() -> None:
    assert dem_tiles_for((-0.3, 51.4, -0.1, 51.6)) == [(51, -1)]
    assert sorted(dem_tiles_for((-0.05, 51.95, 0.05, 52.05))) == [
        (51, -1),
        (51, 0),
        (52, -1),
        (52, 0),
    ]
    # An edge exactly on a whole degree does not pull in the next tile.
    assert dem_tiles_for((1.0, 1.0, 2.0, 2.0)) == [(1, 1)]


def test_sample_at_nearest_and_outside() -> None:
    data = np.arange(12, dtype="float32").reshape(3, 4)  # 1 degree pixels, NW corner (0, 3)
    transform = (1.0, 0.0, 0.0, 0.0, -1.0, 3.0)
    lons = np.array([[0.5, 3.9, 10.0]])
    lats = np.array([[2.5, 0.1, 1.0]])
    out = sample_at(data, transform, lons, lats)
    assert out[0, 0] == 0 and out[0, 1] == 11
    assert math.isnan(out[0, 2])


def test_arcsec_constant() -> None:
    assert pytest.approx(1.0) == ARCSEC * 3600
