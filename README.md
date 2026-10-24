# FloodScope 3D

Click anywhere on a flat world map and see what open flood data says about that spot:

- **Now:** ground height, river flow and its 30-day forecast, live Environment Agency gauges.
- **How bad it could get:** modelled 1-in-10 to 1-in-500 year flood depths, in 3D water over real terrain.
- **Underground:** how wet the soil is for the time of year, and the water table.
- **AI:** a 1–7 day flow forecast (LSTM), a Claude-written explanation, Google Flood Hub status, and satellite water maps of past floods.
- **Simulation:** a WebGPU shallow-water model of river inflow and rain.

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
web/   Next.js 16 App Router + CesiumJS + Tailwind (TypeScript strict); Web Workers and WebGPU
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
npm install        # also copies Cesium's static assets into public/cesium
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
| Map and 3D views | [CesiumJS](https://cesium.com/platform/cesiumjs/) (no Cesium ion services) | — | Apache 2.0 |

## How it works

### Phase 1: point data
- **Elevation:** a one-pixel read through GDAL `/vsicurl/`, after a cached HEAD check that the
  tile exists.
- **River flow:** if the clicked GloFAS cell has no flow (null *or all zero*), the 8 neighbours
  at 0.05° and then 0.1° are tried, one request per ring, keeping the largest river.
- **Hazard and EA:** JRC depth is read for 7 return periods plus the permanent-water and
  spurious-depth masks. EA data comes from stations within 5 km and warnings within 10 km.

### The map
- **Flat 2D map:** Cesium in 2D mode with a Web Mercator projection, like a normal web map. No
  Cesium ion token is needed.
- **Base maps:** a dark street map (Esri Dark Gray Canvas) and satellite imagery (Esri World
  Imagery), with labels. Both are keyless tiles, checked live on 2026-10-24. CARTO's dark tiles
  were tried first but now return an "API key required" image.
- **3D only when close up:** the 3D flood view and the underground view switch the scene to 3D
  for a window a few kilometres across, which looks flat anyway, and switch back to the same map
  view on exit.

### Phase 2: 3D flood view
- **Terrain:** the DEM window becomes Cesium terrain. Heights are DEM + EGM2008 geoid, so the
  water and the ground share one surface. The chosen base map is draped over it.
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
- **Water mesh:** built in the worker as a GLB. A Cesium `CustomShader` draws the depth colours,
  ripples and the rise animation on the GPU.
- **Readouts:** hover depth with a human scale; flooded area counts water at least 5 cm deep;
  and max depth. Building counts came from Cesium OSM Buildings, which needed Cesium ion, so they
  were removed with it.

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
- **Underground view:** the ground turns see-through around the point and the camera can go below
  ground. The soil cut-away is drawn ×20 deeper and labelled so; the water table is drawn at its
  true depth.

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
- **Display:** depth is read back about twice a second and meshed in the worker.
- **Reference implementation:** `web/src/lib/sim/swe.ts` is the CPU version of the same maths.
  Its tests check a still lake stays still, mass is conserved, rain/inflow/outflow balance, and
  depth never goes negative.
- **Fallback:** without WebGPU, the tab explains this and offers the Phase 2 fill.

**Caching:** disk cache in `api/.cache`, keyed by tile, pixel or cell plus date. Errors are
never cached.

## Tests and checks

```bash
cd api && uv run pytest && uv run ruff check . && uv run mypy floodscope tests
uv run pytest -m live          # real APIs: point and scene for London, Lagos, Dhaka, New Orleans
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
