import numpy as np
import pytest

from floodscope.replay.sim import (
    SimParams,
    Simulation,
    aggregate_ground,
    bilinear_rain,
    sea_mask,
)

MM_H = 1 / 1000 / 3600  # 1 mm per hour, in m/s


def balance(s: Simulation) -> float:
    """Rain in minus everything accounted for; zero when no water is made or lost."""
    return s.added_m3 - (s.volume_m3() + s.outflow_m3 + s.drained_m3 + s.sea_exchange_m3)


def bowl(n: int = 41, depth: float = 4.0) -> np.ndarray:
    y, x = np.mgrid[0:n, 0:n]
    r = np.hypot(x - n // 2, y - n // 2) / (n // 2)
    z: np.ndarray = 10 + depth * (r**2 - 1)
    return z


def test_sea_mask_follows_the_edge_and_skips_polders_and_lakes() -> None:
    z = np.full((6, 8), 5.0)
    z[:, 0] = 0.0  # sea along the west edge
    z[2, 1] = 0.0  # a lagoon cell joined to it
    z[4, 4] = 0.0  # an inland 0 m patch, not joined to the edge
    z[1, 6] = -2.0  # a polder below sea level
    z[0, 7] = np.nan  # no data at the edge: open sea
    sea = sea_mask(z)
    assert sea[:, 0].all() and sea[2, 1] and sea[0, 7]
    assert not sea[4, 4]
    assert not sea[1, 6]
    assert sea.sum() == 6 + 1 + 1


def test_aggregate_ground_keeps_land_height_and_counts_water() -> None:
    native = np.array(
        [
            [0.0, 0.0, 2.0, 4.0],
            [0.0, 1.5, 2.0, 2.0],
            [np.nan, np.nan, -1.0, -1.0],
            [np.nan, np.nan, -1.0, -3.0],
        ]
    )
    ground, water = aggregate_ground(native, 2, 2)
    # Shoreline cell: three water pixels and one at 1.5 m keeps 1.5 m, not 0.375 m.
    np.testing.assert_allclose(ground, [[1.5, 2.5], [0.0, -1.5]])
    np.testing.assert_allclose(water, [[0.75, 0.0], [1.0, 0.0]])
    # A polder below sea level is land, not water.
    sea = sea_mask(ground, water >= 0.5)
    assert sea.tolist() == [[True, False], [True, False]]


def test_sea_mask_absorbs_specks_but_keeps_islands() -> None:
    z = np.zeros((12, 12))
    z[2, 2] = 0.3  # a stake in the lagoon: one cell
    z[5, 5:7] = 0.4  # a jetty: two cells
    z[8:11, 7:11] = 2.0  # a real island: 12 cells
    z[0, 9] = 0.5  # a speck on the window edge: kept, it may be more land outside
    sea = sea_mask(z)
    assert sea[2, 2] and sea[5, 5] and sea[5, 6]
    assert not sea[8:11, 7:11].any()
    assert not sea[0, 9]


def test_specks_next_to_big_land_stay_land() -> None:
    z = np.zeros((10, 10))
    z[3:8, 3:8] = 1.0  # a 25-cell island; the search starts at its corners
    z[1, 5] = 0.5  # one cell joined to nothing: a speck
    sea = sea_mask(z)
    assert not sea[3:8, 3:8].any()
    assert sea[1, 5]


def test_lake_at_rest_stays_still() -> None:
    z = bowl()
    s = Simulation(z, np.zeros_like(z, dtype=bool), SimParams(dx=60, dy=60, drain_mm_h=0))
    level = 8.0
    s.h = np.maximum(level - z, 0.0)
    before = s.h.copy()
    s.run(3600, 0.0)
    assert np.abs(s.h - before).max() < 1e-6
    assert np.abs(s.qx).max() < 1e-9 and np.abs(s.qy).max() < 1e-9


def test_rain_into_a_closed_bowl_is_conserved() -> None:
    z = bowl()
    s = Simulation(z, np.zeros_like(z, dtype=bool), SimParams(dx=60, dy=60, drain_mm_h=0))
    rain = np.zeros_like(z)
    rain[3:-3, 3:-3] = 20 * MM_H  # rain on the rim would rightly run off the edge
    s.run(2 * 3600, rain)
    assert s.outflow_m3 == pytest.approx(0.0, abs=1e-6)
    assert s.volume_m3() == pytest.approx(s.added_m3, rel=1e-9)
    # Water gathers at the bottom.
    centre = z.shape[0] // 2
    assert s.h[centre, centre] > s.h[2, centre]


def test_mass_balance_closes_with_drains_sea_and_edges() -> None:
    rng = np.random.default_rng(3)
    n = 60
    y, x = np.mgrid[0:n, 0:n]
    z = 3 + 0.02 * x + np.sin(x / 7) * np.cos(y / 5) + rng.normal(0, 0.3, (n, n))
    z[:, :8] = 0.0
    sea = sea_mask(z)
    s = Simulation(z, sea, SimParams(dx=60, dy=60, drain_mm_h=5))
    for level in (0.0, 0.4, -0.3):
        s.set_sea_level(level)
        s.run(1800, 25 * MM_H)
    assert s.added_m3 > 0
    assert abs(balance(s)) < 1e-6 * s.added_m3
    assert s.drained_m3 > 0 and s.sea_exchange_m3 > 0 and (s.h >= 0).all()


def test_sea_never_flows_onto_land() -> None:
    z = np.full((10, 10), 0.2)  # low shore
    z[:, :3] = 0.0
    sea = sea_mask(z)
    s = Simulation(z, sea, SimParams(dx=60, dy=60, drain_mm_h=0))
    s.set_sea_level(1.0)  # a high tide well above the shore
    s.run(3600, 0.0)
    assert s.h[~sea].max() == 0.0
    assert s.h[sea].min() == pytest.approx(1.0)


def test_high_tide_holds_water_back_on_land() -> None:
    def run(level: float) -> float:
        z = np.tile(np.linspace(0.4, 0.0, 12), (6, 1))  # slopes down to the sea in the east
        z[:, -2:] = 0.0
        sea = sea_mask(z)
        s = Simulation(z, sea, SimParams(dx=60, dy=60, drain_mm_h=0))
        s.set_sea_level(level)
        s.run(3600, 30 * MM_H)
        return s.volume_m3()

    assert run(0.6) > run(-0.5)


def test_drains_stop_below_sea_level() -> None:
    z = np.full((5, 5), 0.3)
    z[:, 0] = 0.0
    sea = sea_mask(z)
    s = Simulation(z, sea, SimParams(dx=60, dy=60, drain_mm_h=10))
    s.set_sea_level(0.5)
    s.h[2, 3] = 0.05
    s.run(600, 0.0)
    assert s.drained_m3 == 0.0
    s.set_sea_level(-1.0)  # ground now 1.3 m above the sea: full rate
    s.run(600, 0.0)
    assert s.drained_m3 > 0.0


def test_bilinear_rain_matches_points_and_interpolates() -> None:
    values = np.array([[[0.0, 4.0], [8.0, 12.0]]])  # north row first, west to east
    lons, lats = np.array([0.0, 1.0]), np.array([1.0, 0.0])
    cell_lons = np.array([[0.0, 1.0, 0.5], [0.5, -1.0, 2.0]])
    cell_lats = np.array([[1.0, 0.0, 0.5], [1.0, 1.0, 0.0]])
    out = bilinear_rain(values, lons, lats, cell_lons, cell_lats)
    assert out.shape == (1, 2, 3)
    np.testing.assert_allclose(out[0], [[0.0, 12.0, 6.0], [2.0, 0.0, 12.0]])
