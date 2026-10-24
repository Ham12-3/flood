import json
from pathlib import Path

import numpy as np
import pytest

from floodscope_ml.satellite import (
    BAND_ASSETS,
    NO_DATA,
    TILE_PX,
    Scene,
    finish,
    pick_scene,
    to_reflectance_x10000,
    utm_window,
    water_overlay,
)


def feature(id_: str, cloud: float | None, bands: tuple[str, ...] = BAND_ASSETS) -> dict:
    return {
        "id": id_,
        "properties": {
            "eo:cloud_cover": cloud,
            "proj:code": "EPSG:32645",
            "datetime": "2024-08-13T04:41:00Z",
        },
        "assets": {
            b: {
                "href": f"https://x/{id_}/{b}.tif",
                "raster:bands": [{"scale": 0.0001, "offset": -0.1}],
            }
            for b in bands
        },
    }


def test_pick_scene_least_cloudy_complete_under_limit() -> None:
    feats = [
        feature("cloudy", 80.0),
        feature("clear_but_missing_band", 1.0, BAND_ASSETS[:-1]),
        feature("best", 12.0),
        feature("ok", 20.0),
        feature("no_cloud_info", None),
    ]
    s = pick_scene(feats, max_cloud=30)
    assert s is not None and s.id == "best"
    assert s.epsg == 32645 and s.offset == -0.1 and s.scale == 0.0001
    assert list(s.assets) == list(BAND_ASSETS)
    assert pick_scene(feats[:1], max_cloud=30) is None


def test_reflectance_conversion_matches_l2a_offset() -> None:
    dn = np.array([[0, 1000, 2500, 30000]], dtype="uint16")
    out = to_reflectance_x10000(dn, 0.0001, -0.1)
    assert out.tolist() == [[NO_DATA, 0, 1500, 10000]]  # 0 = nodata, then clipped to 0..10000
    assert out.dtype == np.int16


def test_utm_window_is_512_px_of_10_m_around_point() -> None:
    pytest.importorskip("pyproj")
    left, bottom, right, top = utm_window(23.81, 90.41, 32645)
    assert right - left == TILE_PX * 10 and top - bottom == TILE_PX * 10
    assert left % 10 == 0 and bottom % 10 == 0


def test_water_overlay_is_transparent_except_water() -> None:
    rgba = water_overlay(np.array([[True, False]]))
    assert rgba[0, 0, 3] > 0 and rgba[0, 1].tolist() == [0, 0, 0, 0]


def test_finish_reprojects_and_writes_meta(tmp_path: Path) -> None:
    rasterio = pytest.importorskip("rasterio")
    from rasterio.transform import from_origin

    pred = tmp_path / "pred_S2.tiff"
    mask = np.zeros((64, 64), dtype="uint8")
    mask[:32, :] = 255  # northern half water
    with rasterio.open(
        pred,
        "w",
        driver="GTiff",
        width=64,
        height=64,
        count=1,
        dtype="uint8",
        crs="EPSG:32645",
        transform=from_origin(230000, 2636000, 10, 10),
    ) as dst:
        dst.write(mask, 1)
    scene = Scene("S2X", "2024-08-13T04:41:00Z", 12.0, 32645, {}, -0.1, 0.0001)
    meta = finish(pred, scene, 23.81, 90.41, tmp_path)
    assert (tmp_path / "overlay.png").exists()
    saved = json.loads((tmp_path / "meta.json").read_text())
    assert saved == meta
    w, s, e, n = meta["bounds"]
    # Easting 230000 in UTM zone 45N is about 84.35 E, 23.8 N.
    assert w < e and s < n and 84 < w < 85 and 23 < s < 24
    assert 0.4 < meta["water_fraction"] < 0.6
