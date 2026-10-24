"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  API_BASE_URL,
  fetchPrediction,
  fetchSatellite,
  fetchScene,
  type PredictResponse,
  type SatelliteResponse,
  type SceneResponse,
} from "@/lib/api";
import { describeForecast, forecastRequest, formatReturnPeriod } from "@/lib/flood/describe";
import { DEPTH_STOPS, FloodMap, type HoverInfo } from "@/lib/flood/floodMap";
import { humanScale } from "@/lib/flood/humanScale";
import type { ComputeResult, DepthRequest, WorkerResponse } from "@/lib/flood/messages";
import { RETURN_PERIODS, type Scenario } from "@/lib/flood/scenario";
import { decodeScene, type SceneArrays } from "@/lib/flood/sceneData";
import { formatDay } from "@/lib/format";
import { formatLength, type UnitSystem } from "@/lib/units";
import type { MapLibre, MLMap } from "@/lib/maplibre";
import SimulationPanel from "./SimulationPanel";
import SourceTag from "./SourceTag";

interface Props {
  lat: number;
  lon: number;
  units: UnitSystem;
  getMap(): { ml: MapLibre; map: MLMap } | null;
  onExit(): void;
}

const SIZES = [2, 4, 6, 8, 10];
const RISE_SECONDS = 3;
const EXAGGERATIONS = [1, 2, 4];

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; scene: SceneResponse; arrays: SceneArrays };

type Tab = "today" | "forecast" | "ai" | "returnPeriod" | "custom" | "simulate";

export default function FloodView({ lat, lon, units, getMap, onExit }: Props) {
  const [sizeKm, setSizeKm] = useState(4);
  const [userTab, setUserTab] = useState<Tab | null>(null);
  const [day, setDay] = useState(1);
  const [rp, setRp] = useState(100);
  const [rise, setRise] = useState(1);
  const [aiDay, setAiDay] = useState(1);
  const [overlayOn, setOverlayOn] = useState(false);
  const [extras, setExtras] = useState<{ key: string; ai: PredictResponse | null; sat: SatelliteResponse | null } | null>(null);
  const [computing, setComputing] = useState(false);
  const [progress, setProgress] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [exaggeration, setExaggeration] = useState(1);
  const exaggerationRef = useRef(exaggeration);

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
  const mine = <T,>(t: Tagged<T>): T | null => (t && t.arrays === arrays ? t.value : null);
  const result = mine(resultTag);
  const workerError = mine(workerErrorTag);

  const sceneRef = useRef<FloodMap | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);
  const animateNext = useRef(true); // simulation frames are shown as they are, without the rise
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

  // AI forecast and satellite maps for this point (optional extras; failures just hide them).
  useEffect(() => {
    const ctrl = new AbortController();
    const quiet = <T,>(p: Promise<T>) => p.catch(() => null);
    Promise.all([quiet(fetchPrediction(lat, lon, ctrl.signal)), quiet(fetchSatellite(lat, lon, ctrl.signal))]).then(
      ([ai, sat]) => {
        if (!ctrl.signal.aborted) setExtras({ key: `${lat},${lon}`, ai, sat });
      },
    );
    return () => ctrl.abort();
  }, [lat, lon]);
  const extrasNow = extras && extras.key === `${lat},${lon}` ? extras : null;
  const ai = extrasNow?.ai?.status === "ok" ? extrasNow.ai : null;
  const satellite = extrasNow?.sat?.status === "ok" ? extrasNow.sat.results[0] : undefined;

  const hasForecast = scene?.fit.status === "ok" && (scene?.scenarios.length ?? 0) > 0;
  const hasHazard = scene?.hazard.status === "ok";
  const hasAi = Boolean(ai && ai.days.length > 0 && hasHazard);
  const enabled: Record<Tab, boolean> = {
    today: hasForecast,
    forecast: hasForecast,
    ai: hasAi,
    returnPeriod: hasHazard,
    custom: hasHazard,
    simulate: Boolean(arrays),
  };
  const defaultTab: Tab = hasForecast ? "today" : hasHazard ? "returnPeriod" : "custom";
  const tab: Tab = userTab && enabled[userTab] ? userTab : defaultTab;

  // 2. Set up the terrain, the water layer and the worker for this window.
  useEffect(() => {
    if (!arrays) return;
    const m = getMap();
    if (!m) return; // the panel only opens after the map is running
    const fs = new FloodMap(m.map, arrays);
    sceneRef.current = fs;
    fs.enter(exaggerationRef.current);
    fs.enableHover(setHover);

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
      if (animateNext.current) fs.setProgress(0); // the rise starts from below
      fs.setWater(msg.depth);
      if (animateNext.current) {
        playStart.current = performance.now();
        setPlaying(true);
      } else {
        setPlaying(false);
        setProgress(1);
        fs.setProgress(1);
      }
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
  }, [arrays, getMap]);

  useEffect(() => {
    exaggerationRef.current = exaggeration;
    sceneRef.current?.setExaggeration(exaggeration);
  }, [exaggeration]);

  // Simulation frames go straight to the worker for stats.
  const showSimulatedDepth = useCallback((depth: Float32Array) => {
    const worker = workerRef.current;
    if (!worker) return;
    requestId.current += 1;
    animateNext.current = false;
    worker.postMessage({ type: "compute", id: requestId.current, request: { kind: "given", depth } }, [depth.buffer]);
  }, []);

  // 3. Work out what to compute for the chosen scenario.
  const scenario: Scenario = useMemo(() => {
    if (tab === "today") return { kind: "forecast", day: 0 };
    if (tab === "forecast") return { kind: "forecast", day };
    if (tab === "ai") return { kind: "ai", day: aiDay };
    if (tab === "returnPeriod") return { kind: "returnPeriod", rp };
    return { kind: "custom", rise };
  }, [tab, day, aiDay, rp, rise]);

  const forecastDay = scene && scenario.kind === "forecast" ? scene.scenarios.find((s) => s.day === scenario.day) : undefined;
  const aiForecastDay = ai && scenario.kind === "ai" ? ai.days.find((d) => d.day === scenario.day) : undefined;

  const request: DepthRequest | null = useMemo(() => {
    if (!scene || tab === "simulate") return null; // the simulation sends its own frames
    if (scenario.kind === "forecast") return forecastDay && hasForecast ? forecastRequest(forecastDay) : null;
    if (scenario.kind === "ai") return aiForecastDay && hasAi ? forecastRequest(aiForecastDay) : null;
    if (scenario.kind === "returnPeriod") return hasHazard ? { kind: "layer", rp: scenario.rp } : null;
    return hasHazard ? { kind: "custom", rise: scenario.rise } : null;
  }, [scene, tab, scenario, forecastDay, aiForecastDay, hasForecast, hasAi, hasHazard]);

  // Satellite water map overlay.
  const overlayUrl = overlayOn && satellite ? `${API_BASE_URL}${satellite.overlay_url}` : null;
  useEffect(() => {
    const fs = sceneRef.current;
    if (!fs) return;
    fs.setOverlay(overlayUrl, satellite?.bounds);
  }, [overlayUrl, satellite, arrays]);

  const requestKey = request ? JSON.stringify(request) : null;
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker || !request) return;
    // Debounce slider drags a little.
    const timer = setTimeout(() => {
      requestId.current += 1;
      animateNext.current = true;
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
        <div role="group" aria-label="Height exaggeration" className="flex items-center gap-1 text-xs text-[var(--text-secondary)]">
          Heights
          {EXAGGERATIONS.map((x) => (
            <button
              key={x}
              onClick={() => setExaggeration(x)}
              aria-pressed={exaggeration === x}
              className={`rounded px-1.5 py-0.5 ${exaggeration === x ? "bg-[var(--surface-2)] text-[var(--text-primary)]" : ""}`}
            >
              ×{x}
            </button>
          ))}
        </div>
        <button
          onClick={onExit}
          className="ml-auto rounded bg-[var(--surface-2)] px-3 py-1.5 text-xs hover:text-[var(--text-primary)]"
        >
          Back to map
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
            <div role="tablist" aria-label="Flood scenario" className="grid grid-cols-3 gap-1 text-xs">
              {(
                [
                  ["today", "Today", hasForecast],
                  ["forecast", "Forecast", hasForecast],
                  ["ai", "AI forecast", hasAi],
                  ["returnPeriod", "1-in-N year", hasHazard],
                  ["custom", "Custom", hasHazard],
                  ["simulate", "Simulate", Boolean(arrays)],
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
              {tab === "ai" && ai && (
                <label className="block">
                  <span className="flex justify-between text-xs text-[var(--text-secondary)]">
                    <span>AI predicted flood, day {aiDay}</span>
                    <span>{aiForecastDay ? formatDay(aiForecastDay.date) : ""}</span>
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={ai.days.length}
                    value={aiDay}
                    onChange={(e) => setAiDay(Number(e.target.value))}
                    className="mt-1 w-full accent-[var(--series-1)]"
                  />
                </label>
              )}
              {tab === "simulate" && arrays && (
                <SimulationPanel
                  arrays={arrays}
                  todayFlow={scene.scenarios[0]?.discharge ?? null}
                  units={units}
                  onDepth={showSimulatedDepth}
                  onUseFill={() => setUserTab("custom")}
                />
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
                {tab === "simulate"
                  ? ""
                  : tab === "ai" && aiForecastDay
                    ? `AI predicted flood, day ${aiDay}: ${describeForecast(aiForecastDay, units, "AI forecast")}`
                    : scenarioText(tab, scene, forecastDay, rp, units)}
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

          {satellite && (
            <label className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3 text-xs text-[var(--text-secondary)]">
              <input type="checkbox" checked={overlayOn} onChange={(e) => setOverlayOn(e.target.checked)} className="mt-0.5" />
              <span>
                Show real water seen by satellite on {formatDay(satellite.datetime.slice(0, 10))} (Sentinel-2,{" "}
                {satellite.cloud_cover ?? "?"}% cloud), mapped by Prithvi. Compare it with the simulated flood. Clouds hide water.
              </span>
            </label>
          )}

          <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">At full flood level</h3>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <Stat label="Flooded land" value={stats ? `${stats.floodedAreaKm2.toFixed(2)} km²` : "–"} />
              <Stat label="Max depth" value={stats && stats.floodedCells ? formatLength(stats.maxDepthM, units) : "–"} />
            </dl>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
              Flooded land is water at least 5 cm deep, leaving out permanent rivers and lakes.
              {result && ` Computed in ${Math.round(result.ms)} ms in a Web Worker.`}
            </p>
            <DepthLegend units={units} />
          </section>

          <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3 text-xs text-[var(--text-secondary)]">
            <p>
              Terrain: our 30 m height map of this window, heights above sea level
              {exaggeration > 1 ? `, drawn ${exaggeration}× taller so the slopes show` : ""}. Outside the window the map is dimmed.{" "}
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
