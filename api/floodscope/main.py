"""FastAPI app. Run with: uv run uvicorn floodscope.main:app --reload"""

import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime
from typing import Annotated

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse

from floodscope.cache import ResponseCache
from floodscope.config import get_settings
from floodscope.explain import explain
from floodscope.grid import MAX_SIZE_KM, MIN_SIZE_KM
from floodscope.ground import build_ground
from floodscope.models import (
    ExplainRequest,
    ExplainResponse,
    GeocodeResponse,
    GoogleFloodResponse,
    GroundResponse,
    PointResponse,
    PredictResponse,
    ReplayResponse,
    SatelliteResponse,
    SceneResponse,
)
from floodscope.point import build_point
from floodscope.predict import build_prediction
from floodscope.replay.build import MAX_SIZE_KM as REPLAY_MAX_KM
from floodscope.replay.build import MIN_SIZE_KM as REPLAY_MIN_KM
from floodscope.replay.build import ReplayParams
from floodscope.replay.jobs import ReplayJobs
from floodscope.satellite import list_results, overlay_path
from floodscope.scene import build_scene
from floodscope.sources.geocode import search_places
from floodscope.sources.google_flood import get_google_flood


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    app.state.cache = ResponseCache(settings.cache_dir)
    app.state.replays = ReplayJobs(settings.cache_dir / "replay")
    app.state.http = httpx.AsyncClient(
        timeout=settings.http_timeout_s,
        headers={"User-Agent": settings.user_agent},
        limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        follow_redirects=True,
    )
    try:
        yield
    finally:
        await app.state.replays.close()
        await app.state.http.aclose()
        app.state.cache.close()


app = FastAPI(title="FloodScope 3D API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origin_list,
    allow_origin_regex=get_settings().cors_origin_regex or None,
    allow_methods=["GET", "POST"],
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


@app.get("/api/ground", response_model=GroundResponse)
async def ground(request: Request, lat: Lat, lon: Lon) -> GroundResponse:
    """Soil moisture in four layers against its 2000-present range, and groundwater."""
    return await build_ground(
        lat, lon, request.app.state.http, request.app.state.cache, get_settings()
    )


@app.get("/api/predict", response_model=PredictResponse)
async def predict(request: Request, lat: Lat, lon: Lon) -> PredictResponse:
    """AI discharge forecast for days 1-7 at the point's river, with flood-map scenarios."""
    settings = get_settings()
    today = datetime.now(UTC).date()
    cache: ResponseCache = request.app.state.cache
    return await cache.get_or_fetch(
        f"predict:{lat:.3f}:{lon:.3f}:{today}",
        PredictResponse,
        lambda: build_prediction(
            lat, lon, request.app.state.http, request.app.state.cache, settings
        ),
        settings.ttl_forecast,
        lambda r: r.status == "ok",
    )


@app.post("/api/explain", response_model=ExplainResponse)
async def explain_point(request: Request, body: ExplainRequest) -> ExplainResponse:
    """Plain-English explanation from Claude, using only numbers from FloodScope's tools."""
    return await explain(body, request.app.state.http, request.app.state.cache, get_settings())


@app.get("/api/google-flood", response_model=GoogleFloodResponse)
async def google_flood(request: Request, lat: Lat, lon: Lon) -> GoogleFloodResponse:
    """Google Flood Hub gauges near the point (feature flag: needs a waitlist API key)."""
    settings = get_settings()
    cache: ResponseCache = request.app.state.cache
    key = settings.google_flood_api_key
    return await cache.get_or_fetch(
        f"google-flood:{lat:.2f}:{lon:.2f}:{bool(key)}",
        GoogleFloodResponse,
        lambda: get_google_flood(request.app.state.http, key, lat, lon),
        settings.ttl_ea * 6,
        lambda r: r.status == "ok",
    )


@app.get("/api/satellite", response_model=SatelliteResponse)
async def satellite(lat: Lat, lon: Lon) -> SatelliteResponse:
    """Prithvi water maps from Sentinel-2 that cover this point (made offline by the ML job)."""
    return list_results(get_settings().satellite_dir, lat, lon)


@app.get("/api/satellite/{result_id}/overlay.png")
async def satellite_overlay(result_id: str) -> FileResponse:
    path = overlay_path(get_settings().satellite_dir, result_id)
    if path is None:
        raise HTTPException(status_code=404, detail="No such satellite result")
    return FileResponse(path, media_type="image/png")


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


@app.get("/api/replay", response_model=ReplayResponse)
async def replay(
    request: Request,
    lat: Lat,
    lon: Lon,
    start: date,
    end: date,
    size_km: Annotated[float, Query(ge=REPLAY_MIN_KM, le=REPLAY_MAX_KM)] = 10.0,
    rain_scale: Annotated[float, Query(ge=0.5, le=5.0)] = 1.0,
    drain_mm_h: Annotated[float, Query(ge=0.0, le=50.0)] = 5.0,
) -> ReplayResponse:
    """Replay a storm: hourly rain on the ground over 1-7 days, simulated on the server.

    The first request starts the job and returns status "running" with progress; ask
    again (every few seconds) until it is "ok". Finished replays are kept on disk.
    """
    try:
        params = ReplayParams.normalised(lat, lon, size_km, start, end, rain_scale, drain_mm_h)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    jobs: ReplayJobs = request.app.state.replays
    return await jobs.request(
        params,
        datetime.now(UTC).date(),
        request.app.state.http,
        request.app.state.cache,
        get_settings(),
    )


_REPLAY_FILES = {"depth.bin": "depth.bin.gz", "features.bin": "features.bin.gz"}


@app.get("/api/replay/{replay_id}/{name}")
async def replay_file(request: Request, replay_id: str, name: str) -> FileResponse:
    """Binary parts of a finished replay (already gzip-compressed on disk)."""
    jobs: ReplayJobs = request.app.state.replays
    folder = jobs.result_dir(replay_id) if re.fullmatch(r"[0-9a-f]{16}", replay_id) else None
    if folder is None or name not in _REPLAY_FILES:
        raise HTTPException(status_code=404, detail="No such replay file")
    return FileResponse(
        folder / _REPLAY_FILES[name],
        media_type="application/octet-stream",
        headers={"Content-Encoding": "gzip", "Cache-Control": "public, max-age=86400"},
    )
