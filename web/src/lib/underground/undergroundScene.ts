import type * as CesiumNS from "cesium";
import type { GroundResponse } from "@/lib/api";
import { enter3D, type Cesium } from "@/lib/cesium";
import { BLOCK_WIDTH_M, groundwaterOffsetM, layerBoxes, rankText, VERTICAL_EXAGGERATION, wetnessColor } from "./geometry";

const TRANSLUCENT_RADIUS_DEG = 0.02;

/**
 * Switches the flat map to 3D, turns the ground see-through around a point, lets the
 * camera go under the surface, and draws the soil cut-away and the water table.
 * Restores everything on exit.
 */
export class UndergroundScene {
  private readonly C: Cesium;
  private readonly viewer: CesiumNS.Viewer;
  private readonly entities: CesiumNS.Entity[] = [];
  private destroyed = false;
  private restoreMode: (() => void) | null = null;
  private readonly saved: { collision: boolean; translucency: boolean; alpha: number };

  constructor(C: Cesium, viewer: CesiumNS.Viewer) {
    this.C = C;
    this.viewer = viewer;
    const t = viewer.scene.globe.translucency;
    this.saved = {
      collision: viewer.scene.screenSpaceCameraController.enableCollisionDetection,
      translucency: t.enabled,
      alpha: t.frontFaceAlpha,
    };
  }

  async enter(lat: number, lon: number, data: GroundResponse, formatDepth: (m: number) => string): Promise<void> {
    const { C, viewer } = this;
    this.restoreMode = enter3D(C, viewer);
    const scene = viewer.scene;
    const globe = scene.globe;
    globe.translucency.enabled = true;
    globe.translucency.frontFaceAlpha = 0.35;
    globe.translucency.rectangle = C.Rectangle.fromDegrees(
      lon - TRANSLUCENT_RADIUS_DEG,
      lat - TRANSLUCENT_RADIUS_DEG,
      lon + TRANSLUCENT_RADIUS_DEG,
      lat + TRANSLUCENT_RADIUS_DEG,
    );
    scene.screenSpaceCameraController.enableCollisionDetection = false;

    const surface = await this.surfaceHeight(lat, lon);
    if (this.destroyed) return;
    const at = (offset: number) => C.Cartesian3.fromDegrees(lon, lat, surface + offset);
    const label = (text: string) => ({
      text,
      font: "13px sans-serif",
      fillColor: C.Color.WHITE,
      showBackground: true,
      backgroundColor: C.Color.fromCssColorString("#1a1a19").withAlpha(0.85),
      horizontalOrigin: C.HorizontalOrigin.LEFT,
      verticalOrigin: C.VerticalOrigin.CENTER,
      pixelOffset: new C.Cartesian2(10, 0),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });

    const layerLines: string[] = [];
    if (data.soil.status === "ok") {
      const boxes = layerBoxes(data.soil.layers);
      data.soil.layers.forEach((layer, i) => {
        const box = boxes[i];
        const color = C.Color.fromCssColorString(wetnessColor(layer.relative_wetness_pct)).withAlpha(0.92);
        this.add({
          position: at(box.centreOffsetM),
          box: {
            dimensions: new C.Cartesian3(BLOCK_WIDTH_M, BLOCK_WIDTH_M, box.drawnHeightM),
            material: color,
            outline: true,
            outlineColor: C.Color.fromCssColorString("#1a1a19"),
          },
        });
        const value = layer.value === null ? "no value" : `${layer.value.toFixed(2)} m³/m³`;
        const ranked = rankText(layer.season_percentile);
        const rank = ranked ? `, ${ranked}` : "";
        layerLines.push(`${layer.top_cm}–${layer.bottom_cm} cm: ${value}${rank}`);
      });
    }
    const blockDepth = (255 / 100) * VERTICAL_EXAGGERATION;
    if (layerLines.length) {
      this.add({
        // Labels sit on the west (left) side so the side panel never covers them.
        position: C.Cartesian3.fromDegrees(lon - this.metresToLon(lat, BLOCK_WIDTH_M / 2), lat, surface - blockDepth / 2),
        label: {
          ...label([`Soil layers (drawn ×${VERTICAL_EXAGGERATION} deeper)`, ...layerLines].join("\n")),
          horizontalOrigin: C.HorizontalOrigin.RIGHT,
          pixelOffset: new C.Cartesian2(-10, 0),
        },
      });
    }

    const station = data.groundwater.status === "ok" ? data.groundwater.station : null;
    const gwOffset = groundwaterOffsetM(station?.depth_below_datum_m);
    if (station && gwOffset !== null) {
      const d = this.metresToLat(BLOCK_WIDTH_M);
      const e = this.metresToLon(lat, BLOCK_WIDTH_M);
      this.add({
        rectangle: {
          coordinates: C.Rectangle.fromDegrees(lon - e, lat - d, lon + e, lat + d),
          height: surface + gwOffset,
          material: C.Color.fromCssColorString("#3987e5").withAlpha(0.55),
          outline: true,
          outlineColor: C.Color.fromCssColorString("#9ec5f4"),
        },
      });
      this.add({
        polyline: {
          positions: [at(0), at(gwOffset)],
          width: 2,
          material: new C.PolylineDashMaterialProperty({ color: C.Color.fromCssColorString("#9ec5f4") }),
        },
      });
      this.add({
        position: C.Cartesian3.fromDegrees(lon - this.metresToLon(lat, BLOCK_WIDTH_M / 2), lat, surface + gwOffset),
        label: {
          ...label(
            [
              `Water table about ${formatDepth(station.depth_below_datum_m ?? 0)} down (true depth)`,
              `${station.label} borehole, ${station.distance_km.toFixed(1)} km away`,
            ].join("\n"),
          ),
          horizontalOrigin: C.HorizontalOrigin.RIGHT,
          pixelOffset: new C.Cartesian2(-10, 0),
        },
      });
    }

    // Look at the cut-away from the side, from just below the surface.
    const deepest = Math.min(-blockDepth, gwOffset ?? 0);
    const centre = at(deepest / 2);
    const radius = Math.max(Math.abs(deepest) / 2, BLOCK_WIDTH_M);
    viewer.camera.flyToBoundingSphere(new C.BoundingSphere(centre, radius), {
      offset: new C.HeadingPitchRange(C.Math.toRadians(35), C.Math.toRadians(-5), radius * 3.2),
      duration: 1.5,
    });
  }

  private add(options: CesiumNS.Entity.ConstructorOptions): void {
    this.entities.push(this.viewer.entities.add(options));
  }

  private metresToLat(m: number): number {
    return m / 111_320;
  }

  private metresToLon(lat: number, m: number): number {
    return m / (111_320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  }

  private async surfaceHeight(lat: number, lon: number): Promise<number> {
    const { C, viewer } = this;
    try {
      const [p] = await C.sampleTerrainMostDetailed(viewer.terrainProvider, [C.Cartographic.fromDegrees(lon, lat)]);
      return Number.isFinite(p.height) ? p.height : 0;
    } catch {
      return 0; // smooth ellipsoid (no terrain): the surface is at height 0
    }
  }

  exit(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const { viewer } = this;
    if (viewer.isDestroyed()) return;
    for (const e of this.entities) viewer.entities.remove(e);
    const t = viewer.scene.globe.translucency;
    t.enabled = this.saved.translucency;
    t.frontFaceAlpha = this.saved.alpha;
    t.rectangle = this.C.Rectangle.MAX_VALUE;
    viewer.scene.screenSpaceCameraController.enableCollisionDetection = this.saved.collision;
    this.restoreMode?.();
  }
}
