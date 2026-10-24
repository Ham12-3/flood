"""Soil moisture by layer, ranked against the same time of year since 2000.

Verified live 2026-10-24:
- The ERA5 archive (models=era5) has daily means for 0-7, 7-28, 28-100 and 100-255 cm,
  0.25 deg grid, latest day about 6 days ago.
- Open-Meteo weights requests by volume, so 26 years x 4 layers in one call costs
  hundreds of "calls" and trips the per-minute limit. We fetch a +-15 day window per
  year instead (about 1/10 of the weight).
- ECMWF IFS (models=ecmwf_ifs025) forecasts the same layers, but its values can sit
  outside ERA5's whole record (Lagos: every layer above the ERA5 maximum). So the
  percentile uses ERA5 against ERA5, and IFS is shown only as a 7-day change.
"""

import asyncio
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx

from floodscope.models import SoilBlock, SoilLayer, SoilPoint, SourceInfo

LAYERS: tuple[tuple[int, int], ...] = ((0, 7), (7, 28), (28, 100), (100, 255))
CLIMATE_START_YEAR = 2000
SEASON_HALF_WINDOW = 15
MIN_SEASON_DAYS = 100
RECENT_DAYS = 30
MAX_CONCURRENT = 2  # Open-Meteo answers 429 to many parallel requests
RETRIES = 3

Series = list[tuple[date, float | None]]
Payload = dict[str, Any]


def var(top: int, bottom: int) -> str:
    return f"soil_moisture_{top}_to_{bottom}cm_mean"


def forecast_source() -> SourceInfo:
    return SourceInfo(
        name="ECMWF IFS soil moisture forecast",
        provider="ECMWF, served by Open-Meteo",
        url="https://open-meteo.com/en/docs/ecmwf-api",
        resolution="0.25 degree (about 25 km), 4 soil layers",
        data_date="Today and the next 7 days (shown as a change only)",
        licence="CC BY 4.0 (ECMWF open data). Open-Meteo free API: non-commercial use.",
        retrieved_at=datetime.now(UTC),
    )


def climatology_source(latest: date | None = None, years: str | None = None) -> SourceInfo:
    when = f"Latest day {latest.isoformat()}" if latest else "Latest available day"
    return SourceInfo(
        name="ERA5 soil moisture reanalysis",
        provider="Copernicus Climate Change Service (ECMWF), served by Open-Meteo",
        url="https://open-meteo.com/en/docs/historical-weather-api",
        resolution="0.25 degree (about 28 km), daily means",
        data_date=f"{when}; compared with {years or 'earlier years'}",
        licence="Copernicus licence (free, with attribution). Open-Meteo free API: "
        "non-commercial use.",
        retrieved_at=datetime.now(UTC),
    )


def parse_daily(payload: Payload) -> dict[str, Series]:
    daily = payload.get("daily") or {}
    times = [date.fromisoformat(t) for t in daily.get("time") or []]
    out: dict[str, Series] = {}
    for top, bottom in LAYERS:
        values = daily.get(var(top, bottom)) or [None] * len(times)
        out[var(top, bottom)] = list(zip(times, values, strict=False))
    return out


def season_windows(latest: date) -> list[tuple[date, date]]:
    """+-15 day windows around `latest`'s calendar date in every earlier year since 2000."""
    out: list[tuple[date, date]] = []
    for year in range(CLIMATE_START_YEAR, latest.year):
        try:
            centre = latest.replace(year=year)
        except ValueError:  # 29 February
            centre = date(year, 2, 28)
        out.append(
            (
                centre - timedelta(days=SEASON_HALF_WINDOW),
                centre + timedelta(days=SEASON_HALF_WINDOW),
            )
        )
    return out


def latest_values(recent: Payload) -> tuple[date | None, dict[str, float | None]]:
    """Most recent day on which the top layer has a value, and every layer's value then."""
    series = parse_daily(recent)
    top = [(d, v) for d, v in series[var(*LAYERS[0])] if v is not None]
    if not top:
        return None, {var(t, b): None for t, b in LAYERS}
    day = top[-1][0]
    return day, {k: next((v for d, v in s if d == day), None) for k, s in series.items()}


def percentile(value: float, sample: Sequence[float]) -> float | None:
    if len(sample) < MIN_SEASON_DAYS:
        return None
    below = sum(1 for v in sample if v < value)
    equal = sum(1 for v in sample if v == value)
    return round(100 * (below + 0.5 * equal) / len(sample), 1)


def relative_wetness(value: float, lo: float, hi: float) -> float | None:
    if hi <= lo:
        return None
    return round(min(max((value - lo) / (hi - lo), 0.0), 1.0) * 100, 1)


def summarise(layers: Sequence[SoilLayer]) -> str | None:
    """Plain-English summary from the top two layers, which control how rain soaks in."""
    top = [layer for layer in layers[:2] if layer.season_percentile is not None]
    if not top:
        return None
    p = sum(layer.season_percentile or 0 for layer in top) / len(top)
    if p < 0.5:
        pct = "drier than any day at this time of year since 2000"
    elif p > 99.5:
        pct = "wetter than any day at this time of year since 2000"
    else:
        pct = f"wetter than {p:.0f}% of days at this time of year since 2000"
    if p >= 90:
        text = (
            f"The ground is very wet for the time of year ({pct}), so heavy rain will run "
            "off faster than normal."
        )
    elif p >= 70:
        text = f"The ground is wetter than usual ({pct}), so more of any heavy rain will run off."
    elif p > 30:
        text = f"Ground wetness is about normal for the time of year ({pct})."
    elif p > 10:
        text = f"The ground is drier than usual ({pct}), so it can soak up more rain than normal."
    else:
        text = (
            f"The ground is very dry for the time of year ({pct}). It can absorb more rain, "
            "though hard, dry soil can still shed intense downpours."
        )
    w = layers[0].relative_wetness_pct
    if w is not None:
        text += (
            f" Topsoil is {w:.0f}% of the way from its driest to its wettest at this time of year."
        )
    return text


def build_soil(
    forecast: Payload | None, recent: Payload, seasons: Sequence[Payload], today: date
) -> SoilBlock:
    """Combine the latest ERA5 day, earlier years' windows and the IFS trend. Pure."""
    latest_day, latest = latest_values(recent)
    if latest_day is None:
        return SoilBlock(
            status="no_data",
            reason="No soil moisture here (open sea or outside the model's land mask).",
            forecast_source=forecast_source(),
            climatology_source=climatology_source(),
        )
    season_series = [parse_daily(p) for p in seasons]
    fc = parse_daily(forecast) if forecast else None
    years = sorted({d.year for s in season_series for d, v in s[var(*LAYERS[0])] if v is not None})
    span = f"{years[0]}-{years[-1]}" if years else None

    layers: list[SoilLayer] = []
    for top, bottom in LAYERS:
        key = var(top, bottom)
        value = latest[key]
        sample = [v for s in season_series for _, v in s[key] if v is not None]
        lo = min(sample) if sample else None
        hi = max(sample) if sample else None
        points = [SoilPoint(date=d, value=v) for d, v in (fc[key] if fc else []) if d >= today]
        change = None
        if len(points) >= 8 and points[0].value is not None and points[7].value is not None:
            change = round(points[7].value - points[0].value, 3)
        layers.append(
            SoilLayer(
                top_cm=top,
                bottom_cm=bottom,
                value=value,
                season_percentile=percentile(value, sample) if value is not None else None,
                relative_wetness_pct=relative_wetness(value, lo, hi)
                if value is not None and lo is not None and hi is not None
                else None,
                season_min=lo,
                season_max=hi,
                forecast=points,
                forecast_change_7d=change,
            )
        )
    if all(not layer.season_max for layer in layers):
        return SoilBlock(
            status="no_data",
            reason="Soil moisture is zero in every year here, so this is open sea or ice.",
            forecast_source=forecast_source(),
            climatology_source=climatology_source(latest_day, span),
        )
    return SoilBlock(
        status="ok",
        value_date=latest_day,
        layers=layers,
        summary=summarise(layers),
        climatology_years=span,
        forecast_source=forecast_source(),
        climatology_source=climatology_source(latest_day, span),
    )


async def _get(client: httpx.AsyncClient, url: str, params: dict[str, str]) -> Payload:
    for attempt in range(RETRIES):
        resp = await client.get(url, params=params, timeout=60)
        if resp.status_code == 429 and attempt < RETRIES - 1:
            await asyncio.sleep(1.5 * (attempt + 1))  # rate limited: back off and retry
            continue
        if resp.status_code >= 400:
            try:
                reason = resp.json().get("reason", resp.text)
            except ValueError:
                reason = resp.text
            raise httpx.HTTPStatusError(
                f"Open-Meteo returned {resp.status_code}: {reason}",
                request=resp.request,
                response=resp,
            )
        body: Payload = resp.json()
        return body
    raise AssertionError("unreachable")


def _params(lat: float, lon: float) -> dict[str, str]:
    return {
        "latitude": f"{lat:.4f}",
        "longitude": f"{lon:.4f}",
        "daily": ",".join(var(t, b) for t, b in LAYERS),
        "timezone": "GMT",
    }


async def fetch_forecast(client: httpx.AsyncClient, url: str, lat: float, lon: float) -> Payload:
    params = _params(lat, lon) | {"forecast_days": "8", "models": "ecmwf_ifs025"}
    return await _get(client, url, params)


async def fetch_archive(
    client: httpx.AsyncClient, url: str, lat: float, lon: float, start: date, end: date
) -> Payload:
    params = _params(lat, lon) | {
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "models": "era5",
    }
    return await _get(client, url, params)


async def fetch_seasons(
    client: httpx.AsyncClient, url: str, lat: float, lon: float, latest: date
) -> list[Payload]:
    sem = asyncio.Semaphore(MAX_CONCURRENT)

    async def one(start: date, end: date) -> Payload:
        async with sem:
            return await fetch_archive(client, url, lat, lon, start, end)

    return list(await asyncio.gather(*(one(s, e) for s, e in season_windows(latest))))
