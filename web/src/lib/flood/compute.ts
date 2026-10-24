import { connectedFlood } from "./floodfill";
import type { ComputeResult, DepthRequest } from "./messages";
import { blendDepth, layerDepth } from "./scenario";
import type { SceneArrays } from "./sceneData";
import { floodStats } from "./stats";
import { buildWaterMesh } from "./waterMesh";

/** Everything the worker does for one scenario. Kept separate from the worker so it is testable. */
export function computeScenario(scene: SceneArrays, request: DepthRequest, id: number): ComputeResult {
  const t0 = performance.now();
  const n = scene.grid.nx * scene.grid.ny;
  let depth: Float32Array;
  let notice: string | null = null;

  switch (request.kind) {
    case "layer": {
      const layer = scene.layers[request.rp];
      if (!layer) throw new Error(`No 1-in-${request.rp} layer for this window`);
      depth = layerDepth(layer);
      break;
    }
    case "blend": {
      const lower = scene.layers[request.lower];
      const upper = scene.layers[request.upper];
      if (!lower || !upper) throw new Error("Hazard layers missing for this window");
      depth = blendDepth(lower, upper, request.weight);
      break;
    }
    case "banks":
      depth = new Float32Array(n);
      break;
    case "given":
      if (request.depth.length !== n) throw new Error("Depth grid does not match the scene");
      depth = request.depth;
      break;
    case "custom": {
      const result = connectedFlood(scene.ground, scene.permanent, scene.grid.nx, scene.grid.ny, request.rise);
      depth = result.depth;
      if (result.seeds === 0) {
        notice = "No river or lake (permanent water) in this window to start the flood from.";
      }
      break;
    }
  }

  const stats = floodStats(depth, scene.permanent, scene.grid.cellW * scene.grid.cellH);
  const mesh = buildWaterMesh({
    grid: scene.grid,
    ground: scene.ground,
    depth,
    permanent: scene.permanent,
    geoid: scene.geoid,
  });
  return { type: "result", id, depth, stats, mesh, notice, ms: performance.now() - t0 };
}
