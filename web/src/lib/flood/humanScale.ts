/** Rough body and building heights, in metres, for the hover readout. */
const SCALE: { upTo: number; label: string }[] = [
  { upTo: 0.15, label: "Ankle deep" },
  { upTo: 0.5, label: "Knee deep" },
  { upTo: 1.1, label: "Waist deep" },
  { upTo: 1.8, label: "Up to head height" },
  { upTo: 3.0, label: "Over head height, up to one storey" },
  { upTo: 6.0, label: "Up to two storeys" },
];

export function humanScale(depthM: number): string {
  if (!(depthM > 0)) return "Dry";
  for (const s of SCALE) if (depthM <= s.upTo) return s.label;
  return "Above two storeys";
}
