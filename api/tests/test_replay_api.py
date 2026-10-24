import gzip
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from floodscope import main
from floodscope.config import Settings, get_settings
from floodscope.models import ReplayResponse
from floodscope.replay import jobs as jobs_module
from floodscope.replay.build import ReplayParams

Params = dict[str, str | float]
PARAMS: Params = {"lat": 6.45, "lon": 3.4, "start": "2026-06-28", "end": "2026-07-01", "size_km": 5}


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    settings = Settings(cache_dir=tmp_path / "cache")
    monkeypatch.setattr(main, "get_settings", lambda: settings)
    with TestClient(main.app) as c:
        yield c
    get_settings.cache_clear()


def poll(client: TestClient, params: Params, until: str, tries: int = 50) -> dict[str, Any]:
    body: dict[str, Any] = {}
    for _ in range(tries):
        body = client.get("/api/replay", params=params).json()
        if body["status"] == until:
            return body
        time.sleep(0.05)
    raise AssertionError(f"never reached {until}: {body}")


@pytest.mark.parametrize(
    ("override", "detail"),
    [
        ({"end": "2026-06-27"}, "before the start"),
        ({"end": "2026-07-10"}, "at most 7 days"),
    ],
)
def test_replay_rejects_bad_dates(client: TestClient, override: Params, detail: str) -> None:
    resp = client.get("/api/replay", params={**PARAMS, **override})
    assert resp.status_code == 422 and detail in resp.json()["detail"]


@pytest.mark.parametrize("override", [{"size_km": 50}, {"rain_scale": 10}, {"drain_mm_h": -1}])
def test_replay_rejects_out_of_range_settings(client: TestClient, override: Params) -> None:
    assert client.get("/api/replay", params={**PARAMS, **override}).status_code == 422


def test_replay_runs_in_the_background_then_serves_files(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[ReplayParams] = []

    async def fake_build(
        p: ReplayParams,
        rid: str,
        out: Path,
        _client: Any,
        _cache: Any,
        _settings: Any,
        _today: Any,
        progress: Any,
        *_: Any,
    ) -> ReplayResponse:
        calls.append(p)
        progress(0.5, "Simulating hour 2 of 4")
        (out / "depth.bin.gz").write_bytes(gzip.compress(b"\x01\x00\x02\x00"))
        (out / "features.bin.gz").write_bytes(gzip.compress(b"\x00" * 16))
        return ReplayResponse(
            status="ok", id=rid, request=p.echo(), depth_url=f"/api/replay/{rid}/depth.bin"
        )

    monkeypatch.setattr(jobs_module, "build_replay", fake_build)
    first = client.get("/api/replay", params=PARAMS).json()
    assert first["status"] == "running" and first["request"]["size_km"] == 5
    done = poll(client, PARAMS, "ok")
    assert done["id"] == first["id"] and len(calls) == 1
    # Served from disk now, without running again.
    assert client.get("/api/replay", params=PARAMS).json()["status"] == "ok"
    assert len(calls) == 1

    depth = client.get(f"/api/replay/{done['id']}/depth.bin")
    assert depth.status_code == 200
    assert depth.headers["content-encoding"] == "gzip"
    assert depth.content == b"\x01\x00\x02\x00"  # the client un-gzips it
    assert client.get(f"/api/replay/{done['id']}/nope.bin").status_code == 404
    assert client.get("/api/replay/../../etc/depth.bin").status_code == 404
    assert client.get("/api/replay/0123456789abcdef/depth.bin").status_code == 404


def test_failed_replay_is_reported_once_then_retried(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    attempts = []

    async def broken(*_: Any, **__: Any) -> ReplayResponse:
        attempts.append(1)
        raise RuntimeError("upstream timed out")

    monkeypatch.setattr(jobs_module, "build_replay", broken)
    client.get("/api/replay", params=PARAMS)
    failed = poll(client, PARAMS, "error")
    assert "upstream timed out" in failed["reason"]
    again = client.get("/api/replay", params=PARAMS).json()
    assert again["status"] == "running"
    poll(client, PARAMS, "error")
    assert len(attempts) == 2


def test_no_data_is_passed_through(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def all_sea(p: ReplayParams, rid: str, *_: Any, **__: Any) -> ReplayResponse:
        return ReplayResponse(
            status="no_data", id=rid, request=p.echo(), reason="This area is all sea or lagoon."
        )

    monkeypatch.setattr(jobs_module, "build_replay", all_sea)
    client.get("/api/replay", params=PARAMS)
    body = poll(client, PARAMS, "no_data")
    assert body["reason"] == "This area is all sea or lagoon."
