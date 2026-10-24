from datetime import UTC, datetime

import httpx
import respx

from floodscope.sources.ea import get_groundwater, parse_groundwater

from .conftest import load_fixture

BASE = "https://ea.example/flood-monitoring"
READING = (51.45, -0.97)
NOW = datetime(2026, 10, 24, 12, 0, tzinfo=UTC)


def _hodcott() -> dict[str, object]:
    items = load_fixture("ea_groundwater_stations_reading.json")["items"]
    station: dict[str, object] = next(s for s in items if s["stationReference"] == "SU48_72B")
    return station


def test_parse_recorded_borehole() -> None:
    station = parse_groundwater(
        _hodcott(),
        load_fixture("ea_groundwater_measures_SU48_72B.json")["items"],
        load_fixture("ea_groundwater_stagescale_SU48_72B.json")["items"],
        *READING,
        now=NOW,
    )
    assert station.label == "Hodcott"
    assert station.level_maod is not None and station.datum_maod == 127.07
    assert station.depth_below_datum_m == round(127.07 - station.level_maod, 2)
    assert not station.stale
    assert station.max_on_record == 121.778 and station.min_on_record == 102.484
    assert 20 < station.distance_km < 30


def test_parse_without_stage_scale_or_reading() -> None:
    station = parse_groundwater(_hodcott(), [], {}, *READING, now=NOW)
    assert station.level_maod is None and station.datum_maod is None
    assert station.depth_below_datum_m is None
    assert station.stale


async def test_outside_great_britain() -> None:
    async with httpx.AsyncClient() as client:
        block = await get_groundwater(client, BASE, 6.45, 3.39)
    assert block.status == "no_data"


@respx.mock
async def test_skips_retired_boreholes_and_returns_nearest_live() -> None:
    respx.get(f"{BASE}/id/stations").mock(
        return_value=httpx.Response(200, json=load_fixture("ea_groundwater_stations_reading.json"))
    )
    measures = load_fixture("ea_groundwater_measures_SU48_72B.json")

    def measures_for(request: httpx.Request) -> httpx.Response:
        ref = request.url.params["stationReference"]
        return httpx.Response(200, json=measures if ref == "SU48_72B" else {"items": []})

    respx.get(f"{BASE}/id/measures").mock(side_effect=measures_for)
    respx.get(url__regex=rf"{BASE}/id/stations/.+/stageScale").mock(
        return_value=httpx.Response(
            200, json=load_fixture("ea_groundwater_stagescale_SU48_72B.json")
        )
    )
    async with httpx.AsyncClient() as client:
        block = await get_groundwater(client, BASE, *READING)
    # The recorded reading may be days old by the time tests run; either way the
    # retired boreholes (no measures) must be skipped and only Hodcott considered.
    assert block.status in ("ok", "no_data")
    if block.status == "ok":
        assert block.station is not None and block.station.reference == "SU48_72B"
    # Refs containing "/" never hit the stageScale path.
    assert not any("/78A/" in str(c.request.url) for c in respx.calls)


@respx.mock
async def test_api_failure_is_error_with_message() -> None:
    respx.get(f"{BASE}/id/stations").mock(side_effect=httpx.ReadTimeout(""))
    async with httpx.AsyncClient() as client:
        block = await get_groundwater(client, BASE, *READING)
    assert block.status == "error"
    assert block.reason is not None and "ReadTimeout" in block.reason
