/**
 * Pure geometry and colours for the underground cut-away, kept free of Cesium so it
 * can be unit tested. Real soil layers are 7 cm to 1.5 m thick, invisible from any
 * useful camera distance, so the soil block is drawn exaggerated (and labelled so).
 * The water table is drawn at its true depth, with its own label.
 */

export const VERTICAL_EXAGGERATION = 20;
export const BLOCK_WIDTH_M = 60;

/** Dry -> saturated colours: the same single blue hue as the water, light to dark. */
const WET_RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
const NO_DATA = "#8f8e86";

export function wetnessColor(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return NO_DATA;
  const t = Math.min(Math.max(pct, 0), 100) / 100;
  return WET_RAMP[Math.round(t * (WET_RAMP.length - 1))];
}

export interface LayerBox {
  topCm: number;
  bottomCm: number;
  /** Height of the box centre relative to the ground surface, metres (negative = below). */
  centreOffsetM: number;
  /** Drawn height of the box in metres (exaggerated). */
  drawnHeightM: number;
}

export function layerBoxes(layers: { top_cm: number; bottom_cm: number }[], exaggeration = VERTICAL_EXAGGERATION): LayerBox[] {
  return layers.map((l) => {
    const top = (l.top_cm / 100) * exaggeration;
    const bottom = (l.bottom_cm / 100) * exaggeration;
    return {
      topCm: l.top_cm,
      bottomCm: l.bottom_cm,
      centreOffsetM: -(top + bottom) / 2,
      drawnHeightM: bottom - top,
    };
  });
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
