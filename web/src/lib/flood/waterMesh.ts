import { enuFrame, toEcef, toEnu } from "./geodesy";
import { writeGlb } from "./glb";
import type { SceneGrid } from "./sceneData";

/**
 * Builds the water surface as a GLB in a local east-north-up frame.
 *
 * Every vertex sits at the ground (ellipsoid height = DEM + geoid) and carries:
 *   _DEPTH: final water depth there. On dry cells next to water it is the neighbouring
 *           water level minus the ground (negative on a bank), so the surface stays flat
 *           and the terrain hides it where it runs into the bank.
 *   _KIND:  1 for permanent water whose depth the maps do not give, else 0.
 * The shader lifts each vertex by _DEPTH - (1 - progress) * maxDepth, so the whole
 * surface rises by maxDepth as progress goes 0 -> 1 and lands on the final level at 1.
 */

/** Permanent water without a modelled depth is drawn this far above the ground. */
export const PERMANENT_DISPLAY_DEPTH = 0.3;

export interface WaterMeshInput {
  grid: SceneGrid;
  ground: Float32Array;
  depth: Float32Array;
  permanent: Uint8Array;
  geoid: number;
}

export interface WaterMesh {
  glb: ArrayBuffer;
  origin: { lat: number; lon: number; height: number };
  maxDepth: number;
  vertices: number;
  triangles: number;
}

export function buildWaterMesh({ grid, ground, depth, permanent, geoid }: WaterMeshInput): WaterMesh | null {
  const { nx, ny } = grid;
  const n = nx * ny;
  const show = new Float32Array(n); // display depth, > 0 means wet
  const kind = new Uint8Array(n);
  let maxDepth = 0;
  let wetCount = 0;
  let groundSum = 0;
  let groundCount = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(ground[i])) continue;
    groundSum += ground[i];
    groundCount++;
    let d = depth[i];
    if (!(d > 0) && permanent[i]) {
      d = PERMANENT_DISPLAY_DEPTH;
      kind[i] = 1;
    }
    if (d > 0) {
      show[i] = d;
      wetCount++;
      if (d > maxDepth) maxDepth = d;
    }
  }
  if (wetCount === 0) return null;

  // Vertices: wet cells plus a one-cell ring around them.
  const vertexOf = new Int32Array(n).fill(-1);
  const attrDepth: number[] = [];
  const attrKind: number[] = [];
  const cellsUsed: number[] = [];
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (!Number.isFinite(ground[i])) continue;
      let value: number;
      if (show[i] > 0) {
        value = show[i];
      } else {
        let level = -Infinity;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
            const j = yy * nx + xx;
            if (show[j] > 0) level = Math.max(level, ground[j] + show[j]);
          }
        if (level === -Infinity) continue;
        value = Math.min(0, level - ground[i]);
      }
      vertexOf[i] = cellsUsed.length;
      cellsUsed.push(i);
      attrDepth.push(value);
      attrKind.push(kind[i]);
    }
  }

  const lat0 = (grid.north + grid.south) / 2;
  const lon0 = (grid.east + grid.west) / 2;
  const h0 = groundSum / groundCount + geoid;
  const frame = enuFrame(lat0, lon0, h0);
  const positions = new Float32Array(cellsUsed.length * 3);
  cellsUsed.forEach((i, v) => {
    const x = i % nx;
    const y = (i - x) / nx;
    const lon = grid.west + (x + 0.5) * grid.dx;
    const lat = grid.north - (y + 0.5) * grid.dy;
    const p = toEnu(frame, toEcef(lat, lon, ground[i] + geoid));
    positions[v * 3] = p[0];
    positions[v * 3 + 1] = p[1];
    positions[v * 3 + 2] = p[2];
  });

  const indices: number[] = [];
  for (let y = 0; y < ny - 1; y++) {
    for (let x = 0; x < nx - 1; x++) {
      const a = y * nx + x;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      const va = vertexOf[a];
      const vb = vertexOf[b];
      const vc = vertexOf[c];
      const vd = vertexOf[d];
      if (va < 0 || vb < 0 || vc < 0 || vd < 0) continue;
      if (!(show[a] > 0 || show[b] > 0 || show[c] > 0 || show[d] > 0)) continue;
      // Counter-clockwise seen from above (x east, y north, row index grows southward).
      indices.push(va, vc, vb, vb, vc, vd);
    }
  }
  if (indices.length === 0) return null;

  const glb = writeGlb({
    positions,
    scalars: { _DEPTH: Float32Array.from(attrDepth), _KIND: Float32Array.from(attrKind) },
    indices: Uint32Array.from(indices),
  });
  return {
    glb,
    origin: { lat: lat0, lon: lon0, height: h0 },
    maxDepth,
    vertices: cellsUsed.length,
    triangles: indices.length / 3,
  };
}
