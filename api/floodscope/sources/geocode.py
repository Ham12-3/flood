"""Place search via the Open-Meteo Geocoding API (GeoNames data, no key)."""

from datetime import UTC, datetime

import httpx

from floodscope.models import GeocodeResponse, Place, SourceInfo


def source_info() -> SourceInfo:
    return SourceInfo(
        name="Open-Meteo Geocoding",
        provider="Open-Meteo, using GeoNames",
        url="https://open-meteo.com/en/docs/geocoding-api",
        resolution="Place names (towns, cities, regions)",
        data_date="Live",
        licence="CC BY 4.0 (GeoNames)",
        retrieved_at=datetime.now(UTC),
    )


async def search_places(
    client: httpx.AsyncClient, url: str, query: str, count: int = 8
) -> GeocodeResponse:
    resp = await client.get(
        url, params={"name": query, "count": str(count), "language": "en", "format": "json"}
    )
    resp.raise_for_status()
    results = [
        Place(
            name=r["name"],
            lat=float(r["latitude"]),
            lon=float(r["longitude"]),
            country=r.get("country"),
            admin1=r.get("admin1"),
        )
        for r in resp.json().get("results", []) or []
    ]
    return GeocodeResponse(query=query, results=results, source=source_info())
