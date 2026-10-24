import { describe, expect, it } from "vitest";
import { G, inflowCells, initialState, runUntil, stableDt, step, volume, type SweParams } from "./swe";

function params(nx: number, ny: number, over: Partial<SweParams> = {}): SweParams {
  return { nx, ny, dx: 30, dy: 30, manning: 0.035, rainMmPerHour: 0, inflow: [], alpha: 0.7, maxDt: 10, ...over };
}

/** A closed basin: a high rim all round, so nothing reaches the outflow edges. */
function basin(nx: number, ny: number, floor = 0, rim = 100): Float32Array {
  const z = new Float32Array(nx * ny).fill(floor);
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) if (x === 0 || y === 0 || x === nx - 1 || y === ny - 1) z[y * nx + x] = rim;
  return z;
}

describe("local inertial shallow water", () => {
  it("keeps a still lake still (well-balanced over uneven ground)", () => {
    const nx = 12;
    const ny = 12;
    const z = basin(nx, ny);
    for (let i = 0; i < z.length; i++) if (z[i] < 50) z[i] = (i % 5) * 0.2; // bumpy floor below the water
    const s = initialState(nx, ny);
    for (let i = 0; i < z.length; i++) if (z[i] < 50) s.h[i] = 3 - z[i]; // flat surface at 3 m
    runUntil(s, z, params(nx, ny), 600);
    for (let i = 0; i < z.length; i++) if (z[i] < 50) expect(z[i] + s.h[i]).toBeCloseTo(3, 4);
  });

  it("conserves water in a closed basin while a dam break spreads", () => {
    const nx = 30;
    const ny = 10;
    const z = basin(nx, ny);
    const s = initialState(nx, ny);
    for (let y = 1; y < ny - 1; y++) for (let x = 1; x < 10; x++) s.h[y * nx + x] = 2;
    const p = params(nx, ny);
    const v0 = volume(s.h, p);
    runUntil(s, z, p, 1800);
    expect(Math.abs(volume(s.h, p) - v0) / v0).toBeLessThan(1e-3);
    // Water reached the far end of the basin.
    expect(s.h[5 * nx + 25]).toBeGreaterThan(0.1);
  });

  it("adds rain and river inflow, and lets water out at the open edges", () => {
    const nx = 20;
    const ny = 20;
    const z = new Float32Array(nx * ny); // flat, open on every side
    const p = params(nx, ny, { rainMmPerHour: 36, inflow: [{ cell: 210, m3s: 5 }] });
    const s = initialState(nx, ny);
    runUntil(s, z, p, 3600);
    const v = volume(s.h, p);
    // Mass balance: stored = added - outflow (small error from clamping at zero depth).
    expect(Math.abs(v - (s.added - s.outflow)) / s.added).toBeLessThan(0.01);
    expect(s.outflow).toBeGreaterThan(0);
    // 36 mm/h for an hour on 360,000 m^2 plus 5 m^3/s for an hour.
    expect(s.added).toBeCloseTo(0.036 * nx * ny * 900 + 5 * 3600, -2);
  });

  it("never holds water on no-data cells and never goes negative", () => {
    const nx = 5;
    const ny = 1;
    const z = new Float32Array([0, Number.NaN, 0, 0, 0]);
    const s = initialState(nx, ny);
    s.h[0] = 1;
    s.h[2] = 0.001;
    const p = params(nx, ny);
    for (let k = 0; k < 200; k++) step(s, z, p, stableDt(s.h, p));
    expect(s.h[1]).toBe(0);
    expect(Array.from(s.h).every((v) => v >= 0)).toBe(true);
  });

  it("limits the time step by wave speed", () => {
    const h = new Float32Array([0, 4]);
    const p = params(2, 1);
    expect(stableDt(h, p)).toBeCloseTo((0.7 * 30) / Math.sqrt(G * 4), 6);
    expect(stableDt(new Float32Array(2), p)).toBe(10);
  });
});

describe("inflowCells", () => {
  it("picks the highest river cluster on the window edge", () => {
    const nx = 6;
    const ny = 4;
    const z = new Float32Array(nx * ny).fill(10);
    const water = new Uint8Array(nx * ny);
    // River enters on the west edge (rows 1-2, ground 5) and leaves on the east (ground 2).
    for (const y of [1, 2]) {
      for (let x = 0; x < nx; x++) {
        water[y * nx + x] = 1;
        z[y * nx + x] = 5 - x * 0.6;
      }
    }
    expect(inflowCells(z, water, nx, ny).sort((a, b) => a - b)).toEqual([6, 12]);
    expect(inflowCells(z, new Uint8Array(nx * ny), nx, ny)).toEqual([]);
  });
});
