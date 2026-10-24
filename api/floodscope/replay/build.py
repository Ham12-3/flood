"""Runs one storm replay: data, simulation, hourly counts, files on disk.

A replay is identified by its normalised request (and, for forecasts, the day it was
run). Results live in <cache_dir>/replay/<id>/ as meta.json, depth.bin.gz and
features.bin.gz, so a repeat request is served from disk.
"""

import asyncio
import gzip
import hashlib
import math
import shutil
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

import httpx
import numpy as np

from floodscope.cache import ResponseCache
from floodscope.config import Settings
from floodscope.grid import WindowGrid
from floodscope.models import ReplayHour, ReplayRequestEcho, ReplayResponse
from floodscope.replay.features import (
    EncodedBuildings,
    EncodedRoads,
    count_hour,
    encode_buildings,
    encode_roads,
    features_blob,
)
from floodscope.replay.sim import SimParams, Simulation, aggregate_ground, bilinear_rain, sea_mask
from floodscope.scene import b64, depth_to_cm, fit_shape, scene_grid_model
from floodscope.sources import fabdem, overture, storm

MIN_SIZE_KM = 2.0
MAX_SIZE_KM = 20.0
MAX_DAYS = 7
CELL_ARCSEC = 2.0  # about 60 m north-south
RAIN_POINTS = 4  # rain is fetched on a 4 x 4 grid of points over the area
MANNING = 0.035  # same roughness as the in-browser simulation


@dataclass(frozen=True)
class ReplayParams:
    lat: float
    lon: float
    size_km: float
    start: date
    end: date
    rain_scale: float
    drain_mm_h: float

    @classmethod
    def normalised(
        cls,
        lat: float,
        lon: float,
        size_km: float,
        start: date,
        end: date,
        rain_scale: float,
        drain_mm_h: float,
    ) -> "ReplayParams":
        if end < start:
            raise ValueError("The end date is before the start date.")
        if (end - start).days + 1 > MAX_DAYS:
            raise ValueError(f"Pick at most {MAX_DAYS} days.")
        if not MIN_SIZE_KM <= size_km <= MAX_SIZE_KM:
            raise ValueError(f"The area must be {MIN_SIZE_KM:g}-{MAX_SIZE_KM:g} km across.")
        return cls(
            round(lat, 3),
            round(lon, 3),
            round(size_km * 2) / 2,
            start,
            end,
            round(rain_scale, 1),
            round(drain_mm_h * 2) / 2,
        )

    def echo(self) -> ReplayRequestEcho:
        return ReplayRequestEcho(
            lat=self.lat,
            lon=self.lon,
            size_km=self.size_km,
            start=self.start,
            end=self.end,
            rain_scale=self.rain_scale,
            drain_mm_h=self.drain_mm_h,
        )


def replay_id(p: ReplayParams, today: date) -> str:
    # Forecast-based replays change as forecasts update, so they are keyed by day too.
    run_day = today.isoformat() if p.end >= today - timedelta(days=2) else "archive"
    parts = (p.lat, p.lon, p.size_km, p.start, p.end, p.rain_scale, p.drain_mm_h, run_day)
    raw = "v1:" + ":".join(str(x) for x in parts)
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def replay_grid(lat: float, lon: float, size_km: float) -> WindowGrid:
    """A roughly square ~60 m grid centred on the point, snapped to whole cells."""
    dy = CELL_ARCSEC / 3600
    dx = max(CELL_ARCSEC, round(CELL_ARCSEC / max(math.cos(math.radians(lat)), 0.05))) / 3600
    half_lat = size_km / 2 / 111.32
    half_lon = size_km / 2 / (111.32 * max(math.cos(math.radians(lat)), 0.05))
    west = math.floor((lon - half_lon) / dx) * dx
    south = math.floor((lat - half_lat) / dy) * dy
    nx = math.ceil((lon + half_lon - west) / dx)
    ny = math.ceil((lat + half_lat - south) / dy)
    return WindowGrid(west, south, west + nx * dx, south + ny * dy, nx, ny, dx, dy)


ASSUMPTIONS = [
    "Drains take away {drain:g} mm of water per hour everywhere, working less near the sea "
    "and not at all below its level. Real drain capacity is not known.",
    "Rain is multiplied by {scale:g}. Weather models spread storms out, so local downpours "
    "can be stronger than shown.",
    "Ground roughness (Manning's n) is 0.035 everywhere.",
    "The area starts dry, and the sea or lagoon is held at the tide level each hour.",
]

LIMITS = [
    "Rivers flowing in from outside the area are not included, and the height map has no "
    "river channels, so valleys hold too much water.",
    "60 m squares: a high plot next to a low road share one value. Blocked drains, walls, "
    "pumps and flood defences are not in the model.",
    "A building counts as having water at the door when its square has 10 cm or more.",
    "Bridges and flyovers count as flooded when the ground under them is.",
]


Progress = Callable[[float, str], None]


async def build_replay(
    p: ReplayParams,
    rid: str,
    out_dir: Path,
    client: httpx.AsyncClient,
    cache: ResponseCache,
    settings: Settings,
    today: date,
    progress: Progress,
    sim_lock: asyncio.Semaphore,
    stop: threading.Event,
) -> ReplayResponse:
    g = replay_grid(p.lat, p.lon, p.size_km)
    base = ReplayResponse(status="ok", id=rid, request=p.echo(), grid=scene_grid_model(g))

    progress(0.02, "Reading bare-ground heights (FABDEM)")
    blocks = set(
        await fabdem.available_blocks(client, settings.fabdem_url, cache, settings.ttl_static)
    )
    tile_paths: list[str] = []
    for la, lo in fabdem.tiles_for(g.bounds):
        block = fabdem.block_name(la + 0.5, lo + 0.5)
        if block not in blocks:
            continue  # the whole 10-degree block is ocean
        members_key = f"fabdem:{fabdem.VERSION}:members:{block}"
        known = cache.get_text(members_key)
        if known is None:
            members = await asyncio.to_thread(
                fabdem.zip_members, f"{settings.fabdem_url}/{block}", settings.user_agent
            )
            known = "\n".join(members)
            cache.set_text(members_key, known, settings.ttl_static)
        tile = fabdem.tile_name(la + 0.5, lo + 0.5)
        if tile in known.split("\n"):
            tile_paths.append(f"{block}/{tile}")
    # Read every native 1" pixel, then build the ~60 m cells ourselves, so a cell that is
    # mostly lagoon counts as water and a shoreline cell keeps its land height.
    ky, kx = round(g.dy * 3600), round(g.dx * 3600)
    window = await asyncio.to_thread(
        fabdem.read_fabdem_window,
        settings.fabdem_url,
        tile_paths,
        g.bounds,
        (1 / 3600, 1 / 3600),
        settings.user_agent,
    )
    native = fit_shape(window.data, g.ny * ky, g.nx * kx).astype("float64")
    z, water_fraction = aggregate_ground(native, ky, kx)
    sea = sea_mask(z, water_fraction >= 0.5)
    land = ~sea
    if not land.any():
        return base.model_copy(
            update={"status": "no_data", "reason": "This area is all sea or lagoon."}
        )

    progress(0.06, "Fetching hourly rain and tide")
    lats = [float(v) for v in np.linspace(g.north, g.south, RAIN_POINTS)]
    lons = [float(v) for v in np.linspace(g.west, g.east, RAIN_POINTS)]
    urls = {
        "forecast": settings.open_meteo_forecast_url,
        "historical": settings.open_meteo_historical_forecast_url,
        "archive": settings.open_meteo_archive_url,
    }
    try:
        rain = await storm.get_rain(client, urls, lats, lons, p.start, p.end, today)
    except storm.StormDataError as exc:
        return base.model_copy(update={"status": "no_data", "reason": str(exc)})
    sea_level = None
    if sea.any():
        rows, cols = np.nonzero(sea)
        lon_c, lat_c = g.cell_centres()
        dist = np.hypot(lon_c[rows, cols] - p.lon, lat_c[rows, cols] - p.lat)
        picks = [int(i) for i in np.argsort(dist)[::-1][:3]]  # far from land first
        pts = [(float(lat_c[rows[i], cols[i]]), float(lon_c[rows[i], cols[i]])) for i in picks]
        sea_level = await storm.get_sea_level(
            client, settings.open_meteo_marine_url, pts, p.start, p.end
        )

    progress(0.1, "Fetching buildings and roads (Overture Maps)")
    release = await overture.latest_release(client, settings.overture_stac_url, cache, 24 * 3600)
    b_files, r_files = await asyncio.gather(
        overture.file_index(
            client,
            settings.overture_stac_url,
            settings.overture_bucket,
            release,
            "buildings",
            "building",
            cache,
            settings.ttl_static,
        ),
        overture.file_index(
            client,
            settings.overture_stac_url,
            settings.overture_bucket,
            release,
            "transportation",
            "segment",
            cache,
            settings.ttl_static,
        ),
    )
    b_geoms, (r_geoms, r_classes) = await asyncio.gather(
        asyncio.to_thread(
            overture.read_buildings,
            settings.overture_bucket,
            settings.overture_region,
            overture.files_touching(b_files, g.bounds),
            g.bounds,
        ),
        asyncio.to_thread(
            overture.read_roads,
            settings.overture_bucket,
            settings.overture_region,
            overture.files_touching(r_files, g.bounds),
            g.bounds,
        ),
    )
    buildings = await asyncio.to_thread(encode_buildings, b_geoms, g)
    roads = await asyncio.to_thread(encode_roads, r_geoms, r_classes, g)

    progress(0.14, "Waiting for the simulator" if sim_lock.locked() else "Simulating")
    async with sim_lock:
        result = await asyncio.to_thread(
            _simulate, g, z, sea, rain, sea_level, p, buildings, roads, out_dir, progress, stop
        )
    hours, rain_total = result

    (out_dir / "features.bin.gz").write_bytes(features_blob(buildings, roads))
    sources = [fabdem.source_info(), rain.source]
    if sea_level is not None:
        sources.append(sea_level.source)
    sources.append(overture.source_info(release))
    assumptions = [a.format(drain=p.drain_mm_h, scale=p.rain_scale) for a in ASSUMPTIONS]
    if sea.any() and sea_level is None:
        assumptions[3] = (
            "The area starts dry. No tide data was found here, so the sea or "
            "lagoon is held at mean sea level."
        )
    if not tile_paths:
        assumptions.append("FABDEM has no land tile here, so the whole area is treated as sea.")
    ground = np.where(sea, np.nan, z).astype("float32")
    stamp = int(time.time())
    return base.model_copy(
        update={
            "timezone": rain.timezone,
            "hours": hours,
            "ground_f32": b64(ground, "<f4"),
            "sea_u8": b64(sea.astype("u1"), "u1"),
            "buildings_total": len(buildings.cells),
            "roads_km_total": round(float(roads.km_per_cell.sum()), 1),
            "rain_total_mm": round(rain_total, 1),
            # The version stamp keeps browsers from showing a cached earlier run.
            "depth_url": f"/api/replay/{rid}/depth.bin?v={stamp}",
            "features_url": f"/api/replay/{rid}/features.bin?v={stamp}",
            "sources": sources,
            "assumptions": assumptions,
            "limits": LIMITS,
        }
    )


def _simulate(
    g: WindowGrid,
    z: np.ndarray,
    sea: np.ndarray,
    rain: storm.RainSeries,
    sea_level: storm.SeaLevelSeries | None,
    p: ReplayParams,
    buildings: EncodedBuildings,
    roads: EncodedRoads,
    out_dir: Path,
    progress: Progress,
    stop: threading.Event,
) -> tuple[list[ReplayHour], float]:
    w, h = g.cell_size_m()
    sim = Simulation(
        np.where(sea, 0.0, z), sea, SimParams(dx=w, dy=h, manning=MANNING, drain_mm_h=p.drain_mm_h)
    )
    lon_c, lat_c = g.cell_centres()
    pt_lats = np.linspace(g.north, g.south, rain.values.shape[1])
    pt_lons = np.linspace(g.west, g.east, rain.values.shape[2])
    n_hours = len(rain.times) - 1
    hours: list[ReplayHour] = []
    rain_total = 0.0
    land = ~sea
    with gzip.open(out_dir / "depth.bin.gz", "wb", compresslevel=6) as frames:
        for i in range(n_hours):
            field = bilinear_rain(
                rain.values[i + 1 : i + 2] * p.rain_scale, pt_lons, pt_lats, lon_c, lat_c
            )[0]
            level = 0.0
            if sea_level is not None:
                level = float((sea_level.values[i] + sea_level.values[i + 1]) / 2)
            sim.set_sea_level(level)
            sim.run(3600.0, field / 1000 / 3600, stop.is_set)
            depth = np.where(sea, 0.0, sim.h)
            frames.write(depth_to_cm(depth).tobytes())
            c = count_hour(sim.h, sea, w * h, buildings, roads)
            mean_rain = float(field[land].mean())
            rain_total += mean_rain
            hours.append(
                ReplayHour(
                    time=rain.times[i + 1],
                    rain_mm=round(mean_rain, 2),
                    sea_level_m=round(level, 2) if sea_level is not None else None,
                    flooded_km2=round(c.flooded_km2, 3),
                    max_depth_m=round(c.max_depth_m, 2),
                    buildings_wet=c.buildings_wet,
                    roads_km_10cm=round(c.roads_km_10cm, 2),
                    roads_km_30cm=round(c.roads_km_30cm, 2),
                )
            )
            progress(0.15 + 0.83 * (i + 1) / n_hours, f"Simulating hour {i + 1} of {n_hours}")
    return hours, rain_total


def save_meta(out_dir: Path, resp: ReplayResponse) -> None:
    (out_dir / "meta.json").write_text(resp.model_dump_json(), encoding="utf-8")


def load_meta(root: Path, rid: str) -> ReplayResponse | None:
    path = root / rid / "meta.json"
    if not path.exists():
        return None
    return ReplayResponse.model_validate_json(path.read_text(encoding="utf-8"))


def discard(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
