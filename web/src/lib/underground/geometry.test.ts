import { describe, expect, it } from "vitest";
import { groundwaterOffsetM, rankText, wetnessColor } from "./geometry";

describe("wetnessColor", () => {
  it("runs light (dry) to dark (wet) and greys out missing values", () => {
    expect(wetnessColor(0)).toBe("#cde2fb");
    expect(wetnessColor(100)).toBe("#0d366b");
    expect(wetnessColor(150)).toBe("#0d366b");
    expect(wetnessColor(null)).toBe("#8f8e86");
    expect(wetnessColor(Number.NaN)).toBe("#8f8e86");
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
