"""POST /api/explain: Claude explains, in plain English, what the data says about a place.

Claude gets tools over FloodScope's own data (the same functions behind /api/point,
/api/ground, /api/predict and the forecast scenarios) and may only use numbers those
tools return. After it answers, every number in the answer is checked against the tool
results; any that cannot be found are returned in `unverified_numbers` so the UI can
warn about them. With no tool data, there is no answer.
"""

import json
import re
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

import anthropic
import httpx
from anthropic.types.beta import BetaMessageParam, BetaToolParam, BetaToolResultBlockParam

from floodscope.cache import ResponseCache
from floodscope.config import Settings
from floodscope.ground import build_ground
from floodscope.models import ExplainRequest, ExplainResponse
from floodscope.point import build_point
from floodscope.predict import build_prediction
from floodscope.scene import build_scenarios, river_and_fit

MAX_TURNS = 6

SYSTEM_PROMPT = """You explain flood data for one place to a member of the public, in plain English.

You have tools that return FloodScope's data for the place: current river flow and its 30-day forecast, how deep modelled floods could get, live UK gauges, soil moisture and groundwater, and (if installed) an AI flow forecast. Call the tools you need before answering; usually that means get_point_data plus whichever others the question touches.

Rules:
- Use only numbers that appear in tool results. Never estimate, round into new figures, or bring in outside facts or numbers. If something the user asks about is not in the data, say it is not available and why (tool results include a reason).
- Name the source of each number in passing, e.g. "the GloFAS forecast (Copernicus, via Open-Meteo)" or "the JRC flood hazard map", with its date where the tool gives one.
- Explain what numbers mean for people on the ground: is the river high or normal, would a 1-in-100 year flood reach this spot, how deep (use the human scale: ankle, knee, waist, head height, one storey), is the ground wet enough to make floods worse.
- Mention important limits the tools state, such as hazard maps ignoring flood defences.
- This is exploration, not a warning service. End with one sentence pointing to the official agency (in England: the Environment Agency's Check for flooding service; elsewhere, the national weather or hydrology agency).
- Keep it short: at most about 200 words, in short paragraphs, no tables."""


def _tool(name: str, description: str) -> BetaToolParam:
    return {
        "name": name,
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": {
                "lat": {"type": "number", "description": "Latitude, WGS84 degrees"},
                "lon": {"type": "number", "description": "Longitude, WGS84 degrees"},
            },
            "required": ["lat", "lon"],
            "additionalProperties": False,
        },
        "strict": True,
    }


TOOLS: list[BetaToolParam] = [
    _tool(
        "get_point_data",
        "Ground elevation, today's river flow and 30-day GloFAS forecast summary, modelled "
        "flood depth for 1-in-10 to 1-in-500 year floods, and live Environment Agency gauges "
        "and warnings (England only). Each block has a status, a reason when there is no "
        "data, and its source.",
    ),
    _tool(
        "get_ground_data",
        "Soil moisture in four layers ranked against the same time of year since 2000, a "
        "plain summary, the 7-day trend, and the nearest groundwater level (England only).",
    ),
    _tool(
        "get_flood_scenarios",
        "For each GloFAS forecast day: the flow, its return period from a flood-frequency "
        "fit to annual peaks, and which flood map it corresponds to (or that the river stays "
        "in its banks).",
    ),
    _tool(
        "get_ai_forecast",
        "The FloodScope AI (LSTM) flow forecast for days 1-7 with an error band, its "
        "held-out skill, and the GloFAS forecast for the same days. Status no_data if no "
        "trained model is installed.",
    ),
]


def _point_summary(p: Any) -> dict[str, Any]:
    river = p.river.model_dump(mode="json")
    forecast = river.pop("forecast", [])
    peak = max(
        (d for d in forecast if d.get("discharge") is not None),
        key=lambda d: d["discharge"],
        default=None,
    )
    river["forecast_peak"] = peak
    river["forecast_days"] = len(forecast)
    return {
        "elevation": p.elevation.model_dump(mode="json"),
        "river": river,
        "hazard": p.hazard.model_dump(mode="json"),
        "uk_live": p.uk_live.model_dump(mode="json"),
    }


ToolFn = Callable[[float, float], Awaitable[dict[str, Any]]]


def make_tools(
    client: httpx.AsyncClient, cache: ResponseCache, settings: Settings
) -> dict[str, ToolFn]:
    async def point(lat: float, lon: float) -> dict[str, Any]:
        return _point_summary(await build_point(lat, lon, client, cache, settings))

    async def ground(lat: float, lon: float) -> dict[str, Any]:
        g = await build_ground(lat, lon, client, cache, settings)
        data = g.model_dump(mode="json")
        for layer in data["soil"].get("layers", []):
            layer.pop("forecast", None)  # the 7-day change is enough
        return data

    async def scenarios(lat: float, lon: float) -> dict[str, Any]:
        today = datetime.now(UTC).date()
        river, fit = await river_and_fit(lat, lon, client, cache, settings, today)
        return {
            "fit": fit.model_dump(mode="json"),
            "scenarios": [
                s.model_dump(mode="json") for s in build_scenarios(river.forecast, fit, today)
            ],
        }

    async def ai(lat: float, lon: float) -> dict[str, Any]:
        r = await build_prediction(lat, lon, client, cache, settings)
        return r.model_dump(mode="json", exclude={"sources"})

    return {
        "get_point_data": point,
        "get_ground_data": ground,
        "get_flood_scenarios": scenarios,
        "get_ai_forecast": ai,
    }


_NUMBER = re.compile(r"(?<![\w.])-?\d[\d,]*(?:\.\d+)?")


def _numbers(text: str) -> list[str]:
    return [m.group(0) for m in _NUMBER.finditer(text)]


def _as_float(token: str) -> float | None:
    try:
        return float(token.replace(",", ""))
    except ValueError:
        return None


def unverified_numbers(answer: str, tool_texts: list[str], ignore: set[str]) -> list[str]:
    """Numbers in the answer that no tool result supports.

    A number counts as supported if some tool value equals it when rounded to the same
    number of decimals (so 4.47 supports "4.5" and "4"), or it is one of `ignore` (the
    coordinates and return-period labels like 100 in "1-in-100").
    """
    pool: list[float] = []
    for t in tool_texts:
        pool.extend(v for v in (_as_float(n) for n in _numbers(t)) if v is not None)
    out: list[str] = []
    for token in _numbers(answer):
        if token.lstrip("-") in ignore:
            continue
        value = _as_float(token)
        if value is None:
            continue
        decimals = len(token.split(".")[1]) if "." in token else 0
        if not any(round(p, decimals) == round(value, decimals) for p in pool):
            out.append(token)
    return sorted(set(out), key=out.index)


def _reference_numbers(req: ExplainRequest) -> set[str]:
    rps = {"10", "20", "50", "75", "100", "200", "500", "1", "2", "3", "4", "5", "6", "7", "30"}
    coords = {f"{abs(req.lat):.{d}f}" for d in range(5)} | {
        f"{abs(req.lon):.{d}f}" for d in range(5)
    }
    return rps | coords


async def explain(
    req: ExplainRequest,
    client: httpx.AsyncClient,
    cache: ResponseCache,
    settings: Settings,
    claude: anthropic.AsyncAnthropic | None = None,
) -> ExplainResponse:
    base: dict[str, Any] = {"lat": req.lat, "lon": req.lon, "generated_at": datetime.now(UTC)}
    try:
        if claude is None:
            key = settings.anthropic_api_key
            claude = anthropic.AsyncAnthropic(api_key=key) if key else anthropic.AsyncAnthropic()
    except anthropic.AnthropicError as exc:
        return ExplainResponse(
            status="no_data",
            reason=f"The AI explainer is off: no Anthropic credentials ({exc}). Set "
            "ANTHROPIC_API_KEY in .env to turn it on.",
            **base,
        )

    tools = make_tools(client, cache, settings)
    question = req.question or "What does the flood data say about this place?"
    units = "metres" if req.units == "metric" else "feet (convert from the metre values given)"
    messages: list[BetaMessageParam] = [
        {
            "role": "user",
            "content": f"Place: latitude {req.lat:.5f}, longitude {req.lon:.5f}. "
            f"Give lengths in {units}.\n\nQuestion: {question}",
        }
    ]
    tool_texts: list[str] = []
    used: list[str] = []

    for _ in range(MAX_TURNS):
        try:
            response = await claude.beta.messages.create(
                model=settings.claude_model,
                max_tokens=16000,
                system=SYSTEM_PROMPT,
                tools=TOOLS,
                messages=messages,
                output_config={"effort": "medium"},
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            )
        except anthropic.AuthenticationError:
            return ExplainResponse(
                status="no_data",
                reason="The AI explainer is off: the Anthropic API key was rejected.",
                **base,
            )
        except anthropic.RateLimitError:
            return ExplainResponse(
                status="error", reason="The AI explainer is busy; try again in a minute.", **base
            )
        except anthropic.APIStatusError as exc:
            return ExplainResponse(
                status="error", reason=f"Claude API error {exc.status_code}: {exc.message}", **base
            )
        except anthropic.APIConnectionError:
            return ExplainResponse(status="error", reason="Could not reach the Claude API.", **base)
        except anthropic.AnthropicError as exc:
            return ExplainResponse(
                status="no_data",
                reason=f"The AI explainer is off ({exc}). Set ANTHROPIC_API_KEY in .env "
                "to turn it on.",
                **base,
            )
        except TypeError as exc:
            # anthropic 2.x raises a plain TypeError when no credentials are configured.
            if "authentication" not in str(exc):
                raise
            return ExplainResponse(
                status="no_data",
                reason="The AI explainer is off: no Anthropic credentials are configured. Set "
                "ANTHROPIC_API_KEY in .env to turn it on.",
                **base,
            )

        if response.stop_reason == "refusal":
            return ExplainResponse(
                status="error", reason="The model declined to answer this question.", **base
            )
        if response.stop_reason != "tool_use":
            answer = "\n\n".join(b.text for b in response.content if b.type == "text").strip()
            if not tool_texts:
                return ExplainResponse(
                    status="no_data",
                    reason="The model answered without looking at any data, so the answer was "
                    "discarded.",
                    model=response.model,
                    **base,
                )
            return ExplainResponse(
                status="ok",
                answer=answer,
                model=response.model,
                tools_used=used,
                unverified_numbers=unverified_numbers(answer, tool_texts, _reference_numbers(req)),
                **base,
            )

        messages.append({"role": "assistant", "content": response.content})
        results: list[BetaToolResultBlockParam] = []
        for block in response.content:
            if block.type != "tool_use":
                continue
            fn = tools.get(block.name)
            try:
                if fn is None:
                    raise KeyError(f"Unknown tool {block.name}")
                # Always answer about the requested place, whatever coordinates were passed.
                data = await fn(req.lat, req.lon)
                text = json.dumps(data, ensure_ascii=False)
                tool_texts.append(text)
                used.append(block.name)
                results.append({"type": "tool_result", "tool_use_id": block.id, "content": text})
            except Exception as exc:  # report tool failures to the model, never crash the loop
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": f"Error: {type(exc).__name__}: {exc}",
                        "is_error": True,
                    }
                )
        messages.append({"role": "user", "content": results})

    return ExplainResponse(
        status="error",
        reason=f"The explanation did not finish within {MAX_TURNS} steps.",
        tools_used=used,
        **base,
    )
