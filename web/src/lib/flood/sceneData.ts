import type { SceneResponse } from "@/lib/api";
import { refineWaterMask } from "./waterMask";

export interface SceneGrid {
  west: number;
  south: number;
  east: number;
  north: number;
  nx: number;
  ny: number;
  dx: number;
  dy: number;
  cellW: number; // metres east-west
  cellH: number; // metres north-south
}

/** Decoded scene arrays, ready to send to the worker. Row-major, row 0 north. */
export interface SceneArrays {
  grid: SceneGrid;
  ground: Float32Array; // metres above sea level (EGM2008), NaN = no data
  layers: Record<number, Uint16Array>; // return period -> depth in cm
  permanent: Uint8Array; // JRC permanent water, kept only where the ground is the water surface
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function float32(b64: string, n: number): Float32Array {
  const bytes = base64ToBytes(b64);
  if (bytes.byteLength !== n * 4) throw new Error(`Expected ${n} float32 values, got ${bytes.byteLength / 4}`);
  return new Float32Array(bytes.buffer, 0, n);
}

function uint16(b64: string, n: number): Uint16Array {
  const bytes = base64ToBytes(b64);
  if (bytes.byteLength !== n * 2) throw new Error(`Expected ${n} uint16 values, got ${bytes.byteLength / 2}`);
  return new Uint16Array(bytes.buffer, 0, n);
}

/** Returns null with a reason when the scene has no terrain to show. */
export function decodeScene(scene: SceneResponse): { arrays: SceneArrays } | { reason: string } {
  const g = scene.grid;
  const n = g.nx * g.ny;
  if (scene.dem.status !== "ok" || !scene.dem.heights_f32) {
    return { reason: scene.dem.reason ?? "No terrain for this window." };
  }
  const layers: Record<number, Uint16Array> = {};
  let permanent: Uint8Array = new Uint8Array(n);
  if (scene.hazard.status === "ok") {
    for (const layer of scene.hazard.layers) layers[layer.return_period] = uint16(layer.depth_cm_u16, n);
    if (scene.hazard.permanent_water_u8) permanent = base64ToBytes(scene.hazard.permanent_water_u8);
  }
  const ground = float32(scene.dem.heights_f32, n);
  return {
    arrays: {
      grid: {
        west: g.west,
        south: g.south,
        east: g.east,
        north: g.north,
        nx: g.nx,
        ny: g.ny,
        dx: g.dx_deg,
        dy: g.dy_deg,
        cellW: g.cell_size_m[0],
        cellH: g.cell_size_m[1],
      },
      ground,
      layers,
      permanent: refineWaterMask(ground, permanent, g.nx, g.ny),
    },
  };
}

/** Index of the grid cell containing a point, or -1 outside the window. */
export function cellIndex(grid: SceneGrid, lat: number, lon: number): number {
  const x = Math.floor((lon - grid.west) / grid.dx);
  const y = Math.floor((grid.north - lat) / grid.dy);
  if (x < 0 || y < 0 || x >= grid.nx || y >= grid.ny) return -1;
  return y * grid.nx + x;
}

/** Bilinear height (EGM2008 m) at a point, using cell centres; clamps outside the window. */
export function sampleGround(arrays: Pick<SceneArrays, "grid" | "ground">, lat: number, lon: number, fallback = 0): number {
  const { grid, ground } = arrays;
  const fx = Math.min(Math.max((lon - grid.west) / grid.dx - 0.5, 0), grid.nx - 1);
  const fy = Math.min(Math.max((grid.north - lat) / grid.dy - 0.5, 0), grid.ny - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, grid.nx - 1);
  const y1 = Math.min(y0 + 1, grid.ny - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const v = (x: number, y: number) => {
    const h = ground[y * grid.nx + x];
    return Number.isFinite(h) ? h : fallback;
  };
  const top = v(x0, y0) * (1 - tx) + v(x1, y0) * tx;
  const bottom = v(x0, y1) * (1 - tx) + v(x1, y1) * tx;
  return top * (1 - ty) + bottom * ty;
}
