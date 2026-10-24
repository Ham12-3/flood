"use client";

import { useId } from "react";
import type { ReplayHour } from "@/lib/api";
import { formatLocalHour } from "@/lib/replay/data";

interface Props {
  hours: ReplayHour[];
  hour: number;
  onPick(hour: number): void;
}

const W = 380;
const H = 120;
const M = { top: 10, right: 8, bottom: 20, left: 8 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

/** Hourly rain (bars) and land under water (line); click or drag to pick an hour. */
export default function ReplayChart({ hours, hour, onPick }: Props) {
  const titleId = useId();
  const n = hours.length;
  const maxRain = Math.max(1, ...hours.map((h) => h.rain_mm));
  const maxFlood = Math.max(0.01, ...hours.map((h) => h.flooded_km2));
  const x = (i: number) => M.left + ((i + 0.5) / n) * PLOT_W;
  const barW = Math.max(1, PLOT_W / n - 1);
  const line = hours
    .map((h, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${(M.top + PLOT_H - (h.flooded_km2 / maxFlood) * PLOT_H).toFixed(1)}`)
    .join("");
  // Day boundaries for the axis: hours ending at 01:00 start a new day.
  const days = hours.flatMap((h, i) => (h.time.endsWith("T01:00") || i === 0 ? [i] : []));

  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = ((e.clientX - rect.left) / rect.width) * W;
    onPick(Math.min(n - 1, Math.max(0, Math.floor(((fx - M.left) / PLOT_W) * n))));
  };

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full cursor-pointer touch-none select-none"
      role="img"
      aria-labelledby={titleId}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        pick(e);
      }}
      onPointerMove={(e) => e.buttons && pick(e)}
    >
      <title id={titleId}>
        Rain each hour (bars, wettest {maxRain.toFixed(1)} mm) and land under water (line, most {maxFlood.toFixed(2)} km²)
      </title>
      {hours.map((h, i) => (
        <rect
          key={h.time}
          x={x(i) - barW / 2}
          y={M.top + PLOT_H - (h.rain_mm / maxRain) * PLOT_H}
          width={barW}
          height={(h.rain_mm / maxRain) * PLOT_H}
          fill="var(--text-muted)"
          opacity={0.55}
        />
      ))}
      <path d={line} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" />
      <line x1={x(hour)} x2={x(hour)} y1={M.top - 4} y2={M.top + PLOT_H} stroke="var(--text-primary)" strokeWidth={1.5} />
      <line x1={M.left} x2={W - M.right} y1={M.top + PLOT_H} y2={M.top + PLOT_H} stroke="var(--border)" />
      {days.map((i) => (
        <text key={i} x={x(i)} y={H - 6} fontSize={10} fill="var(--text-muted)">
          {formatLocalHour(hours[i].time).split(",")[0]}
        </text>
      ))}
    </svg>
  );
}
