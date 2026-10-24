"use client";

import dynamic from "next/dynamic";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { fetchPoint, type Place, type PointResponse } from "@/lib/api";
import { formatLatLon } from "@/lib/format";
import type { UnitSystem } from "@/lib/units";
import AboutDialog from "./AboutDialog";
import FloodView from "./FloodView";
import type { GlobeHandle } from "./Globe";
import PointPanel from "./PointPanel";
import SearchBox from "./SearchBox";

// Cesium touches `window`, so the globe never renders on the server.
const Globe = dynamic(() => import("./Globe"), { ssr: false });

const DISCLAIMER = "Estimates for exploration. Not an official flood warning.";
const UNITS_KEY = "floodscope.units";

interface Selection {
  lat: number;
  lon: number;
  label?: string;
}

type Load =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "done"; data: PointResponse }
  | { state: "error"; message: string };

// Unit preference lives in localStorage (a per-viewer convenience). Read through
// useSyncExternalStore so the server render and hydration both start in metres.
const unitListeners = new Set<() => void>();
let unitsInMemory: UnitSystem | null = null; // used when storage is blocked

function readUnits(): UnitSystem {
  if (unitsInMemory) return unitsInMemory;
  try {
    return localStorage.getItem(UNITS_KEY) === "imperial" ? "imperial" : "metric";
  } catch {
    return "metric";
  }
}

function writeUnits(u: UnitSystem) {
  unitsInMemory = u;
  try {
    localStorage.setItem(UNITS_KEY, u);
  } catch {
    // storage blocked: the in-memory value still works for this visit
  }
  unitListeners.forEach((l) => l());
}

function subscribeUnits(listener: () => void) {
  unitListeners.add(listener);
  return () => unitListeners.delete(listener);
}

export default function FloodScopeApp() {
  const globe = useRef<GlobeHandle>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [load, setLoad] = useState<Load>({ state: "idle" });
  const units = useSyncExternalStore(subscribeUnits, readUnits, () => "metric" as const);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [floodMode, setFloodMode] = useState(false);
  const getViewer = useCallback(() => globe.current?.getViewer() ?? null, []);
  const abort = useRef<AbortController | null>(null);

  const inspect = useCallback((sel: Selection) => {
    setSelected(sel);
    setPanelOpen(true);
    setLoad({ state: "loading" });
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    fetchPoint(sel.lat, sel.lon, ctrl.signal)
      .then((data) => setLoad({ state: "done", data }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoad({ state: "error", message: err instanceof Error ? err.message : String(err) });
      });
  }, []);

  const onPick = useCallback((lat: number, lon: number) => inspect({ lat, lon }), [inspect]);

  const onPlace = (p: Place) => {
    globe.current?.flyTo(p.lat, p.lon);
    inspect({ lat: p.lat, lon: p.lon, label: [p.name, p.country].filter(Boolean).join(", ") });
  };

  return (
    <main className="fixed inset-0 overflow-hidden bg-[var(--surface-0)] text-[var(--text-primary)]">
      <Globe ref={globe} selected={selected} interactive={!floodMode} onPick={onPick} />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start gap-3 p-3 sm:p-4">
        <div className="pointer-events-auto flex min-w-0 flex-1 flex-wrap items-center gap-3">
          <h1 className="rounded-lg bg-[var(--surface-1)]/90 px-3 py-2 text-sm font-semibold tracking-tight shadow-lg">
            FloodScope <span className="text-[var(--series-1)]">3D</span>
          </h1>
          <SearchBox onSelect={onPlace} />
        </div>
        <div className="pointer-events-auto flex shrink-0 items-center gap-2">
          <div role="group" aria-label="Units" className="flex rounded-lg bg-[var(--surface-1)]/90 p-0.5 text-xs shadow-lg">
            {(["metric", "imperial"] as const).map((u) => (
              <button
                key={u}
                onClick={() => writeUnits(u)}
                aria-pressed={units === u}
                className={`rounded-md px-2.5 py-1.5 ${units === u ? "bg-[var(--surface-2)] text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}
              >
                {u === "metric" ? "m" : "ft"}
              </button>
            ))}
          </div>
          <button
            onClick={() => setAboutOpen(true)}
            className="rounded-lg bg-[var(--surface-1)]/90 px-3 py-2 text-xs text-[var(--text-secondary)] shadow-lg hover:text-[var(--text-primary)]"
          >
            About
          </button>
        </div>
      </header>

      {selected && (
        <aside
          aria-label="Flood data for the selected point"
          className={`absolute z-10 flex flex-col border-[var(--border)] bg-[var(--surface-0)]/95 shadow-2xl backdrop-blur
            inset-x-0 bottom-0 rounded-t-xl border-t sm:inset-x-auto sm:top-20 sm:right-4 sm:bottom-14 sm:w-[420px] sm:rounded-xl sm:border
            ${panelOpen ? "max-h-[65vh] sm:max-h-none" : "max-h-24 sm:max-h-none"}`}
        >
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
            <div className="min-w-0 flex-1">
              {floodMode && <p className="text-xs font-medium uppercase tracking-wide text-[var(--series-1)]">3D flood view</p>}
              {selected.label && <p className="truncate text-sm font-medium">{selected.label}</p>}
              <p className="text-xs tabular-nums text-[var(--text-secondary)]">{formatLatLon(selected.lat, selected.lon)}</p>
            </div>
            <button
              onClick={() => setPanelOpen((o) => !o)}
              className="rounded px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] sm:hidden"
              aria-expanded={panelOpen}
            >
              {panelOpen ? "Hide" : "Show"}
            </button>
            <button
              onClick={() => {
                abort.current?.abort();
                setFloodMode(false);
                setSelected(null);
                setLoad({ state: "idle" });
              }}
              className="rounded px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
              aria-label="Close panel"
            >
              ✕
            </button>
          </div>
          <div className={`flex-1 overflow-y-auto p-3 pb-16 sm:pb-3 ${panelOpen ? "" : "hidden sm:block"}`}>
            {!floodMode && load.state === "loading" && <LoadingState />}
            {!floodMode && load.state === "error" && (
              <div role="alert" className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4 text-sm">
                <p className="font-medium">Couldn&apos;t load data for this point</p>
                <p className="mt-1 text-[var(--text-secondary)]">{load.message}</p>
                <button onClick={() => inspect(selected)} className="mt-3 rounded bg-[var(--surface-2)] px-3 py-1.5 text-xs">
                  Try again
                </button>
              </div>
            )}
            {floodMode ? (
              <FloodView
                lat={selected.lat}
                lon={selected.lon}
                units={units}
                getViewer={getViewer}
                onExit={() => {
                  setFloodMode(false);
                  globe.current?.flyTo(selected.lat, selected.lon);
                }}
              />
            ) : (
              load.state === "done" && <PointPanel data={load.data} units={units} onOpen3D={() => setFloodMode(true)} />
            )}
          </div>
        </aside>
      )}

      {!selected && (
        <p className="pointer-events-none absolute left-1/2 top-24 z-10 -translate-x-1/2 rounded-full bg-[var(--surface-1)]/85 px-4 py-2 text-sm text-[var(--text-secondary)] shadow-lg">
          Click anywhere on the globe to inspect it
        </p>
      )}

      <footer className="absolute inset-x-0 bottom-0 z-20 flex flex-wrap items-center justify-center gap-x-2 bg-[var(--surface-0)]/85 px-3 py-1.5 text-center text-xs text-[var(--text-secondary)]">
        <span aria-hidden className="text-[var(--status-warning)]">⚠</span>
        <strong className="font-medium text-[var(--text-primary)]">{DISCLAIMER}</strong>
        <span>
          Official UK warnings:{" "}
          <a href="https://check-for-flooding.service.gov.uk/" target="_blank" rel="noreferrer" className="underline">
            Check for flooding
          </a>
        </span>
      </footer>

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </main>
  );
}

function LoadingState() {
  return (
    <div aria-live="polite" className="space-y-3">
      <p className="px-1 text-sm text-[var(--text-secondary)]">
        Looking up elevation, river flow, hazard maps and gauges. The first look-up in a new area downloads map tiles and can
        take up to 30 seconds.
      </p>
      {[90, 220, 180].map((h) => (
        <div key={h} className="animate-pulse rounded-lg border border-[var(--border)] bg-[var(--surface-1)]" style={{ height: h }} />
      ))}
    </div>
  );
}
