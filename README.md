# FloodScope 3D

Click anywhere on a 3D globe and see what open flood data says about that spot: ground
elevation, river flow today and over the next 30 days, how deep a 1-in-10 to 1-in-500 year
flood could get, and live Environment Agency gauges in England.

> **Estimates for exploration. Not an official flood warning.** In England use
> [Check for flooding](https://check-for-flooding.service.gov.uk/). Elsewhere, follow your
> national meteorological or hydrological agency.

**Status:** Phase 1 (globe, click, side panel, `/api/point`) and Phase 2 (3D flood view,
`/api/scene`) are built. The underground view and the AI prediction come in later phases.

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

`GET /api/scene?lat=51.4938&lon=-0.2288&size_km=4` (1 to 10 km) returns the terrain window for
the 3D view (`SceneResponse`):

- **Terrain:** the GLO-30 heights on their native ~30 m grid (base64 float32, row 0 north),
  plus the EGM2008 geoid height at the window centre.
- **Hazard:** depth grids for all 7 return periods (uint16 cm) and the permanent-water mask,
  both sampled onto that grid.
- **River:** the river forecast, a flood-frequency fit, and one scenario per forecast day.

It is a few hundred kB gzipped for 4 km and about 3 MB for 10 km.

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

How the 3D flood view works (Phase 2):

- **Terrain:** the scene's DEM becomes the ground through a `CustomHeightmapTerrainProvider`,
  and the globe is clipped to the window. Heights are DEM + geoid (EGM2008 via PROJ's CDN), so
  water and ground use the same surface.
- **Return periods:** these use the JRC depth raster directly (water surface = ground +
  depth). JRC's 90 m cells show as blocks on the 30 m terrain.
- **Today and forecast days:** we fit a Gumbel curve (L-moments) to calendar-year peak flows at
  the GloFAS cell. Open-Meteo has 1997 to last year, about 29 years. Each day's ensemble-mean
  flow is converted to a return period, with the ensemble 25th–75th percentiles as a range. The
  two nearest JRC maps are then blended, linearly in log return period. Below 1-in-10 there is
  no flood map, so only permanent water is shown ("in its banks"). Above 1-in-500 the 500-year
  map is shown with a warning.
- **Custom +X m:** a connected flood fill in a Web Worker (`web/src/lib/flood/floodfill.ts`).
  - Seeds are permanent-water cells. The JRC mask is first trimmed to cells whose ground is at
    the local water surface, because its 90 m edge cells often land on banks or rooftops.
  - Water spreads 8-neighbour through ground below the level. Each cell takes the level of the
    *nearest* seed that can reach it (seed surface + X), so a sloping river rises evenly.
  - Hollows cut off by higher ground stay dry.
- **Water rendering:** the worker builds a GLB mesh, which Cesium renders with a
  `CustomShader`. The shader handles the depth colour ramp (one blue hue), ripples and the rise
  animation on the GPU.
- **Readouts:** hovering shows depth plus a human scale (ankle, knee, waist, head, one storey,
  two storeys). Stats show flooded land area (excluding permanent water), max depth, and
  buildings touched. The building count is the number of Cesium OSM Buildings whose centre is in
  water, and it needs the ion token.

**Caching:** disk cache in `api/.cache` using diskcache. Keys are tile or pixel plus date:
DEM and JRC values and scene grids for 30 days, flood-curve fits for 30 days, forecasts for
6 h, EA for 5 min. Errors are never cached.

## Tests and checks

```bash
cd api
uv run pytest            # unit tests on recorded real API responses and local GeoTIFFs
uv run pytest -m live    # /api/point and /api/scene for London, Lagos, Dhaka, New Orleans
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
- **Defences again, in 3D:** New Orleans shows about 70% of a 4 km window under water at
  1-in-10, because the JRC maps don't model levees.
- **One flood size for the whole window.** Forecast scenarios use the clicked river cell's
  return period everywhere in the window, so tributaries can differ.
- **Gumbel fits on ~29 years** are uncertain beyond about 1-in-100. Today's flows at the four
  test cities are all around 1-in-1 year, so "Today" shows rivers within their banks.
- **Custom +X m is a fill, not a flow model.** It ignores how long water takes to arrive and
  how much there is. Phase 5's shallow-water solver addresses that.
- **OSM building heights** sit on Cesium World Terrain, not our DEM, so buildings can look
  slightly sunk or raised. Counts only include tiles loaded so far; zoom in to load more.

## Not yet verified (need keys)

Cesium ion and Cesium OSM Buildings (need your token), Google Photorealistic 3D Tiles, the Google Flood Forecasting
API (waitlist key) and the Claude API. These belong to later phases and will be checked when
they're built.
