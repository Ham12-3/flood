/// <reference lib="webworker" />
// Heavy flood maths (map blending, connected fill, water mesh) off the main thread.
import { computeScenario } from "./compute";
import type { WorkerRequest, WorkerResponse } from "./messages";
import type { SceneArrays } from "./sceneData";

let scene: SceneArrays | null = null;

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message, transfer);
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type === "init") {
    scene = msg.scene;
    post({ type: "ready" });
    return;
  }
  if (!scene) {
    post({ type: "error", id: msg.id, message: "Worker has no scene yet" });
    return;
  }
  try {
    const result = computeScenario(scene, msg.request, msg.id);
    post(result, [result.depth.buffer]);
  } catch (err) {
    post({ type: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
