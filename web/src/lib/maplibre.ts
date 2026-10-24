import type * as MapLibreNS from "maplibre-gl";
import type { AddProtocolAction } from "maplibre-gl";

export type MapLibre = typeof MapLibreNS;
export type MLMap = MapLibreNS.Map;

const BASE = "/maplibre/";
let loading: Promise<MapLibre> | null = null;

/**
 * Tile handlers keyed by name, behind one custom protocol: tiles we draw ourselves
 * (storm replay, terrain from our height grid) use URLs like
 * fs://<handler>/<z>/<x>/<y>. Handlers are registered and removed as views open and close.
 */
const handlers = new Map<string, (z: number, x: number, y: number, signal: AbortSignal) => Promise<ImageBitmap>>();

export function registerTiles(
  name: string,
  draw: (z: number, x: number, y: number, signal: AbortSignal) => Promise<ImageBitmap>,
): () => void {
  handlers.set(name, draw);
  return () => {
    if (handlers.get(name) === draw) handlers.delete(name);
  };
}

const fsProtocol: AddProtocolAction = async (params, abort) => {
  const m = /^fs:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
  const draw = m && handlers.get(m[1]);
  if (!m || !draw) throw new Error(`No tile handler for ${params.url}`);
  return { data: await draw(Number(m[2]), Number(m[3]), Number(m[4]), abort.signal) };
};

/**
 * Load MapLibre GL JS on the client. Its worker and stylesheet are served from
 * /public/maplibre (copied there by scripts/copy-maplibre.mjs on install).
 */
export function loadMapLibre(): Promise<MapLibre> {
  if (loading) return loading;
  loading = (async () => {
    if (!document.querySelector(`link[href="${BASE}maplibre-gl.css"]`)) {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = `${BASE}maplibre-gl.css`;
      document.head.appendChild(css);
    }
    const ml = await import("maplibre-gl");
    ml.setWorkerUrl(`${BASE}maplibre-gl-worker.mjs`);
    ml.addProtocol("fs", fsProtocol);
    return ml;
  })().catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading;
}

/** Bounds of a Web Mercator tile in degrees. */
export function tileBounds(z: number, x: number, y: number): { west: number; south: number; east: number; north: number } {
  const n = 2 ** z;
  const lat = (row: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return { west: (x / n) * 360 - 180, east: ((x + 1) / n) * 360 - 180, north: lat(y), south: lat(y + 1) };
}

/** Space the side panel takes on wide screens, so fitted areas are not hidden under it. */
export function panelPadding(): MapLibreNS.PaddingOptions {
  const wide = typeof window !== "undefined" && window.innerWidth >= 640;
  return wide ? { top: 90, bottom: 60, left: 40, right: 470 } : { top: 80, bottom: 260, left: 20, right: 20 };
}
