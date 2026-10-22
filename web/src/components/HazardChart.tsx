"use client";

import { useId, useState } from "react";
import type { HazardDepth } from "@/lib/api";
import { niceCeil } from "@/lib/discharge";
import { annualChance } from "@/lib/format";
import { formatLength, lengthUnit, lengthValue, type UnitSystem } from "@/lib/units";

interface Props {
  depths: HazardDepth[];
  units: UnitSystem;
}

const W = 360;
const H = 160;
const M = { top: 18, right: 8, bottom: 30, left: 40 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;
const GAP = 2;
const R = 4;

/** Bar with 4px rounded top corners, square at the baseline. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(R, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export default function HazardChart({ depths, units }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  const maxDepth = Math.max(0, ...depths.map((d) => d.depth_m ?? 0));
  const yMax = niceCeil(lengthValue(maxDepth || 1, units));
  const slot = PLOT_W / depths.length;
  const barW = Math.min(30, slot - GAP * 4);
  const y = (v: number) => M.top + PLOT_H - (v / yMax) * PLOT_H;
  const ticks = [0, 0.5, 1].map((f) => f * yMax);
  const maxIndex = depths.findIndex((d) => d.depth_m === maxDepth && maxDepth > 0);
  const hovered = hover !== null ? depths[hover] : null;

  return (
    <figure className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none" role="img" aria-labelledby={titleId}>
        <title id={titleId}>Modelled flood depth at this point for each return period</title>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} className="stroke-[var(--grid)]" strokeWidth={1} />
            <text x={M.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-[var(--text-muted)] text-[10px] tabular-nums">
              {t.toLocaleString("en-GB", { maximumFractionDigits: 2 })} {lengthUnit(units)}
            </text>
          </g>
        ))}
        {depths.map((d, i) => {
          const cx = M.left + slot * i + slot / 2;
          const v = d.depth_m !== null && d.depth_m !== undefined ? lengthValue(d.depth_m, units) : 0;
          const top = y(v);
          return (
            <g
              key={d.return_period}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
              className="cursor-default"
            >
              {/* Hit target wider and taller than the mark. */}
              <rect x={M.left + slot * i} y={M.top} width={slot} height={PLOT_H} fill="transparent" />
              {d.flooded && v > 0 ? (
                <path
                  d={barPath(cx - barW / 2, top, barW, M.top + PLOT_H - top)}
                  className="fill-[var(--series-1)]"
                  opacity={hover === null || hover === i ? 1 : 0.55}
                />
              ) : (
                <text x={cx} y={M.top + PLOT_H - 4} textAnchor="middle" className="fill-[var(--text-muted)] text-[9px]">
                  dry
                </text>
              )}
              {i === maxIndex && (
                <text x={cx} y={top - 5} textAnchor="middle" className="fill-[var(--text-secondary)] text-[10px] tabular-nums">
                  {formatLength(maxDepth, units, 2)}
                </text>
              )}
              <text x={cx} y={H - 14} textAnchor="middle" className="fill-[var(--text-secondary)] text-[10px]">
                {d.return_period}
              </text>
            </g>
          );
        })}
        <text x={M.left + PLOT_W / 2} y={H - 2} textAnchor="middle" className="fill-[var(--text-muted)] text-[9px]">
          Return period (years)
        </text>
      </svg>
      {hovered && hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-xs shadow-lg"
          style={{
            left: `${((M.left + slot * hover + slot / 2) / W) * 100}%`,
            transform: hover > depths.length / 2 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
          }}
        >
          <div className="font-medium text-[var(--text-primary)]">1 in {hovered.return_period} years</div>
          <div className="text-[var(--text-secondary)]">
            {annualChance(hovered.return_period)} chance each year ·{" "}
            <span className="text-[var(--text-primary)]">
              {hovered.flooded && hovered.depth_m ? formatLength(hovered.depth_m, units, 2) : "stays dry"}
            </span>
          </div>
        </div>
      )}
    </figure>
  );
}
