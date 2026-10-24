"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchScene, type SceneResponse } from "@/lib/api";
import type { Cesium } from "@/lib/cesium";
import { describeForecast, forecastRequest, formatReturnPeriod } from "@/lib/flood/describe";
import { DEPTH_STOPS, FloodScene, type HoverInfo } from "@/lib/flood/floodScene";
import { humanScale } from "@/lib/flood/humanScale";
import type { ComputeResult, DepthRequest, WorkerResponse } from "@/lib/flood/messages";
import { RETURN_PERIODS, type Scenario } from "@/lib/flood/scenario";
import { decodeScene, type SceneArrays } from "@/lib/flood/sceneData";
import { formatDay } from "@/lib/format";
import { formatLength, type UnitSystem } from "@/lib/units";
import type * as CesiumNS from "cesium";
import SourceTag from "./SourceTag";

interface Props {
  lat: number;
  lon: number;
  units: UnitSystem;
  getViewer(): { C: Cesium; viewer: CesiumNS.Viewer } | null;
  onExit(): void;
}

const SIZES = [2, 4, 6, 8, 10];
const RISE_SECONDS = 3;
const HAS_ION_TOKEN = Boolean(process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN);

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; scene: SceneResponse; arrays: SceneArrays };

type Tab = "today" | "forecast" | "returnPeriod" | "custom";

export default function FloodView({ lat, lon, units, getViewer, onExit }: Props) {
  const [sizeKm, setSizeKm] = useState(4);
  const [userTab, setUserTab] = useState<Tab | null>(null);
  const [day, setDay] = useState(1);
  const [rp, setRp] = useState(100);
  const [rise, setRise] = useState(1);
  const [computing, setComputing] = useState(false);
  const [progress, setProgress] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [hover, setHover] = useState<HoverInfo | null>(null);

  // State below is tagged with the window (key) or scene (arrays) it belongs to, so a new
  // window starts clean without resetting state inside effects.
  const key = `${lat},${lon},${sizeKm}`;
  const [fetched, setFetched] = useState<{ key: string; load: Load } | null>(null);
  const load: Load = fetched?.key === key ? fetched.load : { state: "loading" };
  const scene = load.state === "ready" ? load.scene : null;
  const arrays = load.state === "ready" ? load.arrays : null;

  type Tagged<T> = { arrays: SceneArrays; value: T } | null;
  const [resultTag, setResultTag] = useState<Tagged<ComputeResult>>(null);
  const [workerErrorTag, setWorkerErrorTag] = useState<Tagged<string | null>>(null);
  const [buildingsTag, setBuildingsTag] = useState<Tagged<{ loaded: number; touched: number } | null>>(null);
  const [buildingsErrorTag, setBuildingsErrorTag] = useState<Tagged<string>>(null);
  const mine = <T,>(t: Tagged<T>): T | null => (t && t.arrays === arrays ? t.value : null);
  const result = mine(resultTag);
  const workerError = mine(workerErrorTag);
  const buildings = mine(buildingsTag);
  const buildingsError = mine(buildingsErrorTag);

  const sceneRef = useRef<FloodScene | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);
  const playStart = useRef(0);

  // 1. Fetch and decode the terrain window.
  useEffect(() => {
    const ctrl = new AbortController();
    fetchScene(lat, lon, sizeKm, ctrl.signal)
      .then((resp) => {
        const decoded = decodeScene(resp);
        setFetched({
          key,
          load: "reason" in decoded ? { state: "error", message: decoded.reason } : { state: "ready", scene: resp, arrays: decoded.arrays },
        });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setFetched({ key, load: { state: "error", message: err instanceof Error ? err.message : String(err) } });
      });
    return () => ctrl.abort();
  }, [lat, lon, sizeKm, key]);

  const hasForecast = scene?.fit.status === "ok" && (scene?.scenarios.length ?? 0) > 0;
  const hasHazard = scene?.hazard.status === "ok";
  const enabled: Record<Tab, boolean> = { today: hasForecast, forecast: hasForecast, returnPeriod: hasHazard, custom: hasHazard };
  const defaultTab: Tab = hasForecast ? "today" : hasHazard ? "returnPeriod" : "custom";
  const tab: Tab = userTab && enabled[userTab] ? userTab : defaultTab;

  // 2. Set up the Cesium scene and the worker for this window.
  useEffect(() => {
    if (!arrays) return;
    const v = getViewer();
    if (!v) return; // the panel only opens after the globe is running
    const fs = new FloodScene(v.C, v.viewer, arrays);
    sceneRef.current = fs;
    fs.enter(HAS_ION_TOKEN);
    fs.enableHover(setHover);
    fs.onBuildingsChanged = () => setBuildingsTag({ arrays, value: fs.buildingCounts() });
    if (HAS_ION_TOKEN) {
      fs.loadBuildings().catch((err: unknown) =>
        setBuildingsErrorTag({ arrays, value: err instanceof Error ? err.message : "Cesium OSM Buildings failed to load" }),
      );
    }

    const worker = new Worker(new URL("../lib/flood/flood.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === "ready") return;
      if (msg.id !== requestId.current) return; // superseded
      setComputing(false);
      if (msg.type === "error") {
        setWorkerErrorTag({ arrays, value: msg.message });
        return;
      }
      setWorkerErrorTag({ arrays, value: null });
      setResultTag({ arrays, value: msg });
      fs.setWater(msg.mesh, msg.depth).catch((err: unknown) =>
        setWorkerErrorTag({
          arrays,
          value: err instanceof Error ? `Could not draw the water: ${err.message}` : "Could not draw the water",
        }),
      );
      playStart.current = performance.now();
      setPlaying(true);
    };
    worker.onerror = (e) => {
      setComputing(false);
      setWorkerErrorTag({ arrays, value: e.message || "The flood worker crashed" });
    };
    worker.postMessage({ type: "init", scene: arrays });

    return () => {
      worker.terminate();
      workerRef.current = null;
      fs.exit();
      sceneRef.current = null;
      setHover(null);
    };
  }, [arrays, getViewer]);

  // 3. Work out what to compute for the chosen scenario.
  const scenario: Scenario = useMemo(() => {
    if (tab === "today") return { kind: "forecast", day: 0 };
    if (tab === "forecast") return { kind: "forecast", day };
    if (tab === "returnPeriod") return { kind: "returnPeriod", rp };
    return { kind: "custom", rise };
  }, [tab, day, rp, rise]);

  const forecastDay = scene && scenario.kind === "forecast" ? scene.scenarios.find((s) => s.day === scenario.day) : undefined;

  const request: DepthRequest | null = useMemo(() => {
    if (!scene) return null;
    if (scenario.kind === "forecast") return forecastDay && hasForecast ? forecastRequest(forecastDay) : null;
    if (scenario.kind === "returnPeriod") return hasHazard ? { kind: "layer", rp: scenario.rp } : null;
    return hasHazard ? { kind: "custom", rise: scenario.rise } : null;
  }, [scene, scenario, forecastDay, hasForecast, hasHazard]);

  const requestKey = request ? JSON.stringify(request) : null;
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker || !request) return;
    // Debounce slider drags a little.
    const timer = setTimeout(() => {
      requestId.current += 1;
      setComputing(true);
      worker.postMessage({ type: "compute", id: requestId.current, request });
    }, 120);
    return () => clearTimeout(timer);
    // requestKey captures the request's content; arrays resets the worker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, arrays]);

  // 4. Rise animation.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const t = Math.min((performance.now() - playStart.current) / (RISE_SECONDS * 1000), 1);
      setProgress(t);
      sceneRef.current?.setProgress(t);
      if (t < 1) raf = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const onScrub = useCallback((t: number) => {
    setPlaying(false);
    setProgress(t);
    sceneRef.current?.setProgress(t);
  }, []);

  const play = () => {
    playStart.current = performance.now() - (progress >= 1 ? 0 : progress * RISE_SECONDS * 1000);
    setPlaying(true);
  };

  const stats = result?.stats;
  const g = scene?.grid;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-[var(--text-secondary)]" htmlFor="flood-size">
          Window
        </label>
        <select
          id="flood-size"
          value={sizeKm}
          onChange={(e) => setSizeKm(Number(e.target.value))}
          className="rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-xs"
        >
          {SIZES.map((s) => (
            <option key={s} value={s}>
              {s} × {s} km
            </option>
          ))}
        </select>
        {g && (
          <span className="text-xs text-[var(--text-muted)]">
            {g.nx} × {g.ny} cells of {Math.round(g.cell_size_m[0])} × {Math.round(g.cell_size_m[1])} m
          </span>
        )}
        <button
          onClick={onExit}
          className="ml-auto rounded bg-[var(--surface-2)] px-3 py-1.5 text-xs hover:text-[var(--text-primary)]"
        >
          Back to globe
        </button>
      </div>

      {load.state === "loading" && (
        <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4 text-sm text-[var(--text-secondary)]" aria-live="polite">
          Loading 30 m terrain and flood maps for this window. A new area can take up to a minute on a slow connection.
        </p>
      )}
      {load.state === "error" && (
        <div role="alert" className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4 text-sm">
          <p className="font-medium">No 3D flood view here</p>
          <p className="mt-1 text-[var(--text-secondary)]">{load.message}</p>
        </div>
      )}

      {scene && (
        <>
          <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3">
            <div role="tablist" aria-label="Flood scenario" className="grid grid-cols-4 gap-1 text-xs">
              {(
                [
                  ["today", "Today", hasForecast],
                  ["forecast", "Forecast", hasForecast],
                  ["returnPeriod", "1-in-N year", hasHazard],
                  ["custom", "Custom", hasHazard],
                ] as const
              ).map(([key, label, enabled]) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={tab === key}
                  disabled={!enabled}
                  onClick={() => setUserTab(key)}
                  className={`rounded-md px-2 py-1.5 disabled:opacity-40 ${tab === key ? "bg-[var(--surface-2)] text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="mt-3 text-sm">
              {tab === "forecast" && (
                <label className="block">
                  <span className="flex justify-between text-xs text-[var(--text-secondary)]">
                    <span>Forecast day {day}</span>
                    <span>{forecastDay ? formatDay(forecastDay.date) : ""}</span>
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={Math.max(1, scene.scenarios.length - 1)}
                    value={day}
                    onChange={(e) => setDay(Number(e.target.value))}
                    className="mt-1 w-full accent-[var(--series-1)]"
                  />
                </label>
              )}
              {tab === "returnPeriod" && (
                <div className="flex flex-wrap gap-1">
                  {RETURN_PERIODS.map((r) => (
                    <button
                      key={r}
                      onClick={() => setRp(r)}
                      aria-pressed={rp === r}
                      className={`rounded px-2 py-1 text-xs ${rp === r ? "bg-[var(--series-1)] text-white" : "bg-[var(--surface-2)] text-[var(--text-secondary)]"}`}
                    >
                      1-in-{r}
                    </button>
                  ))}
                </div>
              )}
              {tab === "custom" && (
                <label className="block">
                  <span className="text-xs text-[var(--text-secondary)]">
                    Rivers and lakes rise by <strong className="text-[var(--text-primary)]">{formatLength(rise, units, 2)}</strong>
                  </span>
                  <input
                    type="range"
                    min={0.25}
                    max={10}
                    step={0.25}
                    value={rise}
                    onChange={(e) => setRise(Number(e.target.value))}
                    className="mt-1 w-full accent-[var(--series-1)]"
                  />
                </label>
              )}
              <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
                {scenarioText(tab, scene, forecastDay, rp, units)}
              </p>
            </div>

            {!hasForecast && (tab === "today" || tab === "forecast") && (
              <p className="mt-2 text-xs text-[var(--text-secondary)]">{scene.fit.reason}</p>
            )}

            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={playing ? () => setPlaying(false) : play}
                className="rounded bg-[var(--surface-2)] px-2.5 py-1 text-xs"
                aria-label={playing ? "Pause the rise" : "Play the rise"}
              >
                {playing ? "Pause" : "▶ Rise"}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={progress}
                onChange={(e) => onScrub(Number(e.target.value))}
                aria-label="Water rise"
                className="flex-1 accent-[var(--series-1)]"
              />
              <span className="w-10 text-right text-xs tabular-nums text-[var(--text-muted)]">{Math.round(progress * 100)}%</span>
            </div>
            {computing && <p className="mt-1 text-xs text-[var(--text-muted)]">Computing…</p>}
            {result?.notice && <p className="mt-2 text-xs text-[var(--text-primary)]">{result.notice}</p>}
            {workerError && (
              <p role="alert" className="mt-2 text-xs text-[var(--text-primary)]">
                {workerError}
              </p>
            )}
          </section>

          <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">At full flood level</h3>
            <dl className="grid grid-cols-3 gap-2 text-sm">
              <Stat label="Flooded land" value={stats ? `${stats.floodedAreaKm2.toFixed(2)} km²` : "–"} />
              <Stat label="Max depth" value={stats && stats.floodedCells ? formatLength(stats.maxDepthM, units) : "–"} />
              <Stat
                label="Buildings touched"
                value={
                  !HAS_ION_TOKEN ? "Needs token" : buildingsError ? "Unavailable" : buildings ? buildings.touched.toLocaleString("en-GB") : "Loading…"
                }
              />
            </dl>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
              Flooded land leaves out permanent rivers and lakes.{" "}
              {HAS_ION_TOKEN
                ? buildingsError
                  ? `Cesium OSM Buildings: ${buildingsError}.`
                  : buildings
                    ? `Buildings: centre point in water, out of ${buildings.loaded.toLocaleString("en-GB")} Cesium OSM Buildings loaded so far in this window (zoom in to load more).`
                    : ""
                : "Building counts use Cesium OSM Buildings, which need a Cesium ion token in .env."}
              {result && ` Computed in ${Math.round(result.ms)} ms in a Web Worker.`}
            </p>
            <DepthLegend units={units} />
          </section>

          <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3 text-xs text-[var(--text-secondary)]">
            <p>
              Terrain: our DEM window, placed with the EGM2008 geoid ({scene.geoid_offset_m?.toFixed(1)} m here).{" "}
              {scene.hazard.note}
            </p>
            {scene.hazard.spurious_depth_in_window && (
              <p className="mt-2 text-[var(--text-primary)]">
                <span aria-hidden>⚠ </span>JRC flags part of this window as possibly having unrealistic depths.
              </p>
            )}
            {scene.fit.status === "ok" && (
              <p className="mt-2">
                Flood curve: {scene.fit.method} at the GloFAS cell, {scene.fit.first_year}–{scene.fit.last_year} ({scene.fit.n_years}{" "}
                years). {scene.scenario_basis}
              </p>
            )}
            <SourceTag source={scene.dem.source} />
            <SourceTag source={scene.hazard.source} />
            {scene.fit.status === "ok" && <SourceTag source={scene.fit.source} />}
          </section>
        </>
      )}

      {hover && <HoverCard hover={hover} units={units} />}
    </div>
  );
}

function scenarioText(
  tab: Tab,
  scene: SceneResponse,
  forecastDay: SceneResponse["scenarios"][number] | undefined,
  rp: number,
  units: UnitSystem,
): string {
  if (tab === "today" || tab === "forecast") {
    return forecastDay ? describeForecast(forecastDay, units) : "No forecast for this day.";
  }
  if (tab === "returnPeriod") {
    const layer = scene.hazard.layers.find((l) => l.return_period === rp);
    return `The ${formatReturnPeriod(rp)} flood (${(100 / rp).toFixed(rp > 100 ? 1 : 0)}% chance each year) from the JRC map. ${
      layer ? `${layer.flooded_cells.toLocaleString("en-GB")} cells under water, including the river channel.` : ""
    }`;
  }
  return "Water spreads from rivers and lakes to connected ground lower than their surface plus the rise. Hollows cut off by higher ground stay dry. Each stretch of river rises above its own level.";
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-[var(--text-muted)]">{label}</dt>
      <dd className="font-semibold tabular-nums text-[var(--text-primary)]">{value}</dd>
    </div>
  );
}

function DepthLegend({ units }: { units: UnitSystem }) {
  const gradient = `linear-gradient(to right, ${DEPTH_STOPS.map((s, i) => `${s.color} ${(i / (DEPTH_STOPS.length - 1)) * 100}%`).join(", ")})`;
  return (
    <figure className="mt-3">
      <div className="h-2.5 rounded-sm" style={{ background: gradient }} aria-hidden />
      <figcaption className="mt-1 flex justify-between text-[10px] tabular-nums text-[var(--text-muted)]">
        {DEPTH_STOPS.map((s, i) => (
          <span key={s.depth}>
            {formatLength(s.depth, units, s.depth === 0 ? 0 : units === "imperial" ? (s.depth < 3 ? 1 : 0) : s.depth < 1 ? 1 : 0)}
            {i === DEPTH_STOPS.length - 1 ? "+" : ""}
          </span>
        ))}
      </figcaption>
      <p className="text-[10px] text-[var(--text-muted)]">Water depth</p>
    </figure>
  );
}

function HoverCard({ hover, units }: { hover: HoverInfo; units: UnitSystem }) {
  const wet = hover.depthM > 0;
  return (
    <div
      className="pointer-events-none fixed z-30 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-xs shadow-lg"
      style={{ left: hover.x + 14, top: hover.y + 14 }}
    >
      {wet ? (
        <>
          <div className="font-medium text-[var(--text-primary)]">
            {formatLength(hover.depthM, units, 2)} deep · {humanScale(hover.depthM)}
          </div>
          {hover.permanent && <div className="text-[var(--text-muted)]">River or lake channel</div>}
        </>
      ) : hover.permanent ? (
        <div className="text-[var(--text-primary)]">Permanent water (depth not modelled)</div>
      ) : (
        <div className="text-[var(--text-primary)]">Dry</div>
      )}
      {hover.groundM !== null && (
        <div className="text-[var(--text-muted)]">Ground {formatLength(hover.groundM, units)} above sea level</div>
      )}
    </div>
  );
}
