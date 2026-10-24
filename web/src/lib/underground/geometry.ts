/** Colours and helpers for the underground cut-away diagram. Pure, so they are unit tested. */

/** Dry -> saturated colours: the same single blue hue as the water, light to dark. */
const WET_RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
const NO_DATA = "#8f8e86";

export function wetnessColor(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return NO_DATA;
  const t = Math.min(Math.max(pct, 0), 100) / 100;
  return WET_RAMP[Math.round(t * (WET_RAMP.length - 1))];
}

/** Where to draw the water table: its true depth below the surface, or null. */
export function groundwaterOffsetM(depthBelowDatumM: number | null | undefined): number | null {
  if (depthBelowDatumM === null || depthBelowDatumM === undefined || !Number.isFinite(depthBelowDatumM)) return null;
  return -Math.max(depthBelowDatumM, 0);
}

/** "wetter than 62% of past days", with the extremes said plainly. */
export function rankText(percentile: number | null | undefined): string | null {
  if (percentile === null || percentile === undefined || !Number.isFinite(percentile)) return null;
  if (percentile < 0.5) return "drier than any past day at this time of year";
  if (percentile > 99.5) return "wetter than any past day at this time of year";
  return `wetter than ${Math.round(percentile)}% of past days`;
}
