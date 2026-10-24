import { describe, expect, it } from "vitest";
import type { ForecastScenario } from "@/lib/api";
import { describeForecast, forecastRequest, formatReturnPeriod } from "./describe";

function scenario(over: Partial<ForecastScenario>): ForecastScenario {
  return {
    day: 0,
    date: "2026-10-22",
    discharge: 100,
    discharge_low: 90,
    discharge_high: 110,
    return_period: 1.5,
    return_period_low: 1.4,
    return_period_high: 1.7,
    maps: null,
    beyond_largest_map: false,
    ...over,
  };
}

describe("formatReturnPeriod", () => {
  it.each([
    [1.0234, "1-in-1.02 year"],
    [3.25, "1-in-3.3 year"],
    [37.4, "1-in-37 year"],
    [1234, "1-in-1,234 year"],
    [10_000, "beyond 1-in-10,000 year"],
  ])("%s -> %s", (t, s) => expect(formatReturnPeriod(t)).toBe(s));
});

describe("forecastRequest", () => {
  it("maps each case to a worker request", () => {
    expect(forecastRequest(scenario({}))).toEqual({ kind: "banks" });
    expect(forecastRequest(scenario({ maps: { lower: 500, upper: 500, weight: 1 } }))).toEqual({ kind: "layer", rp: 500 });
    expect(forecastRequest(scenario({ maps: { lower: 20, upper: 50, weight: 0.3 } }))).toEqual({
      kind: "blend",
      lower: 20,
      upper: 50,
      weight: 0.3,
    });
  });
});

describe("describeForecast", () => {
  it("explains in-bank flows", () => {
    const text = describeForecast(scenario({}), "metric");
    expect(text).toContain("100 m³/s");
    expect(text).toContain("1-in-1.5 year");
    expect(text).toContain("stays in its banks");
    expect(text).toContain("1-in-1.4 year to 1-in-1.7 year");
  });

  it("explains blended and beyond-range floods", () => {
    expect(describeForecast(scenario({ return_period: 30, maps: { lower: 20, upper: 50, weight: 0.4 } }), "metric")).toContain(
      "Blending the 1-in-20 and 1-in-50",
    );
    expect(
      describeForecast(scenario({ return_period: 900, beyond_largest_map: true, maps: { lower: 500, upper: 500, weight: 1 } }), "metric"),
    ).toContain("could be bigger");
  });

  it("says when there is no flow or no curve", () => {
    expect(describeForecast(scenario({ discharge: null }), "metric")).toBe("No forecast flow for this day.");
    expect(describeForecast(scenario({ return_period: null }), "imperial")).toContain("No flood curve");
  });
});
