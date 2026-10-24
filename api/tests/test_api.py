from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from floodscope import main
from floodscope.config import Settings, get_settings
from floodscope.models import (
    Elevation,
    FloodHazard,
    PointResponse,
    RiverDischarge,
    UKLive,
)
from floodscope.sources import dem, ea, flood, hazard

from .conftest import load_fixture


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    settings = Settings(cache_dir=tmp_path / "cache")
    monkeypatch.setattr(main, "get_settings", lambda: settings)
    with TestClient(main.app) as c:
        yield c
    get_settings.cache_clear()


@pytest.mark.parametrize(
    "params", [{"lat": 91, "lon": 0}, {"lat": 0, "lon": 181}, {"lat": "x", "lon": 0}, {"lat": 1}]
)
def test_point_rejects_bad_coordinates(client: TestClient, params: dict[str, Any]) -> None:
    assert client.get("/api/point", params=params).status_code == 422


def test_point_combines_all_sources(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    now = datetime.now(UTC)

    async def fake_elev(*_: object, **__: object) -> Elevation:
        return Elevation(status="ok", elevation_m=3.2, source=dem.source_info())

    async def fake_river(*_: object, **__: object) -> RiverDischarge:
        return RiverDischarge(status="no_data", reason="none", source=flood.source_info())

    async def fake_hazard(*_: object, **__: object) -> FloodHazard:
        return FloodHazard(status="error", reason="boom", source=hazard.source_info())

    async def fake_uk(*_: object, **__: object) -> UKLive:
        return UKLive(status="no_data", search_radius_km=5, source=ea.source_info())

    monkeypatch.setattr(dem, "get_elevation", fake_elev)
    monkeypatch.setattr(flood, "get_river_discharge", fake_river)
    monkeypatch.setattr(hazard, "get_hazard", fake_hazard)
    monkeypatch.setattr(ea, "get_uk_live", fake_uk)

    resp = client.get("/api/point", params={"lat": 1.5, "lon": 2.5})
    assert resp.status_code == 200
    body = PointResponse.model_validate(resp.json())
    assert body.elevation.elevation_m == 3.2
    assert body.river.status == "no_data"
    assert body.hazard.status == "error"
    assert body.disclaimer.startswith("Estimates for exploration")
    assert body.generated_at >= now
    for block in (body.elevation, body.river, body.hazard, body.uk_live):
        assert block.source.name and block.source.licence and block.source.resolution


@respx.mock
def test_geocode(client: TestClient) -> None:
    respx.get(url__startswith="https://geocoding-api.open-meteo.com").mock(
        return_value=httpx.Response(200, json=load_fixture("openmeteo_geocode_lagos.json"))
    )
    resp = client.get("/api/geocode", params={"q": "Lagos"})
    assert resp.status_code == 200
    first = resp.json()["results"][0]
    assert first["name"] == "Lagos" and first["country"] == "Nigeria"


@respx.mock
def test_geocode_upstream_failure_is_502(client: TestClient) -> None:
    respx.get(url__startswith="https://geocoding-api.open-meteo.com").mock(
        return_value=httpx.Response(503)
    )
    assert client.get("/api/geocode", params={"q": "Nowhere"}).status_code == 502


def test_health(client: TestClient) -> None:
    assert client.get("/api/health").json() == {"status": "ok"}
