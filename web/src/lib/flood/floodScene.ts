import type * as CesiumNS from "cesium";
import type { Cesium } from "@/lib/cesium";
import { cellIndex, sampleGround, type SceneArrays } from "./sceneData";
import type { WaterMesh } from "./waterMesh";

/** Depth colour stops in metres; one blue hue, light to dark (colour-blind safe). */
export const DEPTH_STOPS: { depth: number; color: string }[] = [
  { depth: 0, color: "#9ec5f4" },
  { depth: 0.5, color: "#6da7ec" },
  { depth: 1, color: "#3987e5" },
  { depth: 2, color: "#256abf" },
  { depth: 3, color: "#184f95" },
  { depth: 5, color: "#0d366b" },
];
const PERMANENT_COLOR = "#3987e5";
const FLOODED_BUILDING = "#eb6834"; // categorical orange: reads against the blue water
const BUILDING_WET_THRESHOLD_M = 0.05;

function glslColor(hex: string): string {
  const v = [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(4));
  return `vec3(${v.join(", ")})`;
}

function rampGlsl(): string {
  const lines = ["vec3 depthRamp(float d) {", `  vec3 c = ${glslColor(DEPTH_STOPS[0].color)};`];
  for (let i = 1; i < DEPTH_STOPS.length; i++) {
    const a = DEPTH_STOPS[i - 1];
    const b = DEPTH_STOPS[i];
    lines.push(
      `  c = mix(c, ${glslColor(b.color)}, clamp((d - ${a.depth.toFixed(2)}) / ${(b.depth - a.depth).toFixed(2)}, 0.0, 1.0));`,
    );
  }
  lines.push("  return c;", "}");
  return lines.join("\n");
}

export interface HoverInfo {
  x: number;
  y: number;
  lat: number;
  lon: number;
  groundM: number | null;
  depthM: number; // at the current rise
  permanent: boolean;
}

/**
 * Owns everything the 3D flood view adds to the Cesium viewer, and puts the globe back
 * the way it was on exit.
 */
export class FloodScene {
  private readonly C: Cesium;
  private readonly viewer: CesiumNS.Viewer;
  private readonly arrays: SceneArrays;
  private previousTerrain: CesiumNS.TerrainProvider | null = null;
  private model: CesiumNS.Model | null = null;
  private modelToken = 0;
  private readonly shader: CesiumNS.CustomShader;
  private removePreRender: (() => void) | null = null;
  private handler: CesiumNS.ScreenSpaceEventHandler | null = null;
  private removeLeave: (() => void) | null = null;
  private buildings: CesiumNS.Cesium3DTileset | null = null;
  private readonly buildingCells = new Map<string, number>();
  private depth: Float32Array | null = null;
  private progress = 1;
  private maxDepth = 0;
  private destroyed = false;
  onBuildingsChanged: (() => void) | null = null;

  constructor(C: Cesium, viewer: CesiumNS.Viewer, arrays: SceneArrays) {
    this.C = C;
    this.viewer = viewer;
    this.arrays = arrays;
    this.shader = new C.CustomShader({
      lightingModel: C.LightingModel.UNLIT,
      translucencyMode: C.CustomShaderTranslucencyMode.TRANSLUCENT,
      uniforms: {
        u_progress: { type: C.UniformType.FLOAT, value: 1 },
        u_maxDepth: { type: C.UniformType.FLOAT, value: 0 },
        u_time: { type: C.UniformType.FLOAT, value: 0 },
      },
      // Cesium already declares v_<name> for each custom attribute (v_depth, v_kind),
      // so our own varyings use a different prefix.
      varyings: {
        v_waterLift: C.VaryingType.FLOAT,
        v_waterKind: C.VaryingType.FLOAT,
        v_waterXY: C.VaryingType.VEC2,
      },
      vertexShaderText: `
        void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {
          float lift = vsInput.attributes.depth - (1.0 - u_progress) * u_maxDepth;
          vsOutput.positionMC.z += lift;
          v_waterLift = lift;
          v_waterKind = vsInput.attributes.kind;
          v_waterXY = vsInput.attributes.positionMC.xy;
        }`,
      fragmentShaderText: `
        ${rampGlsl()}
        void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
          float d = max(v_waterLift, 0.0);
          vec3 c = mix(depthRamp(d), ${glslColor(PERMANENT_COLOR)}, clamp(v_waterKind, 0.0, 1.0));
          // Gentle ripples: two drifting wave patterns in local metres.
          float t = u_time;
          float r = sin(v_waterXY.x * 0.21 + t * 1.3) * sin(v_waterXY.y * 0.17 - t * 1.1)
                  + 0.5 * sin((v_waterXY.x + v_waterXY.y) * 0.37 + t * 2.1);
          material.diffuse = clamp(c + 0.045 * r, 0.0, 1.0);
          material.alpha = 0.8;
        }`,
    });
  }

  /** Swap in our DEM as terrain, clip the globe to the window and fly there. */
  enter(hasIonToken: boolean): void {
    const { C, viewer, arrays } = this;
    const { grid, geoid } = arrays;
    const tiling = new C.GeographicTilingScheme();
    const size = 65;
    const provider = new C.CustomHeightmapTerrainProvider({
      width: size,
      height: size,
      tilingScheme: tiling,
      callback: (x, y, level) => {
        const r = tiling.tileXYToRectangle(x, y, level);
        const west = C.Math.toDegrees(r.west);
        const east = C.Math.toDegrees(r.east);
        const north = C.Math.toDegrees(r.north);
        const south = C.Math.toDegrees(r.south);
        const out = new Float32Array(size * size);
        for (let j = 0; j < size; j++) {
          const lat = north - ((north - south) * j) / (size - 1);
          for (let i = 0; i < size; i++) {
            const lon = west + ((east - west) * i) / (size - 1);
            out[j * size + i] = sampleGround(arrays, lat, lon, 0) + geoid;
          }
        }
        return out;
      },
    });
    this.previousTerrain = viewer.scene.terrainProvider;
    viewer.scene.terrainProvider = provider;
    const globe = viewer.scene.globe;
    globe.cartographicLimitRectangle = C.Rectangle.fromDegrees(grid.west, grid.south, grid.east, grid.north);
    globe.depthTestAgainstTerrain = true;
    if (!hasIonToken) {
      // The offline Natural Earth image is too coarse at this scale; shade by height instead.
      globe.material = this.elevationMaterial();
    }

    const centre = C.Cartesian3.fromDegrees(
      (grid.west + grid.east) / 2,
      (grid.south + grid.north) / 2,
      sampleGround(arrays, (grid.south + grid.north) / 2, (grid.west + grid.east) / 2) + geoid,
    );
    const radius = Math.max(grid.nx * grid.cellW, grid.ny * grid.cellH) / 2;
    viewer.camera.flyToBoundingSphere(new C.BoundingSphere(centre, radius), {
      offset: new C.HeadingPitchRange(0, C.Math.toRadians(-38), radius * 2.4),
      duration: 2,
    });

    this.removePreRender = viewer.scene.preRender.addEventListener(() => {
      this.shader.setUniform("u_time", (performance.now() / 1000) % 1000);
    });
  }

  private elevationMaterial(): CesiumNS.Material {
    const { C, arrays } = this;
    let min = Infinity;
    let max = -Infinity;
    for (const h of arrays.ground) {
      if (!Number.isFinite(h)) continue;
      if (h < min) min = h;
      if (h > max) max = h;
    }
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const g = ctx.createLinearGradient(0, 0, 256, 0);
      g.addColorStop(0, "#3d4a3a");
      g.addColorStop(0.5, "#8a8f74");
      g.addColorStop(1, "#d8d4c4");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 1);
    }
    return C.Material.fromType("ElevationRamp", {
      image: canvas,
      minimumHeight: min + arrays.geoid,
      maximumHeight: Math.max(max, min + 1) + arrays.geoid,
    });
  }

  /** Replace the water surface. Pass null to clear it. */
  async setWater(mesh: WaterMesh | null, depth: Float32Array): Promise<void> {
    const { C, viewer } = this;
    this.depth = depth;
    const token = ++this.modelToken;
    if (!mesh) {
      this.removeModel();
      this.refreshBuildings();
      return;
    }
    const url = URL.createObjectURL(new Blob([mesh.glb], { type: "model/gltf-binary" }));
    try {
      const model = await C.Model.fromGltfAsync({
        url,
        modelMatrix: C.Transforms.eastNorthUpToFixedFrame(
          C.Cartesian3.fromDegrees(mesh.origin.lon, mesh.origin.lat, mesh.origin.height),
        ),
        // Positions are already east-north-up; skip glTF's Y-up / Z-forward correction.
        upAxis: C.Axis.Z,
        forwardAxis: C.Axis.X,
        customShader: this.shader,
        backFaceCulling: false,
        allowPicking: false,
        cull: false,
      });
      if (this.destroyed || token !== this.modelToken) {
        model.destroy();
        return;
      }
      this.removeModel();
      this.model = viewer.scene.primitives.add(model) as CesiumNS.Model;
      this.maxDepth = mesh.maxDepth;
      this.shader.setUniform("u_maxDepth", mesh.maxDepth);
      this.setProgress(this.progress);
      model.readyEvent.addEventListener(() => URL.revokeObjectURL(url));
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
    this.refreshBuildings();
  }

  /** 0 = water lowered by the deepest depth (hidden), 1 = final flood level. */
  setProgress(t: number): void {
    this.progress = Math.min(Math.max(t, 0), 1);
    this.shader.setUniform("u_progress", this.progress);
  }

  /** Depth at a cell for the current rise, matching what the shader draws. */
  depthAt(i: number): number {
    if (!this.depth || i < 0) return 0;
    return Math.max(0, this.depth[i] - (1 - this.progress) * this.maxDepth);
  }

  enableHover(onHover: (info: HoverInfo | null) => void): void {
    const { C, viewer, arrays } = this;
    let pending: CesiumNS.Cartesian2 | null = null;
    let raf = 0;
    const run = () => {
      raf = 0;
      if (!pending) return;
      const pos = pending;
      pending = null;
      const ray = viewer.camera.getPickRay(pos);
      const hit = ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined;
      if (!hit) return onHover(null);
      const carto = C.Cartographic.fromCartesian(hit);
      const lat = C.Math.toDegrees(carto.latitude);
      const lon = C.Math.toDegrees(carto.longitude);
      const i = cellIndex(arrays.grid, lat, lon);
      if (i < 0) return onHover(null);
      const g = arrays.ground[i];
      onHover({
        x: pos.x,
        y: pos.y,
        lat,
        lon,
        groundM: Number.isFinite(g) ? g : null,
        depthM: this.depthAt(i),
        permanent: arrays.permanent[i] === 1,
      });
    };
    const canvas = viewer.scene.canvas;
    const leave = () => {
      pending = null;
      onHover(null);
    };
    canvas.addEventListener("mouseleave", leave);
    this.removeLeave = () => canvas.removeEventListener("mouseleave", leave);
    this.handler = new C.ScreenSpaceEventHandler(canvas);
    this.handler.setInputAction((e: CesiumNS.ScreenSpaceEventHandler.MotionEvent) => {
      pending = e.endPosition.clone();
      if (!raf) raf = requestAnimationFrame(run);
    }, C.ScreenSpaceEventType.MOUSE_MOVE);
  }

  /**
   * Load Cesium OSM Buildings (needs an ion token) and track each building's centre cell.
   * Buildings outside the window are hidden; flooded ones are tinted.
   */
  async loadBuildings(): Promise<void> {
    const { C, viewer, arrays } = this;
    const tileset = await C.createOsmBuildingsAsync();
    if (this.destroyed) {
      tileset.destroy();
      return;
    }
    tileset.tileLoad.addEventListener((tile: CesiumNS.Cesium3DTile) => {
      const content = tile.content;
      let added = false;
      for (let k = 0; k < content.featuresLength; k++) {
        const f = content.getFeature(k);
        const lat = Number(f.getProperty("cesium#latitude"));
        const lon = Number(f.getProperty("cesium#longitude"));
        const i = cellIndex(arrays.grid, lat, lon);
        if (i < 0) continue;
        const id = String(f.getProperty("elementId") ?? `${lat},${lon}`);
        if (!this.buildingCells.has(id)) {
          this.buildingCells.set(id, i);
          added = true;
        }
      }
      if (added) this.onBuildingsChanged?.();
    });
    const cellOf = (f: CesiumNS.Cesium3DTileFeature) =>
      cellIndex(arrays.grid, Number(f.getProperty("cesium#latitude")), Number(f.getProperty("cesium#longitude")));
    const white = C.Color.WHITE.withAlpha(0.95);
    const wet = C.Color.fromCssColorString(FLOODED_BUILDING);
    const style = new C.Cesium3DTileStyle();
    // Custom expressions: plain objects with evaluate / evaluateColor (see Cesium3DTileStyle docs).
    style.show = { evaluate: (f: CesiumNS.Cesium3DTileFeature) => cellOf(f) >= 0 } as unknown as CesiumNS.StyleExpression;
    style.color = {
      evaluateColor: (f: CesiumNS.Cesium3DTileFeature, result?: CesiumNS.Color) => {
        const i = cellOf(f);
        const c = this.depth && i >= 0 && this.depth[i] > BUILDING_WET_THRESHOLD_M ? wet : white;
        return C.Color.clone(c, result);
      },
    } as unknown as CesiumNS.StyleExpression;
    tileset.style = style;
    this.buildings = viewer.scene.primitives.add(tileset) as CesiumNS.Cesium3DTileset;
  }

  /** Buildings whose centre is in water at the final flood level. */
  buildingCounts(): { loaded: number; touched: number } | null {
    if (!this.buildings) return null;
    let touched = 0;
    for (const i of this.buildingCells.values()) {
      if (this.depth && this.depth[i] > BUILDING_WET_THRESHOLD_M) touched++;
    }
    return { loaded: this.buildingCells.size, touched };
  }

  private refreshBuildings(): void {
    this.buildings?.makeStyleDirty();
    this.onBuildingsChanged?.();
  }

  private removeModel(): void {
    if (this.model) {
      this.viewer.scene.primitives.remove(this.model); // also destroys it
      this.model = null;
    }
  }

  exit(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const { C, viewer } = this;
    this.removeModel();
    if (this.buildings) viewer.scene.primitives.remove(this.buildings);
    this.handler?.destroy();
    this.removeLeave?.();
    this.removePreRender?.();
    if (viewer.isDestroyed()) return;
    const globe = viewer.scene.globe;
    globe.cartographicLimitRectangle = C.Rectangle.MAX_VALUE;
    globe.material = undefined as unknown as CesiumNS.Material;
    if (this.previousTerrain) viewer.scene.terrainProvider = this.previousTerrain;
  }
}
