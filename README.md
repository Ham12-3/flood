# FloodScope 3D

Click anywhere on a 3D globe and see what open flood data says about that spot: ground
elevation, river flow today and over the next 30 days, how deep a 1-in-10 to 1-in-500 year
flood could get, and live Environment Agency gauges in England.

> **Estimates for exploration. Not an official flood warning.** In England use
> [Check for flooding](https://check-for-flooding.service.gov.uk/). Elsewhere, follow your
> national meteorological or hydrological agency.

**Status:** Phase 1 (globe, click, side panel, `/api/point`). The 3D flood view, the underground
view and the AI prediction come in later phases.

## Layout

```
api/   FastAPI backend: data clients, raster reads, caching (Python 3.12+, uv)
web/   Next.js 16 App Router frontend with CesiumJS and Tailwind (TypeScript strict)
.env.example   one env file for both
```

## Setup

Prerequisites: Node 22+, [uv](https://docs.astral.sh/uv/), and optionally Docker.

```bash
cp .env.example .env
```

Put your free Cesium ion token in `.env` as `NEXT_PUBLIC_CESIUM_ION_TOKEN`. You can get one at
[ion.cesium.com/tokens](https://ion.cesium.com/tokens). Without it, the globe still works but
uses a low-detail offline image and flat terrain.

**Backend** (http://localhost:8000):

```bash
cd api
uv sync
uv run uvicorn floodscope.main:app --reload
```

Or run it in a container: `docker compose up --build`.

**Frontend** (http://localhost:3000):

```bash
cd web
npm install        # also copies Cesium's static assets into public/cesium
npm run dev
```

`web/next.config.ts` loads the repo-root `.env`, so one file configures both apps.

## API

`GET /api/point?lat=51.5005&lon=-0.1218` returns one typed response (`PointResponse` in
`api/floodscope/models.py`) with four blocks: `elevation`, `river`, `hazard`, `uk_live`.

Every block has:

- `status`: `ok`, `no_data` (the source has nothing here; `reason` says why) or `error`
  (the source failed; `reason` has the message). Blocks fail independently.
- `source`: name, provider, resolution, data date, licence and retrieval time. The UI prints
  this under every section.

`GET /api/geocode?q=Dhaka` handles place search. `GET /api/health` is a liveness check.

The frontend types in `web/src/lib/api-types.ts` are generated from the OpenAPI schema. After
changing a Pydantic model, run `npm run gen:api` in `web/`.

## Data sources

All of these were checked live with curl on 2026-10-21 before building against them.

| Data | Source | Resolution | Licence |
|---|---|---|---|
| Ground elevation | [Copernicus DEM GLO-30](https://registry.opendata.aws/copernicus-dem/) COGs on AWS | 1″ (~30 m) | Copernicus DEM licence, attribution required |
| River discharge, 30-day ensemble | [GloFAS v4 via Open-Meteo Flood API](https://open-meteo.com/en/docs/flood-api) | 0.05° (~5 km) | CC BY 4.0; Open-Meteo free tier is non-commercial |
| Flood depth for return periods 10–500 yr | [JRC CEMS-GloFAS hazard maps v2.1.2](https://data.jrc.ec.europa.eu/collection/id-0054) | 3″ (~90 m) | CC BY 4.0 |
| Live gauges and warnings (England) | [Environment Agency flood-monitoring API](https://environment.data.gov.uk/flood-monitoring/doc/reference) | point gauges, ~15 min | Open Government Licence v3.0 |
| Place search | [Open-Meteo Geocoding](https://open-meteo.com/en/docs/geocoding-api) (GeoNames) | places | CC BY 4.0 |
| Globe, terrain, imagery | [CesiumJS](https://cesium.com/) and Cesium ion | — | Apache 2.0, ion terms |

How each source is used:

- **Elevation:** one-pixel windowed read through GDAL `/vsicurl/`. A cached HEAD request
  checks that the tile exists first, so ocean points report "no data" instead of an error.
- **River flow:** if the clicked GloFAS cell has no flow (all null *or all zero*, since
  Open-Meteo returns 0.0 in dry areas), we query 8 neighbours at 0.05°, then at 0.1°, in one
  multi-coordinate request per ring. We keep the cell with the largest median flow. Otherwise
  the answer is "No modelled river here".
- **Hazard:** the tile is found from `tile_extents.geojson`, then 9 one-pixel reads run in
  parallel: 7 return periods, permanent water and the spurious-depth mask. `-9999` means dry.
- **EA:** this source is only queried inside Great Britain. It returns stations within 5 km
  (up to 6, with typical range and record high), warnings within 10 km, and marks readings
  older than 24 h as stale.

**Caching:** disk cache in `api/.cache` using diskcache. Keys are tile or pixel plus date:
DEM and JRC values for 30 days, forecasts for 6 h, EA for 5 min. Errors are never cached.

## Tests and checks

```bash
cd api
uv run pytest            # unit tests on recorded real API responses and local GeoTIFFs
uv run pytest -m live    # London, Lagos, Dhaka and New Orleans against the real APIs
uv run ruff check . && uv run ruff format --check . && uv run mypy floodscope tests
```

```bash
cd web
npm test && npm run lint && npm run typecheck
```

## Known limits

- **First click in a new area is slow on a slow connection.** GLO-30 stores 1024×1024
  compressed blocks, so one pixel pulls about 1–3 MB. On a ~100 KB/s link that took about 18 s.
  Repeat clicks hit the cache.
- **The DEM is a surface model.** In cities it measures rooftops and trees: central
  New Orleans reads about 4–12 m although the streets are near or below sea level. FABDEM
  (bare earth) is planned as an option, but it is only distributed as ~950 MB 10° zips with a
  non-commercial licence, so it needs a pre-download step.
- **JRC hazard maps ignore flood defences.** Hammersmith shows up to 2 ft (0.6 m) at 1-in-500
  even though the Thames Barrier protects it.
- **River floods only.** These maps don't include coastal surge or surface water from heavy rain.
- **GloFAS cells are ~5 km** and follow the main river in each cell. In central Dhaka the
  nearest cell carries ~20 m³/s, not the large rivers around the city. The UI shows the cell
  centre and its distance from your click.
- **The main forecast is one run.** Weeks ahead it can swing hard (London: 6 → 125 m³/s on
  one day), so the chart's solid line is the ensemble mean and the main run is dashed.
- **Open-Meteo's GloFAS history returned null before about 1997** at the points we tested,
  not 1984 as documented. This matters for the Phase 4 return-period fits.
- **The JRC tiles aren't formal COGs** (no overviews), but they are internally tiled, so
  range reads work.
- **The EA covers England only.** Wales (NRW) and Scotland (SEPA) are not wired in.

## Not yet verified (need keys)

Cesium ion (needs your token), Google Photorealistic 3D Tiles, the Google Flood Forecasting
API (waitlist key) and the Claude API. These belong to later phases and will be checked when
they're built.
