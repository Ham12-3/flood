"""Builds /api/scene: the terrain window, hazard grids and forecast scenarios."""

import asyncio
import base64
import math
from datetime import UTC, date, datetime

import httpx
import numpy as np

from floodscope.cache import ResponseCache
from floodscope.config import Settings
from floodscope.geo import copernicus_tile_name
from floodscope.geoid import geoid_height_m
from floodscope.grid import WindowGrid, dem_tiles_for, window_grid
from floodscope.models import (
    RETURN_PERIODS,
    DischargeDay,
    DischargeForRP,
    ForecastScenario,
    HazardLayer,
    MapBlend,
    ReturnPeriodFitInfo,
    RiverDischarge,
    SceneDem,
    SceneGrid,
    SceneHazard,
    SceneResponse,
    SceneStatic,
)
from floodscope.point import river_cache_key
from floodscope.raster import RasterReadError
from floodscope.returnperiod import GumbelFit, annual_maxima, bracket, fit_gumbel
from floodscope.sources import dem, flood, hazard

MAX_RETURN_PERIOD = 10_000.0  # report anything rarer as "beyond 1-in-10,000"
THRESHOLD_RPS = (2, 5, 10, 20, 50, 100, 200, 500)


def b64(arr: np.ndarray, dtype: str) -> str:
    return base64.b64encode(np.ascontiguousarray(arr, dtype=dtype).tobytes()).decode("ascii")


def fit_shape(arr: np.ndarray, ny: int, nx: int) -> np.ndarray:
    """Crop or NaN-pad a window to exactly (ny, nx); merge can be off by one pixel."""
    out = np.full((ny, nx), np.nan, dtype="float32")
    h, w = min(ny, arr.shape[0]), min(nx, arr.shape[1])
    out[:h, :w] = arr[:h, :w]
    return out


def depth_to_cm(depth_m: np.ndarray) -> np.ndarray:
    d = np.nan_to_num(depth_m, nan=0.0, posinf=0.0, neginf=0.0)
    out: np.ndarray = np.clip(np.round(d * 100), 0, 65535).astype("<u2")
    return out


def scene_grid_model(g: WindowGrid) -> SceneGrid:
    w, h = g.cell_size_m()
    return SceneGrid(
        west=g.west,
        south=g.south,
        east=g.east,
        north=g.north,
        nx=g.nx,
        ny=g.ny,
        dx_deg=g.dx,
        dy_deg=g.dy,
        cell_size_m=(round(w, 2), round(h, 2)),
    )


async def _scene_dem(
    g: WindowGrid, client: httpx.AsyncClient, cache: ResponseCache, settings: Settings
) -> SceneDem:
    base = settings.copernicus_dem_url
    tiles = [copernicus_tile_name(la + 0.5, lo + 0.5) for la, lo in dem_tiles_for(g.bounds)]
    try:
        exists = await asyncio.gather(
            *(dem.tile_exists(client, base, t, cache, settings.ttl_static) for t in tiles)
        )
        present = [t for t, ok in zip(tiles, exists, strict=True) if ok]
        if not present:
            return SceneDem(
                status="no_data",
                reason="No Copernicus DEM tiles here; the window is open sea.",
                source=dem.source_info(),
            )
        window = await asyncio.to_thread(
            dem.read_dem_window, base, present, g.bounds, (g.dx, g.dy), settings.user_agent
        )
    except (httpx.HTTPError, RasterReadError) as exc:
        return SceneDem(
            status="error", reason=f"Terrain unavailable: {exc}", source=dem.source_info()
        )
    heights = fit_shape(window.data, g.ny, g.nx)
    finite = heights[np.isfinite(heights)]
    if finite.size == 0:
        return SceneDem(
            status="no_data",
            reason="The DEM has no values in this window.",
            source=dem.source_info(),
        )
    return SceneDem(
        status="ok",
        heights_f32=b64(heights, "<f4"),
        min_m=round(float(finite.min()), 2),
        max_m=round(float(finite.max()), 2),
        source=dem.source_info(),
    )


async def _scene_hazard(
    g: WindowGrid, client: httpx.AsyncClient, cache: ResponseCache, settings: Settings
) -> SceneHazard:
    base = settings.jrc_hazard_url
    try:
        tiles = hazard.tiles_for_bounds(
            await hazard.get_tiles(client, base, cache, settings.ttl_static), g.bounds
        )
        if not tiles:
            return SceneHazard(
                status="no_data",
                reason="Outside the JRC flood hazard maps, which only cover land.",
                source=hazard.source_info(),
            )
        lons, lats = g.cell_centres()
        jobs: dict[str, list[str]] = {
            f"rp{rp}": [f"RP{rp}/{t}_RP{rp}_depth.tif" for t in tiles] for rp in RETURN_PERIODS
        }
        jobs["permanent"] = [f"Permanent_WaterBodies/{t}_permanent_water.tif" for t in tiles]
        jobs["spurious"] = [f"Spurious_Depths/{t}_spurious_depth_areas.tif" for t in tiles]
        loop = asyncio.get_running_loop()
        results = await asyncio.gather(
            *(
                loop.run_in_executor(
                    hazard._POOL,
                    hazard.read_layer_on_grid,
                    base,
                    paths,
                    g.bounds,
                    lons,
                    lats,
                    settings.user_agent,
                )
                for paths in jobs.values()
            )
        )
    except (httpx.HTTPError, RasterReadError, ValueError, KeyError) as exc:
        return SceneHazard(
            status="error",
            reason=f"Flood hazard maps unavailable: {exc}",
            source=hazard.source_info(),
        )
    grids = dict(zip(jobs, results, strict=True))
    layers = []
    for rp in RETURN_PERIODS:
        cm = depth_to_cm(grids[f"rp{rp}"])
        layers.append(
            HazardLayer(
                return_period=rp, depth_cm_u16=b64(cm, "<u2"), flooded_cells=int((cm > 0).sum())
            )
        )
    perm = (np.nan_to_num(grids["permanent"], nan=0.0) > 0).astype("u1")
    spurious = bool((np.nan_to_num(grids["spurious"], nan=0.0) > 0).any())
    return SceneHazard(
        status="ok",
        layers=layers,
        permanent_water_u8=b64(perm, "u1"),
        permanent_water_cells=int(perm.sum()),
        spurious_depth_in_window=spurious,
        source=hazard.source_info(),
    )


async def build_static(
    g: WindowGrid, client: httpx.AsyncClient, cache: ResponseCache, settings: Settings
) -> SceneStatic:
    centre_lat, centre_lon = (g.south + g.north) / 2, (g.west + g.east) / 2
    dem_block, hazard_block = await asyncio.gather(
        _scene_dem(g, client, cache, settings), _scene_hazard(g, client, cache, settings)
    )
    try:
        geoid: float | None = await asyncio.to_thread(geoid_height_m, centre_lat, centre_lon)
    except RuntimeError:
        geoid = None
    return SceneStatic(
        grid=scene_grid_model(g), geoid_offset_m=geoid, dem=dem_block, hazard=hazard_block
    )


def fit_info(
    river: RiverDischarge, history: list[tuple[date, float | None]] | None, error: str | None = None
) -> ReturnPeriodFitInfo:
    source = flood.source_info()
    source.name = "GloFAS v4 river discharge reanalysis"
    source.data_date = "Daily reanalysis, complete calendar years"
    if river.status != "ok" or river.grid_lat is None or river.grid_lon is None:
        return ReturnPeriodFitInfo(
            status="no_data",
            reason="No modelled river at this point, so forecast flows cannot be turned "
            "into flood maps.",
            source=source,
        )
    base = {"grid_lat": river.grid_lat, "grid_lon": river.grid_lon}
    if history is None:
        return ReturnPeriodFitInfo(status="error", reason=error, source=source, **base)
    try:
        fit = fit_gumbel(annual_maxima(history))
    except ValueError as exc:
        return ReturnPeriodFitInfo(status="no_data", reason=str(exc), source=source, **base)
    source.data_date = f"Annual maxima {fit.first_year}-{fit.last_year}"
    return ReturnPeriodFitInfo(
        status="ok",
        first_year=fit.first_year,
        last_year=fit.last_year,
        n_years=fit.n_years,
        location=round(fit.location, 3),
        scale=round(fit.scale, 3),
        thresholds=[
            DischargeForRP(return_period=t, discharge=round(fit.discharge_for(t), 2))
            for t in THRESHOLD_RPS
        ],
        source=source,
        **base,
    )


def _rp(fit: GumbelFit, q: float | None) -> float | None:
    if q is None:
        return None
    t = fit.return_period(q)
    return MAX_RETURN_PERIOD if math.isinf(t) or t > MAX_RETURN_PERIOD else round(t, 2)


def build_scenarios(
    forecast: list[DischargeDay], fit_block: ReturnPeriodFitInfo, today: date
) -> list[ForecastScenario]:
    """One scenario per forecast day from today onwards. Pure, so it is unit tested."""
    fit = None
    if fit_block.status == "ok" and fit_block.location is not None and fit_block.scale:
        fit = GumbelFit(
            fit_block.location,
            fit_block.scale,
            fit_block.first_year or 0,
            fit_block.last_year or 0,
            fit_block.n_years or 0,
        )
    out: list[ForecastScenario] = []
    for d in forecast:
        if d.date < today:
            continue
        q = d.ensemble_mean if d.ensemble_mean is not None else d.discharge
        t = _rp(fit, q) if fit else None
        blend = bracket(t, RETURN_PERIODS) if t is not None else None
        out.append(
            ForecastScenario(
                day=(d.date - today).days,
                date=d.date,
                discharge=q,
                discharge_low=d.ensemble_p25,
                discharge_high=d.ensemble_p75,
                return_period=t,
                return_period_low=_rp(fit, d.ensemble_p25) if fit else None,
                return_period_high=_rp(fit, d.ensemble_p75) if fit else None,
                maps=MapBlend(lower=blend[0], upper=blend[1], weight=round(blend[2], 4))
                if blend
                else None,
                beyond_largest_map=t is not None and t >= RETURN_PERIODS[-1],
            )
        )
    return out


async def build_scene(
    lat: float,
    lon: float,
    size_km: float,
    client: httpx.AsyncClient,
    cache: ResponseCache,
    settings: Settings,
) -> SceneResponse:
    g = window_grid(lat, lon, size_km)
    today = datetime.now(UTC).date()

    static = await cache.get_or_fetch(
        f"scene:static:v1:{g.key}",
        SceneStatic,
        lambda: build_static(g, client, cache, settings),
        settings.ttl_static,
        lambda s: s.dem.status != "error" and s.hazard.status != "error",
    )
    river = await cache.get_or_fetch(
        river_cache_key(lat, lon, today),
        RiverDischarge,
        lambda: flood.get_river_discharge(client, settings.open_meteo_flood_url, lat, lon),
        settings.ttl_forecast,
        lambda r: r.status != "error",
    )

    async def fetch_fit() -> ReturnPeriodFitInfo:
        if river.status != "ok" or river.grid_lat is None or river.grid_lon is None:
            return fit_info(river, None)
        try:
            history = await flood.get_history(
                client,
                settings.open_meteo_flood_url,
                river.grid_lat,
                river.grid_lon,
                date(today.year - 1, 12, 31),
            )
        except (httpx.HTTPError, ValueError) as exc:
            return fit_info(river, None, f"Flow history unavailable: {exc}")
        return fit_info(river, history)

    fit = await cache.get_or_fetch(
        f"glofas:fit:{river.grid_lat}:{river.grid_lon}:{today.year}",
        ReturnPeriodFitInfo,
        fetch_fit,
        settings.ttl_static,
        lambda f: f.status != "error",
    )
    return SceneResponse(
        lat=lat,
        lon=lon,
        size_km=size_km,
        generated_at=datetime.now(UTC),
        grid=static.grid,
        geoid_offset_m=static.geoid_offset_m,
        dem=static.dem,
        hazard=static.hazard,
        river=river,
        fit=fit,
        scenarios=build_scenarios(river.forecast, fit, today),
    )
