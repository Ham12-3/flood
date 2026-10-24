import type { ForecastScenario } from "@/lib/api";
import { formatDischarge, type UnitSystem } from "@/lib/units";
import type { DepthRequest } from "./messages";

/** "1-in-37 year", "1-in-1.1 year", "beyond 1-in-10,000 year". */
export function formatReturnPeriod(t: number): string {
  if (t >= 10_000) return "beyond 1-in-10,000 year";
  const digits = t < 2 ? 2 : t < 10 ? 1 : 0;
  const value = t.toLocaleString("en-GB", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  return `1-in-${value} year`;
}

export function forecastRequest(s: ForecastScenario): DepthRequest {
  if (!s.maps) return { kind: "banks" };
  if (s.maps.lower === s.maps.upper) return { kind: "layer", rp: s.maps.lower };
  return { kind: "blend", lower: s.maps.lower, upper: s.maps.upper, weight: s.maps.weight };
}

/** Plain-English summary of what a forecast day means and which maps are shown. */
export function describeForecast(s: ForecastScenario, units: UnitSystem): string {
  if (s.discharge === null || s.discharge === undefined) return "No forecast flow for this day.";
  const flow = `${formatDischarge(s.discharge, units)} (ensemble mean)`;
  if (s.return_period === null || s.return_period === undefined) {
    return `Forecast flow ${flow}. No flood curve for this river, so it cannot be turned into a flood map.`;
  }
  const range =
    typeof s.return_period_low === "number" &&
    typeof s.return_period_high === "number" &&
    s.return_period_high - s.return_period_low >= 0.05
      ? ` (middle 50% of the ensemble: ${formatReturnPeriod(s.return_period_low)} to ${formatReturnPeriod(s.return_period_high)})`
      : "";
  const size = `about a ${formatReturnPeriod(s.return_period)} flow${range}`;
  if (!s.maps) {
    return `Forecast flow ${flow} is ${size}. That is below the smallest flood map (1-in-10 year), so the river stays in its banks: showing permanent water only.`;
  }
  if (s.beyond_largest_map) {
    return `Forecast flow ${flow} is ${size}, beyond the largest map. Showing the 1-in-500 year map; the real flood could be bigger.`;
  }
  if (s.maps.lower === s.maps.upper) {
    return `Forecast flow ${flow} is ${size}. Showing the 1-in-${s.maps.lower} year map.`;
  }
  return `Forecast flow ${flow} is ${size}. Blending the 1-in-${s.maps.lower} and 1-in-${s.maps.upper} year maps.`;
}
