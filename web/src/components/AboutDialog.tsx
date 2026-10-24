"use client";

import { useEffect, useRef } from "react";

interface Props {
  open: boolean;
  onClose(): void;
}

const DATASETS: { name: string; by: string; licence: string; url: string; use: string }[] = [
  {
    name: "Copernicus DEM GLO-30",
    by: "ESA / Copernicus, © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, hosted on AWS Open Data",
    licence: "Copernicus DEM licence (free, attribution required)",
    url: "https://registry.opendata.aws/copernicus-dem/",
    use: "Ground elevation (30 m)",
  },
  {
    name: "GloFAS v4 river discharge",
    by: "Copernicus Emergency Management Service, served by the Open-Meteo Flood API",
    licence: "CC BY 4.0. Open-Meteo free API is for non-commercial use",
    url: "https://open-meteo.com/en/docs/flood-api",
    use: "River flow today and the 30-day ensemble forecast",
  },
  {
    name: "Global river flood hazard maps v2.1.2",
    by: "European Commission Joint Research Centre (CEMS-GloFAS)",
    licence: "CC BY 4.0",
    url: "https://data.jrc.ec.europa.eu/collection/id-0054",
    use: "Flood depth for 1-in-10 to 1-in-500 year floods, permanent water, spurious-depth flags",
  },
  {
    name: "Real-time flood monitoring",
    by: "Environment Agency",
    licence: "Open Government Licence v3.0",
    url: "https://environment.data.gov.uk/flood-monitoring/doc/reference",
    use: "Live river, tide and groundwater gauges and flood warnings in England",
  },
  {
    name: "Open-Meteo Geocoding",
    by: "Open-Meteo, using GeoNames",
    licence: "CC BY 4.0",
    url: "https://open-meteo.com/en/docs/geocoding-api",
    use: "Place search",
  },
  {
    name: "CesiumJS, Cesium World Terrain and ion imagery",
    by: "Cesium GZ, Inc. (imagery providers credited on the globe)",
    licence: "Apache 2.0 (CesiumJS); Cesium ion terms",
    url: "https://cesium.com/",
    use: "3D globe, terrain and base imagery",
  },
];

export default function AboutDialog({ open, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto max-h-[85vh] w-[min(640px,calc(100vw-32px))] overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-0 text-[var(--text-primary)] backdrop:bg-black/60"
    >
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold">About FloodScope 3D</h2>
          <button onClick={onClose} className="rounded px-2 text-[var(--text-secondary)] hover:bg-[var(--surface-2)]" aria-label="Close">
            ✕
          </button>
        </div>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          Click anywhere on the globe to see what open flood datasets say about that spot. Every number shows where it came
          from. Nothing is estimated or filled in by FloodScope: if a source has no data, we say so.
        </p>
        <p className="mt-3 rounded border border-[var(--status-warning)]/50 bg-[var(--status-warning)]/10 px-3 py-2 text-sm">
          <strong>Estimates for exploration. Not an official flood warning.</strong> In England, use{" "}
          <a className="underline" href="https://check-for-flooding.service.gov.uk/" target="_blank" rel="noreferrer">
            Check for flooding
          </a>
          . Elsewhere, follow your national meteorological or hydrological agency.
        </p>

        <h3 className="mt-5 text-sm font-medium text-[var(--text-muted)] uppercase tracking-wide">Data sources</h3>
        <ul className="mt-2 space-y-3">
          {DATASETS.map((d) => (
            <li key={d.name} className="text-sm">
              <a href={d.url} target="_blank" rel="noreferrer" className="font-medium underline decoration-dotted">
                {d.name}
              </a>
              <span className="text-[var(--text-secondary)]"> · {d.use}</span>
              <div className="text-xs text-[var(--text-muted)]">
                {d.by}. Licence: {d.licence}.
              </div>
            </li>
          ))}
        </ul>

        <h3 className="mt-5 text-sm font-medium text-[var(--text-muted)] uppercase tracking-wide">Known limits</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--text-secondary)]">
          <li>The DEM is a surface model: in cities it measures rooftops and trees, not the street.</li>
          <li>JRC hazard maps ignore flood defences, so protected areas (e.g. behind the Thames Barrier) can show water.</li>
          <li>Hazard maps cover river floods only, not coastal surges or surface water from heavy rain.</li>
          <li>GloFAS uses ~5 km cells and follows the main river in each cell; small streams are not modelled.</li>
          <li>Open-Meteo&apos;s GloFAS history starts around 1997 in our checks, not 1984.</li>
          <li>
            3D view: forecast days are turned into flood maps through a flood-frequency curve fitted to about 29 years of
            peaks, so rare floods are uncertain. &quot;Custom +X m&quot; is a connected fill, not a flow simulation.
          </li>
        </ul>
      </div>
    </dialog>
  );
}
