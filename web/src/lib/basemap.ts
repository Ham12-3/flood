import type * as CesiumNS from "cesium";
import type { Cesium } from "@/lib/cesium";

export type BasemapId = "map" | "satellite";

interface TileLayer {
  url: string;
  maximumLevel: number;
  credit: string;
}

/**
 * Free raster tiles that need no key (checked live 2026-10-24; CARTO's dark tiles now
 * return an "API key required" image, so they are not used). Esri's tile URLs are
 * {z}/{y}/{x}.
 */
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const ESRI_CANVAS_CREDIT = "Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community";
const LABELS: TileLayer = {
  url: `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
  maximumLevel: 16,
  credit: ESRI_CANVAS_CREDIT,
};

export const BASEMAPS: Record<BasemapId, { label: string; layers: TileLayer[] }> = {
  map: {
    label: "Map",
    layers: [
      {
        url: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
        maximumLevel: 16,
        credit: ESRI_CANVAS_CREDIT,
      },
      LABELS,
    ],
  },
  satellite: {
    label: "Satellite",
    layers: [
      {
        url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
        maximumLevel: 19,
        credit: "Esri, Maxar, Earthstar Geographics, and the GIS user community",
      },
      LABELS,
    ],
  },
};

/**
 * Keeps the basemap at the bottom of the imagery stack, so overlays added later
 * (the satellite water map in the 3D view) stay on top when the basemap changes.
 */
export class Basemap {
  private readonly C: Cesium;
  private readonly viewer: CesiumNS.Viewer;
  private layers: CesiumNS.ImageryLayer[] = [];

  constructor(C: Cesium, viewer: CesiumNS.Viewer) {
    this.C = C;
    this.viewer = viewer;
  }

  set(id: BasemapId): void {
    const { C, viewer } = this;
    if (viewer.isDestroyed()) return;
    for (const layer of this.layers) viewer.imageryLayers.remove(layer, true);
    this.layers = BASEMAPS[id].layers.map((l, i) => {
      const provider = new C.UrlTemplateImageryProvider({
        url: l.url,
        maximumLevel: l.maximumLevel,
        credit: new C.Credit(l.credit),
      });
      return viewer.imageryLayers.addImageryProvider(provider, i);
    });
    viewer.scene.requestRender(); // the map only redraws on request
  }
}
