"""FastAPI app. Run with: uv run uvicorn floodscope.main:app --reload"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from floodscope.cache import ResponseCache
from floodscope.config import get_settings
from floodscope.grid import MAX_SIZE_KM, MIN_SIZE_KM
from floodscope.models import GeocodeResponse, PointResponse, SceneResponse
from floodscope.point import build_point
from floodscope.scene import build_scene
from floodscope.sources.geocode import search_places


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    app.state.cache = ResponseCache(settings.cache_dir)
    app.state.http = httpx.AsyncClient(
        timeout=settings.http_timeout_s,
        headers={"User-Agent": settings.user_agent},
        limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        follow_redirects=True,
    )
    try:
        yield
    finally:
        await app.state.http.aclose()
        app.state.cache.close()


app = FastAPI(title="FloodScope 3D API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origin_list,
    allow_origin_regex=get_settings().cors_origin_regex or None,
    allow_methods=["GET"],
    allow_headers=["*"],
)
# Scene grids are a few MB of base64; they compress well.
app.add_middleware(GZipMiddleware, minimum_size=1024)

Lat = Annotated[float, Query(ge=-90, le=90, description="Latitude, WGS84 degrees")]
Lon = Annotated[float, Query(ge=-180, le=180, description="Longitude, WGS84 degrees")]


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/point", response_model=PointResponse)
async def point(request: Request, lat: Lat, lon: Lon) -> PointResponse:
    """Everything we know about one point: elevation, river flow, hazard depths, UK gauges."""
    return await build_point(
        lat, lon, request.app.state.http, request.app.state.cache, get_settings()
    )


@app.get("/api/scene", response_model=SceneResponse)
async def scene(
    request: Request,
    lat: Lat,
    lon: Lon,
    size_km: Annotated[float, Query(ge=MIN_SIZE_KM, le=MAX_SIZE_KM)] = 4.0,
) -> SceneResponse:
    """Terrain window, hazard depth grids and forecast flood scenarios for the 3D view."""
    return await build_scene(
        lat, lon, size_km, request.app.state.http, request.app.state.cache, get_settings()
    )


@app.get("/api/geocode", response_model=GeocodeResponse)
async def geocode(
    request: Request, q: Annotated[str, Query(min_length=2, max_length=100)]
) -> GeocodeResponse:
    cache: ResponseCache = request.app.state.cache
    settings = get_settings()
    try:
        return await cache.get_or_fetch(
            f"geocode:{q.strip().lower()}",
            GeocodeResponse,
            lambda: search_places(request.app.state.http, settings.open_meteo_geocoding_url, q),
            settings.ttl_static,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Place search unavailable: {exc}") from exc
