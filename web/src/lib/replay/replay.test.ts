import { describe, expect, it } from "vitest";
import { depthRgb, DEPTH_STOPS } from "@/lib/flood/depthRamp";
import { cellAt, decodeFeatures, decodeFrames, formatLocalHour, frame, type ReplayGrid } from "./data";
import { buildIndex, COLORS, drawFeatures, metresPerPixel, paintWater, TILE, WATER_ALPHA, type Ctx2D, type TileBounds } from "./render";

// 4 x 2 cells over a small area near the equator (about 1.1 km x 0.55 km).
const GRID: ReplayGrid = { west: 3, south: 6.995, east: 3.01, north: 7, nx: 4, ny: 2, dxDeg: 0.0025, dyDeg: 0.0025 };
const Q = 65535;

/** Quantise lon/lat into the grid the way the API does. */
function q(lon: number, lat: number): [number, number] {
  return [
    Math.round(((lon - GRID.west) / (GRID.east - GRID.west)) * Q),
    Math.round(((GRID.north - lat) / (GRID.north - GRID.south)) * Q),
  ];
}

function blob(
  buildings: { ring: [number, number][]; cell: number }[],
  roads: { line: [number, number][]; cls: number }[],
): ArrayBuffer {
  const bOff = [0];
  const bCoords: number[] = [];
  for (const b of buildings) {
    b.ring.forEach(([lon, lat]) => bCoords.push(...q(lon, lat)));
    bOff.push(bOff[bOff.length - 1] + b.ring.length);
  }
  const rOff = [0];
  const rCoords: number[] = [];
  for (const r of roads) {
    r.line.forEach(([lon, lat]) => rCoords.push(...q(lon, lat)));
    rOff.push(rOff[rOff.length - 1] + r.line.length);
  }
  const parts = [
    new Uint32Array([buildings.length, bCoords.length / 2, roads.length, rCoords.length / 2]),
    new Uint32Array(bOff),
    new Uint32Array(buildings.map((b) => b.cell)),
    new Uint32Array(rOff),
    new Uint16Array(bCoords),
    new Uint16Array(rCoords),
    new Uint8Array(roads.map((r) => r.cls)),
  ];
  const size = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), at);
    at += p.byteLength;
  }
  return out.buffer;
}

const square = (lon: number, lat: number, s = 0.0003): [number, number][] => [
  [lon, lat],
  [lon + s, lat],
  [lon + s, lat - s],
  [lon, lat - s],
];

class FakeCtx implements Ctx2D {
  fillStyle: string | CanvasGradient | CanvasPattern = "";
  strokeStyle: string | CanvasGradient | CanvasPattern = "";
  lineWidth = 1;
  lineJoin: CanvasLineJoin = "miter";
  fills: { color: string; shapes: number }[] = [];
  strokes: { color: string; pieces: number }[] = [];
  private moves = 0;
  beginPath() {
    this.moves = 0;
  }
  moveTo() {
    this.moves++;
  }
  lineTo() {}
  closePath() {}
  fill() {
    this.fills.push({ color: String(this.fillStyle), shapes: this.moves });
  }
  stroke() {
    this.strokes.push({ color: String(this.strokeStyle), pieces: this.moves });
  }
}

const WHOLE: TileBounds = { west: GRID.west, south: GRID.south, east: GRID.east, north: GRID.north };

describe("replay data", () => {
  it("decodes the buildings and roads file", () => {
    const f = decodeFeatures(
      blob([{ ring: square(3.001, 6.999), cell: 0 }], [{ line: [[3, 6.998], [3.009, 6.998]], cls: 2 }]),
    );
    expect(Array.from(f.buildingOffsets)).toEqual([0, 4]);
    expect(Array.from(f.buildingCells)).toEqual([0]);
    expect(Array.from(f.roadOffsets)).toEqual([0, 2]);
    expect(f.buildingCoords.length).toBe(8);
    expect(Array.from(f.roadClasses)).toEqual([2]);
  });

  it("refuses files of the wrong length", () => {
    expect(() => decodeFeatures(new ArrayBuffer(8))).toThrow(/too short/);
    const good = blob([], []);
    const longer = new Uint8Array(good.byteLength + 4);
    longer.set(new Uint8Array(good));
    expect(() => decodeFeatures(longer.buffer)).toThrow(/wrong length/);
    expect(() => decodeFrames(new ArrayBuffer(10), 2, GRID)).toThrow(/expected 16/);
  });

  it("slices hourly frames and finds cells", () => {
    const frames = decodeFrames(new Uint16Array(16).map((_, i) => i).buffer, 2, GRID);
    expect(Array.from(frame(frames, GRID, 1))).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
    expect(cellAt(GRID, 3.0001, 6.9999)).toBe(0);
    expect(cellAt(GRID, 3.0099, 6.9951)).toBe(7);
    expect(cellAt(GRID, 2.9, 6.99)).toBe(-1);
  });

  it("formats local hours without changing time zones", () => {
    expect(formatLocalHour("2026-06-30T17:00")).toBe("Tue 30 Jun, 17:00");
    expect(formatLocalHour("2026-07-01T00:00")).toBe("Wed 1 Jul, 00:00");
    expect(formatLocalHour("nonsense")).toBe("nonsense");
  });
});

describe("depth colours", () => {
  it("hits the stops and mixes between them", () => {
    expect(depthRgb(0)).toEqual([0x9e, 0xc5, 0xf4]);
    expect(depthRgb(10)).toEqual([0x0d, 0x36, 0x6b]);
    const mid = depthRgb(0.25);
    expect(mid[0]).toBeGreaterThan(0x6d);
    expect(mid[0]).toBeLessThan(0x9e);
    expect(DEPTH_STOPS.length).toBe(6);
  });
});

describe("tile drawing", () => {
  it("paints water from 5 cm and leaves the sea and dry land clear", () => {
    const rgba = new Uint8ClampedArray(TILE * TILE * 4);
    const depth = new Uint16Array([0, 4, 50, 0, 120, 0, 0, 300]); // cm
    const sea = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]);
    const painted = paintWater(rgba, WHOLE, GRID, depth, sea);
    // Cells 2 and 4 are wet; each covers a quarter of the width and half the height.
    expect(painted).toBeGreaterThan(0.24 * TILE * TILE);
    expect(painted).toBeLessThan(0.26 * TILE * TILE);
    const at = (i: number, j: number) => Array.from(rgba.slice((j * TILE + i) * 4, (j * TILE + i) * 4 + 4));
    expect(at(10, 10)).toEqual([0, 0, 0, 0]); // cell 0, dry
    expect(at(150, 10)).toEqual([...depthRgb(0.5), WATER_ALPHA]); // cell 2
    expect(at(250, 250)).toEqual([0, 0, 0, 0]); // cell 7 is sea
  });

  it("colours buildings by water at the door and roads by depth", () => {
    const f = decodeFeatures(
      blob(
        [
          { ring: square(3.0005, 6.9995), cell: 0 },
          { ring: square(3.0055, 6.9995), cell: 2 },
        ],
        [
          { line: [[3.0001, 6.9988], [3.0024, 6.9988]], cls: 5 }, // in cell 0
          { line: [[3.0051, 6.9988], [3.0074, 6.9988]], cls: 5 }, // in cell 2
          { line: [[3.0076, 6.9988], [3.0099, 6.9988]], cls: 5 }, // in cell 3
        ],
      ),
    );
    const idx = buildIndex(f, GRID);
    const depth = new Uint16Array([0, 0, 15, 45, 0, 0, 0, 0]);
    const ctx = new FakeCtx();
    expect(metresPerPixel(WHOLE)).toBeLessThan(6);
    const counts = drawFeatures(ctx, WHOLE, GRID, f, idx, depth);
    expect(counts).toEqual({ buildings: 2, wetBuildings: 1, wetRoadPieces: 2 });
    expect(ctx.fills).toEqual([
      { color: COLORS.buildingDry, shapes: 1 },
      { color: COLORS.buildingWet, shapes: 1 },
    ]);
    expect(ctx.strokes).toEqual([
      { color: COLORS.roadWet, pieces: 1 },
      { color: COLORS.roadDeep, pieces: 1 },
    ]);
  });

  it("skips buildings and side streets when zoomed far out", () => {
    const f = decodeFeatures(
      blob([{ ring: square(3.0005, 6.9995), cell: 0 }], [{ line: [[3.0001, 6.9988], [3.0024, 6.9988]], cls: 6 }]),
    );
    const far: TileBounds = { west: 2, south: 6, east: 4, north: 8 };
    const ctx = new FakeCtx();
    const counts = drawFeatures(ctx, far, GRID, f, buildIndex(f, GRID), new Uint16Array(8).fill(50));
    expect(counts).toEqual({ buildings: 0, wetBuildings: 0, wetRoadPieces: 0 });
  });
});
