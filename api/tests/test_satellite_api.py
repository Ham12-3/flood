import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from floodscope import main
from floodscope.config import Settings
from floodscope.satellite import list_results, overlay_path


def make_result(
    root: Path, rid: str, bounds: list[float], dt: str = "2024-08-13T04:41:00Z"
) -> None:
    d = root / rid
    d.mkdir(parents=True)
    (d / "overlay.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    meta = {
        "scene_id": "S2A_X",
        "datetime": dt,
        "cloud_cover": 12.0,
        "bounds": bounds,
        "water_fraction": 0.31,
        "model": "prithvi",
        "note": "test",
    }
    (d / "meta.json").write_text(json.dumps(meta))


def test_lists_only_results_covering_the_point(tmp_path: Path) -> None:
    make_result(tmp_path, "a_old", [90.3, 23.7, 90.5, 23.9], "2023-01-01T00:00:00Z")
    make_result(tmp_path, "b_new", [90.3, 23.7, 90.5, 23.9], "2024-09-01T00:00:00Z")
    make_result(tmp_path, "c_far", [0.0, 0.0, 1.0, 1.0])
    (tmp_path / "broken").mkdir()
    (tmp_path / "broken" / "meta.json").write_text("{not json")
    r = list_results(tmp_path, 23.81, 90.41)
    assert r.status == "ok"
    assert [x.id for x in r.results] == ["b_new", "a_old"]  # newest first
    assert r.results[0].overlay_url == "/api/satellite/b_new/overlay.png"


def test_no_results_explains_how_to_make_one(tmp_path: Path) -> None:
    r = list_results(tmp_path / "missing", 0, 0)
    assert r.status == "no_data" and r.reason is not None and "satellite_prithvi" in r.reason


def test_overlay_path_rejects_traversal(tmp_path: Path) -> None:
    make_result(tmp_path, "ok_1", [0, 0, 1, 1])
    assert overlay_path(tmp_path, "ok_1") is not None
    assert overlay_path(tmp_path, "../secret") is None
    assert overlay_path(tmp_path, "missing") is None


def test_endpoints(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    make_result(tmp_path / "sat", "s1", [90.3, 23.7, 90.5, 23.9])
    settings = Settings(cache_dir=tmp_path / "cache", satellite_dir=tmp_path / "sat")
    monkeypatch.setattr(main, "get_settings", lambda: settings)
    with TestClient(main.app) as c:
        assert c.get("/api/satellite", params={"lat": 23.81, "lon": 90.41}).json()["status"] == "ok"
        png = c.get("/api/satellite/s1/overlay.png")
        assert png.status_code == 200 and png.headers["content-type"] == "image/png"
        assert c.get("/api/satellite/..%2Fx/overlay.png").status_code == 404
