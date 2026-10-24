"""Bare-ground heights from FABDEM V1-2 (Copernicus DEM with buildings and trees removed).

Verified live 2026-10-24: the University of Bristol data repository serves one zip per
10x10 degree block (about 1 GB, with HTTP range support), named by its south-west and
north-east corners, e.g. N00E000-N10E010_FABDEM_V1-2.zip. Inside are 1x1 degree
GeoTIFFs (N06E003_FABDEM_V1-2.tif): 1 arc-second, float32, 256 px deflate tiles,
stored uncompressed in the zip, so GDAL reads small windows through
/vsizip//vsicurl/ without downloading the zip. The sea and coastal lagoons are 0 m.
All-ocean tiles and blocks are left out.

We read each zip's table of contents (a few range requests) to know which tiles exist,
so a network failure is never mistaken for open sea.
"""

import io
import math
import re
import zipfile
from datetime import UTC, datetime

import httpx
import numpy as np
from affine import Affine
from rasterio.enums import Resampling

from floodscope.cache import ResponseCache
from floodscope.models import SourceInfo
from floodscope.raster import WindowRead, gdal_path, read_window

VERSION = "V1-2"


def source_info() -> SourceInfo:
    return SourceInfo(
        name="FABDEM V1-2 (bare-ground heights)",
        provider="University of Bristol (Hawker et al. 2022), from Copernicus DEM GLO-30",
        url="https://data.bris.ac.uk/data/dataset/s5hqmjcdj8yo2ibzi9b4ew3sn",
        resolution="1 arc-second (about 30 m), averaged to the replay grid",
        data_date="V1-2 (2023); radar acquired 2011-2015",
        licence="CC BY-NC-SA 4.0 (non-commercial); contains Copernicus DEM data",
        retrieved_at=datetime.now(UTC),
    )


def _lat(v: int) -> str:
    return f"{'N' if v >= 0 else 'S'}{abs(v):02d}"


def _lon(v: int) -> str:
    if v >= 180:
        v -= 360
    return f"{'E' if v >= 0 else 'W'}{abs(v):03d}"


def block_name(lat: float, lon: float) -> str:
    la = math.floor(lat / 10) * 10
    lo = math.floor(lon / 10) * 10
    return f"{_lat(la)}{_lon(lo)}-{_lat(la + 10)}{_lon(lo + 10)}_FABDEM_{VERSION}.zip"


def tile_name(lat: float, lon: float) -> str:
    return f"{_lat(math.floor(lat))}{_lon(math.floor(lon))}_FABDEM_{VERSION}.tif"


def parse_block_list(html: str) -> list[str]:
    return sorted(set(re.findall(r'href="([^"/]+_FABDEM_[^"]+\.zip)"', html)))


class _HttpRangeFile(io.RawIOBase):
    """A read-only, seekable file over HTTP range requests (enough for zipfile)."""

    def __init__(self, client: httpx.Client, url: str) -> None:
        self._client = client
        self._url = url
        head = client.head(url)
        head.raise_for_status()
        self._size = int(head.headers["content-length"])
        self._pos = 0

    def seekable(self) -> bool:
        return True

    def readable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self._pos, io.SEEK_END: self._size}[whence]
        self._pos = max(0, base + offset)
        return self._pos

    def read(self, size: int | None = -1) -> bytes:
        if size is None or size < 0:
            size = self._size - self._pos
        if size == 0 or self._pos >= self._size:
            return b""
        end = min(self._pos + size, self._size) - 1
        resp = self._client.get(self._url, headers={"Range": f"bytes={self._pos}-{end}"})
        resp.raise_for_status()
        self._pos += len(resp.content)
        return resp.content

    def readinto(self, b: bytearray) -> int:  # type: ignore[override]
        data = self.read(len(b))
        b[: len(data)] = data
        return len(data)


def zip_members(url: str, user_agent: str = "", timeout_s: float = 60.0) -> list[str]:
    """File names inside a remote zip, from its central directory (blocking)."""
    with httpx.Client(
        timeout=timeout_s, headers={"User-Agent": user_agent}, follow_redirects=True
    ) as client:
        raw = _HttpRangeFile(client, url)
        buffered = io.BufferedReader(raw, buffer_size=256 * 1024)  # type: ignore[type-var]
        with zipfile.ZipFile(buffered) as zf:
            return zf.namelist()


async def available_blocks(
    client: httpx.AsyncClient, base_url: str, cache: ResponseCache, ttl_s: int
) -> list[str]:
    key = f"fabdem:{VERSION}:blocks"
    known = cache.get_text(key)
    if known is not None:
        return known.split("\n") if known else []
    resp = await client.get(f"{base_url.rstrip('/')}/")
    resp.raise_for_status()
    blocks = parse_block_list(resp.text)
    if not blocks:
        raise RuntimeError("The FABDEM download page lists no blocks; its layout may have changed")
    cache.set_text(key, "\n".join(blocks), ttl_s)
    return blocks


def tiles_for(bounds: tuple[float, float, float, float]) -> list[tuple[int, int]]:
    west, south, east, north = bounds
    return [
        (la, lo)
        for la in range(math.floor(south), math.floor(north - 1e-12) + 1)
        for lo in range(math.floor(west), math.floor(east - 1e-12) + 1)
    ]


def read_fabdem_window(
    base_url: str,
    tile_paths: list[str],
    bounds: tuple[float, float, float, float],
    res: tuple[float, float],
    user_agent: str = "",
) -> WindowRead:
    """FABDEM pixels on a regular window (nearest pixel; pass its native 1" spacing to
    keep every pixel). Cells with no tile (open sea) come back as NaN."""
    paths = [
        gdal_path(base_url, p).replace("/vsicurl/", "/vsizip//vsicurl/", 1) for p in tile_paths
    ]
    if not paths:
        west, south, east, north = bounds
        ny = round((north - south) / res[1])
        nx = round((east - west) / res[0])
        return WindowRead(
            np.full((ny, nx), np.nan, dtype="float32"), Affine(res[0], 0, west, 0, -res[1], north)
        )
    return read_window(
        paths,
        bounds,
        res,
        user_agent,
        resampling=Resampling.nearest,
        allowed_extensions=".zip,.tif",
    )
