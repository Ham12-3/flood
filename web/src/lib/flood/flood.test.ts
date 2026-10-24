import { describe, expect, it } from "vitest";
import { computeScenario } from "./compute";
import { enuFrame, toEcef, toEnu } from "./geodesy";
import { writeGlb } from "./glb";
import { humanScale } from "./humanScale";
import { blendDepth, layerDepth, scenarioKey } from "./scenario";
import { base64ToBytes, cellIndex, sampleGround, type SceneArrays, type SceneGrid } from "./sceneData";
import { floodStats } from "./stats";
import { buildWaterMesh, PERMANENT_DISPLAY_DEPTH } from "./waterMesh";

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

describe("geodesy", () => {
  it("matches known ECEF coordinates", () => {
    const [x, y, z] = toEcef(0, 0, 0);
    expect(x).toBeCloseTo(6378137, 3);
    expect(y).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(0, 6);
    const pole = toEcef(90, 0, 0);
    expect(pole[2]).toBeCloseTo(6356752.3142, 3);
  });

  it("maps a point 100 m north and 10 m up into ENU", () => {
    const frame = enuFrame(51.5, -0.12, 50);
    const metresPerDegLat = 111_257; // at 51.5 N
    const [e, n, u] = toEnu(frame, toEcef(51.5 + 100 / metresPerDegLat, -0.12, 60));
    expect(e).toBeCloseTo(0, 1);
    expect(n).toBeCloseTo(100, 0);
    expect(u).toBeCloseTo(10, 1);
  });
});

describe("writeGlb", () => {
  it("writes a valid GLB header and JSON chunk", () => {
    const glb = writeGlb({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      scalars: { _DEPTH: new Float32Array([1, 2, 3]) },
      indices: new Uint32Array([0, 1, 2]),
    });
    const view = new DataView(glb);
    expect(view.getUint32(0, true)).toBe(0x46546c67);
    expect(view.getUint32(8, true)).toBe(glb.byteLength);
    expect(glb.byteLength % 4).toBe(0);
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength)));
    const prim = json.meshes[0].primitives[0];
    expect(prim.attributes).toEqual({ POSITION: 0, _DEPTH: 1 });
    expect(json.accessors[0].max).toEqual([1, 1, 0]);
    expect(json.accessors[prim.indices].count).toBe(3);
  });

  it("rejects attribute names without an underscore", () => {
    expect(() =>
      writeGlb({ positions: new Float32Array(3), scalars: { DEPTH: new Float32Array(1) }, indices: new Uint32Array(0) }),
    ).toThrow();
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
    geoid: 40,
    layers: {
      10: new Uint16Array([0, 300, 0, 0, 0, 300, 0, 0, 0, 300, 0, 0]),
      20: new Uint16Array([100, 400, 100, 0, 100, 400, 100, 0, 100, 400, 100, 0]),
    },
  };
}

describe("buildWaterMesh", () => {
  it("returns null when nothing is wet", () => {
    const s = scene();
    s.permanent.fill(0);
    expect(buildWaterMesh({ ...s, depth: new Float32Array(12) })).toBeNull();
  });

  it("covers wet cells plus a ring, with bank vertices below the water level", () => {
    const s = scene();
    const mesh = buildWaterMesh({ ...s, depth: layerDepth(s.layers[10]) });
    expect(mesh).not.toBeNull();
    // Wet column 1 plus ring columns 0 and 2 -> 9 vertices; column 3 is not touched.
    expect(mesh!.vertices).toBe(9);
    expect(mesh!.maxDepth).toBe(3);
    expect(mesh!.triangles).toBe(8);
    expect(mesh!.origin.height).toBeCloseTo(40 + 13 / 4, 5);
  });

  it("shows permanent water without a modelled depth at the display depth", () => {
    const s = scene();
    const mesh = buildWaterMesh({ ...s, depth: new Float32Array(12) });
    expect(mesh!.maxDepth).toBe(PERMANENT_DISPLAY_DEPTH);
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
    expect(banks.mesh).not.toBeNull(); // permanent water still drawn

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
    expect(r.mesh).toBeNull();
  });
});
