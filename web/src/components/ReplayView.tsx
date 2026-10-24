"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchBinary, fetchReplay, type ReplayRequest, type ReplayResponse } from "@/lib/api";
import type { MapLibre, MLMap } from "@/lib/maplibre";
import { DEPTH_STOPS } from "@/lib/flood/depthRamp";
import { base64ToBytes } from "@/lib/flood/sceneData";
import { formatLocalHour, type ReplayGrid } from "@/lib/replay/data";
import type { ReplayWorkerRequest, ReplayWorkerResponse } from "@/lib/replay/messages";
import { COLORS } from "@/lib/replay/render";
import { ReplayLayer, type ReplayHover } from "@/lib/replay/replayLayer";
import { formatLength, formatShortLength, type UnitSystem } from "@/lib/units";
import ReplayChart from "./ReplayChart";
import SourceTag from "./SourceTag";

interface Props {
  lat: number;
  lon: number;
  units: UnitSystem;
  getMap(): { ml: MapLibre; map: MLMap } | null;
  onExit(): void;
}

const SIZES = [
  { km: 2, hint: "about 10 s" },
  { km: 5, hint: "about 30 s" },
  { km: 10, hint: "1-2 min" },
  { km: 20, hint: "5-10 min" },
];
const RAIN_SCALES = [1, 1.5, 2, 3];
const MAX_DAYS = 7;
const SPEEDS = [
  { label: "1×", ms: 1000 },
  { label: "2×", ms: 500 },
  { label: "4×", ms: 250 },
];
const POLL_MS = 2000;

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return isoDay(d);
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T12:00:00`).getTime() - new Date(`${a}T12:00:00`).getTime()) / 86_400_000);
}

type Poll = { runId: number; resp: ReplayResponse | null; error: string | null };
type Loaded = {
  resp: ReplayResponse;
  layer: ReplayLayer;
  frames: Uint16Array;
  ground: Float32Array;
  grid: ReplayGrid;
};

export default function ReplayView({ lat, lon, units, getMap, onExit }: Props) {
  const today = isoDay(new Date());
  const [form, setForm] = useState({
    start: addDays(today, -3),
    end: addDays(today, -1),
    sizeKm: 5,
    rainScale: 1,
    drainMmH: 5,
  });
  const [run, setRun] = useState<{ id: number; req: ReplayRequest } | null>(null);
  const [poll, setPoll] = useState<Poll | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<{ id: string; message: string } | null>(null);
  const [userHour, setUserHour] = useState<{ id: string; hour: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(SPEEDS[0].ms);
  const [hover, setHover] = useState<ReplayHover | null>(null);
  const runCounter = useRef(0);

  const days = daysBetween(form.start, form.end) + 1;
  const formError =
    days < 1 ? "The end date is before the start." : days > MAX_DAYS ? `Pick at most ${MAX_DAYS} days.` : null;

  // 1. Start the replay and poll until it is done.
  useEffect(() => {
    if (!run) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      fetchReplay(run.req, ctrl.signal)
        .then((resp) => {
          setPoll({ runId: run.id, resp, error: null });
          if (resp.status === "running") timer = setTimeout(tick, POLL_MS);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setPoll({ runId: run.id, resp: null, error: err instanceof Error ? err.message : String(err) });
        });
    };
    tick();
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [run]);

  const current = run && poll?.runId === run.id ? poll : null;
  const result = current?.resp?.status === "ok" ? current.resp : null;

  // 2. Load the frames and the buildings and roads, then put the layer on the map.
  useEffect(() => {
    if (!result?.grid || !result.depth_url || !result.features_url || !result.sea_u8 || !result.ground_f32) return;
    const m = getMap();
    if (!m) return;
    const ctrl = new AbortController();
    const worker = new Worker(new URL("../lib/replay/replay.worker.ts", import.meta.url), { type: "module" });
    const g = result.grid;
    const grid: ReplayGrid = { west: g.west, south: g.south, east: g.east, north: g.north, nx: g.nx, ny: g.ny, dxDeg: g.dx_deg, dyDeg: g.dy_deg };
    const seaBytes = base64ToBytes(result.sea_u8);
    const groundBytes = base64ToBytes(result.ground_f32);
    const ground = new Float32Array(groundBytes.buffer, groundBytes.byteOffset, groundBytes.byteLength / 4);
    let layer: ReplayLayer | null = null;
    (async () => {
      const [frames, features] = await Promise.all([
        fetchBinary(result.depth_url as string, ctrl.signal),
        fetchBinary(result.features_url as string, ctrl.signal),
      ]);
      const ready = new Promise<void>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<ReplayWorkerResponse>) => {
          if (e.data.type === "ready") resolve();
          else if (e.data.type === "error" && e.data.id === null) reject(new Error(e.data.message));
        };
        worker.onerror = (e) => reject(new Error(e.message || "The map worker crashed"));
      });
      const init: ReplayWorkerRequest = { type: "init", grid, hours: result.hours.length, frames: frames.slice(0), features, sea: seaBytes };
      worker.postMessage(init, [init.frames, features]);
      await ready;
      worker.onmessage = null;
      if (ctrl.signal.aborted) return;
      layer = new ReplayLayer(m.map, worker, grid);
      layer.enableHover(setHover);
      layer.fit();
      setLoaded({ resp: result, layer, frames: new Uint16Array(frames), ground, grid });
    })().catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setLoadError({ id: result.id, message: err instanceof Error ? err.message : String(err) });
    });
    return () => {
      ctrl.abort();
      layer?.destroy();
      worker.terminate();
      setHover(null);
    };
  }, [result, getMap]);

  const live = loaded && loaded.resp === result ? loaded : null;
  const hours = useMemo(() => result?.hours ?? [], [result]);
  const peakFlood = useMemo(() => hours.reduce((best, h, i) => (h.flooded_km2 > hours[best].flooded_km2 ? i : best), 0), [hours]);
  const peakBuildings = useMemo(
    () => hours.reduce((best, h, i) => (h.buildings_wet > hours[best].buildings_wet ? i : best), 0),
    [hours],
  );
  const hour = result && userHour?.id === result.id ? userHour.hour : peakFlood;
  const setHour = (h: number) => result && setUserHour({ id: result.id, hour: Math.max(0, Math.min(hours.length - 1, h)) });

  // 3. Show the hour; when playing, move on after the tiles are drawn.
  useEffect(() => {
    if (!live || !result) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = performance.now();
    void live.layer.show(hour).then(() => {
      if (cancelled || !playing) return;
      if (hour + 1 >= result.hours.length) {
        setPlaying(false);
        return;
      }
      timer = setTimeout(
        () => setUserHour({ id: result.id, hour: hour + 1 }),
        Math.max(0, speed - (performance.now() - started)),
      );
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [live, result, hour, playing, speed]);

  const start = () => {
    runCounter.current += 1;
    setPlaying(false);
    setRun({ id: runCounter.current, req: { lat, lon, ...form } });
  };

  const header = (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">Storm replay</h3>
      <button onClick={onExit} className="rounded bg-[var(--surface-2)] px-3 py-1.5 text-xs hover:text-[var(--text-primary)]">
        Back to map
      </button>
    </div>
  );

  // --- Settings ------------------------------------------------------------------
  if (!run) {
    const field = "mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-sm";
    return (
      <div className="space-y-3">
        {header}
        <p className="text-sm text-[var(--text-secondary)]">
          Pick a few days. FloodScope takes the hourly rain for this area, moves it across the bare ground hour by hour, and
          shows where water collects, which roads go under and which buildings get water at the door.
        </p>
        <section className="grid grid-cols-2 gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3 text-xs text-[var(--text-secondary)]">
          <label>
            First day
            <input type="date" value={form.start} max={addDays(today, 15)} onChange={(e) => setForm({ ...form, start: e.target.value })} className={field} />
          </label>
          <label>
            Last day
            <input type="date" value={form.end} max={addDays(today, 15)} onChange={(e) => setForm({ ...form, end: e.target.value })} className={field} />
          </label>
          <div className="col-span-2 flex flex-wrap gap-2">
            {[
              { label: "Last 3 days", start: addDays(today, -3), end: addDays(today, -1) },
              { label: "Next 3 days", start: today, end: addDays(today, 2) },
            ].map((p) => (
              <button key={p.label} onClick={() => setForm({ ...form, start: p.start, end: p.end })} className="rounded-full bg-[var(--surface-2)] px-3 py-1 hover:text-[var(--text-primary)]">
                {p.label}
              </button>
            ))}
          </div>
          <label className="col-span-2">
            Area
            <select value={form.sizeKm} onChange={(e) => setForm({ ...form, sizeKm: Number(e.target.value) })} className={field}>
              {SIZES.map((s) => (
                <option key={s.km} value={s.km}>
                  {s.km} × {s.km} km (first run {s.hint})
                </option>
              ))}
            </select>
          </label>
          <label>
            Rain
            <select value={form.rainScale} onChange={(e) => setForm({ ...form, rainScale: Number(e.target.value) })} className={field}>
              {RAIN_SCALES.map((r) => (
                <option key={r} value={r}>
                  {r === 1 ? "As forecast (1×)" : `${r}× stronger`}
                </option>
              ))}
            </select>
          </label>
          <label>
            Drains: {form.drainMmH} mm/h
            <input type="range" min={0} max={30} step={1} value={form.drainMmH} onChange={(e) => setForm({ ...form, drainMmH: Number(e.target.value) })} className="mt-2 w-full accent-[var(--series-1)]" />
          </label>
          <p className="col-span-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
            Weather models spread storms out, so a local downpour can be stronger than its rain data. Drain capacity is not known
            anywhere; it is a setting you choose. Dates are local days. Rain data reaches 15 days ahead.
          </p>
        </section>
        {formError && <p role="alert" className="text-xs text-[var(--text-primary)]">{formError}</p>}
        <button
          onClick={start}
          disabled={Boolean(formError)}
          className="w-full rounded-lg bg-[var(--series-1)] px-4 py-2.5 text-sm font-medium text-white shadow hover:brightness-110 disabled:opacity-40"
        >
          Run the replay
        </button>
      </div>
    );
  }

  const back = (
    <button onClick={() => setRun(null)} className="rounded bg-[var(--surface-2)] px-3 py-1.5 text-xs hover:text-[var(--text-primary)]">
      Change settings
    </button>
  );

  // --- Running, failed or empty -----------------------------------------------------
  const resp = current?.resp ?? null;
  if (!result) {
    const error = current?.error ?? (resp && resp.status !== "running" ? resp.reason : null);
    return (
      <div className="space-y-3">
        {header}
        {error ? (
          <div role="alert" className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4 text-sm">
            <p className="font-medium">{resp?.status === "no_data" ? "No data here" : "The replay could not run"}</p>
            <p className="mt-1 text-[var(--text-secondary)]">{error}</p>
            <div className="mt-3 flex gap-2">
              <button onClick={start} className="rounded bg-[var(--surface-2)] px-3 py-1.5 text-xs">Try again</button>
              {back}
            </div>
          </div>
        ) : (
          <div aria-live="polite" className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4 text-sm">
            <p className="font-medium">{resp?.stage || "Starting the replay"}</p>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-2)]">
              <div className="h-full bg-[var(--series-1)] transition-all" style={{ width: `${Math.round((resp?.progress ?? 0) * 100)}%` }} />
            </div>
            <p className="mt-2 text-xs text-[var(--text-muted)]">
              The server downloads ground heights, rain and buildings, then simulates every hour. You can leave this open; the result
              is saved, so asking again later is instant.
            </p>
            <div className="mt-3">{back}</div>
          </div>
        )}
      </div>
    );
  }

  // --- Result ---------------------------------------------------------------------
  const h = hours[hour];
  const n = live ? live.grid.nx * live.grid.ny : 0;
  const hoverDepth = live && hover ? live.frames[hour * n + hover.cell] / 100 : null;
  const hoverGround = live && hover ? live.ground[hover.cell] : null;
  const wettest = Math.max(...hours.map((x) => x.rain_mm));
  const quiet = hours[peakFlood].flooded_km2 < 0.05;
  const req = result.request;

  return (
    <div className="space-y-3">
      {header}
      <p className="text-xs text-[var(--text-secondary)]">
        {formatLocalHour(`${req.start}T00:00`).split(",")[0]} to {formatLocalHour(`${req.end}T00:00`).split(",")[0]} ·{" "}
        {req.size_km} × {req.size_km} km · rain {req.rain_scale}× · drains {req.drain_mm_h} mm/h · {result.timezone} time
      </p>
      {loadError?.id === result.id && (
        <p role="alert" className="text-xs text-[var(--text-primary)]">Could not draw the replay: {loadError.message}</p>
      )}
      {!live && !loadError && <p className="text-xs text-[var(--text-muted)]">Loading the map layers…</p>}

      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              if (!playing && hour + 1 >= hours.length) setHour(0);
              setPlaying((p) => !p);
            }}
            disabled={!live}
            aria-label={playing ? "Pause" : "Play"}
            className="grid h-8 w-8 place-items-center rounded-full bg-[var(--series-1)] text-white disabled:opacity-40"
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <div className="flex rounded-md bg-[var(--surface-2)] p-0.5 text-[11px]" role="group" aria-label="Speed">
            {SPEEDS.map((s) => (
              <button key={s.ms} onClick={() => setSpeed(s.ms)} aria-pressed={speed === s.ms} className={`rounded px-2 py-0.5 ${speed === s.ms ? "bg-[var(--surface-1)] text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}>
                {s.label}
              </button>
            ))}
          </div>
          <p className="ml-auto text-sm font-medium tabular-nums">{formatLocalHour(h.time)}</p>
        </div>
        <div className="mt-2">
          <ReplayChart hours={hours} hour={hour} onPick={(i) => { setPlaying(false); setHour(i); }} />
        </div>
        <input
          type="range"
          min={0}
          max={hours.length - 1}
          value={hour}
          onChange={(e) => { setPlaying(false); setHour(Number(e.target.value)); }}
          aria-label="Hour"
          className="w-full accent-[var(--series-1)]"
        />
        <p className="text-[11px] text-[var(--text-muted)]">
          Bars: rain each hour. Line: land under {formatShortLength(0.1, units)} of water or more.
        </p>
      </section>

      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3">
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">At this hour</h4>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
          <Stat label={`Land under water (${formatShortLength(0.1, units)}+)`} value={`${h.flooded_km2.toFixed(2)} km²`} />
          <Stat label="Water at the door" value={`${h.buildings_wet.toLocaleString("en-GB")} of ${result.buildings_total.toLocaleString("en-GB")} buildings`} />
          <Stat label={`Roads under ${formatShortLength(0.1, units)}+`} value={`${h.roads_km_10cm.toFixed(1)} km`} />
          <Stat label={`Roads under ${formatShortLength(0.3, units)}+ (cars stop)`} value={`${h.roads_km_30cm.toFixed(1)} km`} />
          <Stat label="Rain this hour" value={`${h.rain_mm.toFixed(1)} mm`} />
          <Stat label="Sea level (tide)" value={h.sea_level_m === null ? "No sea here" : formatLength(h.sea_level_m, units, 2)} />
        </dl>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <button onClick={() => { setPlaying(false); setHour(peakFlood); }} className="rounded-full bg-[var(--surface-2)] px-3 py-1 hover:text-[var(--text-primary)]">
            Most land under water: {formatLocalHour(hours[peakFlood].time)}
          </button>
          <button onClick={() => { setPlaying(false); setHour(peakBuildings); }} className="rounded-full bg-[var(--surface-2)] px-3 py-1 hover:text-[var(--text-primary)]">
            Most buildings with water at the door: {formatLocalHour(hours[peakBuildings].time)}
          </button>
        </div>
        {hover && hoverDepth !== null && (
          <p className="mt-3 text-xs text-[var(--text-secondary)]">
            Under the cursor: {hoverDepth >= 0.05 ? `${formatShortLength(hoverDepth, units)} of water` : "dry"}
            {hoverGround !== null && Number.isFinite(hoverGround) ? `, ground ${formatLength(hoverGround, units)} above sea level` : ", sea"}
          </p>
        )}
        {quiet && (
          <p className="mt-3 text-xs text-[var(--text-primary)]">
            Little water stays on the ground in this replay. The wettest hour had {wettest.toFixed(1)} mm of rain over the area
            (after the {req.rain_scale}× setting), and drains take {req.drain_mm_h} mm an hour. Weather models spread storms out,
            so try stronger rain or smaller drains to see what a concentrated downpour would do.
          </p>
        )}
        <Legend units={units} />
      </section>

      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3 text-xs text-[var(--text-secondary)]">
        <p>
          {result.rain_total_mm.toFixed(0)} mm of rain fell on average over the area. {result.roads_km_total.toFixed(0)} km of
          roads and {result.buildings_total.toLocaleString("en-GB")} buildings are mapped here.
        </p>
        <details className="mt-2">
          <summary className="cursor-pointer text-[var(--text-primary)]">What the model assumes</summary>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {result.assumptions.map((a) => <li key={a}>{a}</li>)}
          </ul>
        </details>
        <details className="mt-2">
          <summary className="cursor-pointer text-[var(--text-primary)]">What it leaves out</summary>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {result.limits.map((a) => <li key={a}>{a}</li>)}
          </ul>
        </details>
        {result.sources.map((s) => <SourceTag key={s.name} source={s} />)}
        <div className="mt-3">{back}</div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-[var(--text-muted)]">{label}</dt>
      <dd className="font-semibold tabular-nums text-[var(--text-primary)]">{value}</dd>
    </div>
  );
}

function Legend({ units }: { units: UnitSystem }) {
  const stops = DEPTH_STOPS.filter((s) => s.depth <= 2);
  const gradient = `linear-gradient(to right, ${stops.map((s, i) => `${s.color} ${(i / (stops.length - 1)) * 100}%`).join(", ")})`;
  const swatch = (color: string, label: string, line = false) => (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className={line ? "h-1 w-4 rounded" : "h-3 w-3 rounded-sm"} style={{ background: color }} />
      {label}
    </span>
  );
  return (
    <figure className="mt-3 text-[10px] text-[var(--text-muted)]">
      <div className="h-2.5 rounded-sm" style={{ background: gradient }} aria-hidden />
      <figcaption className="mt-1 flex justify-between tabular-nums">
        <span>{formatShortLength(0.05, units)}</span>
        <span>{formatLength(1, units, 0)}</span>
        <span>{formatLength(2, units, 0)}+</span>
      </figcaption>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {swatch(COLORS.roadWet, `Road, ${formatShortLength(0.1, units)} to ${formatShortLength(0.3, units)}`, true)}
        {swatch(COLORS.roadDeep, `Road, ${formatShortLength(0.3, units)}+`, true)}
        {swatch(COLORS.buildingWet, "Water at the door")}
        {swatch("rgb(200,200,200)", "Building (zoom in)")}
      </div>
    </figure>
  );
}
