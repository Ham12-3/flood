import { describe, expect, it } from "vitest";
import { computeScenario } from "./compute";
import { encodeTerrarium, paintWater, risenDepth, terrainHeight } from "./floodMap";
import { humanScale } from "./humanScale";
import { blendDepth, layerDepth, scenarioKey } from "./scenario";
import { base64ToBytes, cellIndex, sampleGround, type SceneArrays, type SceneGrid } from "./sceneData";
import { floodStats } from "./stats";

const GRID: SceneGrid = {
  west: 0,
  south: 0,
  east: 0.004,
  north: 0.003,
  nx: 4,
  ny: 3,
  dx: 0.001,
  dy: 0.001,
  cellW: 111,
  cellH: 111,
};

describe("humanScale", () => {
  it.each([
    [0, "Dry"],
    [-1, "Dry"],
    [Number.NaN, "Dry"],
    [0.1, "Ankle deep"],
    [0.3, "Knee deep"],
    [1.0, "Waist deep"],
    [1.6, "Up to head height"],
    [2.5, "Over head height, up to one storey"],
    [4, "Up to two storeys"],
    [9, "Above two storeys"],
  ])("%s m -> %s", (d, label) => expect(humanScale(d)).toBe(label));
});

describe("hazard layers", () => {
  it("converts cm to metres", () => {
    expect(Array.from(layerDepth(new Uint16Array([0, 125, 1000])))).toEqual([0, 1.25, 10]);
  });

  it("blends with the weight and clamps it", () => {
    const lo = new Uint16Array([0, 100]);
    const hi = new Uint16Array([200, 300]);
    expect(Array.from(blendDepth(lo, hi, 0.5))).toEqual([1, 2]);
    expect(Array.from(blendDepth(lo, hi, 2))).toEqual([2, 3]);
    expect(() => blendDepth(lo, new Uint16Array(3), 0.5)).toThrow();
  });

  it("gives each scenario a stable key", () => {
    expect(scenarioKey({ kind: "forecast", day: 3 })).toBe("forecast:3");
    expect(scenarioKey({ kind: "returnPeriod", rp: 100 })).toBe("rp:100");
    expect(scenarioKey({ kind: "custom", rise: 1.5 })).toBe("custom:1.5");
  });
});

describe("floodStats", () => {
  it("excludes permanent water from area and depth", () => {
    const depth = new Float32Array([0, 1, 3, 10]);
    const perm = new Uint8Array([0, 0, 0, 1]);
    const s = floodStats(depth, perm, 900);
    expect(s.floodedCells).toBe(2);
    expect(s.floodedAreaKm2).toBeCloseTo(0.0018);
    expect(s.maxDepthM).toBe(3);
    expect(s.meanDepthM).toBe(2);
    expect(s.permanentCells).toBe(1);
  });
});

describe("scene helpers", () => {
  it("finds the cell under a point, row 0 at the north", () => {
    expect(cellIndex(GRID, 0.0029, 0.0001)).toBe(0);
    expect(cellIndex(GRID, 0.0001, 0.0039)).toBe(11);
    expect(cellIndex(GRID, 0.01, 0)).toBe(-1);
  });

  it("interpolates ground between cell centres and clamps outside", () => {
    const ground = new Float32Array([0, 10, 20, 30, 0, 10, 20, 30, 0, 10, 20, Number.NaN]);
    const s = { grid: GRID, ground };
    expect(sampleGround(s, 0.0025, 0.001)).toBeCloseTo(5);
    expect(sampleGround(s, 0.0025, -1)).toBe(0);
    expect(sampleGround(s, 0.0005, 0.0035, -7)).toBe(-7);
  });

  it("decodes base64", () => {
    expect(Array.from(base64ToBytes(btoa("\u0001\u0002ÿ")))).toEqual([1, 2, 255]);
  });
});

function scene(): SceneArrays {
  // A 4x3 valley: river (permanent) down column 1, ground rising to the east.
  const ground = new Float32Array([2, 0, 3, 8, 2, 0, 3, 8, 2, 0, 3, 8]);
  const permanent = new Uint8Array([0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0]);
  return {
    grid: GRID,
    ground,
    permanent,
    layers: {
      10: new Uint16Array([0, 300, 0, 0, 0, 300, 0, 0, 0, 300, 0, 0]),
      20: new Uint16Array([100, 400, 100, 0, 100, 400, 100, 0, 100, 400, 100, 0]),
    },
  };
}

describe("water painting", () => {
  it("colours flood depth, keeps rivers blue and leaves dry land clear", () => {
    const s = scene();
    const rgba = new Uint8ClampedArray(12 * 4);
    const depth = new Float32Array([0, 3, 0.5, 0.02, 0, 0, 0, 0, 0, 0, 0, 0]);
    paintWater(rgba, s, depth, 1, 3);
    const px = (i: number) => Array.from(rgba.slice(4 * i, 4 * i + 4));
    expect(px(0)[3]).toBe(0); // dry
    expect(px(2)[3]).toBeGreaterThan(0); // 50 cm of flood water
    expect(px(3)[3]).toBe(0); // a 2 cm film is not drawn
    expect(px(5)).toEqual([0x39, 0x87, 0xe5, 205]); // river with no modelled depth
  });

  it("lowers everything by the deepest depth at the start of the rise", () => {
    expect(risenDepth(3, 0, 3)).toBe(0);
    expect(risenDepth(3, 0.5, 3)).toBe(1.5);
    expect(risenDepth(1, 0.5, 3)).toBe(0);
    expect(risenDepth(1, 1, 3)).toBe(1);
  });
});

describe("terrain tiles", () => {
  it("encodes terrarium heights that decode back", () => {
    const out = new Uint8ClampedArray(4);
    for (const h of [0, 12.5, -3.25, 1601.75]) {
      encodeTerrarium(h, out, 0);
      expect(out[0] * 256 + out[1] + out[2] / 256 - 32768).toBeCloseTo(h, 2);
      expect(out[3]).toBe(255);
    }
  });

  it("uses the window inside and eases to the median outside", () => {
    const ground = new Float32Array([0, 10, 20, 30, 0, 10, 20, 30, 0, 10, 20, 30]);
    const s = { grid: GRID, ground };
    expect(terrainHeight(s, 0.0015, 0.0015, 15)).toBeCloseTo(sampleGround(s, 0.0015, 0.0015));
    const near = terrainHeight(s, 0.0015, 0.0041, 15); // just east of the window
    const far = terrainHeight(s, 0.0015, 0.05, 15); // ~5 km east
    expect(near).toBeCloseTo(30, 0);
    expect(Math.abs(far - 15)).toBeLessThan(0.2);
  });
});

describe("computeScenario", () => {
  it("handles every request type", () => {
    const s = scene();
    const layer = computeScenario(s, { kind: "layer", rp: 20 }, 1);
    expect(layer.stats.floodedCells).toBe(6);
    expect(layer.stats.maxDepthM).toBe(1);

    const blend = computeScenario(s, { kind: "blend", lower: 10, upper: 20, weight: 0.5 }, 2);
    expect(blend.depth[0]).toBeCloseTo(0.5);

    const banks = computeScenario(s, { kind: "banks" }, 3);
    expect(banks.stats.floodedCells).toBe(0);

    const custom = computeScenario(s, { kind: "custom", rise: 2.5 }, 4);
    // Level 2.5 floods the 2 m bank (0.5 deep) but not the 3 m one.
    expect(custom.stats.floodedCells).toBe(3);
    expect(custom.notice).toBeNull();

    expect(() => computeScenario(s, { kind: "layer", rp: 500 }, 5)).toThrow();
  });

  it("explains a custom rise with no permanent water", () => {
    const s = scene();
    s.permanent.fill(0);
    const r = computeScenario(s, { kind: "custom", rise: 1 }, 1);
    expect(r.notice).toMatch(/No river or lake/);
  });
});

describe("minimum flood depth", () => {
  it("ignores films thinner than 5 cm in stats", () => {
    const s = floodStats(new Float32Array([0.01, 0.049, 0.05, 1]), new Uint8Array(4), 100);
    expect(s.floodedCells).toBe(2);
    expect(s.maxDepthM).toBe(1);
  });
});
