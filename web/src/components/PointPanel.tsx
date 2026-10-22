"use client";

import type { EAStation, EAWarning, PointResponse } from "@/lib/api";
import { forecastPeak, riseFactor } from "@/lib/discharge";
import { annualChance, formatDateTime, formatDay, formatLatLon, timeAgo } from "@/lib/format";
import { formatDischarge, formatGaugeValue, formatLength, type UnitSystem } from "@/lib/units";
import DischargeChart from "./DischargeChart";
import HazardChart from "./HazardChart";
import Section from "./Section";

interface Props {
  data: PointResponse;
  units: UnitSystem;
}

export default function PointPanel({ data, units }: Props) {
  return (
    <div className="space-y-3">
      <ElevationSection data={data} units={units} />
      <RiverSection data={data} units={units} />
      <HazardSection data={data} units={units} />
      <UKSection data={data} units={units} />
    </div>
  );
}

function BigValue({ value, label }: { value: string; label: string }) {
  return (
    <p>
      <span className="text-2xl font-semibold tabular-nums text-[var(--text-primary)]">{value}</span>{" "}
      <span className="text-sm text-[var(--text-secondary)]">{label}</span>
    </p>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">{children}</p>;
}

function ElevationSection({ data, units }: Props) {
  const e = data.elevation;
  return (
    <Section title="Ground elevation" status={e.status} reason={e.reason} source={e.source}>
      {typeof e.elevation_m === "number" && <BigValue value={formatLength(e.elevation_m, units)} label="above sea level" />}
      {e.cell_size_m && (
        <Note>
          One {Math.round(e.cell_size_m[0])} × {Math.round(e.cell_size_m[1])} m pixel. {e.note}
        </Note>
      )}
    </Section>
  );
}

function RiverSection({ data, units }: Props) {
  const r = data.river;
  const today = r.today?.discharge;
  const peak = forecastPeak(r.forecast);
  const rise = riseFactor(today, peak);
  return (
    <Section title="River flow" status={r.status} reason={r.reason} source={r.source}>
      {typeof today === "number" ? (
        <BigValue value={formatDischarge(today, units)} label="today (main forecast)" />
      ) : (
        <p className="text-sm text-[var(--text-secondary)]">No value for today in this forecast.</p>
      )}
      {r.today &&
        typeof r.today.ensemble_min === "number" &&
        typeof r.today.ensemble_max === "number" &&
        r.today.ensemble_max > r.today.ensemble_min && (
        <p className="text-xs text-[var(--text-secondary)]">
          Ensemble range today {formatDischarge(r.today.ensemble_min, units)} – {formatDischarge(r.today.ensemble_max, units)}
        </p>
      )}
      {peak && peak.date === r.today?.date && (
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          Today is the highest flow in the {r.forecast.length - 1}-day main forecast.
        </p>
      )}
      {peak && peak.date !== r.today?.date && (
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          Main forecast peaks at{" "}
          <span className="text-[var(--text-primary)]">{formatDischarge(peak.discharge, units)}</span> on {formatDay(peak.date)}
          {rise !== null && rise >= 1.5 && <> ({rise.toFixed(1)}× today)</>} within the next {r.forecast.length - 1} days.
        </p>
      )}
      <div className="mt-3">
        <DischargeChart days={r.forecast} units={units} />
      </div>
      {typeof r.grid_lat === "number" && typeof r.grid_lon === "number" && (
        <Note>
          {r.searched_offsets
            ? "No river is modelled at the clicked spot, so this is the largest river in a nearby cell. "
            : ""}
          GloFAS cell centred at {formatLatLon(r.grid_lat, r.grid_lon, 3)}
          {typeof r.offset_km === "number" && <>, {r.offset_km.toFixed(1)} km from your click</>}. The model picks the main river
          in each ~5 km cell, which may not be the stream next to you.
        </Note>
      )}
    </Section>
  );
}

function HazardSection({ data, units }: Props) {
  const h = data.hazard;
  const anyFlooded = h.depths.some((d) => d.flooded);
  return (
    <Section title="How deep floods could get" status={h.status} reason={h.reason} source={h.source}>
      {h.spurious_depth_area && (
        <p className="mb-2 rounded border border-[var(--status-warning)]/50 bg-[var(--status-warning)]/10 px-2 py-1.5 text-xs text-[var(--text-primary)]">
          <span aria-hidden>⚠ </span>
          <strong>Caution:</strong> JRC marks this area as possibly having unrealistic depths (very deep water predicted in a
          small channel). Treat these numbers with care.
        </p>
      )}
      {h.permanent_water && (
        <Note>
          This pixel is permanent water (a river or lake), so the depths include the normal channel.
        </Note>
      )}
      {!anyFlooded && !h.permanent_water && (
        <p className="text-sm text-[var(--text-primary)]">
          Stays dry in every modelled river flood, up to 1 in 500 years.
        </p>
      )}
      {anyFlooded && <HazardChart depths={h.depths} units={units} />}
      <table className="mt-2 w-full text-left text-sm tabular-nums">
        <thead className="text-xs text-[var(--text-muted)]">
          <tr>
            <th className="py-1 font-normal">Flood size</th>
            <th className="py-1 font-normal">Chance each year</th>
            <th className="py-1 text-right font-normal">Water depth</th>
          </tr>
        </thead>
        <tbody>
          {h.depths.map((d) => (
            <tr key={d.return_period} className="border-t border-[var(--border)]">
              <td className="py-1 text-[var(--text-secondary)]">1 in {d.return_period} years</td>
              <td className="py-1 text-[var(--text-secondary)]">{annualChance(d.return_period)}</td>
              <td className="py-1 text-right text-[var(--text-primary)]">
                {d.flooded && typeof d.depth_m === "number" ? formatLength(d.depth_m, units, 2) : "dry"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Note>{h.note} River floods only: no coastal surge or heavy-rain surface flooding.</Note>
    </Section>
  );
}

function UKSection({ data, units }: Props) {
  const uk = data.uk_live;
  return (
    <Section title="Live UK gauges and warnings" status={uk.status} reason={uk.reason} source={uk.source}>
      <WarningList warnings={uk.warnings} />
      {uk.stations.length > 0 && (
        <ul className="mt-2 space-y-2">
          {uk.stations.map((s) => (
            <StationItem key={s.reference} station={s} units={units} />
          ))}
        </ul>
      )}
      <Note>
        Official flood warnings and advice:{" "}
        <a href={uk.official_url} target="_blank" rel="noreferrer" className="underline">
          Check for flooding (GOV.UK)
        </a>
      </Note>
    </Section>
  );
}

const SEVERITY_STYLE: Record<number, { color: string; icon: string }> = {
  1: { color: "var(--status-critical)", icon: "⛔" },
  2: { color: "var(--status-serious)", icon: "⚠" },
  3: { color: "var(--status-warning)", icon: "ⓘ" },
  4: { color: "var(--text-muted)", icon: "✓" },
};

function WarningList({ warnings }: { warnings: EAWarning[] }) {
  if (warnings.length === 0) {
    return <p className="text-sm text-[var(--text-primary)]">No active flood warnings or alerts within 10 km.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {warnings.map((w) => {
        const style = SEVERITY_STYLE[w.severity_level] ?? SEVERITY_STYLE[4];
        return (
          <li key={w.id} className="rounded border-l-4 bg-[var(--surface-2)] px-2 py-1.5 text-sm" style={{ borderColor: style.color }}>
            <span aria-hidden>{style.icon} </span>
            <strong className="text-[var(--text-primary)]">{w.severity}</strong>
            <span className="text-[var(--text-secondary)]"> · {w.area}</span>
            {w.time_raised && <span className="block text-xs text-[var(--text-muted)]">Raised {formatDateTime(w.time_raised)}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function StationItem({ station: s, units }: { station: EAStation; units: UnitSystem }) {
  const live = s.readings.filter((r) => !r.stale && typeof r.value === "number");
  return (
    <li className="rounded bg-[var(--surface-2)] px-3 py-2 text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <a href={s.url} target="_blank" rel="noreferrer" className="font-medium text-[var(--text-primary)] hover:underline">
          {s.label}
        </a>
        <span className="shrink-0 text-xs text-[var(--text-muted)]">{s.distance_km.toFixed(1)} km</span>
      </div>
      <div className="text-xs text-[var(--text-secondary)]">
        {[s.river, s.station_types.join(", ")].filter(Boolean).join(" · ")}
      </div>
      {live.length === 0 && <p className="mt-1 text-xs text-[var(--text-muted)]">No reading in the last 24 hours.</p>}
      {live.map((r, i) => (
        <p key={i} className="mt-1 tabular-nums">
          <span className="text-[var(--text-secondary)]">
            {r.parameter}
            {r.qualifier ? ` (${r.qualifier})` : ""}:{" "}
          </span>
          <span className="text-[var(--text-primary)]">{formatGaugeValue(r.value as number, r.unit, units)}</span>
          {r.time && <span className="text-xs text-[var(--text-muted)]"> · {timeAgo(r.time)}</span>}
        </p>
      ))}
      {typeof s.typical_range_low === "number" && typeof s.typical_range_high === "number" && (
        <p className="text-xs text-[var(--text-muted)]">
          Typical range {formatLength(s.typical_range_low, units, 2)} – {formatLength(s.typical_range_high, units, 2)}
        </p>
      )}
      {typeof s.max_on_record === "number" && (
        <p className="text-xs text-[var(--text-muted)]">
          Highest on record {formatLength(s.max_on_record, units, 2)}
          {s.max_on_record_time && <> ({new Date(s.max_on_record_time).getUTCFullYear()})</>}
        </p>
      )}
    </li>
  );
}
