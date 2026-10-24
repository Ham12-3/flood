"""Google Flood Forecasting client. Payloads follow the documented v1 schema
(developers.google.com/flood-forecasting/rest, read 2026-10-24); they are not recorded
responses, because the API needs a waitlist key we do not have."""

import httpx
import respx

from floodscope.sources.google_flood import BASE, get_google_flood, loop_around, parse_gauges

GAUGES = [
    {
        "gaugeId": "hybas_far",
        "location": {"latitude": 23.9, "longitude": 90.6},
        "siteName": "Far",
        "qualityVerified": True,
        "hasModel": True,
    },
    {
        "gaugeId": "hybas_near",
        "location": {"latitude": 23.82, "longitude": 90.42},
        "siteName": "Near",
        "river": "Turag",
        "source": "HYBAS",
        "qualityVerified": True,
        "hasModel": True,
    },
]
STATUSES = [
    {
        "gaugeId": "hybas_near",
        "severity": "ABOVE_NORMAL",
        "forecastTrend": "RISE",
        "issuedTime": "2026-10-24T06:00:00Z",
    }
]
FORECASTS = {
    "hybas_near": {
        "forecasts": [
            {"gaugeId": "hybas_near", "issuedTime": "2026-10-23T06:00:00Z", "forecastRanges": []},
            {
                "gaugeId": "hybas_near",
                "issuedTime": "2026-10-24T06:00:00Z",
                "forecastRanges": [
                    {
                        "value": 812.5,
                        "forecastStartTime": "2026-10-25T00:00:00Z",
                        "forecastEndTime": "2026-10-25T00:00:00Z",
                    }
                ],
            },
        ]
    }
}


def test_loop_is_counter_clockwise_box() -> None:
    v = loop_around(10.0, 20.0, 0.5)["vertices"]
    assert [(p["latitude"], p["longitude"]) for p in v] == [
        (9.5, 19.5),
        (9.5, 20.5),
        (10.5, 20.5),
        (10.5, 19.5),
    ]


def test_parse_merges_status_and_latest_forecast() -> None:
    out = parse_gauges(GAUGES, STATUSES, FORECASTS, 23.81, 90.41)
    assert [g.gauge_id for g in out] == ["hybas_near", "hybas_far"]
    near = out[0]
    assert near.severity == "ABOVE_NORMAL" and near.trend == "RISE"
    assert near.forecast_issued_time is not None and near.forecast_issued_time.day == 24
    assert [f.value for f in near.forecast] == [812.5]
    assert out[1].severity is None and out[1].forecast == []


async def test_off_without_key() -> None:
    async with httpx.AsyncClient() as client:
        r = await get_google_flood(client, None, 23.81, 90.41)
    assert (
        r.status == "no_data"
        and r.reason is not None
        and "FLOODSCOPE_GOOGLE_FLOOD_API_KEY" in r.reason
    )


@respx.mock
async def test_full_flow_sends_key_header_and_repeated_ids() -> None:
    search = respx.post(f"{BASE}/gauges:searchGaugesByArea").mock(
        return_value=httpx.Response(200, json={"gauges": GAUGES})
    )
    status = respx.get(f"{BASE}/floodStatus:queryLatestFloodStatusByGaugeIds").mock(
        return_value=httpx.Response(200, json={"floodStatuses": STATUSES})
    )
    respx.get(f"{BASE}/gauges:queryGaugeForecasts").mock(
        return_value=httpx.Response(200, json={"forecasts": FORECASTS})
    )
    async with httpx.AsyncClient() as client:
        r = await get_google_flood(client, "test-key", 23.81, 90.41)
    assert r.status == "ok" and len(r.gauges) == 2
    assert search.calls[0].request.headers["X-Goog-Api-Key"] == "test-key"
    assert status.calls[0].request.url.params.get_list("gaugeIds") == ["hybas_near", "hybas_far"]


@respx.mock
async def test_no_gauges_and_errors() -> None:
    respx.post(f"{BASE}/gauges:searchGaugesByArea").mock(return_value=httpx.Response(200, json={}))
    async with httpx.AsyncClient() as client:
        assert (await get_google_flood(client, "k", 0, 0)).status == "no_data"
    respx.post(f"{BASE}/gauges:searchGaugesByArea").mock(return_value=httpx.Response(403))
    async with httpx.AsyncClient() as client:
        r = await get_google_flood(client, "k", 0, 0)
    assert r.status == "error" and r.reason is not None and "HTTPStatusError" in r.reason
