import { describe, expect, it } from "vitest";
import {
  dischargeUnit,
  dischargeValue,
  formatDischarge,
  formatGaugeValue,
  formatLength,
  lengthValue,
} from "./units";

describe("lengths", () => {
  it("formats metres and feet", () => {
    expect(formatLength(1.5, "metric")).toBe("1.5 m");
    expect(formatLength(1, "imperial")).toBe("3.3 ft");
    expect(formatLength(0.456, "metric", 2)).toBe("0.46 m");
  });

  it("converts one metre to 3.28 feet", () => {
    expect(lengthValue(1, "imperial")).toBeCloseTo(3.2808, 4);
    expect(lengthValue(1, "metric")).toBe(1);
  });

  it("keeps thousands separators", () => {
    expect(formatLength(1234.5, "metric")).toBe("1,234.5 m");
  });
});

describe("discharge", () => {
  it("uses fewer decimals for bigger rivers", () => {
    expect(formatDischarge(12049.36, "metric")).toBe("12,049 m³/s");
    expect(formatDischarge(36.5, "metric")).toBe("36.5 m³/s");
    expect(formatDischarge(1.6, "metric")).toBe("1.60 m³/s");
  });

  it("converts to cubic feet per second", () => {
    expect(dischargeValue(1, "imperial")).toBeCloseTo(35.3147, 3);
    expect(dischargeUnit("imperial")).toBe("ft³/s");
    expect(formatDischarge(100, "imperial")).toBe("3,531 ft³/s");
  });
});

describe("EA gauge values", () => {
  it("keeps the datum when converting levels to feet", () => {
    expect(formatGaugeValue(-1.0, "mAOD", "metric")).toBe("-1.00 mAOD");
    expect(formatGaugeValue(1.0, "mAOD", "imperial")).toBe("3.28 ft AOD");
    expect(formatGaugeValue(1.0, "m", "imperial")).toBe("3.28 ft");
  });

  it("converts flow and leaves other units alone", () => {
    expect(formatGaugeValue(2, "m3/s", "metric")).toBe("2.0 m³/s");
    expect(formatGaugeValue(2, "m3/s", "imperial")).toBe("70.6 ft³/s");
    expect(formatGaugeValue(0, "mm", "imperial")).toBe("0.00 mm");
    expect(formatGaugeValue(5, null, "metric")).toBe("5.00");
  });
});
