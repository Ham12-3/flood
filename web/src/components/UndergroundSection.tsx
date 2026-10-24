"use client";

import type { GroundResponse } from "@/lib/api";
import { formatDay, formatDateTime } from "@/lib/format";
import { rankText, wetnessColor } from "@/lib/underground/geometry";
import { formatLength, type UnitSystem } from "@/lib/units";
import Section from "./Section";
import SourceTag from "./SourceTag";
import UndergroundDiagram from "./UndergroundDiagram";

interface Props {
  ground: GroundResponse | null;
  error: string | null;
  units: UnitSystem;
}

/** Soil moisture by layer, the plain-English summary, and the nearest groundwater level. */
export default function UndergroundSection({ ground, error, units }: Props) {
  if (error) {
    return (
      <section role="alert" className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4 text-sm">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Underground</h3>
        <p className="font-medium">Couldn&apos;t load this right now</p>
        <p className="mt-1 text-[var(--text-secondary)]">{error}</p>
      </section>
    );
  }
  if (!ground) {
    return (
      <section className="animate-pulse rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4 text-sm text-[var(--text-secondary)]">
        Loading soil moisture and groundwater…
      </section>
    );
  }
  const soil = ground.soil;
  const gw = ground.groundwater;
  const station = gw.station;
  return (
    <>
      {(soil.status === "ok" || gw.status === "ok") && (
        <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Underground: cut-away</h3>
          <UndergroundDiagram ground={ground} units={units} />
        </section>
      )}
      <Section title="Underground: soil moisture" status={soil.status} reason={soil.reason} source={soil.climatology_source}>
        {soil.summary && <p className="text-sm text-[var(--text-primary)]">{soil.summary}</p>}
        <table className="mt-3 w-full text-left text-sm tabular-nums">
          <thead className="text-xs text-[var(--text-muted)]">
            <tr>
              <th className="py-1 font-normal">Depth</th>
              <th className="py-1 font-normal">Water</th>
              <th className="py-1 font-normal">Vs. this time of year</th>
              <th className="py-1 text-right font-normal">Next 7 days</th>
            </tr>
          </thead>
          <tbody>
            {soil.layers.map((l) => (
              <tr key={l.top_cm} className="border-t border-[var(--border)]">
                <td className="py-1.5 text-[var(--text-secondary)]">
                  <span
                    className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-middle"
                    style={{ background: wetnessColor(l.relative_wetness_pct) }}
                    aria-hidden
                  />
                  {l.top_cm}–{l.bottom_cm} cm
                </td>
                <td className="py-1.5 text-[var(--text-primary)]">{l.value === null ? "–" : `${l.value.toFixed(2)} m³/m³`}</td>
                <td className="py-1.5 text-[var(--text-secondary)]">
                  {rankText(l.season_percentile) ?? "–"}
                </td>
                <td className="py-1.5 text-right text-[var(--text-secondary)]">{trend(l.forecast_change_7d)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
          Latest ERA5 day {soil.value_date ? formatDay(soil.value_date) : "–"}, ranked against the same 31 days in
          {" "}
          {soil.climatology_years ?? "earlier years"}. Colours run light (driest) to dark (wettest) for this time of year.
          Not a true saturation: soil porosity is not known. The 7-day trend comes from a different model (ECMWF IFS), so
          only its direction and size are shown.
        </p>
        <SourceTag source={soil.forecast_source} />
      </Section>

      <Section title="Underground: groundwater" status={gw.status} reason={gw.reason} source={gw.source}>
        {station && (
          <div className="text-sm">
            {station.depth_below_datum_m !== null ? (
              <p>
                <span className="text-2xl font-semibold tabular-nums">{formatLength(station.depth_below_datum_m, units)}</span>{" "}
                <span className="text-[var(--text-secondary)]">below the borehole top</span>
              </p>
            ) : (
              <p className="text-[var(--text-secondary)]">Level known, but the borehole&apos;s ground level is not published.</p>
            )}
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              <a href={station.url} target="_blank" rel="noreferrer" className="underline">
                {station.label}
              </a>{" "}
              borehole, {station.distance_km.toFixed(1)} km away
              {station.level_maod !== null && <> · level {formatLength(station.level_maod, units, 2)} above Ordnance Datum</>}
              {station.time && <> · {formatDateTime(station.time)}</>}
            </p>
            {station.typical_range_low !== null && station.typical_range_high !== null && station.level_maod !== null && (
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                {station.level_maod > station.typical_range_high
                  ? "Above its typical range: groundwater is high."
                  : station.level_maod < station.typical_range_low
                    ? "Below its typical range: groundwater is low."
                    : "Within its typical range."}
              </p>
            )}
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              One borehole only: groundwater depth can change a lot over short distances.
            </p>
          </div>
        )}
      </Section>

    </>
  );
}

function trend(change: number | null | undefined): string {
  if (change === null || change === undefined) return "–";
  if (Math.abs(change) < 0.005) return "→ steady";
  return change > 0 ? `↑ wetter (+${change.toFixed(2)})` : `↓ drier (${change.toFixed(2)})`;
}
