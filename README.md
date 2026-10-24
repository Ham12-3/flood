# FloodScope 3D

Click anywhere on a flat world map and see what open flood data says about that spot:

- **Now:** ground height, river flow and its 30-day forecast, live Environment Agency gauges.
- **How bad it could get:** modelled 1-in-10 to 1-in-500 year flood depths, in 3D water over real terrain.
- **Underground:** how wet the soil is for the time of year, and the water table.
- **AI:** a 1–7 day flow forecast (LSTM), a Claude-written explanation, Google Flood Hub status, and satellite water maps of past floods.
- **Simulation:** a WebGPU shallow-water model of river inflow and rain.
- **Storm replay:** pick any place and up to 7 days (past, or the next 15 days). The server moves
  the hourly rain across the bare ground and shows, hour by hour, where water collects, which
  roads go under and which buildings get water at the door.

> **Estimates for exploration. Not an official flood warning.** In England use
> [Check for flooding](https://check-for-flooding.service.gov.uk/). Elsewhere, follow your
> national meteorological or hydrological agency.

## Status

All five phases are built. Some parts need something only you can provide before they show
data; until then they say so instead of guessing:

| Needs | Turns on | How |
|---|---|---|
| A trained model | AI flow forecast (`/api/predict`, "AI forecast" tab) | Run `ml/notebooks/train_colab.ipynb` in Colab, put `forecast_lstm.onnx` + `.json` in `ml/artifacts/` |
| Anthropic API key | AI explainer (`/api/explain`) | `ANTHROPIC_API_KEY` in `.env` |
| Google waitlist key | Google Flood Hub panel | `FLOODSCOPE_GOOGLE_FLOOD_API_KEY` in `.env` |
| A satellite run | Satellite water overlay in the 3D view | Run `ml/notebooks/satellite_prithvi.ipynb`, copy the result folder into `ml/satellite_results/` |
| A host for the API container | Deployment | Not chosen yet (the web app deploys to Vercel) |

## Layout

```
api/   FastAPI backend: data clients, raster reads, caching, AI endpoints (Python 3.12+, uv)
web/   Next.js 16 App Router + MapLibre GL JS + Tailwind (TypeScript strict); Web Workers and WebGPU
ml/    Forecast model (NeuralHydrology on Caravan, exported to ONNX) and the Prithvi satellite job
.env.example   one env file for everything
```

## Setup

Prerequisites: Node 22+, [uv](https://docs.astral.sh/uv/), and optionally Docker.

```bash
cp .env.example .env
```

**Backend** (http://localhost:8000):

```bash
cd api
uv sync
uv run uvicorn floodscope.main:app --reload
```

Or run it in a container from the repo root: `docker compose up --build`.

**Frontend** (http://localhost:3000):

```bash
cd web
npm install        # also copies MapLibre's worker and CSS into public/maplibre
npm run dev
```

`web/next.config.ts` loads the repo-root `.env`, so one file configures both apps.

**ML** (training and the satellite job run in Google Colab; locally you only need this for tests):

```bash
cd ml
uv venv --python 3.12
uv pip install -e ".[train]" --extra-index-url https://download.pytorch.org/whl/cpu
```

## API

Every response block has a `status` of `ok`, `no_data` (with a `reason`) or `error` (with a
`reason`), plus a `source` (name, provider, resolution, data date, licence). Blocks fail
independently, and the UI prints the source under every number. The frontend types in
`web/src/lib/api-types.ts` are generated from the OpenAPI schema: run `npm run gen:api` in
`web/` after changing a Pydantic model.

| Endpoint | Returns |
|---|---|
| `GET /api/point?lat&lon` | Elevation, river flow + 30-day ensemble forecast, JRC depths for 7 return periods, EA gauges and warnings |
| `GET /api/scene?lat&lon&size_km` | 1–10 km terrain window (30 m DEM), JRC depth grids, permanent water, geoid, flood-frequency fit, one scenario per forecast day |
| `GET /api/ground?lat&lon` | Soil moisture in 4 layers ranked against the same time of year since 2000, 7-day trend, nearest groundwater level |
| `GET /api/predict?lat&lon` | AI flow forecast for days 1–7 with an error band, GloFAS for the same days, and the matching flood maps |
| `POST /api/explain` | Claude's plain-English explanation, using only numbers from FloodScope's tools |
| `GET /api/google-flood?lat&lon` | Google Flood Hub gauges, status and forecasts near the point (feature flag) |
| `GET /api/satellite?lat&lon` | Prithvi satellite water maps covering the point; PNG at `/api/satellite/{id}/overlay.png` |
| `GET /api/replay?lat&lon&start&end&size_km&rain_scale&drain_mm_h` | Storm replay. The first call starts a background job and returns `running` with progress; poll until `ok`. Hourly counts, grid, sources, assumptions |
| `GET /api/replay/{id}/depth.bin`, `/features.bin` | Hourly depth frames (uint16 cm) and buildings and roads (binary layout in `api/floodscope/replay/features.py`) |
| `GET /api/geocode?q` | Place search |

## Data sources

Every source was checked live before building against it (2026-10-21 to 2026-10-24).

| Data | Source | Resolution | Licence |
|---|---|---|---|
| Ground elevation | [Copernicus DEM GLO-30](https://registry.opendata.aws/copernicus-dem/) COGs on AWS | 1″ (~30 m) | Copernicus DEM licence |
| River flow, history and ensemble forecast | [GloFAS v4 via Open-Meteo Flood API](https://open-meteo.com/en/docs/flood-api) | 0.05° (~5 km) | CC BY 4.0; Open-Meteo free tier non-commercial |
| Flood depth, 10–500 yr | [JRC CEMS-GloFAS hazard maps v2.1.2](https://data.jrc.ec.europa.eu/collection/id-0054) | 3″ (~90 m) | CC BY 4.0 |
| Live gauges, warnings, groundwater (England) | [Environment Agency flood monitoring](https://environment.data.gov.uk/flood-monitoring/doc/reference) | point gauges | Open Government Licence v3.0 |
| Soil moisture, weather | ERA5 and ECMWF IFS via [Open-Meteo](https://open-meteo.com/en/docs/historical-weather-api) | 0.25° | Copernicus licence; CC BY 4.0 |
| Geoid | EGM2008 via PROJ (cdn.proj.org) | grid | PROJ data licences |
| AI training data | [Caravan v1.6](https://doi.org/10.5281/zenodo.6522634) (24.8 GB netCDF) | catchments | CC BY 4.0 |
| Satellite water maps | [Prithvi-EO-2.0 Sen1Floods11](https://huggingface.co/ibm-nasa-geospatial/Prithvi-EO-2.0-300M-TL-Sen1Floods11) on Sentinel-2 L2A ([Earth Search](https://earth-search.aws.element84.com/v1)) | 10 m | Apache 2.0; Copernicus |
| Gauge forecasts (optional) | [Google Flood Forecasting](https://developers.google.com/flood-forecasting) | gauges | CC BY 4.0 |
| Explanations (optional) | Claude via the Anthropic API | — | Anthropic terms |
| Base map (Map, Satellite) | [Esri World Dark Gray Canvas and World Imagery](https://www.arcgis.com/) tiles, no key | to ~0.3 m (imagery) | Esri terms, attribution required |
| Bare ground for replays | [FABDEM V1-2](https://data.bris.ac.uk/data/dataset/s5hqmjcdj8yo2ibzi9b4ew3sn) (Copernicus DEM with buildings and trees removed), read inside the remote zips | 1″ (~30 m), built into ~60 m cells | CC BY-NC-SA 4.0 (non-commercial) |
| Hourly rain for replays | Open-Meteo [historical forecast](https://open-meteo.com/en/docs/historical-forecast-api) (2022 on), [ERA5 archive](https://open-meteo.com/en/docs/historical-weather-api) (earlier) and [forecast](https://open-meteo.com/en/docs) (last 30 / next 15 days) | 1–25 km, hourly | CC BY 4.0 |
| Tide for replays | [Open-Meteo Marine](https://open-meteo.com/en/docs/marine-weather-api) `sea_level_height_msl` | ~8 km, hourly | CC BY 4.0 |
| Buildings and roads for replays | [Overture Maps](https://docs.overturemaps.org/) GeoParquet on AWS (OpenStreetMap + Google + Microsoft buildings) | outlines | ODbL 1.0 and others |
| Map, 3D terrain view, replay layers | [MapLibre GL JS](https://maplibre.org/) 6.13 | — | BSD 3-Clause |

## How it works

### Phase 1: point data
- **Elevation:** a one-pixel read through GDAL `/vsicurl/`, after a cached HEAD check that the
  tile exists.
- **River flow:** if the clicked GloFAS cell has no flow (null *or all zero*), the 8 neighbours
  at 0.05° and then 0.1° are tried, one request per ring, keeping the largest river.
- **Hazard and EA:** JRC depth is read for 7 return periods plus the permanent-water and
  spurious-depth masks. EA data comes from stations within 5 km and warnings within 10 km.

### The map
- **Flat map:** MapLibre GL JS, Web Mercator, like a normal web map. No account or token. It draws
  only when something changes, at pixel ratio 1, to stay light on modest graphics cards.
- **Base maps:** a dark street map (Esri Dark Gray Canvas) and satellite imagery (Esri World
  Imagery), with labels. Both are keyless tiles, checked live on 2026-10-24. CARTO's dark tiles
  were tried first but now return an "API key required" image.
- **Tiles we draw ourselves** (replay water, roads and buildings; terrain from our height grid)
  go through one custom `fs://` protocol (`web/src/lib/maplibre.ts`).

### Phase 2: 3D flood view
- **Terrain:** the DEM window becomes MapLibre terrain, served as Terrarium tiles drawn from the
  height grid; outside the window the ground eases to the window's median height and the map is
  dimmed. Heights can be drawn ×1, ×2 or ×4 (labelled). The chosen base map is draped over it.
- **1-in-N year:** the JRC depth raster is used directly, so water surface = ground + depth.
- **Today and forecast days:**
  - A Gumbel curve (L-moments) is fitted to yearly peak flows at the GloFAS cell, 1997 to last
    year.
  - Each day's flow becomes a return period, and the two nearest JRC maps are blended in log
    return period.
  - Below 1-in-10, only permanent water is shown, because the river stays in its banks.
- **Custom +X m:** a connected flood fill runs in a Web Worker. Seeds are permanent water,
  trimmed to the local water surface. Water spreads 8-neighbour, each cell takes the nearest
  seed's level + X, and isolated hollows stay dry.
- **Water:** one pixel per terrain cell in a canvas, draped on the terrain and coloured by depth;
  the rise animation repaints it.
- **Readouts:** hover depth with a human scale; flooded area counts water at least 5 cm deep;
  and max depth.

### Phase 3: underground
- **Soil moisture:** the latest ERA5 day for 0–7, 7–28, 28–100 and 100–255 cm, ranked against
  ±15 days around the same date in every year since 2000. Requests are fetched per year to stay
  under Open-Meteo's rate limits and cached per grid cell per week.
- **Wetness without porosity:** soil porosity isn't known, so the panel shows "X% of the way from
  its driest to its wettest at this time of year" instead of claiming saturation.
- **7-day trend:** the ECMWF IFS forecast is shown only as a change, because its values can fall
  outside ERA5's whole record (Lagos did).
- **Groundwater:** the nearest EA borehole with a reading in the last week, within 25 km. Depth is
  the borehole datum minus the level.
- **Cut-away diagram:** two columns, each to its own true scale and labelled: the four soil layers
  coloured by wetness, and the water table at the borehole's depth.

### Phase 4: AI
- **4a, forecast model (`ml/`):**
  - A NeuralHydrology `cudalstm` with a 365-day history predicts flow 1–7 days ahead as a ratio
    to the river's 1990/1997–2010 mean flow. That keeps it unit-free, because Caravan is in
    mm/day and serving has m³/s without a catchment area.
  - Inputs are ERA5-Land-style weather and soil, the next 7 days of rain and temperature, and
    today's flow.
  - It is trained in Colab on Caravan sub-datasets, evaluated on held-out basins (NSE, KGE,
    persistence, GloFAS), and exported to ONNX. The API serves it with onnxruntime, without
    torch.
  - `tests/test_pipeline.py` trains NeuralHydrology for one epoch on synthetic data and checks
    that onnxruntime reproduces its predictions to within 1e-4.
- **4b, forecast to 3D:** AI forecasts go through the same Gumbel-to-JRC-map step and appear as
  "AI predicted flood, day N". The band is the 10th–90th percentile of held-out errors.
- **4c, Google Flood Hub:** behind a feature flag, built from the REST reference.
- **4d, satellite:** `python -m floodscope_ml.satellite` picks the least cloudy Sentinel-2 L2A
  scene, reads the six bands Prithvi expects at 10 m, and runs IBM/NASA's own `inference.py`.
  It writes a water mask, an overlay PNG and `meta.json`.
- **4e, explainer:** Claude (default `claude-sonnet-5-5`, set with `FLOODSCOPE_CLAUDE_MODEL`)
  calls tools over FloodScope's own data in a manual tool loop.
  - It runs at medium effort, with the server-side refusal fallback (`fallbacks: "default"`).
  - It may use only tool numbers. Afterwards, every number in the answer is checked against the
    tool results, and any it can't find are shown to the user as a warning. With no tool data,
    there is no answer.

### Phase 5: shallow-water simulation
- **Method:** the local-inertial equations (Bates et al. 2010, as in LISFLOOD-FP) on the 30 m
  terrain, in WGSL on WebGPU.
- **Time step:** chosen on the GPU each step, from the deepest cell (CFL).
- **Sources and edges:** rain minus a constant infiltration rate, plus river inflow where the
  river crosses the window's higher edge. Water leaves freely at the edges.
- **Display:** depth is read back about twice a second, counted in the worker and painted as water.
- **Reference implementation:** `web/src/lib/sim/swe.ts` is the CPU version of the same maths.
  Its tests check a still lake stays still, mass is conserved, rain/inflow/outflow balance, and
  depth never goes negative.
- **Fallback:** without WebGPU, the tab explains this and offers the Phase 2 fill.

### Storm replay
- **Grid:** ~60 m cells (2″ north-south) up to 20 km across. FABDEM's native 30 m pixels are read
  inside the remote zip (its table of contents is read first, so a network error is never taken
  for open sea). A cell that is mostly water is water; a shoreline cell keeps the height of its
  land part.
- **Sea and lagoon:** water cells joined to the window edge, plus specks of ≤ 3 cells inside them
  (stakes, boats). They are held at the tide each hour. Water drains into them only while it
  stands higher, so a high tide holds water back; the sea never flows onto land (the coast's
  height is only good to a metre or two and has no sea walls).
- **Rain:** hourly, on a 4×4 grid of points, spread bilinearly; optional ×1.5–×3 scaling because
  weather models smear storms. Drains remove a set rate (default 5 mm/h), less near the sea.
- **Water:** the same local-inertial scheme as Phase 5, vectorised with numpy, with a limiter so
  no cell gives more than it holds (the water balance closes exactly in tests).
- **Counts each hour:** land with 10 cm or more; buildings whose square has 10 cm or more ("water
  at the door"); road length at 10 cm and 30 cm.
- **Speed:** a 5 km area over 4 days takes about 30 s on the server; one simulation runs at a
  time. Results are saved in `api/.cache/replay/<id>/`; forecast replays are keyed by day.
- **Map:** a Web Worker draws each 256 px tile (water, wet roads, buildings when zoomed in) and
  each hour is swapped in only once its tiles are drawn.

**Caching:** disk cache in `api/.cache`, keyed by tile, pixel or cell plus date. Errors are
never cached.

## Tests and checks

```bash
cd api && uv run pytest && uv run ruff check . && uv run mypy floodscope tests
uv run pytest -m live          # real APIs: point and scene for 4 cities, storm replays for Lagos and Nairobi
```

```bash
cd ml && uv run --no-sync pytest            # includes a short NeuralHydrology training run (~3 min CPU)
```

```bash
cd web && npm test && npm run lint && npm run typecheck && npm run build
```

## Known limits

- **First look-ups in a new area are slow on a slow connection.** One DEM pixel pulls a
  1–3 MB block.
- **The DEM is a surface model.** It includes rooftops and trees. Cities read high, and the
  simulation and fill pool water in pits between buildings.
- **No flood defences.** The JRC maps ignore defences: New Orleans is about 70% under water at
  1-in-10, and Hammersmith floods despite the Thames Barrier.
- **River floods only.** No coastal surge, and no surface-water flooding except in the simulation.
- **GloFAS cells are about 5 km** and follow the main river, so small streams aren't modelled.
- **Forecast days use one flood size for the whole window.** Tributaries can differ. Gumbel fits
  on about 29 years are uncertain beyond 1-in-100.
- **Soil moisture is on a ~28 km grid.** Wetness is relative to the past, not a true saturation.
- **Groundwater** is one borehole up to 25 km away, in England only.
- **AI forecast:**
  - It is trained on catchment-average weather but served with point weather at the click.
  - Its past flow input is GloFAS-simulated, not observed.
  - It is only as good as the held-out skill reported with it.
  - The GloFAS comparison uses its reanalysis, because archived GloFAS forecasts need a CDS
    account.
- **Satellite maps:** clouds hide water, and Prithvi was fine-tuned on L1C while this uses L2A.
- **Simulation:**
  - The DEM has no river bed, so channels spill early.
  - Infiltration is one constant rate.
  - No-data (sea) cells act as walls.
  - It is an illustration of how water spreads, not a forecast.
- **Storm replay:**
  - Weather-model rain is spread out; real downpours are often stronger locally, so the rain
    multiplier is a setting, not a calibration. No gauge correction is applied.
  - Drain capacity is unknown anywhere; it is a setting. Blocked drains, pumps, walls and
    defences are not modelled, and rivers flowing in from outside the area are not included.
  - 60 m cells: a building counts as having water at the door when its cell has 10 cm or more.
    Bridges count as flooded when the ground under them is.
  - FABDEM is non-commercial (CC BY-NC-SA 4.0).
- **Base map tiles come from Esri's public services.** They need no key, but Esri's terms apply
  (attribution, and an ArcGIS account for commercial use). The first world view can take a few
  seconds to draw on a slow connection.
- **The EA covers England only.** Wales (NRW) and Scotland (SEPA) are not wired in.

## Not verified (need keys or long runs)

- The Google Flood Forecasting API needs a waitlist key. It was built from the REST reference;
  how the key is sent (header vs query) is not stated there.
- Claude explanations need an Anthropic key. The no-key path is tested live, and the tool loop
  is tested with a fake client.
- The full Caravan training and evaluation need Colab. The pipeline is proven end to end on
  synthetic data only, and the Caravan variable names are checked against the real files at run
  time.
- The Prithvi satellite run needs a 1.3 GB checkpoint and torch, so it runs in Colab.
- The API Docker image build was not run (Docker Desktop was off).
