/**
 * Draws one 256 px Web Mercator map tile of a storm replay: water by depth, roads under
 * water, and buildings (orange when water reaches the door). Pure functions over plain
 * arrays, so the worker can run them and tests can check them.
 */
import { depthRgb } from "@/lib/flood/depthRamp";
import {
  DEEP_CM,
  MAIN_ROAD_MAX_CLASS,
  SHOW_CM,
  WET_CM,
  qLat,
  qLon,
  type ReplayFeatures,
  type ReplayGrid,
} from "./data";

export const TILE = 256;
export const WATER_ALPHA = 200;
// IBM colour-blind-safe palette.
export const COLORS = {
  roadWet: "#ffb000", // 10-30 cm
  roadDeep: "#dc267f", // 30 cm and more
  buildingWet: "#fe6100", // water at the door
  buildingDry: "rgba(230, 230, 230, 0.45)",
};
const BUILDINGS_MAX_M_PER_PX = 12; // draw outlines from about zoom 14 (2D picks coarse tiles)
const ROADS_MAX_M_PER_PX = 80; // wet roads from about zoom 11 (main roads from zoom 9)
const BUCKET_CELLS = 8; // spatial index buckets of 8 x 8 cells

export interface TileBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** The subset of CanvasRenderingContext2D that tile drawing uses. */
export interface Ctx2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
}

export function mercY(latDeg: number): number {
  const phi = (Math.max(-85.0511, Math.min(85.0511, latDeg)) * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + phi / 2));
}

function inverseMercY(y: number): number {
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
}

export function metresPerPixel(t: TileBounds): number {
  const midLat = (t.north + t.south) / 2;
  return ((t.east - t.west) * 111_320 * Math.cos((midLat * Math.PI) / 180)) / TILE;
}

/** Fill RGBA pixels (TILE x TILE) with water colours for one hour; sea stays clear. */
export function paintWater(
  rgba: Uint8ClampedArray,
  t: TileBounds,
  grid: ReplayGrid,
  depthCm: Uint16Array,
  sea: Uint8Array,
): number {
  const yN = mercY(t.north);
  const yS = mercY(t.south);
  const rows = new Int32Array(TILE);
  const cols = new Int32Array(TILE);
  for (let j = 0; j < TILE; j++) {
    const lat = inverseMercY(yN - ((j + 0.5) / TILE) * (yN - yS));
    const r = Math.floor((grid.north - lat) / grid.dyDeg);
    rows[j] = r >= 0 && r < grid.ny ? r : -1;
  }
  for (let i = 0; i < TILE; i++) {
    const lon = t.west + ((i + 0.5) / TILE) * (t.east - t.west);
    const c = Math.floor((lon - grid.west) / grid.dxDeg);
    cols[i] = c >= 0 && c < grid.nx ? c : -1;
  }
  let painted = 0;
  for (let j = 0; j < TILE; j++) {
    if (rows[j] < 0) continue;
    const base = rows[j] * grid.nx;
    for (let i = 0; i < TILE; i++) {
      if (cols[i] < 0) continue;
      const cell = base + cols[i];
      const d = depthCm[cell];
      if (d < SHOW_CM || sea[cell]) continue;
      const [r, g, b] = depthRgb(d / 100);
      const p = (j * TILE + i) * 4;
      rgba[p] = r;
      rgba[p + 1] = g;
      rgba[p + 2] = b;
      rgba[p + 3] = WATER_ALPHA;
      painted++;
    }
  }
  return painted;
}

/** Buckets of buildings and roads by area (compressed rows), built once per replay. */
export interface FeatureIndex {
  bx: number;
  by: number;
  buildingStart: Uint32Array;
  buildingIds: Uint32Array;
  roadStart: Uint32Array;
  roadIds: Uint32Array;
}

function bucketOf(qx: number, qy: number, bx: number, by: number): number {
  const x = Math.min(bx - 1, Math.floor((qx / 65536) * bx));
  const y = Math.min(by - 1, Math.floor((qy / 65536) * by));
  return y * bx + x;
}

function compress(lists: number[][]): { start: Uint32Array; ids: Uint32Array } {
  const start = new Uint32Array(lists.length + 1);
  for (let k = 0; k < lists.length; k++) start[k + 1] = start[k] + lists[k].length;
  const ids = new Uint32Array(start[lists.length]);
  lists.forEach((l, k) => ids.set(l, start[k]));
  return { start, ids };
}

export function buildIndex(f: ReplayFeatures, grid: ReplayGrid): FeatureIndex {
  const bx = Math.max(1, Math.ceil(grid.nx / BUCKET_CELLS));
  const by = Math.max(1, Math.ceil(grid.ny / BUCKET_CELLS));
  const b: number[][] = Array.from({ length: bx * by }, () => []);
  const r: number[][] = Array.from({ length: bx * by }, () => []);
  for (let k = 0; k + 1 < f.buildingOffsets.length; k++) {
    const v = f.buildingOffsets[k];
    b[bucketOf(f.buildingCoords[2 * v], f.buildingCoords[2 * v + 1], bx, by)].push(k);
  }
  for (let k = 0; k + 1 < f.roadOffsets.length; k++) {
    let last = -1;
    for (let v = f.roadOffsets[k]; v < f.roadOffsets[k + 1]; v++) {
      const bucket = bucketOf(f.roadCoords[2 * v], f.roadCoords[2 * v + 1], bx, by);
      if (bucket !== last && r[bucket][r[bucket].length - 1] !== k) r[bucket].push(k);
      last = bucket;
    }
  }
  const bb = compress(b);
  const rr = compress(r);
  return { bx, by, buildingStart: bb.start, buildingIds: bb.ids, roadStart: rr.start, roadIds: rr.ids };
}

/** Bucket numbers overlapping the tile (with a little margin). */
function bucketsFor(t: TileBounds, grid: ReplayGrid, idx: FeatureIndex): number[] {
  const fx = (lon: number) => ((lon - grid.west) / (grid.east - grid.west)) * idx.bx;
  const fy = (lat: number) => ((grid.north - lat) / (grid.north - grid.south)) * idx.by;
  const x0 = Math.max(0, Math.floor(fx(t.west)) - 1);
  const x1 = Math.min(idx.bx - 1, Math.floor(fx(t.east)) + 1);
  const y0 = Math.max(0, Math.floor(fy(t.north)) - 1);
  const y1 = Math.min(idx.by - 1, Math.floor(fy(t.south)) + 1);
  const out: number[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(y * idx.bx + x);
  return out;
}

export interface FeatureCounts {
  buildings: number;
  wetBuildings: number;
  wetRoadPieces: number;
}

/** Draw wet roads and building outlines for one hour onto the tile. */
export function drawFeatures(
  ctx: Ctx2D,
  t: TileBounds,
  grid: ReplayGrid,
  f: ReplayFeatures,
  idx: FeatureIndex,
  depthCm: Uint16Array,
): FeatureCounts {
  const counts: FeatureCounts = { buildings: 0, wetBuildings: 0, wetRoadPieces: 0 };
  const mpp = metresPerPixel(t);
  if (mpp > ROADS_MAX_M_PER_PX * 4) return counts;
  const yN = mercY(t.north);
  const yS = mercY(t.south);
  const px = (q: number) => ((qLon(grid, q) - t.west) / (t.east - t.west)) * TILE;
  const py = (q: number) => ((yN - mercY(qLat(grid, q))) / (yN - yS)) * TILE;
  const cellOf = (qx: number, qy: number) => {
    const col = Math.min(grid.nx - 1, Math.floor((qx / 65535) * grid.nx));
    const row = Math.min(grid.ny - 1, Math.floor((qy / 65535) * grid.ny));
    return row * grid.nx + col;
  };
  const buckets = bucketsFor(t, grid, idx);

  // Roads: each short piece is coloured by the depth where its midpoint is. Zoomed far
  // out, only main roads.
  {
    const seen = new Set<number>();
    const pieces: [number, number, number, number][][] = [[], []]; // wet, deep
    for (const bucket of buckets) {
      for (let k = idx.roadStart[bucket]; k < idx.roadStart[bucket + 1]; k++) {
        const road = idx.roadIds[k];
        if (seen.has(road)) continue;
        seen.add(road);
        if (mpp > ROADS_MAX_M_PER_PX && f.roadClasses[road] > MAIN_ROAD_MAX_CLASS) continue;
        for (let v = f.roadOffsets[road]; v + 1 < f.roadOffsets[road + 1]; v++) {
          const ax = f.roadCoords[2 * v];
          const ay = f.roadCoords[2 * v + 1];
          const bx = f.roadCoords[2 * v + 2];
          const by = f.roadCoords[2 * v + 3];
          const d = depthCm[cellOf((ax + bx) / 2, (ay + by) / 2)];
          if (d < WET_CM) continue;
          pieces[d >= DEEP_CM ? 1 : 0].push([px(ax), py(ay), px(bx), py(by)]);
        }
      }
    }
    ctx.lineJoin = "round";
    ctx.lineWidth = mpp < 3 ? 4 : mpp < 12 ? 3 : 2;
    [COLORS.roadWet, COLORS.roadDeep].forEach((color, i) => {
      if (!pieces[i].length) return;
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (const [x0, y0, x1, y1] of pieces[i]) {
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
      }
      ctx.stroke();
      counts.wetRoadPieces += pieces[i].length;
    });
  }

  // Buildings, only when zoomed in enough to see them.
  if (mpp <= BUILDINGS_MAX_M_PER_PX) {
    const groups: number[][] = [[], []]; // dry, wet
    for (const bucket of buckets) {
      for (let k = idx.buildingStart[bucket]; k < idx.buildingStart[bucket + 1]; k++) {
        const b = idx.buildingIds[k];
        groups[depthCm[f.buildingCells[b]] >= WET_CM ? 1 : 0].push(b);
      }
    }
    [COLORS.buildingDry, COLORS.buildingWet].forEach((color, i) => {
      if (!groups[i].length) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const b of groups[i]) {
        const v0 = f.buildingOffsets[b];
        const v1 = f.buildingOffsets[b + 1];
        ctx.moveTo(px(f.buildingCoords[2 * v0]), py(f.buildingCoords[2 * v0 + 1]));
        for (let v = v0 + 1; v < v1; v++) ctx.lineTo(px(f.buildingCoords[2 * v]), py(f.buildingCoords[2 * v + 1]));
        ctx.closePath();
      }
      ctx.fill();
      counts.buildings += groups[i].length;
      if (i === 1) counts.wetBuildings = groups[i].length;
    });
  }
  return counts;
}
