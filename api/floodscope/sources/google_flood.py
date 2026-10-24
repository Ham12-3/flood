"""Google Flood Forecasting API (v1), behind a feature flag.

Off unless FLOODSCOPE_GOOGLE_FLOOD_API_KEY is set (access is by waitlist). Built from the
REST reference at developers.google.com/flood-forecasting/rest, read 2026-10-24; NOT
verified live, because no key was available. In particular the docs do not say how the
key is sent; this uses Google's standard X-Goog-Api-Key header.

Flow: gauges:searchGaugesByArea with a small loop around the point, then
floodStatus:queryLatestFloodStatusByGaugeIds and gauges:queryGaugeForecasts for the
nearest gauges.
"""

import asyncio
from datetime import UTC, datetime
from typing import Any

import httpx

from floodscope.geo import haversine_km
from floodscope.models import GoogleFloodResponse, GoogleForecastValue, GoogleGauge, SourceInfo

BASE = "https://floodforecasting.googleapis.com/v1"
SEARCH_HALF_DEG = 0.25  # about 25 km each way
MAX_GAUGES = 5


def source_info() -> SourceInfo:
    return SourceInfo(
        name="Google Flood Forecasting",
        provider="Google Flood Hub",
        url="https://developers.google.com/flood-forecasting",
        resolution="Point gauges (observed and virtual)",
        data_date="Latest status and forecast",
        licence="CC BY 4.0",
        retrieved_at=datetime.now(UTC),
    )


def loop_around(lat: float, lon: float, half: float = SEARCH_HALF_DEG) -> dict[str, Any]:
    """Counter-clockwise box (the interior of an S2 loop is on its left)."""
    s, n = max(lat - half, -90.0), min(lat + half, 90.0)
    w, e = lon - half, lon + half
    return {
        "vertices": [
            {"latitude": s, "longitude": w},
            {"latitude": s, "longitude": e},
            {"latitude": n, "longitude": e},
            {"latitude": n, "longitude": w},
        ]
    }


def _time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def parse_gauges(
    gauges: list[dict[str, Any]],
    statuses: list[dict[str, Any]],
    forecasts: dict[str, Any],
    lat: float,
    lon: float,
) -> list[GoogleGauge]:
    """Merge the three responses. Pure, so it is unit tested."""
    by_status = {s.get("gaugeId"): s for s in statuses}
    out: list[GoogleGauge] = []
    for g in gauges:
        gid = str(g.get("gaugeId"))
        loc = g.get("location") or {}
        g_lat, g_lon = float(loc.get("latitude", 0.0)), float(loc.get("longitude", 0.0))
        st = by_status.get(gid) or {}
        sets = (forecasts.get(gid) or {}).get("forecasts") or []
        latest = max(sets, key=lambda f: f.get("issuedTime", ""), default=None)
        out.append(
            GoogleGauge(
                gauge_id=gid,
                site_name=g.get("siteName"),
                river=g.get("river"),
                source=g.get("source"),
                lat=g_lat,
                lon=g_lon,
                distance_km=round(haversine_km(lat, lon, g_lat, g_lon), 2),
                quality_verified=g.get("qualityVerified"),
                has_model=g.get("hasModel"),
                severity=st.get("severity"),
                trend=st.get("forecastTrend"),
                issued_time=_time(st.get("issuedTime")),
                forecast_issued_time=_time(latest.get("issuedTime")) if latest else None,
                forecast=[
                    GoogleForecastValue(
                        start=_time(r.get("forecastStartTime")),
                        end=_time(r.get("forecastEndTime")),
                        value=r.get("value"),
                    )
                    for r in (latest.get("forecastRanges") or [] if latest else [])
                ],
            )
        )
    return sorted(out, key=lambda x: x.distance_km)


async def get_google_flood(
    client: httpx.AsyncClient, api_key: str | None, lat: float, lon: float
) -> GoogleFloodResponse:
    radius = round(SEARCH_HALF_DEG * 111, 0)
    if not api_key:
        return GoogleFloodResponse(
            lat=lat,
            lon=lon,
            status="no_data",
            reason="Google Flood Forecasting is switched off. It needs an API key from "
            "Google's waitlist; set FLOODSCOPE_GOOGLE_FLOOD_API_KEY to turn it on.",
            search_radius_km=radius,
            source=source_info(),
        )
    headers = {"X-Goog-Api-Key": api_key}
    try:
        resp = await client.post(
            f"{BASE}/gauges:searchGaugesByArea",
            json={"loop": loop_around(lat, lon), "pageSize": 200},
            headers=headers,
        )
        resp.raise_for_status()
        gauges = resp.json().get("gauges") or []
        gauges = sorted(
            gauges,
            key=lambda g: haversine_km(
                lat,
                lon,
                (g.get("location") or {}).get("latitude", 0.0),
                (g.get("location") or {}).get("longitude", 0.0),
            ),
        )[:MAX_GAUGES]
        if not gauges:
            return GoogleFloodResponse(
                lat=lat,
                lon=lon,
                status="no_data",
                reason=f"No quality-verified Google gauge within about {radius:g} km.",
                search_radius_km=radius,
                source=source_info(),
            )
        # Repeated query parameter: gaugeIds=a&gaugeIds=b
        ids = {"gaugeIds": [str(g["gaugeId"]) for g in gauges]}
        status_resp, forecast_resp = await asyncio.gather(
            client.get(
                f"{BASE}/floodStatus:queryLatestFloodStatusByGaugeIds", params=ids, headers=headers
            ),
            client.get(f"{BASE}/gauges:queryGaugeForecasts", params=ids, headers=headers),
        )
        status_resp.raise_for_status()
        forecast_resp.raise_for_status()
        merged = parse_gauges(
            gauges,
            status_resp.json().get("floodStatuses") or [],
            forecast_resp.json().get("forecasts") or {},
            lat,
            lon,
        )
    except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
        return GoogleFloodResponse(
            lat=lat,
            lon=lon,
            status="error",
            reason=f"Google Flood Forecasting unavailable: {type(exc).__name__}: {exc}",
            search_radius_km=radius,
            source=source_info(),
        )
    return GoogleFloodResponse(
        lat=lat, lon=lon, status="ok", gauges=merged, search_radius_km=radius, source=source_info()
    )
