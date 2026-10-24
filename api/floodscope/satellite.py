"""Lists Prithvi satellite water maps made by ml/floodscope_ml/satellite.py.

The job writes one folder per run (meta.json + overlay.png). This module only reads
them; it never runs the model.
"""

import json
import re
from datetime import UTC, datetime
from pathlib import Path

from floodscope.geo import point_in_bbox
from floodscope.models import SatelliteResponse, SatelliteResult, SourceInfo

SAFE_ID = re.compile(r"^[A-Za-z0-9_.]+$")


def source_info() -> SourceInfo:
    return SourceInfo(
        name="Prithvi-EO-2.0 Sen1Floods11 water map from Sentinel-2",
        provider="IBM / NASA (model); ESA Copernicus Sentinel-2 via Earth Search (imagery)",
        url="https://huggingface.co/ibm-nasa-geospatial/Prithvi-EO-2.0-300M-TL-Sen1Floods11",
        resolution="10 m",
        data_date="Scene date per result",
        licence="Apache 2.0 (model); Copernicus Sentinel data licence (imagery)",
        retrieved_at=datetime.now(UTC),
    )


def overlay_path(results_dir: Path, result_id: str) -> Path | None:
    """Path to a result's PNG, or None for unknown or unsafe ids."""
    if not SAFE_ID.match(result_id):
        return None
    path = results_dir / result_id / "overlay.png"
    return path if path.is_file() else None


def list_results(results_dir: Path, lat: float, lon: float) -> SatelliteResponse:
    found: list[SatelliteResult] = []
    if results_dir.is_dir():
        for meta_file in sorted(results_dir.glob("*/meta.json")):
            try:
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
                west, south, east, north = (float(v) for v in meta["bounds"])
                if not point_in_bbox(lat, lon, (west, south, east, north)):
                    continue
                rid = meta_file.parent.name
                if not SAFE_ID.match(rid) or not (meta_file.parent / "overlay.png").is_file():
                    continue
                found.append(
                    SatelliteResult(
                        id=rid,
                        scene_id=str(meta["scene_id"]),
                        datetime=str(meta["datetime"]),
                        cloud_cover=meta.get("cloud_cover"),
                        bounds=(west, south, east, north),
                        water_fraction=meta.get("water_fraction"),
                        model=str(meta.get("model", "")),
                        note=meta.get("note"),
                        overlay_url=f"/api/satellite/{rid}/overlay.png",
                    )
                )
            except (KeyError, ValueError, TypeError):
                continue  # skip half-written or foreign folders
    if not found:
        return SatelliteResponse(
            lat=lat,
            lon=lon,
            status="no_data",
            reason="No satellite water map covers this point yet. Run "
            "ml/notebooks/satellite_prithvi.ipynb for it and copy the result into "
            "ml/satellite_results/.",
            source=source_info(),
        )
    found.sort(key=lambda r: r.datetime, reverse=True)
    return SatelliteResponse(lat=lat, lon=lon, status="ok", results=found, source=source_info())
