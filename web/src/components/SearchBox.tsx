"use client";

import { useEffect, useId, useRef, useState } from "react";
import { geocode, type Place } from "@/lib/api";

interface Props {
  onSelect(place: Place): void;
}

export default function SearchBox({ onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const listId = useId();
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const timer = setTimeout(() => {
      abort.current?.abort();
      const ctrl = new AbortController();
      abort.current = ctrl;
      geocode(q, ctrl.signal)
        .then((r) => {
          setResults(r.results);
          setActive(0);
          setMessage(r.results.length ? null : "No places found");
          setOpen(true);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setResults([]);
          setMessage(err instanceof Error ? err.message : "Search failed");
          setOpen(true);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  function choose(place: Place) {
    setQuery(place.name);
    setOpen(false);
    onSelect(place);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="relative w-full max-w-sm">
      <input
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (e.target.value.trim().length < 2) setOpen(false);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => (results.length || message) && query.trim().length >= 2 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search a place, e.g. Dhaka"
        aria-label="Search for a place"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-1)]/95 px-3 py-2 text-sm text-[var(--text-primary)] shadow-lg outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--series-1)]"
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-1)] shadow-xl"
        >
          {message && <li className="px-3 py-2 text-sm text-[var(--text-secondary)]">{message}</li>}
          {results.map((p, i) => (
            <li
              key={`${p.lat},${p.lon}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(p);
              }}
              onMouseEnter={() => setActive(i)}
              className={`cursor-pointer px-3 py-2 text-sm ${i === active ? "bg-[var(--surface-2)]" : ""}`}
            >
              <span className="text-[var(--text-primary)]">{p.name}</span>
              <span className="text-[var(--text-muted)]"> {[p.admin1, p.country].filter(Boolean).join(", ")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
