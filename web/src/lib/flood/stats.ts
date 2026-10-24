export interface FloodStats {
  /** Land newly under water, excluding permanent rivers and lakes. */
  floodedCells: number;
  floodedAreaKm2: number;
  /** Deepest water on flooded land (not in the permanent channel). */
  maxDepthM: number;
  meanDepthM: number;
  permanentCells: number;
}

export function floodStats(depth: Float32Array, permanent: Uint8Array, cellAreaM2: number): FloodStats {
  let flooded = 0;
  let sum = 0;
  let max = 0;
  let perm = 0;
  for (let i = 0; i < depth.length; i++) {
    if (permanent[i]) {
      perm++;
      continue;
    }
    const d = depth[i];
    if (d > 0) {
      flooded++;
      sum += d;
      if (d > max) max = d;
    }
  }
  return {
    floodedCells: flooded,
    floodedAreaKm2: (flooded * cellAreaM2) / 1e6,
    maxDepthM: max,
    meanDepthM: flooded ? sum / flooded : 0,
    permanentCells: perm,
  };
}
