"use client";

import type * as CesiumNS from "cesium";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Basemap, type BasemapId } from "@/lib/basemap";
import { loadCesium, type Cesium } from "@/lib/cesium";

export interface GlobeHandle {
  flyTo(lat: number, lon: number, heightM?: number): void;
  getViewer(): { C: Cesium; viewer: CesiumNS.Viewer } | null;
}

interface GlobeProps {
  ref?: Ref<GlobeHandle>;
  selected: { lat: number; lon: number } | null;
  basemap: BasemapId;
  /** When false, clicks are ignored (the 3D flood view handles its own input). */
  interactive?: boolean;
  onPick(lat: number, lon: number): void;
}

const MARKER_ID = "floodscope-selected";

/** A flat (2D, Web Mercator) world map. The 3D views switch it to 3D while they are open. */
export default function Globe({ ref, selected, basemap, interactive = true, onPick }: GlobeProps) {
  const container = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<CesiumNS.Viewer | null>(null);
  const cesiumRef = useRef<Cesium | null>(null);
  const basemapRef = useRef<Basemap | null>(null);
  const onPickRef = useRef(onPick);
  const interactiveRef = useRef(interactive);
  const basemapIdRef = useRef(basemap);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onPickRef.current = onPick;
    interactiveRef.current = interactive;
  }, [onPick, interactive]);

  useEffect(() => {
    let destroyed = false;
    let handler: CesiumNS.ScreenSpaceEventHandler | null = null;

    loadCesium()
      .then((C) => {
        if (destroyed || !container.current) return;
        cesiumRef.current = C;

        const viewer = new C.Viewer(container.current, {
          animation: false,
          timeline: false,
          baseLayerPicker: false,
          geocoder: false,
          homeButton: false,
          sceneModePicker: false,
          navigationHelpButton: false,
          fullscreenButton: false,
          infoBox: false,
          selectionIndicator: false,
          sceneMode: C.SceneMode.SCENE2D,
          mapProjection: new C.WebMercatorProjection(),
          baseLayer: false, // the Basemap below adds keyless tiles; no Cesium ion
          // Light on the GPU: draw only when something changes (enter3D turns continuous
          // drawing on for the animated 3D views), at most 30 fps, no multisampling.
          requestRenderMode: true,
          maximumRenderTimeChange: Number.POSITIVE_INFINITY,
          targetFrameRate: 30,
          msaaSamples: 1,
        });
        viewer.scene.postProcessStages.fxaa.enabled = false;
        viewer.scene.fog.enabled = false;
        viewerRef.current = viewer;
        basemapRef.current = new Basemap(C, viewer);
        basemapRef.current.set(basemapIdRef.current);
        viewer.scene.globe.depthTestAgainstTerrain = true;
        viewer.scene.globe.enableLighting = false;
        viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
        viewer.camera.setView({ destination: C.Rectangle.fromDegrees(-120, -50, 140, 72) });

        handler = new C.ScreenSpaceEventHandler(viewer.scene.canvas);
        handler.setInputAction((event: CesiumNS.ScreenSpaceEventHandler.PositionedEvent) => {
          if (!interactiveRef.current) return;
          const ray = viewer.camera.getPickRay(event.position);
          const cartesian =
            (ray && viewer.scene.globe.pick(ray, viewer.scene)) ??
            viewer.camera.pickEllipsoid(event.position, viewer.scene.globe.ellipsoid);
          if (!cartesian) return;
          const carto = C.Cartographic.fromCartesian(cartesian);
          onPickRef.current(C.Math.toDegrees(carto.latitude), C.Math.toDegrees(carto.longitude));
        }, C.ScreenSpaceEventType.LEFT_CLICK);
      })
      .catch((err: unknown) => {
        if (!destroyed) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      destroyed = true;
      handler?.destroy();
      if (viewerRef.current && !viewerRef.current.isDestroyed()) viewerRef.current.destroy();
      viewerRef.current = null;
      basemapRef.current = null;
    };
  }, []);

  useEffect(() => {
    basemapIdRef.current = basemap;
    basemapRef.current?.set(basemap);
  }, [basemap]);

  // Keep a single marker on the selected point.
  useEffect(() => {
    const viewer = viewerRef.current;
    const C = cesiumRef.current;
    if (!viewer || !C) return;
    viewer.entities.removeById(MARKER_ID);
    viewer.scene.requestRender();
    if (!selected) return;
    viewer.entities.add({
      id: MARKER_ID,
      position: C.Cartesian3.fromDegrees(selected.lon, selected.lat),
      point: {
        pixelSize: 14,
        color: C.Color.fromCssColorString("#3987e5"),
        outlineColor: C.Color.WHITE,
        outlineWidth: 2,
        heightReference: C.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    viewer.scene.requestRender();
  }, [selected]);

  useImperativeHandle(
    ref,
    () => ({
      flyTo(lat, lon, heightM = 12_000) {
        const viewer = viewerRef.current;
        const C = cesiumRef.current;
        if (!viewer || !C) return;
        viewer.camera.flyTo({ destination: C.Cartesian3.fromDegrees(lon, lat, heightM), duration: 2 });
      },
      getViewer() {
        const viewer = viewerRef.current;
        const C = cesiumRef.current;
        return viewer && C && !viewer.isDestroyed() ? { C, viewer } : null;
      },
    }),
    [],
  );

  return (
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" aria-label="World map. Click anywhere to inspect flood data." />
      {error && (
        <div role="alert" className="absolute inset-0 grid place-items-center p-6 text-center text-[var(--text-secondary)]">
          <p>
            The map could not start: {error}
          </p>
        </div>
      )}
    </div>
  );
}
