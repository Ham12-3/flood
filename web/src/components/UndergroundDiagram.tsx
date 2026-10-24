"use client";

import { useId } from "react";
import type { GroundResponse } from "@/lib/api";
import { groundwaterOffsetM, rankText, wetnessColor } from "@/lib/underground/geometry";
import { formatLength, formatShortLength, type UnitSystem } from "@/lib/units";

interface Props {
  ground: GroundResponse;
  units: UnitSystem;
}

const W = 380;
const H = 230;
const TOP = 30; // ground surface
const BOTTOM = H - 16;
const SOIL_BOTTOM_CM = 255;
const LABEL_GAP = 13; // px between soil labels, so thin layers do not overlap

/**
 * A cut-away below the point. Two columns, each drawn to its own true scale and
 * labelled: the soil layers (top 2.55 m) and the water table (often much deeper).
 */
export default function UndergroundDiagram({ ground, units }: Props) {
  const titleId = useId();
  const soil = ground.soil.status === "ok" ? ground.soil.layers : [];
  const station = ground.groundwater.status === "ok" ? ground.groundwater.station : null;
  const gwOffset = groundwaterOffsetM(station?.depth_below_datum_m);
  const gwDepth = gwOffset === null ? null : -gwOffset;

  // Soil column: 0-2.55 m to scale.
  const soilY = (cm: number) => TOP + (cm / SOIL_BOTTOM_CM) * (BOTTOM - TOP);
  // Water-table column: 0 to a little below the water table (at least the soil depth).
  const gwMax = Math.max(gwDepth === null ? 0 : gwDepth * 1.25, SOIL_BOTTOM_CM / 100 + 0.5);
  const gwY = (m: number) => TOP + (m / gwMax) * (BOTTOM - TOP);
  // Each label sits at its layer's middle, pushed down when the layer above is thin.
  const labelY: number[] = [];
  soil.forEach((l, i) => {
    const mid = (soilY(l.top_cm) + soilY(l.bottom_cm)) / 2 + 3.5;
    labelY.push(i === 0 ? Math.max(mid, TOP + 9) : Math.max(mid, labelY[i - 1] + LABEL_GAP));
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-labelledby={titleId}>
      <title id={titleId}>
        Cut-away below the point: soil layers coloured by how wet they are for the time of year
        {gwDepth !== null ? `, and the water table about ${formatLength(gwDepth, units)} down` : ""}.
      </title>
      {/* Ground surface */}
      <line x1={0} x2={W} y1={TOP} y2={TOP} stroke="#7c9a5c" strokeWidth={3} />
      <text x={4} y={TOP - 8} fontSize={10} fill="var(--text-muted)">
        Ground surface
      </text>

      {/* Soil column */}
      <text x={20} y={H - 2} fontSize={10} fill="var(--text-muted)">
        Soil, top {formatLength(SOIL_BOTTOM_CM / 100, units, 2)} (to scale)
      </text>
      {soil.length === 0 && (
        <text x={20} y={TOP + 30} fontSize={11} fill="var(--text-secondary)">
          No soil data here
        </text>
      )}
      {soil.map((l, i) => {
        const y0 = soilY(l.top_cm);
        const y1 = soilY(l.bottom_cm);
        const rank = rankText(l.season_percentile);
        return (
          <g key={l.top_cm}>
            <rect x={20} y={y0} width={46} height={y1 - y0} fill={wetnessColor(l.relative_wetness_pct)} stroke="#1a1a19" />
            <text x={72} y={labelY[i]} fontSize={9.5} fill="var(--text-secondary)">
              {l.top_cm === 0 ? "0" : formatShortLength(l.top_cm / 100, units)}–{formatShortLength(l.bottom_cm / 100, units)}
              {l.value !== null ? `: ${l.value.toFixed(2)} m³/m³` : ": no value"}
            </text>
            {rank && y1 - y0 > 26 && (
              <text x={72} y={labelY[i] + 12} fontSize={8.5} fill="var(--text-muted)">
                {rank.replace(" at this time of year", "")}
              </text>
            )}
          </g>
        );
      })}

      {/* Water-table column */}
      <g transform="translate(250 0)">
        <text x={0} y={H - 2} fontSize={10} fill="var(--text-muted)">
          Water table (to scale)
        </text>
        <rect x={0} y={TOP} width={46} height={gwY(SOIL_BOTTOM_CM / 100) - TOP} fill="#8a7a62" opacity={0.6} />
        <rect x={0} y={gwY(SOIL_BOTTOM_CM / 100)} width={46} height={BOTTOM - gwY(SOIL_BOTTOM_CM / 100)} fill="#6b6152" opacity={0.6} />
        {gwDepth !== null && station ? (
          <>
            <rect x={0} y={gwY(gwDepth)} width={46} height={BOTTOM - gwY(gwDepth)} fill="#3987e5" opacity={0.75} />
            <line x1={-6} x2={52} y1={gwY(gwDepth)} y2={gwY(gwDepth)} stroke="#9ec5f4" strokeWidth={2} strokeDasharray="4 3" />
            <text x={52} y={Math.max(gwY(gwDepth) - 4, TOP + 10)} fontSize={9.5} fill="var(--text-primary)">
              {formatLength(gwDepth, units)} down
            </text>
            <text x={52} y={Math.max(gwY(gwDepth) + 9, TOP + 22)} fontSize={8.5} fill="var(--text-muted)">
              {station.distance_km.toFixed(1)} km away
            </text>
          </>
        ) : (
          <text x={52} y={TOP + 30} fontSize={9.5} fill="var(--text-secondary)">
            <tspan x={52}>No borehole</tspan>
            <tspan x={52} dy={12}>reading near here</tspan>
          </text>
        )}
      </g>
    </svg>
  );
}
