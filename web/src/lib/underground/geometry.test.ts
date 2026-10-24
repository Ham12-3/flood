import { describe, expect, it } from "vitest";
import { groundwaterOffsetM, layerBoxes, rankText, wetnessColor } from "./geometry";

describe("wetnessColor", () => {
  it("runs light (dry) to dark (wet) and greys out missing values", () => {
    expect(wetnessColor(0)).toBe("#cde2fb");
    expect(wetnessColor(100)).toBe("#0d366b");
    expect(wetnessColor(150)).toBe("#0d366b");
    expect(wetnessColor(null)).toBe("#8f8e86");
    expect(wetnessColor(Number.NaN)).toBe("#8f8e86");
  });
});

describe("layerBoxes", () => {
  it("stacks the four soil layers without gaps, exaggerated", () => {
    const boxes = layerBoxes(
      [
        { top_cm: 0, bottom_cm: 7 },
        { top_cm: 7, bottom_cm: 28 },
        { top_cm: 28, bottom_cm: 100 },
        { top_cm: 100, bottom_cm: 255 },
      ],
      10,
    );
    expect(boxes[0].drawnHeightM).toBeCloseTo(0.7);
    expect(boxes[0].centreOffsetM).toBeCloseTo(-0.35);
    expect(boxes[3].drawnHeightM).toBeCloseTo(15.5);
    // Bottom of each box meets the top of the next.
    for (let i = 0; i < boxes.length - 1; i++) {
      const bottom = boxes[i].centreOffsetM - boxes[i].drawnHeightM / 2;
      const nextTop = boxes[i + 1].centreOffsetM + boxes[i + 1].drawnHeightM / 2;
      expect(bottom).toBeCloseTo(nextTop);
    }
  });
});

describe("groundwaterOffsetM", () => {
  it("uses the true depth and handles missing data", () => {
    expect(groundwaterOffsetM(13.57)).toBeCloseTo(-13.57);
    expect(groundwaterOffsetM(-2)).toBeCloseTo(0); // artesian: water at the surface
    expect(groundwaterOffsetM(null)).toBeNull();
  });
});

describe("rankText", () => {
  it("phrases the percentile and its extremes", () => {
    expect(rankText(62.4)).toBe("wetter than 62% of past days");
    expect(rankText(0)).toBe("drier than any past day at this time of year");
    expect(rankText(100)).toBe("wetter than any past day at this time of year");
    expect(rankText(null)).toBeNull();
  });
});
