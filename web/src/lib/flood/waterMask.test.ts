import { describe, expect, it } from "vitest";
import { refineWaterMask } from "./waterMask";

describe("refineWaterMask", () => {
  it("drops masked bank cells that sit well above the water surface", () => {
    // A river flattened at 1.0 m, with the mask spilling onto a 12 m bank and a 1.3 m edge.
    const ground = new Float32Array([1, 1, 1, 12, 1.3, 20]);
    const mask = new Uint8Array([1, 1, 1, 1, 1, 0]);
    expect(Array.from(refineWaterMask(ground, mask, 6, 1))).toEqual([1, 1, 1, 0, 1, 0]);
  });

  it("follows a sloping river because the minimum is local", () => {
    const nx = 20;
    const ground = Float32Array.from({ length: nx }, (_, x) => 10 - x * 0.5);
    const mask = new Uint8Array(nx).fill(1);
    const out = refineWaterMask(ground, mask, nx, 1, 1, 0.5);
    // Each cell is within 0.5 m of its downhill neighbour, so all stay water.
    expect(Array.from(out).every((v) => v === 1)).toBe(true);
  });

  it("ignores unmasked and no-data cells", () => {
    const ground = new Float32Array([Number.NaN, 0, -5]);
    const mask = new Uint8Array([1, 1, 0]);
    expect(Array.from(refineWaterMask(ground, mask, 3, 1))).toEqual([0, 1, 0]);
  });

  it("works in two dimensions", () => {
    const ground = new Float32Array([1, 9, 1, 1]);
    const mask = new Uint8Array([1, 1, 1, 1]);
    expect(Array.from(refineWaterMask(ground, mask, 2, 2))).toEqual([1, 0, 1, 1]);
  });
});
