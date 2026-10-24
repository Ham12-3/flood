/// <reference lib="webworker" />
// Draws storm-replay map tiles off the main thread: water, wet roads and buildings.
import { decodeFeatures, decodeFrames, frame, type ReplayFeatures, type ReplayGrid } from "./data";
import type { ReplayWorkerRequest, ReplayWorkerResponse } from "./messages";
import { buildIndex, drawFeatures, paintWater, TILE, type FeatureIndex } from "./render";

interface State {
  grid: ReplayGrid;
  hours: number;
  frames: Uint16Array;
  features: ReplayFeatures;
  index: FeatureIndex;
  sea: Uint8Array;
}

let state: State | null = null;

function post(message: ReplayWorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message, transfer);
}

self.onmessage = (event: MessageEvent<ReplayWorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === "init") {
      const features = decodeFeatures(msg.features);
      state = {
        grid: msg.grid,
        hours: msg.hours,
        frames: decodeFrames(msg.frames, msg.hours, msg.grid),
        features,
        index: buildIndex(features, msg.grid),
        sea: msg.sea,
      };
      post({ type: "ready", buildings: features.buildingCells.length, roads: features.roadClasses.length });
      return;
    }
    if (!state) throw new Error("The replay is not loaded yet");
    const depth = frame(state.frames, state.grid, Math.min(Math.max(msg.hour, 0), state.hours - 1));
    const canvas = new OffscreenCanvas(TILE, TILE);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D canvas in this browser");
    const img = ctx.createImageData(TILE, TILE);
    paintWater(img.data, msg.bounds, state.grid, depth, state.sea);
    ctx.putImageData(img, 0, 0);
    drawFeatures(ctx, msg.bounds, state.grid, state.features, state.index, depth);
    const bitmap = canvas.transferToImageBitmap();
    post({ type: "tile", id: msg.id, bitmap }, [bitmap]);
  } catch (err) {
    post({ type: "error", id: msg.type === "tile" ? msg.id : null, message: err instanceof Error ? err.message : String(err) });
  }
};
