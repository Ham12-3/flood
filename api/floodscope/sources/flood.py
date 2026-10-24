"""GloFAS v4 river discharge via the Open-Meteo Flood API (/v1/flood).

Verified live 2026-10-21:
- Forecasts run 210 days ahead; ensemble stats come as river_discharge_{mean,...}.
- The API snaps to a ~0.05 degree GloFAS cell. Away from rivers it returns 0.0
  (not null), so "no river" means all values null or zero.
- Several coordinates can go in one request (comma-separated), which keeps the
  nearby-cell search to at most three calls.
"""

from datetime import UTC, date, datetime
from typing import Any

import httpx

from floodscope.geo import haversine_km, ring_offsets
from floodscope.models import DischargeDay, RiverDischarge, SourceInfo

DAILY_VARS = (
    "river_discharge",
    "river_discharge_mean",
    "river_discharge_median",
    "river_discharge_min",
    "river_discharge_max",
    "river_discharge_p25",
    "river_discharge_p75",
)
FORECAST_DAYS = 31  # today plus 30 days ahead
SEARCH_STEPS_DEG = (0.05, 0.1)

NO_RIVER_REASON = (
    "No modelled river here. GloFAS has no river flow within about 10 km of this point."
)


def source_info(first_day: date | None = None) -> SourceInfo:
    return SourceInfo(
        name="GloFAS v4 river discharge",
        provider="Copernicus Emergency Management Service, served by Open-Meteo Flood API",
        url="https://open-meteo.com/en/docs/flood-api",
        resolution="0.05 degree grid (about 5 km)",
        data_date=f"Forecast issued for {first_day.isoformat()}" if first_day else "n/a",
        licence="CC BY 4.0 (GloFAS). Open-Meteo free API: non-commercial use.",
        retrieved_at=datetime.now(UTC),
    )


def parse_cell(payload: dict[str, Any]) -> list[DischargeDay]:
    """Turn one Open-Meteo location object into typed daily rows."""
    daily = payload.get("daily") or {}
    times: list[str] = daily.get("time") or []

    def col(name: str) -> list[float | None]:
        values = daily.get(name)
        return list(values) if isinstance(values, list) else [None] * len(times)

    cols = {name: col(name) for name in DAILY_VARS}
    return [
        DischargeDay(
            date=date.fromisoformat(t),
            discharge=cols["river_discharge"][i],
            ensemble_mean=cols["river_discharge_mean"][i],
            ensemble_median=cols["river_discharge_median"][i],
            ensemble_min=cols["river_discharge_min"][i],
            ensemble_max=cols["river_discharge_max"][i],
            ensemble_p25=cols["river_discharge_p25"][i],
            ensemble_p75=cols["river_discharge_p75"][i],
        )
        for i, t in enumerate(times)
    ]


def has_river(days: list[DischargeDay]) -> bool:
    """A cell counts as a river only if some day has a positive discharge."""
    return any(d.discharge is not None and d.discharge > 0 for d in days)


def typical_flow(days: list[DischargeDay]) -> float:
    values = sorted(d.discharge for d in days if d.discharge is not None)
    return values[len(values) // 2] if values else 0.0


def pick_today(days: list[DischargeDay], today: date) -> DischargeDay | None:
    for d in days:
        if d.date == today:
            return d
    return None


async def _fetch_cells(
    client: httpx.AsyncClient, url: str, coords: list[tuple[float, float]]
) -> list[dict[str, Any]]:
    params = {
        "latitude": ",".join(f"{la:.5f}" for la, _ in coords),
        "longitude": ",".join(f"{lo:.5f}" for _, lo in coords),
        "daily": ",".join(DAILY_VARS),
        "forecast_days": str(FORECAST_DAYS),
        "timezone": "GMT",
    }
    resp = await client.get(url, params=params)
    if resp.status_code >= 400:
        try:
            reason = resp.json().get("reason", resp.text)
        except ValueError:
            reason = resp.text
        raise httpx.HTTPStatusError(
            f"Open-Meteo Flood API returned {resp.status_code}: {reason}",
            request=resp.request,
            response=resp,
        )
    body = resp.json()
    return body if isinstance(body, list) else [body]


async def get_river_discharge(
    client: httpx.AsyncClient, url: str, lat: float, lon: float, today: date | None = None
) -> RiverDischarge:
    """Discharge at the clicked cell, or the biggest river in a nearby ring of cells."""
    today = today or datetime.now(UTC).date()
    try:
        rings: list[list[tuple[float, float]]] = [[(lat, lon)]]
        rings += [ring_offsets(lat, lon, step) for step in SEARCH_STEPS_DEG]
        for i, ring in enumerate(rings):
            cells = await _fetch_cells(client, url, ring)
            candidates = [(c, parse_cell(c)) for c in cells]
            rivers = [(c, days) for c, days in candidates if has_river(days)]
            if not rivers:
                continue
            # Prefer the largest river, then the nearest cell.
            cell, days = max(
                rivers,
                key=lambda r: (
                    typical_flow(r[1]),
                    -haversine_km(lat, lon, r[0]["latitude"], r[0]["longitude"]),
                ),
            )
            g_lat, g_lon = float(cell["latitude"]), float(cell["longitude"])
            return RiverDischarge(
                status="ok",
                grid_lat=g_lat,
                grid_lon=g_lon,
                offset_km=round(haversine_km(lat, lon, g_lat, g_lon), 2),
                searched_offsets=i > 0,
                today=pick_today(days, today),
                forecast=days,
                source=source_info(days[0].date if days else None),
            )
        return RiverDischarge(
            status="no_data", reason=NO_RIVER_REASON, searched_offsets=True, source=source_info()
        )
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        return RiverDischarge(
            status="error", reason=f"River discharge unavailable: {exc}", source=source_info()
        )


HISTORY_START = date(1984, 1, 1)  # documented start; data actually begins ~1997


async def get_history(
    client: httpx.AsyncClient, url: str, lat: float, lon: float, end: date
) -> list[tuple[date, float | None]]:
    """Daily GloFAS reanalysis discharge for one cell, from the documented start to `end`."""
    params = {
        "latitude": f"{lat:.5f}",
        "longitude": f"{lon:.5f}",
        "daily": "river_discharge",
        "start_date": HISTORY_START.isoformat(),
        "end_date": end.isoformat(),
        "timezone": "GMT",
    }
    resp = await client.get(url, params=params, timeout=60)
    resp.raise_for_status()
    daily = resp.json().get("daily") or {}
    times: list[str] = daily.get("time") or []
    values: list[float | None] = daily.get("river_discharge") or [None] * len(times)
    return [(date.fromisoformat(t), v) for t, v in zip(times, values, strict=False)]
