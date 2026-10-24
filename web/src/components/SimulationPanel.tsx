"use client";

import { useEffect, useRef, useState } from "react";
import type { SceneArrays } from "@/lib/flood/sceneData";
import { GpuSwe, webgpuAvailable } from "@/lib/sim/gpu";
import { inflowCells, type SweParams } from "@/lib/sim/swe";
import { formatDischarge, type UnitSystem } from "@/lib/units";

interface Props {
  arrays: SceneArrays;
  todayFlow: number | null; // m3/s, GloFAS ensemble mean today
  units: UnitSystem;
  onDepth(depth: Float32Array): void;
  onUseFill(): void;
}

const MANNING = 0.035; // a typical floodplain roughness
const STEPS_PER_FRAME = 40;
const READ_EVERY_MS = 450;

/** Phase 5: a WebGPU shallow-water simulation on the terrain window. */
export default function SimulationPanel({ arrays, todayFlow, units, onDepth, onUseFill }: Props) {
  const [factor, setFactor] = useState(3);
  const [rain, setRain] = useState(0);
  const [soak, setSoak] = useState(10); // mm/h the ground absorbs (typical loam)
  const [hours, setHours] = useState(12);
  const [running, setRunning] = useState(false);
  const [simTime, setSimTime] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const hasGpu = webgpuAvailable();

  const cells = inflowCells(arrays.ground, arrays.permanent, arrays.grid.nx, arrays.grid.ny);
  const inflow = todayFlow && cells.length ? todayFlow * factor : 0;

  useEffect(() => () => stopRef.current?.(), []);

  async function start() {
    setMessage(null);
    const p: SweParams = {
      nx: arrays.grid.nx,
      ny: arrays.grid.ny,
      dx: arrays.grid.cellW,
      dy: arrays.grid.cellH,
      manning: MANNING,
      rainMmPerHour: Math.max(0, rain - soak),
      inflow: cells.map((cell) => ({ cell, m3s: inflow / cells.length })),
      alpha: 0.7,
      maxDt: 10,
    };
    const solver = await GpuSwe.create(arrays.ground, p);
    if ("reason" in solver) {
      setMessage(`${solver.reason} Use the Custom fill instead.`);
      return;
    }
    let raf = 0;
    let stopped = false;
    let lastRead = 0;
    const until = hours * 3600;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      solver.destroy();
      setRunning(false);
      stopRef.current = null;
    };
    stopRef.current = stop;
    setRunning(true);
    setSimTime(0);
    const tick = (now: number) => {
      if (stopped) return;
      solver.run(STEPS_PER_FRAME);
      if (now - lastRead > READ_EVERY_MS) {
        lastRead = now;
        solver
          .read()
          .then((r) => {
            if (!r || stopped) return;
            setSimTime(r.time);
            onDepth(r.depth);
            if (r.time >= until) stop();
          })
          .catch((err: unknown) => {
            setMessage(`Simulation stopped: ${err instanceof Error ? err.message : String(err)}`);
            stop();
          });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  if (!hasGpu) {
    return (
      <div className="text-xs text-[var(--text-secondary)]">
        <p>
          This browser has no WebGPU, so the water simulation cannot run here (it works in recent Chrome and Edge). The
          Custom fill is a fast approximation that needs no GPU.
        </p>
        <button onClick={onUseFill} className="mt-2 rounded bg-[var(--surface-2)] px-3 py-1.5">
          Use the Custom fill
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 text-xs text-[var(--text-secondary)]">
      <label className="block">
        River inflow: {factor}× today&apos;s flow
        {todayFlow ? ` = ${formatDischarge(todayFlow * factor, units)}` : ""}
        <input type="range" min={0} max={20} step={0.5} value={factor} disabled={running}
          onChange={(e) => setFactor(Number(e.target.value))} className="w-full accent-[var(--series-1)]" />
      </label>
      <label className="block">
        Rain: {rain} mm per hour
        <input type="range" min={0} max={100} step={1} value={rain} disabled={running}
          onChange={(e) => setRain(Number(e.target.value))} className="w-full accent-[var(--series-1)]" />
      </label>
      <label className="block">
        Ground soaks up {soak} mm per hour{rain > 0 ? ` (rain reaching the surface: ${Math.max(0, rain - soak)} mm/h)` : ""}
        <input type="range" min={0} max={50} step={1} value={soak} disabled={running}
          onChange={(e) => setSoak(Number(e.target.value))} className="w-full accent-[var(--series-1)]" />
      </label>
      <label className="block">
        Simulate {hours} hours
        <input type="range" min={1} max={48} step={1} value={hours} disabled={running}
          onChange={(e) => setHours(Number(e.target.value))} className="w-full accent-[var(--series-1)]" />
      </label>
      <div className="flex items-center gap-2">
        <button
          onClick={running ? () => stopRef.current?.() : start}
          className="rounded bg-[var(--series-1)] px-3 py-1.5 text-white"
        >
          {running ? "Stop" : "Run simulation"}
        </button>
        {simTime !== null && (
          <span className="tabular-nums">
            {(simTime / 3600).toFixed(1)} h of {hours} h simulated
          </span>
        )}
      </div>
      {!cells.length && <p>The river does not cross the edge of this window, so only rain is added.</p>}
      {cells.length > 0 && !todayFlow && <p>No GloFAS flow for today here, so only rain is added.</p>}
      {message && <p role="alert" className="text-[var(--text-primary)]">{message}</p>}
      <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
        Local-inertial shallow-water equations (Bates et al. 2010, as in LISFLOOD-FP) on the 30 m DEM, run on your GPU.
        River water enters where the river crosses the window&apos;s higher edge; water leaves freely at every edge.
        Floodplain roughness n = {MANNING}. Infiltration is one constant rate everywhere (sandy soils take more, clay and
        paved ground far less; see the Underground panel for how wet the ground already is). The DEM has no river bed, so channels carry too little and spill early: treat
        this as an illustration of how water spreads, not a forecast.
      </p>
    </div>
  );
}
