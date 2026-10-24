"use client";

import { useEffect, useState } from "react";
import {
  explainPoint,
  fetchGoogleFlood,
  fetchPrediction,
  type ExplainResponse,
  type GoogleFloodResponse,
  type PredictResponse,
} from "@/lib/api";
import { formatReturnPeriod } from "@/lib/flood/describe";
import { formatDay } from "@/lib/format";
import { formatDischarge, type UnitSystem } from "@/lib/units";
import Section from "./Section";

interface Props {
  lat: number;
  lon: number;
  units: UnitSystem;
}

type Loaded<T> = { key: string; data: T | null; error: string | null } | null;

function useLoad<T>(key: string, load: (signal: AbortSignal) => Promise<T>): { data: T | null; error: string | null } | null {
  const [state, setState] = useState<Loaded<T>>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal)
      .then((data) => setState({ key, data, error: null }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({ key, data: null, error: err instanceof Error ? err.message : String(err) });
      });
    return () => ctrl.abort();
    // `load` is recreated each render; `key` identifies the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state && state.key === key ? state : null;
}

/** AI flow forecast, Claude's plain-English explanation, and Google Flood Hub. */
export default function AiSection({ lat, lon, units }: Props) {
  const key = `${lat},${lon}`;
  const prediction = useLoad<PredictResponse>(key, (s) => fetchPrediction(lat, lon, s));
  const google = useLoad<GoogleFloodResponse>(key, (s) => fetchGoogleFlood(lat, lon, s));
  return (
    <>
      <PredictionCard state={prediction} units={units} />
      <ExplainCard lat={lat} lon={lon} units={units} />
      <GoogleCard state={google} />
    </>
  );
}

function Loading({ title }: { title: string }) {
  return (
    <section className="animate-pulse rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4 text-sm text-[var(--text-secondary)]">
      Loading {title}…
    </section>
  );
}

function Failed({ title, message }: { title: string; message: string }) {
  return (
    <section role="alert" className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4 text-sm">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">{title}</h3>
      <p className="text-[var(--text-secondary)]">{message}</p>
    </section>
  );
}

function PredictionCard({ state, units }: { state: { data: PredictResponse | null; error: string | null } | null; units: UnitSystem }) {
  const title = "AI flow forecast (days 1–7)";
  if (!state) return <Loading title="the AI forecast" />;
  if (state.error || !state.data) return <Failed title={title} message={state.error ?? "No response"} />;
  const p = state.data;
  return (
    <Section title={title} status={p.status} reason={p.reason} source={p.sources[0] ?? sourceFallback()}>
      <table className="w-full text-left text-sm tabular-nums">
        <thead className="text-xs text-[var(--text-muted)]">
          <tr>
            <th className="py-1 font-normal">Day</th>
            <th className="py-1 font-normal">AI</th>
            <th className="py-1 font-normal">Range</th>
            <th className="py-1 text-right font-normal">GloFAS</th>
          </tr>
        </thead>
        <tbody>
          {p.days.map((d) => (
            <tr key={d.day} className="border-t border-[var(--border)]">
              <td className="py-1 text-[var(--text-secondary)]">{formatDay(d.date)}</td>
              <td className="py-1 text-[var(--text-primary)]">{d.discharge === null ? "–" : formatDischarge(d.discharge, units)}</td>
              <td className="py-1 text-xs text-[var(--text-secondary)]">
                {d.discharge_low !== null && d.discharge_high !== null
                  ? `${formatDischarge(d.discharge_low, units)} – ${formatDischarge(d.discharge_high, units)}`
                  : "–"}
              </td>
              <td className="py-1 text-right text-[var(--text-secondary)]">
                {d.glofas_discharge === null ? "–" : formatDischarge(d.glofas_discharge, units)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {p.days.length > 0 && (
        <p className="mt-2 text-xs text-[var(--text-secondary)]">
          Day 7 is about a {p.days[p.days.length - 1].return_period ? formatReturnPeriod(p.days[p.days.length - 1].return_period ?? 1) : "–"} flow.
          Open the 3D view and pick &quot;AI forecast&quot; to see it as a flood map.
        </p>
      )}
      <p className="mt-2 text-xs leading-relaxed text-[var(--text-muted)]">{p.method}</p>
      {p.model && p.model.skill.length > 0 && (
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Held-out skill ({p.model.held_out_basins ?? "?"} basins never seen in training): median NSE{" "}
          {p.model.skill.map((s) => `day ${s.lead} ${s.nse?.toFixed(2) ?? "–"}`).join(", ")}.
        </p>
      )}
      {p.sources.slice(1).map((s) => (
        <p key={s.name} className="mt-1 text-[11px] text-[var(--text-muted)]">
          Source: {s.name} · {s.resolution} · {s.licence}
        </p>
      ))}
    </Section>
  );
}

function sourceFallback() {
  return {
    name: "FloodScope AI forecast",
    provider: "FloodScope",
    url: "https://github.com/neuralhydrology/neuralhydrology",
    resolution: "Daily",
    data_date: "–",
    licence: "–",
    retrieved_at: new Date().toISOString(),
  };
}

function ExplainCard({ lat, lon, units }: Props) {
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<{ key: string; busy: boolean; result: ExplainResponse | null; error: string | null } | null>(null);
  const key = `${lat},${lon}`;
  const current = state && state.key === key ? state : null;

  const ask = () => {
    setState({ key, busy: true, result: null, error: null });
    explainPoint({ lat, lon, question: question.trim() || undefined, units })
      .then((result) => setState({ key, busy: false, result, error: null }))
      .catch((err: unknown) => setState({ key, busy: false, result: null, error: err instanceof Error ? err.message : String(err) }));
  };

  const r = current?.result;
  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4 text-sm">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Ask the AI to explain</h3>
      <div className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !current?.busy && ask()}
          maxLength={500}
          placeholder="e.g. Would a big flood reach my street?"
          aria-label="Question for the AI explainer"
          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-sm outline-none focus:border-[var(--series-1)]"
        />
        <button
          onClick={ask}
          disabled={current?.busy}
          className="rounded bg-[var(--series-1)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {current?.busy ? "Thinking…" : "Explain"}
        </button>
      </div>
      {current?.error && (
        <p role="alert" className="mt-2 text-[var(--text-secondary)]">
          {current.error}
        </p>
      )}
      {r && r.status !== "ok" && <p className="mt-2 text-[var(--text-secondary)]">{r.reason}</p>}
      {r && r.status === "ok" && r.answer && (
        <div className="mt-3 space-y-2">
          {r.answer.split(/\n{2,}/).map((para, i) => (
            <p key={i} className="leading-relaxed text-[var(--text-primary)]">
              {para}
            </p>
          ))}
          {r.unverified_numbers.length > 0 && (
            <p className="rounded border border-[var(--status-warning)]/50 bg-[var(--status-warning)]/10 px-2 py-1.5 text-xs">
              <span aria-hidden>⚠ </span>
              These numbers in the answer could not be matched to the data and may be wrong:{" "}
              {r.unverified_numbers.join(", ")}.
            </p>
          )}
          <p className="text-[11px] text-[var(--text-muted)]">
            Written by {r.model ?? "Claude"} from FloodScope data ({r.tools_used.join(", ")}). AI can make mistakes; check the
            numbers above. {r.disclaimer}
          </p>
        </div>
      )}
    </section>
  );
}

function GoogleCard({ state }: { state: { data: GoogleFloodResponse | null; error: string | null } | null }) {
  const title = "Google Flood Hub";
  if (!state) return <Loading title="Google Flood Hub" />;
  if (state.error || !state.data) return <Failed title={title} message={state.error ?? "No response"} />;
  const g = state.data;
  return (
    <Section title={title} status={g.status} reason={g.reason} source={g.source}>
      <ul className="space-y-1.5">
        {g.gauges.map((x) => (
          <li key={x.gauge_id} className="rounded bg-[var(--surface-2)] px-3 py-2 text-sm">
            <div className="flex justify-between gap-2">
              <span className="font-medium">{x.site_name ?? x.gauge_id}</span>
              <span className="text-xs text-[var(--text-muted)]">{x.distance_km.toFixed(1)} km</span>
            </div>
            <div className="text-xs text-[var(--text-secondary)]">
              {[x.river, x.severity ? `Status: ${x.severity.replace(/_/g, " ").toLowerCase()}` : null, x.trend ? `trend ${x.trend.toLowerCase().replace("_", " ")}` : null]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-[var(--text-muted)]">
        <a href={g.official_url} target="_blank" rel="noreferrer" className="underline">
          Open Google Flood Hub
        </a>
      </p>
    </Section>
  );
}
