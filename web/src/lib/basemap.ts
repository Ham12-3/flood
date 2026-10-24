import type { StyleSpecification } from "maplibre-gl";
import type { MLMap } from "@/lib/maplibre";

export type BasemapId = "map" | "satellite";

interface TileLayer {
  id: string;
  url: string;
  maxzoom: number;
  attribution: string;
}

/**
 * Free raster tiles that need no key (checked live 2026-10-24; CARTO's dark tiles now
 * return an "API key required" image, so they are not used). Esri's tile URLs are
 * {z}/{y}/{x}.
 */
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const ESRI_CANVAS_CREDIT = "Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community";
const LAYERS: Record<"dark" | "imagery" | "labels", TileLayer> = {
  dark: {
    id: "base-dark",
    url: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    maxzoom: 16,
    attribution: ESRI_CANVAS_CREDIT,
  },
  imagery: {
    id: "base-imagery",
    url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
    maxzoom: 19,
    attribution: "Esri, Maxar, Earthstar Geographics, and the GIS user community",
  },
  labels: {
    id: "base-labels",
    url: `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
    maxzoom: 16,
    attribution: ESRI_CANVAS_CREDIT,
  },
};

export const BASEMAPS: Record<BasemapId, { label: string; layers: TileLayer[] }> = {
  map: { label: "Map", layers: [LAYERS.dark, LAYERS.labels] },
  satellite: { label: "Satellite", layers: [LAYERS.imagery, LAYERS.labels] },
};

/** The overlay layers the app adds go above this one. */
export const LABELS_LAYER = LAYERS.labels.id;

/** Every base layer is in the style; switching base maps only changes visibility. */
export function baseStyle(id: BasemapId): StyleSpecification {
  const shown = new Set(BASEMAPS[id].layers.map((l) => l.id));
  const all = Object.values(LAYERS);
  return {
    version: 8,
    sources: Object.fromEntries(
      all.map((l) => [l.id, { type: "raster", tiles: [l.url], tileSize: 256, maxzoom: l.maxzoom, attribution: l.attribution }]),
    ),
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#1f1f1f" } },
      ...all.map((l) => ({
        id: l.id,
        type: "raster" as const,
        source: l.id,
        layout: { visibility: shown.has(l.id) ? ("visible" as const) : ("none" as const) },
        paint: { "raster-fade-duration": 0 },
      })),
    ],
  };
}

export function setBasemap(map: MLMap, id: BasemapId): void {
  const shown = new Set(BASEMAPS[id].layers.map((l) => l.id));
  for (const l of Object.values(LAYERS)) {
    if (map.getLayer(l.id)) map.setLayoutProperty(l.id, "visibility", shown.has(l.id) ? "visible" : "none");
  }
}
