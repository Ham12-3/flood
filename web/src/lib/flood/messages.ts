import type { SceneArrays } from "./sceneData";
import type { FloodStats } from "./stats";

/** How the worker should produce a depth grid. The main thread resolves forecasts to maps. */
export type DepthRequest =
  | { kind: "layer"; rp: number }
  | { kind: "blend"; lower: number; upper: number; weight: number }
  | { kind: "banks" } // below the smallest map: permanent water only
  | { kind: "custom"; rise: number };

export type WorkerRequest =
  | { type: "init"; scene: SceneArrays }
  | { type: "compute"; id: number; request: DepthRequest };

export interface ComputeResult {
  type: "result";
  id: number;
  depth: Float32Array;
  stats: FloodStats;
  mesh: {
    glb: ArrayBuffer;
    origin: { lat: number; lon: number; height: number };
    maxDepth: number;
    vertices: number;
    triangles: number;
  } | null;
  /** Set when the scenario cannot be computed (e.g. no seeds for a custom rise). */
  notice: string | null;
  ms: number;
}

export type WorkerResponse = ComputeResult | { type: "error"; id: number; message: string } | { type: "ready" };
