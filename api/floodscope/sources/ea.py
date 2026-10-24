"""Environment Agency real-time flood-monitoring API (England only, no auth).

Verified live 2026-10-21. Payload quirks handled here:
- `label`, `lat`, `long` are occasionally lists instead of scalars.
- `measures` is a list or a single object.
- `latestReading` is an object, or just a URL string when the gauge has gone quiet.
- Station detail carries `stageScale` with the typical range and max on record.
"""

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from floodscope.geo import haversine_km, in_great_britain
from floodscope.models import (
    EAReading,
    EAStation,
    EAWarning,
    GroundwaterBlock,
    GroundwaterStation,
    SourceInfo,
    UKLive,
)

STATION_RADIUS_KM = 5.0
WARNING_RADIUS_KM = 10.0
MAX_STATIONS = 6
STALE_AFTER = timedelta(hours=24)

SEVERITY_NAMES = {
    1: "Severe flood warning",
    2: "Flood warning",
    3: "Flood alert",
    4: "Warning no longer in force",
}


def source_info(latest: datetime | None = None) -> SourceInfo:
    return SourceInfo(
        name="Environment Agency real-time flood monitoring",
        provider="Environment Agency (England)",
        url="https://environment.data.gov.uk/flood-monitoring/doc/reference",
        resolution="Point gauges, readings about every 15 minutes",
        data_date=f"Latest reading {latest:%d %b %Y %H:%M} UTC" if latest else "Live",
        licence="Open Government Licence v3.0",
        retrieved_at=datetime.now(UTC),
    )


def _first(value: Any) -> Any:
    return value[0] if isinstance(value, list) and value else value


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _last_segment(uri: str) -> str:
    return uri.rstrip("/").rsplit("/", 1)[-1]


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _float(value: Any) -> float | None:
    value = _first(value)
    return float(value) if isinstance(value, int | float) else None


def parse_reading(measure: dict[str, Any], now: datetime) -> EAReading:
    latest = measure.get("latestReading")
    value: float | None = None
    when: datetime | None = None
    if isinstance(latest, dict):
        value = _float(latest.get("value"))
        when = _parse_time(latest.get("dateTime"))
    stale = when is None or now - when > STALE_AFTER
    return EAReading(
        parameter=str(measure.get("parameterName") or measure.get("parameter") or "Unknown"),
        qualifier=measure.get("qualifier"),
        unit=measure.get("unitName"),
        value=value,
        time=when,
        stale=stale,
    )


def parse_station(detail: dict[str, Any], lat: float, lon: float, now: datetime) -> EAStation:
    s_lat = float(_first(detail["lat"]))
    s_lon = float(_first(detail["long"]))
    ref = str(_first(detail["stationReference"]))
    scale = _dict(detail.get("stageScale"))
    max_rec = _dict(scale.get("maxOnRecord"))
    types = [_last_segment(t) for t in _as_list(detail.get("type")) if isinstance(t, str)]
    readings = [
        parse_reading(m, now) for m in _as_list(detail.get("measures")) if isinstance(m, dict)
    ]
    # Fresh readings first, then by parameter name for a stable order.
    readings.sort(key=lambda r: (r.stale, r.parameter))
    return EAStation(
        reference=ref,
        label=str(_first(detail.get("label")) or ref),
        river=_first(detail.get("riverName")),
        town=_first(detail.get("town")),
        lat=s_lat,
        lon=s_lon,
        distance_km=round(haversine_km(lat, lon, s_lat, s_lon), 2),
        station_types=[t for t in types if t != "Station"],
        typical_range_low=_float(scale.get("typicalRangeLow")),
        typical_range_high=_float(scale.get("typicalRangeHigh")),
        max_on_record=_float(max_rec.get("value")),
        max_on_record_time=_parse_time(max_rec.get("dateTime")),
        readings=readings,
        url=f"https://check-for-flooding.service.gov.uk/station/{ref}",
    )


def parse_warning(item: dict[str, Any]) -> EAWarning:
    level = int(item.get("severityLevel") or 4)
    area = _dict(item.get("floodArea"))
    return EAWarning(
        id=str(item.get("floodAreaID") or _last_segment(str(item.get("@id", "")))),
        area=str(item.get("description") or "Unnamed area"),
        severity=str(item.get("severity") or SEVERITY_NAMES.get(level, "Unknown")),
        severity_level=level,
        message=item.get("message"),
        time_raised=_parse_time(item.get("timeRaised")),
        river_or_sea=area.get("riverOrSea"),
    )


async def _get_items(client: httpx.AsyncClient, url: str, params: dict[str, str]) -> Any:
    resp = await client.get(url, params=params)
    resp.raise_for_status()
    return resp.json().get("items", [])


async def get_uk_live(client: httpx.AsyncClient, base_url: str, lat: float, lon: float) -> UKLive:
    if not in_great_britain(lat, lon):
        return UKLive(
            status="no_data",
            reason="Live gauges come from the Environment Agency, which covers England only.",
            search_radius_km=STATION_RADIUS_KM,
            source=source_info(),
        )
    base = base_url.rstrip("/")
    near = {"lat": f"{lat:.5f}", "long": f"{lon:.5f}"}
    try:
        station_items, warning_items = await asyncio.gather(
            _get_items(client, f"{base}/id/stations", {**near, "dist": str(STATION_RADIUS_KM)}),
            _get_items(client, f"{base}/id/floods", {**near, "dist": str(WARNING_RADIUS_KM)}),
        )
        refs_by_distance = sorted(
            (
                haversine_km(lat, lon, float(_first(s["lat"])), float(_first(s["long"]))),
                str(_first(s["stationReference"])),
            )
            for s in station_items
            if s.get("lat") is not None and s.get("long") is not None
        )[:MAX_STATIONS]
        details = await asyncio.gather(
            *(_get_items(client, f"{base}/id/stations/{ref}", {}) for _, ref in refs_by_distance)
        )
        now = datetime.now(UTC)
        stations = [parse_station(_first(d), lat, lon, now) for d in details if d]
        warnings = sorted((parse_warning(w) for w in warning_items), key=lambda w: w.severity_level)
    except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
        return UKLive(
            status="error",
            reason=f"Environment Agency data unavailable: {exc}",
            search_radius_km=STATION_RADIUS_KM,
            source=source_info(),
        )

    latest = max((r.time for s in stations for r in s.readings if r.time), default=None)
    if not stations and not warnings:
        return UKLive(
            status="no_data",
            reason=f"No Environment Agency gauge within {STATION_RADIUS_KM:g} km and no active "
            f"warnings within {WARNING_RADIUS_KM:g} km. The EA covers England only; Wales "
            "and Scotland have their own agencies.",
            search_radius_km=STATION_RADIUS_KM,
            source=source_info(),
        )
    return UKLive(
        status="ok",
        stations=stations,
        warnings=warnings,
        search_radius_km=STATION_RADIUS_KM,
        source=source_info(latest),
    )


# --- Groundwater (Phase 3) -------------------------------------------------------

GROUNDWATER_RADIUS_KM = 25.0
GROUNDWATER_STALE_AFTER = timedelta(days=7)  # boreholes report hourly to daily


def groundwater_source(latest: datetime | None = None) -> SourceInfo:
    src = source_info(latest)
    src.name = "Environment Agency groundwater levels"
    src.resolution = "Point boreholes, readings hourly to daily"
    return src


def parse_groundwater(
    station: dict[str, Any],
    measures: list[dict[str, Any]],
    scale: dict[str, Any],
    lat: float,
    lon: float,
    now: datetime,
) -> GroundwaterStation:
    """Combine a station, its measures and its stage scale. Pure, so it is unit tested."""
    ref = str(_first(station["stationReference"]))
    s_lat = float(_first(station["lat"]))
    s_lon = float(_first(station["long"]))
    level: float | None = None
    when: datetime | None = None
    for m in measures:
        latest = m.get("latestReading")
        if m.get("unitName") == "mAOD" and isinstance(latest, dict):
            t = _parse_time(latest.get("dateTime"))
            if t and (when is None or t > when):
                level, when = _float(latest.get("value")), t
    datum = _float(scale.get("datum"))
    return GroundwaterStation(
        reference=ref,
        label=str(_first(station.get("label")) or ref),
        lat=s_lat,
        lon=s_lon,
        distance_km=round(haversine_km(lat, lon, s_lat, s_lon), 2),
        level_maod=level,
        time=when,
        stale=when is None or now - when > GROUNDWATER_STALE_AFTER,
        datum_maod=datum if datum else None,
        depth_below_datum_m=round(datum - level, 2) if datum and level is not None else None,
        typical_range_low=_float(scale.get("typicalRangeLow")),
        typical_range_high=_float(scale.get("typicalRangeHigh")),
        max_on_record=_float(_dict(scale.get("maxOnRecord")).get("value")),
        min_on_record=_float(_dict(scale.get("minOnRecord")).get("value")),
        url=f"https://check-for-flooding.service.gov.uk/station/{ref}",
    )


async def get_groundwater(
    client: httpx.AsyncClient, base_url: str, lat: float, lon: float
) -> GroundwaterBlock:
    """Nearest EA borehole with a reading in the last week, within 25 km."""
    if not in_great_britain(lat, lon):
        return GroundwaterBlock(
            status="no_data",
            reason="Groundwater levels come from the Environment Agency, which covers England "
            "only.",
            search_radius_km=GROUNDWATER_RADIUS_KM,
            source=groundwater_source(),
        )
    base = base_url.rstrip("/")
    try:
        stations = await _get_items(
            client,
            f"{base}/id/stations",
            {"type": "Groundwater", "lat": f"{lat:.5f}", "long": f"{lon:.5f}",
             "dist": str(GROUNDWATER_RADIUS_KM)},
        )  # fmt: skip
        stations = sorted(
            (s for s in stations if s.get("lat") is not None and s.get("long") is not None),
            key=lambda s: haversine_km(lat, lon, float(_first(s["lat"])), float(_first(s["long"]))),
        )
        now = datetime.now(UTC)
        for s in stations[:8]:
            ref = str(_first(s["stationReference"]))
            measures = await _get_items(client, f"{base}/id/measures", {"stationReference": ref})
            if not isinstance(measures, list) or not measures:
                continue  # retired borehole
            scale: dict[str, Any] = {}
            if "/" not in ref:  # the stageScale path cannot address refs containing "/"
                resp = await client.get(f"{base}/id/stations/{ref}/stageScale")
                if resp.status_code == 200:
                    scale = _dict(resp.json().get("items"))
            station = parse_groundwater(s, measures, scale, lat, lon, now)
            if not station.stale:
                return GroundwaterBlock(
                    status="ok",
                    station=station,
                    search_radius_km=GROUNDWATER_RADIUS_KM,
                    source=groundwater_source(station.time),
                )
    except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
        return GroundwaterBlock(
            status="error",
            reason=f"Groundwater levels unavailable: {type(exc).__name__}: {exc}",
            search_radius_km=GROUNDWATER_RADIUS_KM,
            source=groundwater_source(),
        )
    return GroundwaterBlock(
        status="no_data",
        reason=f"No Environment Agency borehole with a reading in the last week within "
        f"{GROUNDWATER_RADIUS_KM:g} km.",
        search_radius_km=GROUNDWATER_RADIUS_KM,
        source=groundwater_source(),
    )
