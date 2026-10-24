"use client";

import type * as CesiumNS from "cesium";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { loadCesium, type Cesium } from "@/lib/cesium";

export interface GlobeHandle {
  flyTo(lat: number, lon: number, heightM?: number): void;
  getViewer(): { C: Cesium; viewer: CesiumNS.Viewer } | null;
}

interface GlobeProps {
  ref?: Ref<GlobeHandle>;
  selected: { lat: number; lon: number } | null;
  /** When false, clicks are ignored (the 3D flood view handles its own input). */
  interactive?: boolean;
  onPick(lat: number, lon: number): void;
}

const ION_TOKEN = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN ?? "";
const MARKER_ID = "floodscope-selected";

export default function Globe({ ref, selected, interactive = true, onPick }: GlobeProps) {
  const container = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<CesiumNS.Viewer | null>(null);
  const cesiumRef = useRef<Cesium | null>(null);
  const onPickRef = useRef(onPick);
  const interactiveRef = useRef(interactive);
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
        if (ION_TOKEN) C.Ion.defaultAccessToken = ION_TOKEN;

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
          // With an ion token: Cesium World Terrain + ion default imagery.
          // Without: the Natural Earth image bundled with Cesium, on a smooth ellipsoid.
          ...(ION_TOKEN
            ? { terrain: C.Terrain.fromWorldTerrain() }
            : {
                baseLayer: C.ImageryLayer.fromProviderAsync(
                  C.TileMapServiceImageryProvider.fromUrl(C.buildModuleUrl("Assets/Textures/NaturalEarthII")),
                ),
              }),
        });
        viewerRef.current = viewer;
        viewer.scene.globe.depthTestAgainstTerrain = true;
        viewer.scene.globe.enableLighting = false;
        viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
        viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(10, 25, 22_000_000) });

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
    };
  }, []);

  // Keep a single marker on the selected point.
  useEffect(() => {
    const viewer = viewerRef.current;
    const C = cesiumRef.current;
    if (!viewer || !C) return;
    viewer.entities.removeById(MARKER_ID);
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
      <div ref={container} className="h-full w-full" aria-label="3D globe. Click anywhere to inspect flood data." />
      {!ION_TOKEN && !error && (
        <div className="pointer-events-none absolute bottom-24 left-3 max-w-xs rounded-md border border-[var(--border)] bg-[var(--surface-1)]/90 px-3 py-2 text-xs text-[var(--text-secondary)]">
          No Cesium ion token set, so the globe uses a low-detail offline image and flat terrain. Add
          NEXT_PUBLIC_CESIUM_ION_TOKEN to .env.
        </div>
      )}
      {error && (
        <div role="alert" className="absolute inset-0 grid place-items-center p-6 text-center text-[var(--text-secondary)]">
          <p>
            The globe could not start: {error}
          </p>
        </div>
      )}
    </div>
  );
}
