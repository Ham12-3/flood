import type { ReplayGrid } from "./data";
import type { TileBounds } from "./render";

export type ReplayWorkerRequest =
  | {
      type: "init";
      grid: ReplayGrid;
      hours: number;
      frames: ArrayBuffer; // uint16 cm, hours x ny x nx
      features: ArrayBuffer;
      sea: Uint8Array;
    }
  | { type: "tile"; id: number; hour: number; bounds: TileBounds };

export type ReplayWorkerResponse =
  | { type: "ready"; buildings: number; roads: number }
  | { type: "tile"; id: number; bitmap: ImageBitmap }
  | { type: "error"; id: number | null; message: string };
