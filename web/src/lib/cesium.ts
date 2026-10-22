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
