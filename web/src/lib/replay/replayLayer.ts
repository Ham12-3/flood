import type { MapMouseEvent } from "maplibre-gl";
import { LABELS_LAYER } from "@/lib/basemap";
import { panelPadding, registerTiles, tileBounds, type MLMap } from "@/lib/maplibre";
import { cellAt, type ReplayGrid } from "./data";
import type { ReplayWorkerRequest, ReplayWorkerResponse } from "./messages";

const TILE_LOAD_TIMEOUT_MS = 20_000;
let instances = 0;

export interface ReplayHover {
  lat: number;
  lon: number;
  cell: number;
}

/**
 * Shows a storm replay on the map as raster tiles that the worker draws. Each hour is
 * its own source; a new hour goes on top and the old one is removed once the new
 * tiles are in, so the map never flashes empty.
 */
export class ReplayLayer {
  private readonly map: MLMap;
  private readonly worker: Worker;
  private readonly grid: ReplayGrid;
  private readonly name = `replay${++instances}`;
  private readonly pending = new Map<number, { resolve(b: ImageBitmap): void; reject(e: Error): void }>();
  private readonly offs = new Map<string, () => void>(); // tile handlers of the hours on the map
  private nextId = 1;
  private current: string | null = null;
  private showToken = 0;
  private hoverOff: (() => void) | null = null;
  private destroyed = false;

  constructor(map: MLMap, worker: Worker, grid: ReplayGrid) {
    this.map = map;
    this.worker = worker;
    this.grid = grid;
    worker.addEventListener("message", this.onMessage);
  }

  private onMessage = (e: MessageEvent<ReplayWorkerResponse>) => {
    const msg = e.data;
    if (msg.type === "tile") {
      this.pending.get(msg.id)?.resolve(msg.bitmap);
      this.pending.delete(msg.id);
    } else if (msg.type === "error" && msg.id !== null) {
      this.pending.get(msg.id)?.reject(new Error(msg.message));
      this.pending.delete(msg.id);
    }
  };

  private drawTile(hour: number, z: number, x: number, y: number): Promise<ImageBitmap> {
    const id = this.nextId++;
    return new Promise<ImageBitmap>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const msg: ReplayWorkerRequest = { type: "tile", id, hour, bounds: tileBounds(z, x, y) };
      this.worker.postMessage(msg);
    });
  }

  /** Show an hour. Resolves once its tiles are drawn (or a newer hour was asked for). */
  async show(hour: number): Promise<void> {
    if (this.destroyed) return;
    const { map, grid } = this;
    const token = ++this.showToken;
    const id = `${this.name}-${hour}-${token}`;
    this.offs.set(id, registerTiles(id, (z, x, y) => this.drawTile(hour, z, x, y)));
    map.addSource(id, {
      type: "raster",
      tiles: [`fs://${id}/{z}/{x}/{y}`],
      tileSize: 256,
      maxzoom: 18,
      bounds: [grid.west, grid.south, grid.east, grid.north],
    });
    map.addLayer(
      { id, type: "raster", source: id, paint: { "raster-fade-duration": 0 } },
      map.getLayer(LABELS_LAYER) ? LABELS_LAYER : undefined,
    );
    await this.loaded(id);
    if (this.destroyed) return;
    if (token !== this.showToken) {
      this.remove(id); // a newer hour took over
      return;
    }
    const old = this.current;
    this.current = id;
    if (old) this.remove(old);
  }

  private remove(id: string): void {
    if (this.map.getLayer(id)) this.map.removeLayer(id);
    if (this.map.getSource(id)) this.map.removeSource(id);
    this.offs.get(id)?.();
    this.offs.delete(id);
  }

  private loaded(id: string): Promise<void> {
    return new Promise((resolve) => {
      const started = performance.now();
      const tick = () => {
        if (this.destroyed || !this.map.getSource(id)) return resolve();
        if (this.map.isSourceLoaded(id) || performance.now() - started > TILE_LOAD_TIMEOUT_MS) return resolve();
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  fit(): void {
    const { grid } = this;
    this.map.fitBounds(
      [
        [grid.west, grid.south],
        [grid.east, grid.north],
      ],
      { padding: panelPadding(), duration: 1500 },
    );
  }

  enableHover(onHover: (h: ReplayHover | null) => void): void {
    const move = (e: MapMouseEvent) => {
      const cell = cellAt(this.grid, e.lngLat.lng, e.lngLat.lat);
      onHover(cell < 0 ? null : { lat: e.lngLat.lat, lon: e.lngLat.lng, cell });
    };
    const leave = () => onHover(null);
    this.map.on("mousemove", move);
    this.map.on("mouseout", leave);
    this.hoverOff = () => {
      this.map.off("mousemove", move);
      this.map.off("mouseout", leave);
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.worker.removeEventListener("message", this.onMessage);
    for (const p of this.pending.values()) p.reject(new Error("Replay closed"));
    this.pending.clear();
    this.hoverOff?.();
    try {
      for (const id of [...this.offs.keys()]) this.remove(id);
    } catch {
      // the map was already removed with the page
    }
  }
}
