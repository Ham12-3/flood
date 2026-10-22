import copy
from datetime import date
from typing import Any

import httpx
import pytest
import respx

from floodscope.sources.flood import (
    get_river_discharge,
    has_river,
    parse_cell,
    pick_today,
    typical_flow,
)

from .conftest import load_fixture

URL = "https://flood-api.example/v1/flood"
TODAY = date(2026, 10, 21)  # issue date of the recorded fixtures


def cell(lat: float, lon: float, values: list[float | None]) -> dict[str, Any]:
    return {
        "latitude": lat,
        "longitude": lon,
        "daily": {
            "time": [f"2026-10-{21 + i}" for i in range(len(values))],
            "river_discharge": values,
        },
    }


def test_parse_cell_reads_recorded_london_response() -> None:
    days = parse_cell(load_fixture("openmeteo_flood_london.json"))
    assert len(days) == 31
    assert days[0].date == TODAY
    first = days[0]
    assert first.discharge is not None and first.discharge > 0
    assert first.ensemble_min is not None and first.ensemble_max is not None
    assert first.ensemble_min <= first.ensemble_max


def test_parse_cell_missing_columns_become_none() -> None:
    days = parse_cell(cell(1, 1, [5.0, 6.0]))
    assert [d.discharge for d in days] == [5.0, 6.0]
    assert all(d.ensemble_p25 is None for d in days)


def test_has_river_treats_zero_and_null_as_no_river() -> None:
    assert not has_river(parse_cell(cell(1, 1, [0.0, 0.0])))
    assert not has_river(parse_cell(cell(1, 1, [None, None])))
    assert not has_river(parse_cell(load_fixture("openmeteo_flood_sahara_multi.json")[0]))
    assert has_river(parse_cell(cell(1, 1, [0.0, 0.3])))


def test_typical_flow_is_median() -> None:
    assert typical_flow(parse_cell(cell(1, 1, [1.0, 9.0, 3.0]))) == 3.0
    assert typical_flow(parse_cell(cell(1, 1, [None]))) == 0.0


def test_pick_today() -> None:
    days = parse_cell(cell(1, 1, [1.0, 2.0]))
    assert pick_today(days, date(2026, 10, 22)) is days[1]
    assert pick_today(days, date(2027, 1, 1)) is None


@respx.mock
async def test_river_at_clicked_cell_uses_one_call() -> None:
    route = respx.get(URL).mock(
        return_value=httpx.Response(200, json=load_fixture("openmeteo_flood_london.json"))
    )
    async with httpx.AsyncClient() as client:
        result = await get_river_discharge(client, URL, 51.5005, -0.1218, today=TODAY)
    assert route.call_count == 1
    assert result.status == "ok"
    assert not result.searched_offsets
    assert result.today is not None and result.today.date == TODAY
    assert result.offset_km is not None and result.offset_km < 5
    assert result.source.data_date.endswith("2026-10-21")


@respx.mock
async def test_dry_cell_searches_ring_and_picks_largest_river() -> None:
    dry = cell(10.0, 10.0, [0.0, 0.0])
    ring = [cell(10.0 + i * 0.01, 10.0, [0.0, 0.0]) for i in range(8)]
    ring[2] = cell(10.05, 10.0, [4.0, 5.0])
    ring[5] = cell(9.95, 10.05, [40.0, 50.0])
    route = respx.get(URL).mock(
        side_effect=[httpx.Response(200, json=dry), httpx.Response(200, json=ring)]
    )
    async with httpx.AsyncClient() as client:
        result = await get_river_discharge(client, URL, 10.0, 10.0, today=TODAY)
    assert route.call_count == 2
    assert result.status == "ok"
    assert result.searched_offsets
    assert (result.grid_lat, result.grid_lon) == (9.95, 10.05)
    # Second request asked for eight coordinates in one go.
    second = route.calls[1].request.url.params
    assert len(second["latitude"].split(",")) == 8


@respx.mock
async def test_no_river_anywhere_is_no_data_after_three_calls() -> None:
    dry_one = cell(23.0, 12.0, [0.0])
    dry_ring = [copy.deepcopy(dry_one) for _ in range(8)]
    route = respx.get(URL).mock(
        side_effect=[
            httpx.Response(200, json=dry_one),
            httpx.Response(200, json=dry_ring),
            httpx.Response(200, json=dry_ring),
        ]
    )
    async with httpx.AsyncClient() as client:
        result = await get_river_discharge(client, URL, 23.0, 12.0, today=TODAY)
    assert route.call_count == 3
    assert result.status == "no_data"
    assert result.reason is not None and "No modelled river" in result.reason
    assert result.forecast == []


@respx.mock
async def test_api_error_is_reported_not_raised() -> None:
    respx.get(URL).mock(
        return_value=httpx.Response(400, json={"error": True, "reason": "Latitude out of range"})
    )
    async with httpx.AsyncClient() as client:
        result = await get_river_discharge(client, URL, 10.0, 10.0, today=TODAY)
    assert result.status == "error"
    assert result.reason is not None and "Latitude out of range" in result.reason


@pytest.mark.parametrize("exc", [httpx.ConnectTimeout("slow"), httpx.ConnectError("down")])
@respx.mock
async def test_network_failure_is_error(exc: Exception) -> None:
    respx.get(URL).mock(side_effect=exc)
    async with httpx.AsyncClient() as client:
        result = await get_river_discharge(client, URL, 10.0, 10.0, today=TODAY)
    assert result.status == "error"
