import { describe, expect, it } from "vitest";
import { connectedFlood } from "./floodfill";

/** Build a grid from rows of numbers; "S" marks a seed cell at height 0. */
function grid(rows: (number | "S")[][]) {
  const ny = rows.length;
  const nx = rows[0].length;
  const ground = new Float32Array(nx * ny);
  const seeds = new Uint8Array(nx * ny);
  rows.forEach((row, y) =>
    row.forEach((v, x) => {
      ground[y * nx + x] = v === "S" ? 0 : v;
      seeds[y * nx + x] = v === "S" ? 1 : 0;
    }),
  );
  return { ground, seeds, nx, ny };
}

function depths(result: Float32Array, nx: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < result.length; i += nx) out.push(Array.from(result.slice(i, i + nx), (v) => Math.round(v * 100) / 100));
  return out;
}

describe("connectedFlood", () => {
  it("floods connected low ground up to seed level + rise", () => {
    const g = grid([
      ["S", 1, 2, 5],
      [0.5, 1, 3, 5],
    ]);
    const { depth, seeds } = connectedFlood(g.ground, g.seeds, g.nx, g.ny, 2);
    expect(seeds).toBe(1);
    expect(depths(depth, g.nx)).toEqual([
      [2, 1, 0, 0],
      [1.5, 1, 0, 0],
    ]);
  });

  it("leaves an isolated hollow dry behind a ridge", () => {
    const g = grid([["S", 1, 9, -2, 9]]);
    const { depth } = connectedFlood(g.ground, g.seeds, g.nx, g.ny, 3);
    // The hollow at -2 is below the level (3) but the ridge (9) blocks it.
    expect(depths(depth, g.nx)).toEqual([[3, 2, 0, 0, 0]]);
  });

  it("spreads through diagonal gaps (8-neighbour)", () => {
    const g = grid([
      ["S", 9],
      [9, 0],
    ]);
    const { depth } = connectedFlood(g.ground, g.seeds, g.nx, g.ny, 1);
    expect(depths(depth, g.nx)).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it("takes the nearest seed's level on a sloping river, so upstream water does not spill downhill", () => {
    // Upstream seed at 10, downstream seed at 0, rise 1. The cell at 9 is nearest the
    // upstream seed (level 11); the cell at 0.5 is nearest the downstream seed (level 1).
    const ground = new Float32Array([10, 9, 0.5, 0]);
    const seeds = new Uint8Array([1, 0, 0, 1]);
    const { depth } = connectedFlood(ground, seeds, 4, 1, 1);
    expect(Array.from(depth, (d) => Math.round(d * 100) / 100)).toEqual([1, 2, 0.5, 1]);
  });

  it("lets a farther seed reach a cell the nearest seed cannot", () => {
    // The left seed (level 1) cannot climb the cell at 3; the right seed (level 6) can.
    const ground = new Float32Array([0, 3, 5]);
    const seeds = new Uint8Array([1, 0, 1]);
    const { depth } = connectedFlood(ground, seeds, 3, 1, 1);
    expect(Array.from(depth)).toEqual([1, 3, 1]);
  });

  it("never floods no-data cells and works with zero rise", () => {
    const ground = new Float32Array([0, Number.NaN, -1]);
    const seeds = new Uint8Array([1, 0, 0]);
    const { depth } = connectedFlood(ground, seeds, 3, 1, 0);
    expect(Array.from(depth)).toEqual([0, 0, 0]);
  });

  it("returns all dry with no seeds", () => {
    const { depth, seeds } = connectedFlood(new Float32Array(4), new Uint8Array(4), 2, 2, 5);
    expect(seeds).toBe(0);
    expect(Array.from(depth)).toEqual([0, 0, 0, 0]);
  });

  it("rejects mismatched arrays", () => {
    expect(() => connectedFlood(new Float32Array(3), new Uint8Array(4), 2, 2, 1)).toThrow();
  });

  it("handles a 300x300 grid quickly", () => {
    const nx = 300;
    const ny = 300;
    const ground = new Float32Array(nx * ny);
    const seeds = new Uint8Array(nx * ny);
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        ground[y * nx + x] = Math.abs(x - 150) * 0.1 + Math.sin(y / 10);
        if (x === 150) seeds[y * nx + x] = 1;
      }
    const t = performance.now();
    const { depth } = connectedFlood(ground, seeds, nx, ny, 2);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(depth.some((d) => d > 0)).toBe(true);
  });
});
