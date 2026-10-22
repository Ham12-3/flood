import { describe, expect, it } from "vitest";
import type { DischargeDay } from "./api";
import { dischargeDomain, forecastPeak, niceCeil, riseFactor } from "./discharge";
import { dischargeValue } from "./units";

function day(date: string, discharge: number | null, extra: Partial<DischargeDay> = {}): DischargeDay {
  return {
    date,
    discharge,
    ensemble_mean: null,
    ensemble_median: null,
    ensemble_min: null,
    ensemble_max: null,
    ensemble_p25: null,
    ensemble_p75: null,
    ...extra,
  };
}

describe("forecastPeak", () => {
  it("finds the highest day and skips gaps", () => {
    const days = [day("2026-10-21", 36.5), day("2026-10-22", null), day("2026-10-25", 186.9), day("2026-10-26", 167)];
    expect(forecastPeak(days)).toEqual({ date: "2026-10-25", discharge: 186.9 });
  });

  it("returns null when nothing is forecast", () => {
    expect(forecastPeak([day("2026-10-21", null)])).toBeNull();
    expect(forecastPeak([])).toBeNull();
  });
});

describe("riseFactor", () => {
  it("compares the peak with today", () => {
    expect(riseFactor(36.5, { date: "x", discharge: 186.93 })).toBeCloseTo(5.12, 2);
  });

  it("is null without a positive flow today", () => {
    expect(riseFactor(0, { date: "x", discharge: 5 })).toBeNull();
    expect(riseFactor(null, { date: "x", discharge: 5 })).toBeNull();
    expect(riseFactor(3, null)).toBeNull();
  });
});

describe("niceCeil", () => {
  it.each([
    [0, 1],
    [0.7, 0.8],
    [1, 1],
    [187, 200],
    [291, 300],
    [29240, 30000],
    [12049, 15000],
  ])("%d -> %d", (input, expected) => {
    expect(niceCeil(input)).toBeCloseTo(expected, 9);
  });
});

describe("dischargeDomain", () => {
  it("covers the ensemble maximum, not just the main line", () => {
    const days = [day("a", 100, { ensemble_max: 290 }), day("b", 120, { ensemble_mean: 130 })];
    expect(dischargeDomain(days)).toEqual({ min: 0, max: 300 });
  });

  it("rounds in display units", () => {
    const days = [day("a", 100)];
    // 100 m3/s = 3531 ft3/s -> 4000
    expect(dischargeDomain(days, (v) => dischargeValue(v, "imperial")).max).toBe(4000);
  });

  it("falls back to 1 for an all-zero series", () => {
    expect(dischargeDomain([day("a", 0)]).max).toBe(1);
  });
});
