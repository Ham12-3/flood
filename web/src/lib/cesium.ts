import type * as CesiumNS from "cesium";

export type Cesium = typeof CesiumNS;

declare global {
  interface Window {
    Cesium?: Cesium;
    CESIUM_BASE_URL?: string;
  }
}

const BASE = "/cesium/";
let loading: Promise<Cesium> | null = null;

/**
 * Load the prebuilt Cesium bundle from /public/cesium (copied there by
 * scripts/copy-cesium.mjs). Keeping Cesium out of the app bundle avoids bundler
 * issues with its workers and keeps the first page load small.
 */
export function loadCesium(): Promise<Cesium> {
  if (window.Cesium) return Promise.resolve(window.Cesium);
  if (loading) return loading;
  window.CESIUM_BASE_URL = BASE;
  loading = new Promise<Cesium>((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${BASE}Widgets/widgets.css`;
    document.head.appendChild(css);

    const script = document.createElement("script");
    script.src = `${BASE}Cesium.js`;
    script.async = true;
    script.onload = () => (window.Cesium ? resolve(window.Cesium) : reject(new Error("Cesium did not load")));
    script.onerror = () => {
      loading = null;
      reject(new Error("Could not load Cesium from /cesium. Run `npm install` to copy the assets."));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * The map is flat (2D) while browsing. Close-up views that need real 3D (terrain, the
 * water surface, looking under the ground) switch to 3D; call the returned function on
 * exit to switch back to the same map view. At a few kilometres across, the 3D view
 * looks flat anyway.
 */
export function enter3D(C: Cesium, viewer: CesiumNS.Viewer): () => void {
  const scene = viewer.scene;
  if (scene.mode !== C.SceneMode.SCENE2D) return () => {};
  // A 2D camera sits above its map centre; the orthographic frustum width is the view width.
  const cam = viewer.camera;
  const frustum = cam.frustum as CesiumNS.OrthographicOffCenterFrustum;
  const centre = scene.mapProjection.unproject(new C.Cartesian3(cam.position.x, cam.position.y, 0));
  const widthM = (frustum.right ?? 0) - (frustum.left ?? 0) || 12_000;
  // The 3D views animate (water ripples, rise) and change state Cesium can't see, so they
  // draw continuously; the flat map only draws on change.
  const requestRenderMode = scene.requestRenderMode;
  scene.requestRenderMode = false;
  scene.morphTo3D(0);
  return () => {
    if (viewer.isDestroyed() || scene.mode === C.SceneMode.SCENE2D) return;
    scene.requestRenderMode = requestRenderMode;
    scene.morphTo2D(0);
    cam.setView({ destination: C.Cartesian3.fromRadians(centre.longitude, centre.latitude, widthM) });
  };
}
