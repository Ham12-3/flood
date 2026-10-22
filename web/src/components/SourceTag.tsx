import type { SourceInfo } from "@/lib/api";

/** Source, resolution, data date and licence for the numbers in a section. */
export default function SourceTag({ source }: { source: SourceInfo }) {
  return (
    <p className="mt-3 border-t border-[var(--border)] pt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
      Source:{" "}
      <a href={source.url} target="_blank" rel="noreferrer" className="underline decoration-dotted hover:text-[var(--text-secondary)]">
        {source.name}
      </a>{" "}
      · {source.resolution} · {source.data_date} · {source.licence}
    </p>
  );
}
