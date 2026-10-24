from datetime import date, timedelta
from typing import Any

import httpx
import pytest
import respx

from floodscope.models import SoilLayer
from floodscope.sources import soil

from .conftest import load_fixture

TODAY = date(2026, 10, 24)


def window(payload: dict[str, Any], start: date, end: date) -> dict[str, Any]:
    """Slice a recorded daily series to [start, end], like an archive request would."""
    daily = payload["daily"]
    keep = [i for i, t in enumerate(daily["time"]) if start <= date.fromisoformat(t) <= end]
    return {"daily": {k: [v[i] for i in keep] for k, v in daily.items()}}


@pytest.fixture
def era5() -> dict[str, Any]:
    data: dict[str, Any] = load_fixture("openmeteo_era5_soil_london.json")
    return data


def test_latest_values_uses_last_non_null_day(era5: dict[str, Any]) -> None:
    day, values = soil.latest_values(era5)
    assert day == date(2026, 10, 18)
    assert values[soil.var(0, 7)] is not None
    assert set(values) == {soil.var(t, b) for t, b in soil.LAYERS}


def test_season_windows_cover_each_earlier_year() -> None:
    windows = soil.season_windows(date(2026, 10, 18))
    assert len(windows) == 26
    assert windows[0] == (date(2000, 10, 3), date(2000, 11, 2))
    leap = soil.season_windows(date(2024, 2, 29))
    assert leap[1][0] == date(2001, 2, 28) - timedelta(days=15)


def test_percentile_and_wetness() -> None:
    sample = [float(i) for i in range(200)]
    assert soil.percentile(100.0, sample) == pytest.approx(50.25, abs=0.05)
    assert soil.percentile(1.0, sample[:50]) is None  # too few days to rank
    assert soil.relative_wetness(0.3, 0.2, 0.4) == 50.0
    assert soil.relative_wetness(0.5, 0.2, 0.4) == 100.0
    assert soil.relative_wetness(0.3, 0.3, 0.3) is None


def test_build_soil_from_recorded_data(era5: dict[str, Any]) -> None:
    latest, _ = soil.latest_values(era5)
    assert latest is not None
    seasons = [window(era5, s, e) for s, e in soil.season_windows(latest) if s.year >= 2018]
    block = soil.build_soil(load_fixture("openmeteo_ifs_soil_london.json"), era5, seasons, TODAY)
    assert block.status == "ok"
    assert block.value_date == latest
    assert block.climatology_years == "2018-2025"
    assert [(layer.top_cm, layer.bottom_cm) for layer in block.layers] == list(soil.LAYERS)
    top = block.layers[0]
    assert top.value is not None and top.season_percentile is not None
    assert 0 <= top.season_percentile <= 100
    assert top.season_min is not None and top.season_max is not None
    assert top.season_min <= top.season_max
    assert block.summary and "time of year" in block.summary
    assert block.climatology_source.data_date.startswith("Latest day 2026-10-18")


def test_build_soil_without_forecast_still_ranks(era5: dict[str, Any]) -> None:
    latest, _ = soil.latest_values(era5)
    assert latest is not None
    seasons = [window(era5, s, e) for s, e in soil.season_windows(latest) if s.year >= 2018]
    block = soil.build_soil(None, era5, seasons, TODAY)
    assert block.status == "ok"
    assert all(layer.forecast == [] and layer.forecast_change_7d is None for layer in block.layers)


def test_build_soil_sea_and_empty() -> None:
    zeros = {"daily": {"time": ["2026-10-18"], **{soil.var(t, b): [0.0] for t, b in soil.LAYERS}}}
    seasons = [
        {"daily": {"time": [f"20{y:02d}-10-18"], **{soil.var(t, b): [0.0] for t, b in soil.LAYERS}}}
        for y in range(10)
    ]
    assert soil.build_soil(None, zeros, seasons, TODAY).status == "no_data"
    empty = {"daily": {"time": ["2026-10-18"], **{soil.var(t, b): [None] for t, b in soil.LAYERS}}}
    assert soil.build_soil(None, empty, [], TODAY).status == "no_data"


def _layers(p: float, wet: float | None = 50.0) -> list[SoilLayer]:
    return [
        SoilLayer(top_cm=0, bottom_cm=7, value=0.3, season_percentile=p, relative_wetness_pct=wet),
        SoilLayer(top_cm=7, bottom_cm=28, value=0.3, season_percentile=p),
    ]


@pytest.mark.parametrize(
    ("p", "phrase"),
    [
        (95, "run off faster than normal"),
        (75, "wetter than usual"),
        (50, "about normal"),
        (20, "drier than usual"),
        (5, "very dry"),
        (0, "drier than any day"),
        (100, "wetter than any day"),
    ],
)
def test_summary_wording(p: float, phrase: str) -> None:
    text = soil.summarise(_layers(p))
    assert text is not None and phrase in text
    assert "50% of the way from its driest to its wettest" in text


def test_summary_needs_percentiles() -> None:
    assert soil.summarise([SoilLayer(top_cm=0, bottom_cm=7, value=0.3)]) is None


@respx.mock
async def test_fetch_retries_on_rate_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    async def no_sleep(_: float) -> None:
        return None

    monkeypatch.setattr("floodscope.sources.soil.asyncio.sleep", no_sleep)
    url = "https://archive.example/v1/archive"
    route = respx.get(url).mock(
        side_effect=[
            httpx.Response(429, json={"error": True, "reason": "Too many concurrent requests"}),
            httpx.Response(200, json={"daily": {"time": []}}),
        ]
    )
    async with httpx.AsyncClient() as client:
        body = await soil.fetch_archive(client, url, 51.5, -0.1, TODAY, TODAY)
    assert body == {"daily": {"time": []}}
    assert route.call_count == 2


@respx.mock
async def test_fetch_gives_up_after_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    async def no_sleep(_: float) -> None:
        return None

    monkeypatch.setattr("floodscope.sources.soil.asyncio.sleep", no_sleep)
    url = "https://archive.example/v1/archive"
    respx.get(url).mock(return_value=httpx.Response(429, json={"reason": "Minutely limit"}))
    async with httpx.AsyncClient() as client:
        with pytest.raises(httpx.HTTPStatusError, match="Minutely limit"):
            await soil.fetch_archive(client, url, 51.5, -0.1, TODAY, TODAY)
