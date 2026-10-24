/** Depth colour stops in metres; one blue hue, light to dark (colour-blind safe). */
export const DEPTH_STOPS: { depth: number; color: string }[] = [
  { depth: 0, color: "#9ec5f4" },
  { depth: 0.5, color: "#6da7ec" },
  { depth: 1, color: "#3987e5" },
  { depth: 2, color: "#256abf" },
  { depth: 3, color: "#184f95" },
  { depth: 5, color: "#0d366b" },
];

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

const STOPS_RGB = DEPTH_STOPS.map((s) => ({ depth: s.depth, rgb: rgb(s.color) }));

/** The ramp colour for a depth in metres, linearly mixed between stops. */
export function depthRgb(depthM: number): [number, number, number] {
  if (depthM <= STOPS_RGB[0].depth) return STOPS_RGB[0].rgb;
  for (let i = 1; i < STOPS_RGB.length; i++) {
    const a = STOPS_RGB[i - 1];
    const b = STOPS_RGB[i];
    if (depthM <= b.depth) {
      const t = (depthM - a.depth) / (b.depth - a.depth);
      return [0, 1, 2].map((k) => Math.round(a.rgb[k] + (b.rgb[k] - a.rgb[k]) * t)) as [number, number, number];
    }
  }
  return STOPS_RGB[STOPS_RGB.length - 1].rgb;
}
