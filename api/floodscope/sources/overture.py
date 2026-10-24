"""Buildings and roads from Overture Maps (GeoParquet on AWS Open Data).

Verified live 2026-10-24 (release 2026-10-21.0): the STAC catalogue at
stac.overturemaps.org names the latest release, and each collection's extent lists one
bounding box per parquet file, in file order. Files are spatially sorted, with a
`bbox` struct column whose row-group statistics let pyarrow skip everything outside
the area: a 10 km square of Lagos (111,587 buildings) reads in about 9 s.

Buildings combine OpenStreetMap with machine-learned footprints from Google and
Microsoft, so they cover places OpenStreetMap is missing. Roads are OpenStreetMap.
"""

import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx
import numpy as np
import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.fs as pafs
import shapely

from floodscope.cache import ResponseCache
from floodscope.models import SourceInfo

Bounds = tuple[float, float, float, float]

# Footpaths, steps and tracks are left out: "road" here means where cars go.
NOT_FOR_CARS = {"footway", "steps", "path", "cycleway", "bridleway", "track"}


def source_info(release: str) -> SourceInfo:
    return SourceInfo(
        name="Overture Maps buildings and roads",
        provider="Overture Maps Foundation: OpenStreetMap, plus Google Open Buildings and "
        "Microsoft ML building footprints",
        url="https://docs.overturemaps.org/",
        resolution="Building outlines and road lines",
        data_date=f"Release {release}",
        licence="ODbL 1.0 (© OpenStreetMap contributors and others); some buildings CDLA "
        "Permissive 2.0 or CC BY 4.0",
        retrieved_at=datetime.now(UTC),
    )


async def latest_release(
    client: httpx.AsyncClient, stac_url: str, cache: ResponseCache, ttl_s: int
) -> str:
    key = "overture:latest"
    known = cache.get_text(key)
    if known:
        return known
    resp = await client.get(f"{stac_url.rstrip('/')}/catalog.json")
    resp.raise_for_status()
    release = str(resp.json()["latest"])
    cache.set_text(key, release, ttl_s)
    return release


@dataclass(frozen=True)
class ParquetFile:
    key: str  # path in the bucket
    bbox: Bounds


def pair_files(keys: list[str], boxes: list[list[float]]) -> list[ParquetFile]:
    """Match the collection's per-file boxes (in file order) with the bucket keys."""
    if len(keys) != len(boxes):
        raise RuntimeError(
            f"Overture lists {len(keys)} files but {len(boxes)} file extents; cannot match them"
        )
    return [
        ParquetFile(k, (b[0], b[1], b[2], b[3])) for k, b in zip(sorted(keys), boxes, strict=True)
    ]


async def file_index(
    client: httpx.AsyncClient,
    stac_url: str,
    bucket: str,
    release: str,
    theme: str,
    typ: str,
    cache: ResponseCache,
    ttl_s: int,
) -> list[ParquetFile]:
    key = f"overture:{release}:{theme}:{typ}:files"
    known = cache.get_text(key)
    if known:
        return [ParquetFile(f["key"], (*f["bbox"],)) for f in json.loads(known)]
    coll = await client.get(f"{stac_url.rstrip('/')}/{release}/{theme}/{typ}/collection.json")
    coll.raise_for_status()
    boxes = coll.json()["extent"]["spatial"]["bbox"][1:]  # [0] is the whole collection
    keys: list[str] = []
    token: str | None = None
    while True:
        params = {"list-type": "2", "prefix": f"release/{release}/theme={theme}/type={typ}/"}
        if token:
            params["continuation-token"] = token
        resp = await client.get(f"https://{bucket}.s3.amazonaws.com/", params=params)
        resp.raise_for_status()
        keys += re.findall(r"<Key>([^<]+\.parquet)</Key>", resp.text)
        m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", resp.text)
        if not m:
            break
        token = m.group(1)
    files = pair_files(keys, boxes)
    cache.set_text(key, json.dumps([{"key": f.key, "bbox": f.bbox} for f in files]), ttl_s)
    return files


def files_touching(files: list[ParquetFile], bounds: Bounds) -> list[ParquetFile]:
    w, s, e, n = bounds
    return [
        f for f in files if not (f.bbox[2] < w or f.bbox[0] > e or f.bbox[3] < s or f.bbox[1] > n)
    ]


def _read(
    bucket: str,
    region: str,
    files: list[ParquetFile],
    bounds: Bounds,
    columns: list[str],
    extra: "pc.Expression | None" = None,
) -> "dict[str, np.ndarray]":
    if not files:
        return {c: np.array([], dtype=object) for c in columns}
    s3 = pafs.S3FileSystem(anonymous=True, region=region, connect_timeout=20, request_timeout=60)
    dset = ds.dataset([f"{bucket}/{f.key}" for f in files], filesystem=s3, format="parquet")
    w, s, e, n = bounds
    flt = (
        (pc.field("bbox", "xmax") >= w)
        & (pc.field("bbox", "xmin") <= e)
        & (pc.field("bbox", "ymax") >= s)
        & (pc.field("bbox", "ymin") <= n)
    )
    if extra is not None:
        flt = flt & extra
    table = dset.to_table(columns=columns, filter=flt)
    return {c: table.column(c).to_numpy(zero_copy_only=False) for c in columns}


def read_buildings(
    bucket: str, region: str, files: list[ParquetFile], bounds: Bounds
) -> np.ndarray:
    """Building outlines (shapely Polygons/MultiPolygons) touching the bounds (blocking)."""
    cols = _read(bucket, region, files, bounds, ["geometry"])
    geoms: np.ndarray = shapely.from_wkb(cols["geometry"])
    return geoms


def read_roads(
    bucket: str, region: str, files: list[ParquetFile], bounds: Bounds
) -> tuple[np.ndarray, np.ndarray]:
    """Road lines and their classes touching the bounds, footpaths left out (blocking)."""
    cols = _read(
        bucket, region, files, bounds, ["geometry", "class"], extra=pc.field("subtype") == "road"
    )
    classes = np.array(
        [c if isinstance(c, str) else "unknown" for c in cols["class"]], dtype=object
    )
    keep = np.array([c not in NOT_FOR_CARS for c in classes], dtype=bool)
    geoms: np.ndarray = (
        shapely.from_wkb(cols["geometry"][keep]) if keep.any() else np.array([], dtype=object)
    )
    return geoms, classes[keep]
