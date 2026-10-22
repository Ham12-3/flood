"use client";

import { useId, useMemo, useState } from "react";
import type { DischargeDay } from "@/lib/api";
import { dischargeDomain } from "@/lib/discharge";
import { formatDay } from "@/lib/format";
import { dischargeUnit, dischargeValue, formatDischarge, type UnitSystem } from "@/lib/units";

interface Props {
  days: DischargeDay[];
  units: UnitSystem;
}

const W = 360;
const H = 190;
const M = { top: 12, right: 10, bottom: 24, left: 46 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

type Accessor = (d: DischargeDay) => number | null | undefined;

/** Split into runs of consecutive days where every accessor has a value. */
function runs(days: DischargeDay[], accessors: Accessor[]): number[][] {
  const out: number[][] = [];
  let current: number[] = [];
  days.forEach((d, i) => {
    if (accessors.every((a) => typeof a(d) === "number")) current.push(i);
    else if (current.length) {
      out.push(current);
      current = [];
    }
  });
  if (current.length) out.push(current);
  return out;
}

export default function DischargeChart({ days, units }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  const domain = useMemo(() => dischargeDomain(days, (v) => dischargeValue(v, units)), [days, units]);

  const x = (i: number) => M.left + (days.length > 1 ? (i / (days.length - 1)) * PLOT_W : PLOT_W / 2);
  // v is in m3/s; the domain is in display units.
  const y = (v: number) => M.top + PLOT_H - (dischargeValue(v, units) / domain.max) * PLOT_H;
  const yTick = (t: number) => M.top + PLOT_H - (t / domain.max) * PLOT_H;

  const linePath = (acc: Accessor) =>
    runs(days, [acc])
      .map((run) => run.map((i, k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(acc(days[i]) as number).toFixed(1)}`).join(""))
      .join("");

  const bandPath = (lo: Accessor, hi: Accessor) =>
    runs(days, [lo, hi])
      .map((run) => {
        const top = run.map((i, k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(hi(days[i]) as number).toFixed(1)}`);
        const bottom = [...run].reverse().map((i) => `L${x(i).toFixed(1)},${y(lo(days[i]) as number).toFixed(1)}`);
        return `${top.join("")}${bottom.join("")}Z`;
      })
      .join("");

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * domain.max);
  const dateTicks = days.map((_, i) => i).filter((i) => i % 7 === 0);
  const hasBand = days.some((d) => typeof d.ensemble_min === "number");
  const hovered = hover !== null ? days[hover] : null;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - M.left) / PLOT_W) * (days.length - 1));
    setHover(Math.max(0, Math.min(days.length - 1, i)));
  }

  return (
    <figure className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full touch-none select-none"
        role="img"
        aria-labelledby={titleId}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <title id={titleId}>
          River discharge forecast for the next {days.length} days, in {dischargeUnit(units)}
        </title>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={W - M.right} y1={yTick(t)} y2={yTick(t)} className="stroke-[var(--grid)]" strokeWidth={1} />
            <text x={M.left - 6} y={yTick(t)} dy="0.32em" textAnchor="end" className="fill-[var(--text-muted)] text-[10px] tabular-nums">
              {formatAxis(t)}
            </text>
          </g>
        ))}
        {dateTicks.map((i) => (
          <text key={i} x={x(i)} y={H - 6} textAnchor="middle" className="fill-[var(--text-muted)] text-[10px]">
            {formatDay(days[i].date)}
          </text>
        ))}
        {hasBand && (
          <>
            <path d={bandPath((d) => d.ensemble_min, (d) => d.ensemble_max)} className="fill-[var(--series-1)]" fillOpacity={0.16} />
            <path d={bandPath((d) => d.ensemble_p25, (d) => d.ensemble_p75)} className="fill-[var(--series-1)]" fillOpacity={0.32} />
          </>
        )}
        {/* Ensemble mean is the steadier central estimate weeks ahead; the single
            main run is drawn dashed for comparison. */}
        <path
          d={linePath((d) => d.ensemble_mean)}
          fill="none"
          className="stroke-[var(--series-1)]"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path
          d={linePath((d) => d.discharge)}
          fill="none"
          className="stroke-[var(--text-secondary)]"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          strokeLinejoin="round"
        />
        {hovered && hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + PLOT_H} className="stroke-[var(--text-muted)]" strokeWidth={1} />
            {typeof hovered.ensemble_mean === "number" && (
              <circle cx={x(hover)} cy={y(hovered.ensemble_mean)} r={4} className="fill-[var(--series-1)] stroke-[var(--surface-1)]" strokeWidth={2} />
            )}
          </g>
        )}
      </svg>
      {hovered && hover !== null && (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-40 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-xs shadow-lg"
          style={{
            left: `${(x(hover) / W) * 100}%`,
            transform: hover > days.length / 2 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
          }}
        >
          <div className="mb-1 font-medium text-[var(--text-primary)]">{formatDay(hovered.date)}</div>
          <TooltipRow label="Ensemble mean" value={hovered.ensemble_mean} units={units} />
          <TooltipRow label="Main forecast" value={hovered.discharge} units={units} />
          <TooltipRow label="Middle 50%" value={hovered.ensemble_p25} upper={hovered.ensemble_p75} units={units} />
          <TooltipRow label="Full range" value={hovered.ensemble_min} upper={hovered.ensemble_max} units={units} />
        </div>
      )}
      <figcaption className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--text-secondary)]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded bg-[var(--series-1)]" aria-hidden /> Ensemble mean
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 border-t-[1.5px] border-dashed border-[var(--text-secondary)]" aria-hidden /> Main
          forecast
        </span>
        {hasBand && (
          <>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-4 rounded-sm bg-[var(--series-1)] opacity-50" aria-hidden /> Middle 50% of
              ensemble
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-4 rounded-sm bg-[var(--series-1)] opacity-25" aria-hidden /> Full ensemble
              range
            </span>
          </>
        )}
      </figcaption>
      <details className="mt-2 text-xs text-[var(--text-secondary)]">
        <summary className="cursor-pointer select-none hover:text-[var(--text-primary)]">Show as table</summary>
        <div className="mt-2 max-h-56 overflow-auto rounded border border-[var(--border)]">
          <table className="w-full text-left tabular-nums">
            <thead className="sticky top-0 bg-[var(--surface-2)] text-[var(--text-muted)]">
              <tr>
                <th className="px-2 py-1 font-normal">Day</th>
                <th className="px-2 py-1 font-normal">Mean</th>
                <th className="px-2 py-1 font-normal">Main</th>
                <th className="px-2 py-1 font-normal">Min</th>
                <th className="px-2 py-1 font-normal">Max</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.date} className="border-t border-[var(--border)]">
                  <td className="px-2 py-1">{formatDay(d.date)}</td>
                  <td className="px-2 py-1">{fmtOrDash(d.ensemble_mean, units)}</td>
                  <td className="px-2 py-1">{fmtOrDash(d.discharge, units)}</td>
                  <td className="px-2 py-1">{fmtOrDash(d.ensemble_min, units)}</td>
                  <td className="px-2 py-1">{fmtOrDash(d.ensemble_max, units)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function TooltipRow({
  label,
  value,
  upper,
  units,
}: {
  label: string;
  value: number | null | undefined;
  upper?: number | null | undefined;
  units: UnitSystem;
}) {
  if (typeof value !== "number") return null;
  const text =
    typeof upper === "number"
      ? `${formatDischarge(value, units)} – ${formatDischarge(upper, units)}`
      : formatDischarge(value, units);
  return (
    <div className="flex justify-between gap-3 text-[var(--text-secondary)]">
      <span>{label}</span>
      <span className="tabular-nums text-[var(--text-primary)]">{text}</span>
    </div>
  );
}

function fmtOrDash(v: number | null | undefined, units: UnitSystem): string {
  return typeof v === "number" ? formatDischarge(v, units) : "–";
}

function formatAxis(v: number): string {
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  if (v >= 10) return Math.round(v).toString();
  return v.toFixed(v === 0 ? 0 : 1);
}
