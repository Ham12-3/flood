import type * as CesiumNS from "cesium";
import { enter3D, type Cesium } from "@/lib/cesium";
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
 * Owns everything the 3D flood view adds to the Cesium viewer, and puts the flat map back
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
  private restoreMode: (() => void) | null = null;
  private depth: Float32Array | null = null;
  private overlay: CesiumNS.ImageryLayer | null = null;
  private progress = 1;
  private maxDepth = 0;
  private destroyed = false;

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

  /** Switch to 3D, swap in our DEM as terrain, clip the globe to the window and fly there. */
  enter(): void {
    const { C, viewer, arrays } = this;
    this.restoreMode = enter3D(C, viewer);
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

  /** Replace the water surface. Pass null to clear it. */
  async setWater(mesh: WaterMesh | null, depth: Float32Array): Promise<void> {
    const { C, viewer } = this;
    this.depth = depth;
    const token = ++this.modelToken;
    if (!mesh) {
      this.removeModel();
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
  }

  /** Show a satellite water map (transparent PNG in lat/lon) over the terrain, or clear it. */
  async setOverlay(url: string | null, bounds?: [number, number, number, number]): Promise<void> {
    const { C, viewer } = this;
    if (this.overlay) {
      viewer.imageryLayers.remove(this.overlay, true);
      this.overlay = null;
    }
    if (!url || !bounds || this.destroyed) return;
    const provider = await C.SingleTileImageryProvider.fromUrl(url, {
      rectangle: C.Rectangle.fromDegrees(...bounds),
    });
    if (this.destroyed) return;
    this.overlay = viewer.imageryLayers.addImageryProvider(provider);
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
    if (this.overlay) viewer.imageryLayers.remove(this.overlay, true);
    this.handler?.destroy();
    this.removeLeave?.();
    this.removePreRender?.();
    if (viewer.isDestroyed()) return;
    const globe = viewer.scene.globe;
    globe.cartographicLimitRectangle = C.Rectangle.MAX_VALUE;
    if (this.previousTerrain) viewer.scene.terrainProvider = this.previousTerrain;
    this.restoreMode?.();
  }
}
