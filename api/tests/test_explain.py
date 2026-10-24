from pathlib import Path
from types import SimpleNamespace
from typing import Any

import anthropic
import httpx
import pytest

from floodscope import explain
from floodscope.cache import ResponseCache
from floodscope.config import Settings
from floodscope.models import ExplainRequest


def text(t: str) -> SimpleNamespace:
    return SimpleNamespace(type="text", text=t)


def tool_use(name: str, id_: str = "t1") -> SimpleNamespace:
    return SimpleNamespace(type="tool_use", name=name, id=id_, input={"lat": 51.5, "lon": -0.1})


def reply(stop: str, *blocks: SimpleNamespace) -> SimpleNamespace:
    return SimpleNamespace(stop_reason=stop, content=list(blocks), model="claude-sonnet-5-5")


class FakeClaude:
    """Stands in for AsyncAnthropic: returns scripted replies and records requests."""

    def __init__(self, replies: list[Any]) -> None:
        self.replies = replies
        self.requests: list[dict[str, Any]] = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    async def _create(self, **kwargs: Any) -> Any:
        self.requests.append(kwargs)
        r = self.replies.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


@pytest.fixture
def fake_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    async def point(lat: float, lon: float) -> dict[str, Any]:
        return {"river": {"today": {"discharge": 36.5}}, "hazard": {"depths": [{"depth_m": 4.47}]}}

    async def broken(lat: float, lon: float) -> dict[str, Any]:
        raise RuntimeError("upstream down")

    monkeypatch.setattr(
        explain,
        "make_tools",
        lambda *_: {"get_point_data": point, "get_ground_data": broken},
    )


async def run(claude: FakeClaude, tmp_path: Path, cache: ResponseCache) -> Any:
    settings = Settings(cache_dir=tmp_path / "c")
    async with httpx.AsyncClient() as client:
        return await explain.explain(
            ExplainRequest(lat=51.5, lon=-0.1, question="Is it flooding?"),
            client,
            cache,
            settings,
            claude=claude,  # type: ignore[arg-type]
        )


async def test_tool_loop_and_number_check(
    fake_tools: None, tmp_path: Path, cache: ResponseCache
) -> None:
    claude = FakeClaude(
        [
            reply("tool_use", tool_use("get_point_data", "a"), tool_use("get_ground_data", "b")),
            reply(
                "end_turn",
                text(
                    "The river carries 36.5 m³/s today. A 1-in-100 flood would be 4.5 m deep, "
                    "about 15 m wide."
                ),
            ),
        ]
    )
    r = await run(claude, tmp_path, cache)
    assert r.status == "ok"
    assert r.tools_used == ["get_point_data"]  # the failing tool is not counted
    assert r.unverified_numbers == ["15"]  # 36.5 and 4.5 (from 4.47) are supported
    req = claude.requests[0]
    assert req["model"] == "claude-sonnet-5-5"
    assert req["fallbacks"] == "default"
    assert req["betas"] == ["server-side-fallback-2026-07-01"]
    assert "tool_choice" not in req  # forced tool use is rejected on this model
    # Both tool results went back in one user message; the failure is flagged.
    results = claude.requests[1]["messages"][-1]["content"]
    assert [x["tool_use_id"] for x in results] == ["a", "b"]
    assert results[1]["is_error"] is True and "upstream down" in results[1]["content"]


async def test_answer_without_data_is_discarded(
    fake_tools: None, tmp_path: Path, cache: ResponseCache
) -> None:
    r = await run(FakeClaude([reply("end_turn", text("It is fine."))]), tmp_path, cache)
    assert r.status == "no_data" and r.answer is None


async def test_refusal_is_reported(fake_tools: None, tmp_path: Path, cache: ResponseCache) -> None:
    r = await run(FakeClaude([reply("refusal")]), tmp_path, cache)
    assert r.status == "error" and r.reason is not None and "declined" in r.reason


async def test_missing_credentials_turn_feature_off(
    fake_tools: None, tmp_path: Path, cache: ResponseCache
) -> None:
    err = anthropic.AnthropicError("Could not resolve authentication method")
    r = await run(FakeClaude([err]), tmp_path, cache)
    assert r.status == "no_data" and r.reason is not None and "ANTHROPIC_API_KEY" in r.reason


async def test_sdk_type_error_for_missing_credentials(
    fake_tools: None, tmp_path: Path, cache: ResponseCache
) -> None:
    # What anthropic 2.3 actually raises when no API key or profile is set (seen live).
    err = TypeError('"Could not resolve authentication method. Expected one of api_key, ..."')
    r = await run(FakeClaude([err]), tmp_path, cache)
    assert r.status == "no_data" and r.reason is not None and "ANTHROPIC_API_KEY" in r.reason


async def test_other_type_errors_are_not_swallowed(
    fake_tools: None, tmp_path: Path, cache: ResponseCache
) -> None:
    with pytest.raises(TypeError, match="something else"):
        await run(FakeClaude([TypeError("something else")]), tmp_path, cache)


async def test_step_limit(fake_tools: None, tmp_path: Path, cache: ResponseCache) -> None:
    loop = [reply("tool_use", tool_use("get_point_data")) for _ in range(explain.MAX_TURNS)]
    r = await run(FakeClaude(loop), tmp_path, cache)
    assert r.status == "error" and r.reason is not None and "steps" in r.reason


@pytest.mark.parametrize(
    ("answer", "expected"),
    [
        ("Flow is 1,234 m³/s.", []),
        ("Flow is 1234.0 m³/s.", []),
        ("Depth 4.47 m, or about 4 m.", []),
        ("Depth 4.6 m.", ["4.6"]),
        ("Elevation 12 m and 99 m.", ["99"]),
        ("1-in-100 year flood at 51.5, -0.1.", []),
    ],
)
def test_unverified_numbers(answer: str, expected: list[str]) -> None:
    tool_texts = ['{"discharge": 1234.0, "depth_m": 4.47, "elevation_m": 12.1}']
    ignore = explain._reference_numbers(ExplainRequest(lat=51.5, lon=-0.1))
    assert explain.unverified_numbers(answer, tool_texts, ignore) == expected


def test_tools_are_strict_and_lat_lon_only() -> None:
    for t in explain.TOOLS:
        assert t.get("strict") is True
        schema: dict[str, Any] = dict(t["input_schema"])
        assert schema["additionalProperties"] is False
        assert schema["required"] == ["lat", "lon"]
