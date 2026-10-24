/** What the 3D view is showing. */
export type Scenario =
  | { kind: "forecast"; day: number }
  | { kind: "ai"; day: number }
  | { kind: "returnPeriod"; rp: number }
  | { kind: "custom"; rise: number };

export const RETURN_PERIODS = [10, 20, 50, 75, 100, 200, 500] as const;

/** Depth in metres from one JRC layer (cm). */
export function layerDepth(cm: Uint16Array): Float32Array {
  const out = new Float32Array(cm.length);
  for (let i = 0; i < cm.length; i++) out[i] = cm[i] / 100;
  return out;
}

/**
 * Blend two JRC layers: lower + weight * (upper - lower). The backend picks the maps and
 * the weight (linear in log return period); this just applies them per cell.
 */
export function blendDepth(lower: Uint16Array, upper: Uint16Array, weight: number): Float32Array {
  if (lower.length !== upper.length) throw new Error("Layers differ in size");
  const w = Math.min(Math.max(weight, 0), 1);
  const out = new Float32Array(lower.length);
  for (let i = 0; i < lower.length; i++) out[i] = ((1 - w) * lower[i] + w * upper[i]) / 100;
  return out;
}

export function scenarioKey(s: Scenario): string {
  switch (s.kind) {
    case "forecast":
      return `forecast:${s.day}`;
    case "ai":
      return `ai:${s.day}`;
    case "returnPeriod":
      return `rp:${s.rp}`;
    case "custom":
      return `custom:${s.rise}`;
  }
}
