import type { DischargeDay } from "./api";

export interface Peak {
  date: string;
  discharge: number;
}

/** Highest forecast discharge over the series, or null if there are no values. */
export function forecastPeak(days: DischargeDay[]): Peak | null {
  let best: Peak | null = null;
  for (const d of days) {
    if (d.discharge === null || d.discharge === undefined) continue;
    if (best === null || d.discharge > best.discharge) {
      best = { date: d.date, discharge: d.discharge };
    }
  }
  return best;
}

/** Ratio of the forecast peak to today's flow, e.g. 5.1 means "five times today". */
export function riseFactor(today: number | null | undefined, peak: Peak | null): number | null {
  if (today === null || today === undefined || today <= 0 || peak === null) return null;
  return peak.discharge / today;
}

export interface ChartDomain {
  min: number;
  max: number;
}

/**
 * y-domain covering the lines and the ensemble band, always starting at zero.
 * `toDisplay` converts m3/s to the units on screen so ticks land on round numbers there.
 */
export function dischargeDomain(days: DischargeDay[], toDisplay: (m3s: number) => number = (v) => v): ChartDomain {
  let max = 0;
  for (const d of days) {
    for (const v of [d.discharge, d.ensemble_mean, d.ensemble_max, d.ensemble_p75]) {
      if (typeof v === "number" && v > max) max = v;
    }
  }
  return { min: 0, max: max > 0 ? niceCeil(toDisplay(max)) : 1 };
}

/** Round up to a "nice" number (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 x 10^n) for axis ticks. */
export function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (value <= step * base) return step * base;
  }
  return 10 * base;
}
