import base64
import json
from datetime import date, timedelta
from pathlib import Path
from typing import Literal

import httpx
import numpy as np
import pytest
import respx
from fastapi.testclient import TestClient

from floodscope.cache import ResponseCache
from floodscope.config import Settings
from floodscope.grid import window_grid
from floodscope.models import DischargeDay, RiverDischarge
from floodscope.scene import (
    build_scenarios,
    build_static,
    depth_to_cm,
    fit_info,
    fit_shape,
)
from floodscope.sources import dem, flood, hazard

from .conftest import write_geotiff

TODAY = date(2026, 10, 21)


def river(status: Literal["ok", "no_data"] = "ok") -> RiverDischarge:
    return RiverDischarge(
        status=status,
        grid_lat=10.0 if status == "ok" else None,
        grid_lon=10.0 if status == "ok" else None,
        source=flood.source_info(),
    )


def gumbel_history(mu: float, beta: float, years: int) -> list[tuple[date, float | None]]:
    """Daily series whose yearly maxima follow known Gumbel quantiles."""
    out: list[tuple[date, float | None]] = []
    for i, y in enumerate(range(1997, 1997 + years)):
        p = (i + 0.5) / years
        peak = mu - beta * np.log(-np.log(p))
        start = date(y, 1, 1)
        for k in range(365):
            out.append((start + timedelta(days=k), float(peak if k == 100 else peak / 10)))
    return out


def test_depth_to_cm_handles_nan_and_clips() -> None:
    cm = depth_to_cm(np.array([np.nan, -1.0, 0.004, 1.234, 1000.0], dtype="float32"))
    assert cm.tolist() == [0, 0, 0, 123, 65535]
    assert cm.dtype == np.dtype("<u2")


def test_fit_shape_crops_and_pads() -> None:
    a = np.ones((3, 5), dtype="float32")
    out = fit_shape(a, 4, 4)
    assert out.shape == (4, 4)
    assert np.isnan(out[3]).all() and (out[:3] == 1).all()


def test_fit_info_from_history() -> None:
    info = fit_info(river(), gumbel_history(100.0, 30.0, 29))
    assert info.status == "ok"
    assert (info.first_year, info.last_year, info.n_years) == (1997, 2025, 29)
    q10 = next(t.discharge for t in info.thresholds if t.return_period == 10)
    q100 = next(t.discharge for t in info.thresholds if t.return_period == 100)
    assert q10 < q100
    assert info.source.data_date == "Annual maxima 1997-2025"


def test_fit_info_without_river_or_history() -> None:
    assert fit_info(river("no_data"), None).status == "no_data"
    short = fit_info(river(), gumbel_history(100.0, 30.0, 5))
    assert short.status == "no_data" and short.reason and "at least" in short.reason
    assert fit_info(river(), None, "boom").status == "error"


def _days(values: list[float | None]) -> list[DischargeDay]:
    return [
        DischargeDay(
            date=TODAY + timedelta(days=i - 1),
            discharge=v,
            ensemble_mean=v,
            ensemble_p25=None if v is None else v * 0.9,
            ensemble_p75=None if v is None else v * 1.1,
        )
        for i, v in enumerate(values)
    ]


def test_build_scenarios_maps_flows_to_hazard_maps() -> None:
    info = fit_info(river(), gumbel_history(100.0, 30.0, 29))
    q = {t.return_period: t.discharge for t in info.thresholds}
    days = _days([50.0, 50.0, q[10] * 1.0001, (q[20] * q[50]) ** 0.5, q[500] * 3, None])
    scenarios = build_scenarios(days, info, TODAY)
    # Yesterday is dropped; today is day 0.
    assert [s.day for s in scenarios] == [0, 1, 2, 3, 4]
    today, d1, d2, d3, d4 = scenarios
    assert today.maps is None and today.return_period is not None and today.return_period < 10
    assert d1.maps is not None and (d1.maps.lower, d1.maps.upper) == (10, 20)
    assert d1.maps.weight == pytest.approx(0, abs=0.01)
    assert d2.maps is not None and (d2.maps.lower, d2.maps.upper) == (20, 50)
    assert d3.beyond_largest_map and d3.maps is not None and d3.maps.lower == 500
    assert d4.discharge is None and d4.return_period is None and d4.maps is None
    assert today.return_period_low is not None and today.return_period_high is not None
    assert today.return_period_low <= today.return_period <= today.return_period_high


def test_build_scenarios_without_fit_keeps_flows() -> None:
    scenarios = build_scenarios(_days([0.0, 5.0]), fit_info(river("no_data"), None), TODAY)
    assert len(scenarios) == 1
    assert scenarios[0].discharge == 5.0 and scenarios[0].return_period is None


async def test_build_static_with_local_rasters(
    tmp_path: Path, cache: ResponseCache, monkeypatch: pytest.MonkeyPatch
) -> None:
    g = window_grid(5.5, 2.5, 2)
    dem_tile = "Copernicus_DSM_COG_10_N05_00_E002_00_DEM"
    heights = np.full((3600, 3600), 7.5, dtype="float32")
    write_geotiff(
        tmp_path / "dem" / dem_tile / f"{dem_tile}.tif", heights, 2.0, 6.0, 1 / 3600, -32767
    )

    jrc = tmp_path / "jrc"
    tile = "ID1_N10_E0"
    size = 12000
    for rp in (10, 20, 50, 75, 100, 200, 500):
        depth = np.full((size // 10, size // 10), -9999, dtype="float32")
        if rp >= 100:
            depth[:, :] = 1.25
        # Coarse stand-in covering 0-10 E, 0-10 N at 0.0083 deg (10x JRC spacing).
        write_geotiff(jrc / f"RP{rp}" / f"{tile}_RP{rp}_depth.tif", depth, 0, 10, 10 / 1200, -9999)
    perm = np.full((size // 10, size // 10), 255, dtype="uint8")
    write_geotiff(
        jrc / "Permanent_WaterBodies" / f"{tile}_permanent_water.tif", perm, 0, 10, 10 / 1200, 255
    )
    write_geotiff(
        jrc / "Spurious_Depths" / f"{tile}_spurious_depth_areas.tif", perm, 0, 10, 10 / 1200, 255
    )
    ring = [[0, 10], [10, 10], [10, 0], [0, 0], [0, 10]]
    cache.set_text(
        hazard.EXTENTS_KEY,
        json.dumps(
            {
                "features": [
                    {"properties": {"id": 1, "name": "N10_E0"}, "geometry": {"coordinates": [ring]}}
                ]
            }
        ),
        60,
    )

    async def always(*_: object, **__: object) -> bool:
        return True

    monkeypatch.setattr(dem, "tile_exists", always)
    settings = Settings(
        cache_dir=tmp_path / "c", copernicus_dem_url=str(tmp_path / "dem"), jrc_hazard_url=str(jrc)
    )
    monkeypatch.setattr("floodscope.scene.geoid_height_m", lambda *_: 17.25)
    async with httpx.AsyncClient() as client:
        static = await build_static(g, client, cache, settings)

    assert static.geoid_offset_m == 17.25
    assert static.dem.status == "ok" and static.dem.heights_f32
    h = np.frombuffer(base64.b64decode(static.dem.heights_f32), "<f4")
    assert h.size == g.nx * g.ny and np.allclose(h, 7.5)
    assert static.hazard.status == "ok"
    by_rp = {layer.return_period: layer for layer in static.hazard.layers}
    assert by_rp[50].flooded_cells == 0
    assert by_rp[100].flooded_cells == g.nx * g.ny
    cm = np.frombuffer(base64.b64decode(by_rp[100].depth_cm_u16), "<u2")
    assert (cm == 125).all()
    assert static.hazard.permanent_water_cells == 0
    assert static.hazard.spurious_depth_in_window is False


@respx.mock
async def test_get_history_parses_daily_series() -> None:
    url = "https://flood.example/v1/flood"
    respx.get(url).mock(
        return_value=httpx.Response(
            200,
            json={"daily": {"time": ["1997-01-01", "1997-01-02"], "river_discharge": [1.5, None]}},
        )
    )
    async with httpx.AsyncClient() as client:
        rows = await flood.get_history(client, url, 51.5, -0.1, date(2025, 12, 31))
    assert rows == [(date(1997, 1, 1), 1.5), (date(1997, 1, 2), None)]
    params = respx.calls[0].request.url.params
    assert params["start_date"] == "1984-01-01" and params["end_date"] == "2025-12-31"


def test_scene_endpoint_validates_size(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from floodscope import main

    settings = Settings(cache_dir=tmp_path / "cache")
    monkeypatch.setattr(main, "get_settings", lambda: settings)
    with TestClient(main.app) as c:
        assert c.get("/api/scene", params={"lat": 1, "lon": 1, "size_km": 20}).status_code == 422
        assert c.get("/api/scene", params={"lat": 1, "lon": 1, "size_km": 0.2}).status_code == 422
