import { describe, expect, it } from "vitest";
import { BASEMAPS, baseStyle, LABELS_LAYER } from "./basemap";

describe("base maps", () => {
  it("use keyless HTTPS tile templates with credits", () => {
    for (const { layers } of Object.values(BASEMAPS)) {
      expect(layers.length).toBeGreaterThan(0);
      for (const l of layers) {
        expect(l.url).toMatch(/^https:\/\//);
        // Esri tile services order the template as z / y (row) / x (column).
        expect(l.url).toContain("/tile/{z}/{y}/{x}");
        expect(l.url).not.toMatch(/token|key=/i);
        expect(l.attribution.length).toBeGreaterThan(0);
        expect(l.maxzoom).toBeGreaterThanOrEqual(16);
      }
    }
  });

  it("puts labels on top of the base layer", () => {
    for (const { layers } of Object.values(BASEMAPS)) {
      expect(layers.at(-1)?.url).toContain("Reference");
    }
  });

  it("builds one style with every base layer, showing only the chosen ones", () => {
    const style = baseStyle("satellite");
    const visible = style.layers
      .filter((l) => l.type === "raster" && l.layout?.visibility === "visible")
      .map((l) => l.id);
    expect(visible).toEqual(["base-imagery", LABELS_LAYER]);
    expect(Object.keys(style.sources)).toHaveLength(3);
  });
});
