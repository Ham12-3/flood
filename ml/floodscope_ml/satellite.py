"""Map real water from a Sentinel-2 scene with IBM/NASA Prithvi-EO-2.0 (Sen1Floods11).

    python -m floodscope_ml.satellite --lat 23.81 --lon 90.41 --start 2024-08-01 \
        --end 2024-09-30 --out ml/satellite_results

Steps:
1. Find the least cloudy Sentinel-2 L2A scene over the point (Earth Search STAC).
2. Read a 512 x 512 px, 10 m window of the six bands the model was trained on
   (BLUE, GREEN, RED, NIR_NARROW=B8A, SWIR_1=B11, SWIR_2=B12) as reflectance x 10000.
3. Run IBM/NASA's own inference.py from the Hugging Face model repo.
4. Save the water mask in EPSG:4326, a transparent PNG overlay, and meta.json, which
   the API lists at /api/satellite for the 3D view.

Limits: optical imagery cannot see through cloud (monsoon floods are often hidden); the
model was fine-tuned on Sentinel-2 L1C, and this uses L2A (atmospherically corrected),
a modest domain shift. Run it in Colab with a GPU, or on CPU for one tile.
"""

import argparse
import importlib.util
import json
import math
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np

STAC_URL = "https://earth-search.aws.element84.com/v1/search"
COLLECTION = "sentinel-2-l2a"
BAND_ASSETS = ("blue", "green", "red", "nir08", "swir16", "swir22")  # model band order
HF_REPO = "ibm-nasa-geospatial/Prithvi-EO-2.0-300M-TL-Sen1Floods11"
HF_CHECKPOINT = "Prithvi-EO-V2-300M-TL-Sen1Floods11.pt"
TILE_PX = 512
RES_M = 10.0
NO_DATA = -9999  # what inference.py treats as no data
WATER_RGBA = (57, 135, 229, 170)  # series blue, semi-transparent


@dataclass(frozen=True)
class Scene:
    id: str
    datetime: str
    cloud_cover: float
    epsg: int
    assets: dict[str, str]  # band asset -> COG href
    offset: float  # reflectance offset (L2A baseline >= 04.00: -0.1)
    scale: float


def pick_scene(features: list[dict[str, Any]], max_cloud: float) -> Scene | None:
    """Least cloudy scene with every band, under the cloud limit."""
    best: Scene | None = None
    for f in features:
        p = f.get("properties", {})
        cloud = p.get("eo:cloud_cover")
        epsg = p.get("proj:epsg") or _epsg(p.get("proj:code"))
        assets = f.get("assets", {})
        if cloud is None or cloud > max_cloud or epsg is None:
            continue
        if not all(a in assets for a in BAND_ASSETS):
            continue
        band = (assets["blue"].get("raster:bands") or [{}])[0]
        scene = Scene(
            id=f["id"],
            datetime=p.get("datetime", ""),
            cloud_cover=float(cloud),
            epsg=int(epsg),
            assets={a: assets[a]["href"] for a in BAND_ASSETS},
            offset=float(band.get("offset", 0.0)),
            scale=float(band.get("scale", 1.0)),
        )
        if best is None or scene.cloud_cover < best.cloud_cover:
            best = scene
    return best


def _epsg(code: Any) -> int | None:
    if isinstance(code, str) and code.upper().startswith("EPSG:"):
        return int(code.split(":")[1])
    return None


def search(lat: float, lon: float, start: str, end: str, max_cloud: float) -> Scene | None:
    import httpx

    body = {
        "collections": [COLLECTION],
        "intersects": {"type": "Point", "coordinates": [lon, lat]},
        "datetime": f"{start}T00:00:00Z/{end}T23:59:59Z",
        "limit": 100,
        "query": {"eo:cloud_cover": {"lt": max_cloud}},
    }
    resp = httpx.post(STAC_URL, json=body, timeout=60)
    resp.raise_for_status()
    return pick_scene(resp.json().get("features", []), max_cloud)


def to_reflectance_x10000(dn: np.ndarray, scale: float, offset: float) -> np.ndarray:
    """DN -> reflectance x 10000 (as the model expects); 0 DN is nodata."""
    refl = (dn.astype("float32") * scale + offset) * 10000.0
    out = np.where(dn == 0, NO_DATA, np.clip(refl, 0, 10000))
    return out.astype("int16")


def utm_window(lat: float, lon: float, epsg: int) -> tuple[float, float, float, float]:
    """Bounds (left, bottom, right, top) of the 512 px x 10 m tile centred on the point."""
    from pyproj import Transformer

    x, y = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True).transform(lon, lat)
    half = TILE_PX * RES_M / 2
    x0 = math.floor((x - half) / RES_M) * RES_M
    y0 = math.floor((y - half) / RES_M) * RES_M
    return (x0, y0, x0 + TILE_PX * RES_M, y0 + TILE_PX * RES_M)


def read_stack(scene: Scene, bounds: tuple[float, float, float, float], out_tif: Path) -> None:
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.transform import from_origin
    from rasterio.windows import from_bounds

    bands = []
    env = {"GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR", "AWS_NO_SIGN_REQUEST": "YES"}
    with rasterio.Env(**env):
        for asset in BAND_ASSETS:
            with rasterio.open(scene.assets[asset]) as src:
                window = from_bounds(*bounds, transform=src.transform)
                dn = src.read(
                    1,
                    window=window,
                    out_shape=(TILE_PX, TILE_PX),
                    resampling=Resampling.bilinear,
                    boundless=True,
                    fill_value=0,
                )
                bands.append(to_reflectance_x10000(dn, scene.scale, scene.offset))
    profile = {
        "driver": "GTiff",
        "height": TILE_PX,
        "width": TILE_PX,
        "count": len(bands),
        "dtype": "int16",
        "crs": f"EPSG:{scene.epsg}",
        "nodata": NO_DATA,
        "transform": from_origin(bounds[0], bounds[3], RES_M, RES_M),
        "compress": "deflate",
    }
    with rasterio.open(out_tif, "w", **profile) as dst:
        dst.write(np.stack(bands))


def _load_official_inference() -> tuple[Any, Path, Path]:
    from huggingface_hub import hf_hub_download

    script = Path(hf_hub_download(HF_REPO, "inference.py"))
    config = Path(hf_hub_download(HF_REPO, "config.yaml"))
    checkpoint = Path(hf_hub_download(HF_REPO, HF_CHECKPOINT))  # about 1.3 GB, cached
    spec = importlib.util.spec_from_file_location("prithvi_inference", script)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot import {script}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, config, checkpoint


def water_overlay(mask: np.ndarray) -> np.ndarray:
    """RGBA image: water in semi-transparent blue, everything else transparent."""
    rgba = np.zeros((*mask.shape, 4), dtype="uint8")
    rgba[mask] = WATER_RGBA
    return rgba


def finish(pred_tif: Path, scene: Scene, lat: float, lon: float, out_dir: Path) -> dict[str, Any]:
    """Reproject the mask to EPSG:4326, write overlay.png and meta.json."""
    import rasterio
    from rasterio.warp import Resampling, calculate_default_transform, reproject

    with rasterio.open(pred_tif) as src:
        mask_utm = src.read(1) > 0
        transform, width, height = calculate_default_transform(
            src.crs, "EPSG:4326", src.width, src.height, *src.bounds
        )
        mask = np.zeros((height, width), dtype="uint8")
        reproject(
            mask_utm.astype("uint8"),
            mask,
            src_transform=src.transform,
            src_crs=src.crs,
            dst_transform=transform,
            dst_crs="EPSG:4326",
            resampling=Resampling.nearest,
        )
    west, north = transform.c, transform.f
    east, south = west + transform.a * width, north + transform.e * height
    rgba = water_overlay(mask > 0)
    with rasterio.open(
        out_dir / "overlay.png",
        "w",
        driver="PNG",
        width=width,
        height=height,
        count=4,
        dtype="uint8",
    ) as dst:
        dst.write(np.moveaxis(rgba, -1, 0))
    meta = {
        "id": out_dir.name,
        "scene_id": scene.id,
        "datetime": scene.datetime,
        "cloud_cover": round(scene.cloud_cover, 1),
        "product": COLLECTION,
        "bounds": [west, south, east, north],
        "centre": [lon, lat],
        "water_fraction": round(float((mask > 0).mean()), 4),
        "model": HF_REPO,
        "created": datetime.now().isoformat(timespec="seconds"),
        "note": "Prithvi-EO-2.0 Sen1Floods11 water mask from Sentinel-2 L2A. Clouds hide "
        "water; the model was fine-tuned on L1C.",
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2))
    return meta


def run(
    lat: float, lon: float, start: str, end: str, out_root: Path, max_cloud: float
) -> dict[str, Any]:
    scene = search(lat, lon, start, end, max_cloud)
    if scene is None:
        raise SystemExit(f"No Sentinel-2 scene under {max_cloud}% cloud between {start} and {end}")
    out_dir = out_root / f"{scene.id}_{lat:.4f}_{lon:.4f}".replace("-", "m")
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = (
        scene.datetime[:19].replace("-", "").replace(":", "")
    )  # YYYYMMDDTHHMMSS for inference.py
    tile = out_dir / f"S2_{stamp}.tif"
    read_stack(scene, utm_window(lat, lon, scene.epsg), tile)
    inference, config, checkpoint = _load_official_inference()
    inference.main(str(tile), str(config), str(checkpoint), str(out_dir), rgb_outputs=False)
    return finish(out_dir / f"pred_{tile.stem}.tiff", scene, lat, lon, out_dir)


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--start", required=True, help="YYYY-MM-DD")
    ap.add_argument("--end", required=True, help="YYYY-MM-DD")
    ap.add_argument("--out", type=Path, default=Path("satellite_results"))
    ap.add_argument("--max-cloud", type=float, default=30.0)
    args = ap.parse_args()
    print(
        json.dumps(
            run(args.lat, args.lon, args.start, args.end, args.out, args.max_cloud), indent=2
        )
    )


if __name__ == "__main__":
    main()
