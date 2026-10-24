"use client";

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { baseStyle, setBasemap, type BasemapId } from "@/lib/basemap";
import { loadMapLibre, type MapLibre, type MLMap } from "@/lib/maplibre";

export interface MapHandle {
  flyTo(lat: number, lon: number, zoom?: number): void;
  getMap(): { ml: MapLibre; map: MLMap } | null;
}

interface MapViewProps {
  ref?: Ref<MapHandle>;
  selected: { lat: number; lon: number } | null;
  basemap: BasemapId;
  /** When false, clicks are ignored (the 3D flood view and the replay handle their own input). */
  interactive?: boolean;
  onPick(lat: number, lon: number): void;
}

/**
 * A flat web map (MapLibre GL JS, Web Mercator). It draws only when something changes,
 * at device pixel ratio 1, to stay light on modest graphics cards. Tilting is off here;
 * the 3D flood view turns it on.
 */
export default function MapView({ ref, selected, basemap, interactive = true, onPick }: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const mlRef = useRef<MapLibre | null>(null);
  const markerRef = useRef<InstanceType<MapLibre["Marker"]> | null>(null);
  const onPickRef = useRef(onPick);
  const interactiveRef = useRef(interactive);
  const basemapRef = useRef(basemap);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onPickRef.current = onPick;
    interactiveRef.current = interactive;
  }, [onPick, interactive]);

  useEffect(() => {
    let destroyed = false;
    loadMapLibre()
      .then((ml) => {
        if (destroyed || !container.current) return;
        mlRef.current = ml;
        const map = new ml.Map({
          container: container.current,
          style: baseStyle(basemapRef.current),
          center: [10, 20],
          zoom: 1.6,
          pixelRatio: 1,
          maxPitch: 70,
          attributionControl: { compact: true },
        });
        map.dragRotate.disable();
        map.touchZoomRotate.disableRotation();
        map.keyboard.disableRotation();
        map.addControl(new ml.NavigationControl({ visualizePitch: true }), "bottom-left");
        map.on("click", (e) => {
          if (interactiveRef.current) onPickRef.current(e.lngLat.lat, e.lngLat.lng);
        });
        map.on("load", () => !destroyed && setReady(true));
        map.on("error", (e) => console.warn("Map:", e.error?.message ?? e));
        mapRef.current = map;
      })
      .catch((err: unknown) => {
        if (!destroyed) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      destroyed = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    basemapRef.current = basemap;
    if (ready && mapRef.current) setBasemap(mapRef.current, basemap);
  }, [basemap, ready]);

  // One marker on the selected point.
  useEffect(() => {
    const map = mapRef.current;
    const ml = mlRef.current;
    markerRef.current?.remove();
    markerRef.current = null;
    if (!ready || !map || !ml || !selected) return;
    const el = document.createElement("div");
    el.className = "h-3.5 w-3.5 rounded-full border-2 border-white bg-[#3987e5] shadow";
    markerRef.current = new ml.Marker({ element: el }).setLngLat([selected.lon, selected.lat]).addTo(map);
  }, [selected, ready]);

  useImperativeHandle(
    ref,
    () => ({
      flyTo(lat, lon, zoom = 13) {
        mapRef.current?.flyTo({ center: [lon, lat], zoom, pitch: 0, bearing: 0, duration: 2000 });
      },
      getMap() {
        const map = mapRef.current;
        const ml = mlRef.current;
        return map && ml && ready ? { ml, map } : null;
      },
    }),
    [ready],
  );

  return (
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" aria-label="World map. Click anywhere to inspect flood data." />
      {error && (
        <div role="alert" className="absolute inset-0 grid place-items-center p-6 text-center text-[var(--text-secondary)]">
          <p>The map could not start: {error}</p>
        </div>
      )}
    </div>
  );
}
