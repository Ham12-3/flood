import type { ReactNode } from "react";
import type { SourceInfo } from "@/lib/api";
import SourceTag from "./SourceTag";

interface Props {
  title: string;
  status: "ok" | "no_data" | "error";
  reason?: string | null;
  source: SourceInfo;
  children?: ReactNode;
}

/** A panel section that shows its data, or says plainly why there is none. */
export default function Section({ title, status, reason, source, children }: Props) {
  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">{title}</h3>
      {status === "ok" && children}
      {status === "no_data" && (
        <div>
          <p className="font-medium text-[var(--text-primary)]">No data here</p>
          {reason && <p className="mt-1 text-sm text-[var(--text-secondary)]">{reason}</p>}
        </div>
      )}
      {status === "error" && (
        <div role="alert">
          <p className="font-medium text-[var(--text-primary)]">Couldn&apos;t load this right now</p>
          {reason && <p className="mt-1 break-words text-sm text-[var(--text-secondary)]">{reason}</p>}
        </div>
      )}
      <SourceTag source={source} />
    </section>
  );
}
