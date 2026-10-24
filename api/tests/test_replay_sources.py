import io
import zipfile
from datetime import date
from typing import Any

import httpx
import numpy as np
import pytest
import respx

from floodscope.cache import ResponseCache
from floodscope.sources import fabdem, overture, storm

FAB = "https://fabdem.example"
STAC = "https://stac.example"


# --- FABDEM --------------------------------------------------------------------


@pytest.mark.parametrize(
    ("lat", "lon", "block", "tile"),
    [
        (6.45, 3.4, "N00E000-N10E010_FABDEM_V1-2.zip", "N06E003_FABDEM_V1-2.tif"),
        (-1.3, 36.8, "S10E030-N00E040_FABDEM_V1-2.zip", "S02E036_FABDEM_V1-2.tif"),
        (53.96, -1.08, "N50W010-N60E000_FABDEM_V1-2.zip", "N53W002_FABDEM_V1-2.tif"),
        (5.0, 175.5, "N00E170-N10W180_FABDEM_V1-2.zip", "N05E175_FABDEM_V1-2.tif"),
        (-33.9, -70.6, "S40W080-S30W070_FABDEM_V1-2.zip", "S34W071_FABDEM_V1-2.tif"),
    ],
)
def test_fabdem_names(lat: float, lon: float, block: str, tile: str) -> None:
    assert fabdem.block_name(lat, lon) == block
    assert fabdem.tile_name(lat, lon) == tile


def test_parse_block_list_reads_zip_links() -> None:
    html = (
        '<a href="N00E000-N10E010_FABDEM_V1-2.zip">x</a> <a href="license.txt">l</a>'
        '<a href="N00E000-N10E010_FABDEM_V1-2.zip">dup</a>'
        '<a href="S10E030-N00E040_FABDEM_V1-2.zip">'
    )
    assert fabdem.parse_block_list(html) == [
        "N00E000-N10E010_FABDEM_V1-2.zip",
        "S10E030-N00E040_FABDEM_V1-2.zip",
    ]


def _zip_bytes(names: list[str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        for n in names:
            zf.writestr(n, b"x" * 5000)
    return buf.getvalue()


def _range_server(data: bytes) -> Any:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "HEAD":
            return httpx.Response(200, headers={"content-length": str(len(data))})
        start, end = request.headers["range"].removeprefix("bytes=").split("-")
        return httpx.Response(206, content=data[int(start) : int(end) + 1])

    return handler


@respx.mock
def test_zip_members_reads_the_central_directory_by_range() -> None:
    names = ["N06E003_FABDEM_V1-2.tif", "N06E004_FABDEM_V1-2.tif"]
    route = respx.route(url=f"{FAB}/block.zip").mock(side_effect=_range_server(_zip_bytes(names)))
    assert fabdem.zip_members(f"{FAB}/block.zip") == names
    # Only the end of the file was read, not the tiles.
    assert route.call_count <= 4


@respx.mock
async def test_available_blocks_is_cached(cache: ResponseCache) -> None:
    route = respx.get(f"{FAB}/").respond(200, text='<a href="N00E000-N10E010_FABDEM_V1-2.zip">')
    async with httpx.AsyncClient() as client:
        first = await fabdem.available_blocks(client, FAB, cache, 60)
        second = await fabdem.available_blocks(client, FAB, cache, 60)
    assert first == second == ["N00E000-N10E010_FABDEM_V1-2.zip"]
    assert route.call_count == 1


@respx.mock
async def test_available_blocks_refuses_an_empty_page(cache: ResponseCache) -> None:
    respx.get(f"{FAB}/").respond(200, text="<html>moved</html>")
    async with httpx.AsyncClient() as client:
        with pytest.raises(RuntimeError, match="lists no blocks"):
            await fabdem.available_blocks(client, FAB, cache, 60)


def test_window_without_tiles_is_all_sea() -> None:
    w = fabdem.read_fabdem_window(FAB, [], (0.0, 0.0, 0.01, 0.005), (0.001, 0.001))
    assert w.data.shape == (5, 10) and np.isnan(w.data).all()


# --- Overture --------------------------------------------------------------------


def test_pair_files_matches_sorted_keys_to_boxes() -> None:
    files = overture.pair_files(
        ["b/part-1.parquet", "b/part-0.parquet"], [[0, 0, 1, 1], [2, 2, 3, 3]]
    )
    assert [f.key for f in files] == ["b/part-0.parquet", "b/part-1.parquet"]
    assert files[1].bbox == (2, 2, 3, 3)
    with pytest.raises(RuntimeError, match="cannot match"):
        overture.pair_files(["a"], [])


def test_files_touching_filters_by_box() -> None:
    files = overture.pair_files(["a", "b"], [[0, 0, 1, 1], [5, 5, 6, 6]])
    assert [f.key for f in overture.files_touching(files, (0.5, 0.5, 2, 2))] == ["a"]
    assert overture.files_touching(files, (10, 10, 11, 11)) == []


@respx.mock
async def test_latest_release_and_file_index(cache: ResponseCache) -> None:
    respx.get(f"{STAC}/catalog.json").respond(200, json={"latest": "2026-10-21.0"})
    respx.get(f"{STAC}/2026-10-21.0/buildings/building/collection.json").respond(
        200,
        json={"extent": {"spatial": {"bbox": [[-180, -90, 180, 90], [0, 0, 1, 1], [1, 1, 2, 2]]}}},
    )
    prefix = "release/2026-10-21.0/theme=buildings/type=building/"
    page1 = (
        f"<Key>{prefix}part-00000.parquet</Key><NextContinuationToken>T1</NextContinuationToken>"
    )
    page2 = f"<Key>{prefix}part-00001.parquet</Key><Key>{prefix}_SUCCESS</Key>"
    listing = respx.get("https://bucket.s3.amazonaws.com/").mock(
        side_effect=lambda r: httpx.Response(
            200, text=page2 if "continuation-token" in str(r.url) else page1
        )
    )
    async with httpx.AsyncClient() as client:
        release = await overture.latest_release(client, STAC, cache, 60)
        files = await overture.file_index(
            client, STAC, "bucket", release, "buildings", "building", cache, 60
        )
        again = await overture.file_index(
            client, STAC, "bucket", release, "buildings", "building", cache, 60
        )
    assert release == "2026-10-21.0"
    assert [f.key.rsplit("/", 1)[1] for f in files] == ["part-00000.parquet", "part-00001.parquet"]
    assert files[1].bbox == (1, 1, 2, 2)
    assert again == files and listing.call_count == 2


# --- Open-Meteo rain and sea level -------------------------------------------------

TODAY = date(2026, 10, 24)
URLS = {
    "forecast": "https://f.example",
    "historical": "https://h.example",
    "archive": "https://a.example",
}


@pytest.mark.parametrize(
    ("start", "end", "api"),
    [
        (date(2026, 6, 28), date(2026, 7, 1), "historical"),
        (date(2019, 3, 1), date(2019, 3, 3), "archive"),
        (date(2026, 10, 20), date(2026, 10, 27), "forecast"),
        (date(2026, 10, 1), date(2026, 10, 23), "forecast"),
    ],
)
def test_choose_rain_api(start: date, end: date, api: str) -> None:
    assert storm.choose_rain_api(start, end, TODAY) == api


def test_choose_rain_api_rejects_far_future_and_long_mixed_ranges() -> None:
    with pytest.raises(storm.StormDataError, match="15 days ahead"):
        storm.choose_rain_api(date(2026, 11, 20), date(2026, 11, 21), TODAY)
    with pytest.raises(storm.StormDataError, match="recent past"):
        storm.choose_rain_api(date(2026, 8, 1), date(2026, 10, 24), TODAY)


def _rain_payload(
    n_points: int, hours: int, fill: float | None, tz: str = "Africa/Lagos"
) -> list[dict[str, Any]]:
    times = [f"2026-06-28T{h % 24:02d}:00" for h in range(hours)]
    return [
        {
            "timezone": tz,
            "utc_offset_seconds": 3600,
            "hourly": {
                "time": times,
                "precipitation": [fill if fill is None else fill + i for _ in times],
            },
        }
        for i in range(n_points)
    ]


def test_parse_rain_orders_points_north_first_then_west_to_east() -> None:
    times, values, tz, offset = storm.parse_rain(_rain_payload(6, 3, 0.0), 2, 3)
    assert len(times) == 3 and tz == "Africa/Lagos" and offset == 3600
    assert values.shape == (3, 2, 3)
    assert values[0].tolist() == [[0, 1, 2], [3, 4, 5]]


@respx.mock
async def test_get_rain_falls_back_to_era5_when_archived_forecasts_have_gaps() -> None:
    hours = 2 * 24 + 1
    respx.get(URLS["historical"]).respond(200, json=_rain_payload(4, 2 * 24 + 24, None))
    respx.get(URLS["archive"]).respond(200, json=_rain_payload(4, 2 * 24 + 24, 1.5))
    async with httpx.AsyncClient() as client:
        rain = await storm.get_rain(
            client, URLS, [1.0, 0.0], [0.0, 1.0], date(2026, 6, 28), date(2026, 6, 29), TODAY
        )
    assert rain.values.shape == (hours, 2, 2)
    assert "ERA5" in rain.source.name
    params = respx.calls.last.request.url.params
    assert params["end_date"] == "2026-06-30" and params["timezone"] == "auto"
    assert params["latitude"] == "1.0000,1.0000,0.0000,0.0000"


@respx.mock
async def test_get_rain_reports_why_there_is_none() -> None:
    respx.get(URLS["archive"]).respond(
        400, json={"error": True, "reason": "Parameter 'start_date' is out of range"}
    )
    async with httpx.AsyncClient() as client:
        with pytest.raises(storm.StormDataError, match="out of range"):
            await storm.get_rain(
                client, URLS, [0.0], [0.0], date(1930, 1, 1), date(1930, 1, 1), TODAY
            )


@respx.mock
async def test_sea_level_takes_the_first_point_with_values() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        lat = float(request.url.params["latitude"])
        vals = [None] * 49 if lat > 6.4 else [0.1 * i for i in range(49)]
        return httpx.Response(200, json={"hourly": {"time": [], "sea_level_height_msl": vals}})

    respx.get("https://m.example").mock(side_effect=handler)
    async with httpx.AsyncClient() as client:
        got = await storm.get_sea_level(
            client,
            "https://m.example",
            [(6.5, 3.4), (6.3, 3.4)],
            date(2026, 6, 28),
            date(2026, 6, 29),
        )
        none = await storm.get_sea_level(
            client, "https://m.example", [(6.5, 3.4)], date(2026, 6, 28), date(2026, 6, 29)
        )
    assert got is not None and got.lat == 6.3 and got.values.shape == (49,)
    assert none is None
