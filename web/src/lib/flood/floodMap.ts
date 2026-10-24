import type { CanvasSource, MapMouseEvent } from "maplibre-gl";
import { panelPadding, registerTiles, tileBounds, type MLMap } from "@/lib/maplibre";
import { depthRgb } from "./depthRamp";
import { cellIndex, sampleGround, type SceneArrays } from "./sceneData";
import { MIN_FLOOD_DEPTH_M } from "./stats";

export { DEPTH_STOPS } from "./depthRamp";

const PERMANENT_RGB: [number, number, number] = [0x39, 0x87, 0xe5];
const WATER_ALPHA = 205;
const OUTSIDE_FADE_KM = 1; // terrain beyond the window eases to the window's median height
const TILE = 256;
let instances = 0;

export interface HoverInfo {
  x: number; // client pixels, for the hover card
  y: number;
  lat: number;
  lon: number;
  groundM: number | null;
  depthM: number; // at the current rise
  permanent: boolean;
}

/** Depth shown at a rise of t (0 = water lowered by the deepest depth, 1 = final level). */
export function risenDepth(depth: number, t: number, maxDepth: number): number {
  return Math.max(0, depth - (1 - t) * maxDepth);
}

/**
 * Paint one pixel per cell: depth colours, rivers and lakes in a flat blue, dry cells clear.
 * `rgba` is nx * ny * 4.
 */
export function paintWater(
  rgba: Uint8ClampedArray,
  arrays: Pick<SceneArrays, "permanent" | "ground">,
  depth: Float32Array | null,
  t: number,
  maxDepth: number,
): void {
  rgba.fill(0);
  const n = arrays.permanent.length;
  for (let i = 0; i < n; i++) {
    const d = depth ? risenDepth(depth[i], t, maxDepth) : 0;
    let rgb: [number, number, number] | null = null;
    if (d >= MIN_FLOOD_DEPTH_M) rgb = depthRgb(d);
    else if (arrays.permanent[i] && Number.isFinite(arrays.ground[i])) rgb = PERMANENT_RGB;
    if (!rgb) continue;
    rgba[4 * i] = rgb[0];
    rgba[4 * i + 1] = rgb[1];
    rgba[4 * i + 2] = rgb[2];
    rgba[4 * i + 3] = WATER_ALPHA;
  }
}

function median(values: Float32Array): number {
  const finite = Array.from(values).filter(Number.isFinite).sort((a, b) => a - b);
  return finite.length ? finite[Math.floor(finite.length / 2)] : 0;
}

/** Ground height for terrain: the window inside, easing to its median height outside. */
export function terrainHeight(arrays: Pick<SceneArrays, "grid" | "ground">, lat: number, lon: number, mid: number): number {
  const g = arrays.grid;
  const h = sampleGround(arrays, lat, lon, mid);
  const dxKm = Math.max(g.west - lon, lon - g.east, 0) * (g.cellW / g.dx) / 1000;
  const dyKm = Math.max(g.south - lat, lat - g.north, 0) * (g.cellH / g.dy) / 1000;
  const d = Math.hypot(dxKm, dyKm);
  return d === 0 ? h : mid + (h - mid) * Math.exp(-d / OUTSIDE_FADE_KM);
}

/** Terrarium encoding: height = R * 256 + G + B / 256 - 32768. */
export function encodeTerrarium(h: number, out: Uint8ClampedArray, p: number): void {
  const v = Math.min(Math.max(h + 32768, 0), 65535.99);
  out[p] = Math.floor(v / 256);
  out[p + 1] = Math.floor(v) % 256;
  out[p + 2] = Math.floor((v - Math.floor(v)) * 256);
  out[p + 3] = 255;
}

/**
 * Owns everything the 3D flood view adds to the map: terrain from our height grid, the
 * water (a canvas with one pixel per cell, draped on the terrain), a dimmed surround and
 * the satellite overlay. Puts the flat map back on exit.
 */
export class FloodMap {
  private readonly map: MLMap;
  private readonly arrays: SceneArrays;
  private readonly name = `flood${++instances}`;
  private readonly canvas: HTMLCanvasElement;
  private readonly image: ImageData;
  private readonly mid: number;
  private depth: Float32Array | null = null;
  private maxDepth = 0;
  private progress = 1;
  private offTiles: (() => void) | null = null;
  private offHover: (() => void) | null = null;
  private overlayId: string | null = null;
  private destroyed = false;

  constructor(map: MLMap, arrays: SceneArrays) {
    this.map = map;
    this.arrays = arrays;
    this.canvas = document.createElement("canvas");
    this.canvas.width = arrays.grid.nx;
    this.canvas.height = arrays.grid.ny;
    this.image = new ImageData(arrays.grid.nx, arrays.grid.ny);
    this.mid = median(arrays.ground);
  }

  private id(part: string): string {
    return `${this.name}-${part}`;
  }

  private get corners(): [[number, number], [number, number], [number, number], [number, number]] {
    const g = this.arrays.grid;
    return [
      [g.west, g.north],
      [g.east, g.north],
      [g.east, g.south],
      [g.west, g.south],
    ];
  }

  /** Terrain, water and the camera. */
  enter(exaggeration: number): void {
    const { map, arrays } = this;
    const g = arrays.grid;
    this.offTiles = registerTiles(this.id("dem"), async (z, x, y) => this.demTile(z, x, y));
    map.addSource(this.id("dem"), {
      type: "raster-dem",
      tiles: [`fs://${this.id("dem")}/{z}/{x}/{y}`],
      tileSize: TILE,
      encoding: "terrarium",
      maxzoom: 14,
    });
    map.setTerrain({ source: this.id("dem"), exaggeration });

    // Dim everything outside the window.
    map.addSource(this.id("mask"), {
      type: "geojson",
      data: {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]],
            [[g.west, g.south], [g.west, g.north], [g.east, g.north], [g.east, g.south], [g.west, g.south]],
          ],
        },
      },
    });
    map.addLayer({ id: this.id("mask"), type: "fill", source: this.id("mask"), paint: { "fill-color": "#000", "fill-opacity": 0.45 } });

    paintWater(this.image.data, arrays, null, 1, 0);
    this.flush();
    map.addSource(this.id("water"), { type: "canvas", canvas: this.canvas, coordinates: this.corners, animate: false });
    map.addLayer({ id: this.id("water"), type: "raster", source: this.id("water"), paint: { "raster-fade-duration": 0 } });

    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    map.keyboard.enableRotation();
    const cam = map.cameraForBounds(
      [
        [g.west, g.south],
        [g.east, g.north],
      ],
      { padding: panelPadding() },
    );
    if (cam) map.flyTo({ ...cam, pitch: 55, bearing: -15, duration: 2000 });
  }

  setExaggeration(x: number): void {
    if (!this.destroyed) this.map.setTerrain({ source: this.id("dem"), exaggeration: x });
  }

  private demTile(z: number, x: number, y: number): ImageBitmap {
    const b = tileBounds(z, x, y);
    const canvas = new OffscreenCanvas(TILE, TILE);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D canvas");
    const img = ctx.createImageData(TILE, TILE);
    const n = 2 ** z;
    for (let j = 0; j < TILE; j++) {
      const row = y + (j + 0.5) / TILE;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
      for (let i = 0; i < TILE; i++) {
        const lon = b.west + ((i + 0.5) / TILE) * (b.east - b.west);
        encodeTerrarium(terrainHeight(this.arrays, lat, lon, this.mid), img.data, 4 * (j * TILE + i));
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.transferToImageBitmap();
  }

  private flush(): void {
    this.canvas.getContext("2d")?.putImageData(this.image, 0, 0);
  }

  /** Redraw the water and hand the new pixels to the map once. */
  private repaint(): void {
    paintWater(this.image.data, this.arrays, this.depth, this.progress, this.maxDepth);
    this.flush();
    const src = this.map.getSource(this.id("water")) as CanvasSource | undefined;
    if (!src) return;
    src.play();
    this.map.once("render", () => src.pause());
    this.map.triggerRepaint();
  }

  /** Replace the water. Pass null to clear it. */
  setWater(depth: Float32Array | null): void {
    if (this.destroyed) return;
    this.depth = depth;
    let max = 0;
    if (depth) for (const d of depth) if (d > max) max = d;
    this.maxDepth = max;
    this.repaint();
  }

  /** 0 = water lowered by the deepest depth (hidden), 1 = final flood level. */
  setProgress(t: number): void {
    this.progress = Math.min(Math.max(t, 0), 1);
    if (!this.destroyed) this.repaint();
  }

  depthAt(i: number): number {
    if (!this.depth || i < 0) return 0;
    return risenDepth(this.depth[i], this.progress, this.maxDepth);
  }

  /** Show a satellite water map (transparent PNG in lat/lon) on the terrain, or clear it. */
  setOverlay(url: string | null, bounds?: [number, number, number, number]): void {
    const { map } = this;
    if (this.overlayId) {
      if (map.getLayer(this.overlayId)) map.removeLayer(this.overlayId);
      if (map.getSource(this.overlayId)) map.removeSource(this.overlayId);
      this.overlayId = null;
    }
    if (!url || !bounds || this.destroyed) return;
    const [w, s, e, n] = bounds;
    this.overlayId = this.id("satellite");
    map.addSource(this.overlayId, { type: "image", url, coordinates: [[w, n], [e, n], [e, s], [w, s]] });
    map.addLayer({ id: this.overlayId, type: "raster", source: this.overlayId, paint: { "raster-opacity": 0.85 } });
  }

  enableHover(onHover: (info: HoverInfo | null) => void): void {
    const { map, arrays } = this;
    const move = (e: MapMouseEvent) => {
      const { lat, lng } = e.lngLat;
      const i = cellIndex(arrays.grid, lat, lng);
      if (i < 0) return onHover(null);
      const ground = arrays.ground[i];
      onHover({
        x: e.originalEvent.clientX,
        y: e.originalEvent.clientY,
        lat,
        lon: lng,
        groundM: Number.isFinite(ground) ? ground : null,
        depthM: this.depthAt(i),
        permanent: arrays.permanent[i] === 1,
      });
    };
    const leave = () => onHover(null);
    map.on("mousemove", move);
    map.on("mouseout", leave);
    this.offHover = () => {
      map.off("mousemove", move);
      map.off("mouseout", leave);
    };
  }

  exit(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.offHover?.();
    const { map } = this;
    try {
      this.setOverlay(null);
      map.setTerrain(null);
      for (const part of ["water", "mask", "dem"]) {
        const id = this.id(part);
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(id)) map.removeSource(id);
      }
      map.dragRotate.disable();
      map.touchZoomRotate.disableRotation();
      map.keyboard.disableRotation();
      map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
    } catch {
      // the map was already removed with the page
    }
    this.offTiles?.();
  }
}
