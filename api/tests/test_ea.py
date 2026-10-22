from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import respx

from floodscope.sources.ea import get_uk_live, parse_reading, parse_station, parse_warning

from .conftest import load_fixture

BASE = "https://ea.example/flood-monitoring"
WESTMINSTER = (51.5005, -0.1218)
NOW = datetime(2026, 10, 21, 18, 0, tzinfo=UTC)


def test_parse_recorded_station_detail() -> None:
    detail = load_fixture("ea_station_0006.json")["items"]
    station = parse_station(detail, *WESTMINSTER, now=NOW)
    assert station.reference == "0006"
    assert station.label == "Westminster"
    assert station.river == "Thames Tideway"
    assert station.distance_km < 0.5
    assert "Coastal" in station.station_types
    assert station.max_on_record == 4.81
    assert station.url.endswith("/station/0006")
    # One live tidal-level measure and one retired 1-minute measure (URL-only latestReading).
    assert len(station.readings) == 2
    assert station.readings[0].value is not None
    assert station.readings[-1].stale and station.readings[-1].value is None


def test_parse_station_handles_list_valued_fields() -> None:
    detail: dict[str, Any] = {
        "stationReference": "X1",
        "label": ["Bridge A", "Bridge A (old)"],
        "lat": [51.0, 51.0001],
        "long": [-1.0, -1.0001],
        "measures": {
            "parameterName": "Flow",
            "unitName": "m3/s",
            "latestReading": {"value": [3.2, 3.3], "dateTime": "2026-10-21T17:45:00Z"},
        },
        "stageScale": {"typicalRangeLow": 0.1, "typicalRangeHigh": 1.4},
        "type": "http://environment.data.gov.uk/flood-monitoring/def/core/SingleLevel",
    }
    station = parse_station(detail, 51.0, -1.0, now=NOW)
    assert station.label == "Bridge A"
    assert station.typical_range_high == 1.4
    assert station.station_types == ["SingleLevel"]
    assert station.readings[0].value == 3.2 and not station.readings[0].stale


def test_reading_older_than_a_day_is_stale() -> None:
    old = (NOW - timedelta(days=2)).isoformat()
    reading = parse_reading(
        {"parameter": "level", "latestReading": {"value": 1, "dateTime": old}}, NOW
    )
    assert reading.stale and reading.value == 1


def test_parse_recorded_warning() -> None:
    item = load_fixture("ea_floods_sample.json")["items"][0]
    warning = parse_warning(item)
    assert warning.area
    assert 1 <= warning.severity_level <= 4
    assert warning.severity


async def test_outside_great_britain_skips_api() -> None:
    async with httpx.AsyncClient() as client:
        result = await get_uk_live(client, BASE, 6.45, 3.39)
    assert result.status == "no_data"
    assert result.reason is not None and "England" in result.reason


@respx.mock
async def test_full_flow_with_recorded_responses() -> None:
    stations = load_fixture("ea_stations_westminster.json")
    detail = load_fixture("ea_station_0006.json")
    respx.get(f"{BASE}/id/stations").mock(return_value=httpx.Response(200, json=stations))
    respx.get(url__regex=rf"{BASE}/id/stations/.+").mock(
        return_value=httpx.Response(200, json=detail)
    )
    respx.get(f"{BASE}/id/floods").mock(
        return_value=httpx.Response(200, json=load_fixture("ea_floods_sample.json"))
    )
    async with httpx.AsyncClient() as client:
        result = await get_uk_live(client, BASE, *WESTMINSTER)
    assert result.status == "ok"
    assert len(result.stations) == len(stations["items"])
    assert result.warnings == sorted(result.warnings, key=lambda w: w.severity_level)
    assert result.source.licence.startswith("Open Government Licence")


@respx.mock
async def test_no_stations_no_warnings_is_no_data() -> None:
    empty = httpx.Response(200, json={"items": []})
    respx.get(f"{BASE}/id/stations").mock(return_value=empty)
    respx.get(f"{BASE}/id/floods").mock(return_value=empty)
    async with httpx.AsyncClient() as client:
        result = await get_uk_live(client, BASE, 52.4, -4.08)  # Aberystwyth, Wales
    assert result.status == "no_data"
    assert result.reason is not None and "Wales" in result.reason


@respx.mock
async def test_server_error_is_error() -> None:
    respx.get(f"{BASE}/id/stations").mock(return_value=httpx.Response(500))
    respx.get(f"{BASE}/id/floods").mock(return_value=httpx.Response(200, json={"items": []}))
    async with httpx.AsyncClient() as client:
        result = await get_uk_live(client, BASE, *WESTMINSTER)
    assert result.status == "error"
