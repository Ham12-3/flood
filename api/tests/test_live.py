"""End-to-end checks against the real APIs. Run with: uv run pytest -m live

These are the "done" cities for Phase 1. They are slow on a cold cache because the
DEM read downloads a 1024x1024 block per new 1-degree tile.
"""

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from floodscope import main
from floodscope.config import Settings
from floodscope.models import PointResponse

CITIES = {
    "London": (51.5005, -0.1218),
    "Lagos": (6.4541, 3.3947),
    "Dhaka": (23.8103, 90.4125),
    "New Orleans": (29.9511, -90.0715),
}


@pytest.fixture(scope="module")
def client(tmp_path_factory: pytest.TempPathFactory) -> Iterator[TestClient]:
    settings = Settings(cache_dir=Path(tmp_path_factory.mktemp("cache")))
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(main, "get_settings", lambda: settings)
        with TestClient(main.app) as c:
            yield c


@pytest.mark.live
@pytest.mark.parametrize("city", list(CITIES))
def test_city_has_real_data(client: TestClient, city: str) -> None:
    lat, lon = CITIES[city]
    resp = client.get("/api/point", params={"lat": lat, "lon": lon}, timeout=180)
    assert resp.status_code == 200
    body = PointResponse.model_validate(resp.json())
    assert body.elevation.status == "ok", body.elevation.reason
    assert body.river.status == "ok", body.river.reason
    assert body.river.today is not None
    assert len(body.river.forecast) >= 30
    assert body.hazard.status == "ok", body.hazard.reason
    assert len(body.hazard.depths) == 7
    expected_uk = "ok" if city == "London" else "no_data"
    assert body.uk_live.status == expected_uk, body.uk_live.reason
