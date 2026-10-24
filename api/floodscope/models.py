"""Typed response models for /api/point and friends.

Every block carries a `status` and a `source`. When a source has nothing for the
point, `status` is "no_data" and `reason` says why; we never fill gaps with guesses.
"""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Status = Literal["ok", "no_data", "error"]

DISCLAIMER = "Estimates for exploration. Not an official flood warning."


class ApiModel(BaseModel):
    # Responses always include defaulted fields, so the schema (and the generated
    # TypeScript types) should mark them as required.
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class SourceInfo(ApiModel):
    """Where a number came from. Shown under every value in the UI."""

    name: str
    provider: str
    url: str
    resolution: str
    data_date: str = Field(description="Version, issue date or reading time of the data")
    licence: str
    retrieved_at: datetime


class Elevation(ApiModel):
    status: Status
    reason: str | None = None
    elevation_m: float | None = None
    tile: str | None = None
    cell_size_m: tuple[float, float] | None = Field(
        default=None, description="(east-west, north-south) pixel size in metres at this latitude"
    )
    note: str = "Surface model: includes buildings and trees, so may sit above the bare ground."
    source: SourceInfo


class DischargeDay(ApiModel):
    date: date
    discharge: float | None = Field(description="GloFAS consolidated/forecast value, m3/s")
    ensemble_mean: float | None = None
    ensemble_median: float | None = None
    ensemble_min: float | None = None
    ensemble_max: float | None = None
    ensemble_p25: float | None = None
    ensemble_p75: float | None = None


class RiverDischarge(ApiModel):
    status: Status
    reason: str | None = None
    grid_lat: float | None = Field(default=None, description="Centre of the GloFAS cell used")
    grid_lon: float | None = None
    offset_km: float | None = Field(
        default=None, description="Distance from the clicked point to the GloFAS cell used"
    )
    searched_offsets: bool = Field(
        default=False, description="True when the clicked cell had no river and we looked nearby"
    )
    today: DischargeDay | None = None
    forecast: list[DischargeDay] = Field(default_factory=list)
    source: SourceInfo


ReturnPeriod = Literal[10, 20, 50, 75, 100, 200, 500]
RETURN_PERIODS: tuple[ReturnPeriod, ...] = (10, 20, 50, 75, 100, 200, 500)


class HazardDepth(ApiModel):
    return_period: ReturnPeriod
    depth_m: float | None = Field(description="Water depth; null when the cell stays dry")
    flooded: bool


class FloodHazard(ApiModel):
    status: Status
    reason: str | None = None
    tile: str | None = None
    depths: list[HazardDepth] = Field(default_factory=list)
    permanent_water: bool | None = None
    spurious_depth_area: bool | None = Field(
        default=None,
        description="JRC flags this area as having possibly unrealistic depths (>10 m in small "
        "channels). Treat depths here with caution.",
    )
    note: str = (
        "Modelled without flood defences (walls, barriers, levees), so protected areas can "
        "show water that defences would normally hold back."
    )
    source: SourceInfo


class EAReading(ApiModel):
    parameter: str
    qualifier: str | None = None
    unit: str | None = None
    value: float | None = None
    time: datetime | None = None
    stale: bool = Field(description="True if the latest reading is over 24 hours old or missing")


class EAStation(ApiModel):
    reference: str
    label: str
    river: str | None = None
    town: str | None = None
    lat: float
    lon: float
    distance_km: float
    station_types: list[str] = Field(default_factory=list)
    typical_range_low: float | None = None
    typical_range_high: float | None = None
    max_on_record: float | None = None
    max_on_record_time: datetime | None = None
    readings: list[EAReading] = Field(default_factory=list)
    url: str


class EAWarning(ApiModel):
    id: str
    area: str
    severity: str
    severity_level: int
    message: str | None = None
    time_raised: datetime | None = None
    river_or_sea: str | None = None


class UKLive(ApiModel):
    status: Status
    reason: str | None = None
    stations: list[EAStation] = Field(default_factory=list)
    warnings: list[EAWarning] = Field(default_factory=list)
    search_radius_km: float
    official_url: str = "https://check-for-flooding.service.gov.uk/"
    source: SourceInfo


class PointResponse(ApiModel):
    lat: float
    lon: float
    generated_at: datetime
    disclaimer: str = DISCLAIMER
    elevation: Elevation
    river: RiverDischarge
    hazard: FloodHazard
    uk_live: UKLive


class Place(ApiModel):
    name: str
    lat: float
    lon: float
    country: str | None = None
    admin1: str | None = None


class GeocodeResponse(ApiModel):
    query: str
    results: list[Place]
    source: SourceInfo


# --- Phase 2: terrain window for the 3D flood view --------------------------------


class SceneGrid(ApiModel):
    """Regular lat/lon grid. Arrays are row-major with row 0 at the north edge."""

    west: float
    south: float
    east: float
    north: float
    nx: int
    ny: int
    dx_deg: float
    dy_deg: float
    cell_size_m: tuple[float, float] = Field(description="(east-west, north-south) metres")


class SceneDem(ApiModel):
    status: Status
    reason: str | None = None
    heights_f32: str | None = Field(
        default=None,
        description="base64 little-endian float32, metres above EGM2008; NaN = no data (sea)",
    )
    min_m: float | None = None
    max_m: float | None = None
    source: SourceInfo


class HazardLayer(ApiModel):
    return_period: ReturnPeriod
    depth_cm_u16: str = Field(description="base64 little-endian uint16 depth in cm; 0 = dry")
    flooded_cells: int


class SceneHazard(ApiModel):
    status: Status
    reason: str | None = None
    layers: list[HazardLayer] = Field(default_factory=list)
    permanent_water_u8: str | None = Field(
        default=None, description="base64 uint8 mask, 1 = permanent water (river or lake)"
    )
    permanent_water_cells: int = 0
    spurious_depth_in_window: bool = False
    note: str = (
        "JRC depths are on a 90 m grid, sampled onto the 30 m terrain grid (nearest cell). "
        "Modelled without flood defences."
    )
    source: SourceInfo


class DischargeForRP(ApiModel):
    return_period: int
    discharge: float


class ReturnPeriodFitInfo(ApiModel):
    status: Status
    reason: str | None = None
    method: str = "Gumbel distribution fitted by L-moments to calendar-year maximum daily flow"
    grid_lat: float | None = None
    grid_lon: float | None = None
    first_year: int | None = None
    last_year: int | None = None
    n_years: int | None = None
    location: float | None = None
    scale: float | None = None
    mean_flow: float | None = Field(
        default=None, description="Mean daily flow 1997-01-01 to 2010-09-30, m3/s"
    )
    thresholds: list[DischargeForRP] = Field(default_factory=list)
    source: SourceInfo


class MapBlend(ApiModel):
    """Which hazard maps to show: lower + weight * (upper - lower), in log return period."""

    lower: ReturnPeriod
    upper: ReturnPeriod
    weight: float


class ForecastScenario(ApiModel):
    day: int = Field(description="0 = today")
    date: date
    discharge: float | None = Field(description="Ensemble mean, or the main run if missing")
    discharge_low: float | None = Field(default=None, description="Ensemble 25th percentile")
    discharge_high: float | None = Field(default=None, description="Ensemble 75th percentile")
    return_period: float | None = None
    return_period_low: float | None = None
    return_period_high: float | None = None
    maps: MapBlend | None = Field(
        default=None, description="Null when the flow is below the 1-in-10 map (in banks)"
    )
    beyond_largest_map: bool = False


class SceneResponse(ApiModel):
    lat: float
    lon: float
    size_km: float
    generated_at: datetime
    disclaimer: str = DISCLAIMER
    grid: SceneGrid
    geoid_offset_m: float | None = Field(
        description="EGM2008 geoid height N at the window centre: ellipsoid h = DEM + N"
    )
    dem: SceneDem
    hazard: SceneHazard
    river: RiverDischarge
    fit: ReturnPeriodFitInfo
    scenarios: list[ForecastScenario] = Field(default_factory=list)
    scenario_basis: str = (
        "The river cell's forecast flow is converted to a return period with the fitted "
        "curve, then the two nearest JRC maps are blended in log return period. The same "
        "flood size is applied to the whole window, so tributaries may differ."
    )


class SceneStatic(ApiModel):
    """The cacheable part of a scene: terrain and hazard grids for one window."""

    grid: SceneGrid
    geoid_offset_m: float | None
    dem: SceneDem
    hazard: SceneHazard


# --- Phase 3: underground ---------------------------------------------------------


class SoilPoint(ApiModel):
    date: date
    value: float | None = Field(description="Volumetric soil water, m3/m3")


class SoilLayer(ApiModel):
    top_cm: int
    bottom_cm: int
    value: float | None = Field(description="Latest ERA5 daily mean, m3/m3")
    season_percentile: float | None = Field(
        default=None,
        description="Share of ERA5 days within 15 days of the same date in earlier years "
        "(2000 onwards) that were drier, 0-100",
    )
    relative_wetness_pct: float | None = Field(
        default=None,
        description="Where the value sits between the driest and wettest of those days, "
        "0-100. Not a true saturation: soil porosity is not known.",
    )
    season_min: float | None = None
    season_max: float | None = None
    forecast: list[SoilPoint] = Field(
        default_factory=list, description="ECMWF IFS forecast (a different model; trend only)"
    )
    forecast_change_7d: float | None = Field(
        default=None, description="IFS change from today to 7 days ahead, m3/m3"
    )


class SoilBlock(ApiModel):
    status: Status
    reason: str | None = None
    value_date: date | None = Field(default=None, description="Date of the latest ERA5 day")
    layers: list[SoilLayer] = Field(default_factory=list)
    summary: str | None = None
    climatology_years: str | None = None
    forecast_source: SourceInfo
    climatology_source: SourceInfo


class GroundwaterStation(ApiModel):
    reference: str
    label: str
    lat: float
    lon: float
    distance_km: float
    level_maod: float | None = None
    time: datetime | None = None
    stale: bool
    datum_maod: float | None = Field(
        default=None, description="Borehole datum (about ground level), m above Ordnance Datum"
    )
    depth_below_datum_m: float | None = None
    typical_range_low: float | None = None
    typical_range_high: float | None = None
    max_on_record: float | None = None
    min_on_record: float | None = None
    url: str


class GroundwaterBlock(ApiModel):
    status: Status
    reason: str | None = None
    station: GroundwaterStation | None = None
    search_radius_km: float
    source: SourceInfo


class LeadSkill(ApiModel):
    lead: int
    nse: float | None = None
    kge: float | None = None
    nse_persistence: float | None = None
    nse_glofas: float | None = None


class ModelInfo(ApiModel):
    run: str
    dataset: str | None = None
    train_basins: int | None = None
    held_out_basins: int | None = None
    skill: list[LeadSkill] = Field(
        default_factory=list, description="Median skill on held-out basins, by lead time"
    )
    note: str | None = None


class PredictionDay(ForecastScenario):
    glofas_discharge: float | None = Field(
        default=None, description="GloFAS ensemble-mean forecast for the same day, m3/s"
    )


class PredictResponse(ApiModel):
    lat: float
    lon: float
    generated_at: datetime
    disclaimer: str = DISCLAIMER
    status: Status
    reason: str | None = None
    issue_date: date | None = None
    grid_lat: float | None = None
    grid_lon: float | None = None
    days: list[PredictionDay] = Field(default_factory=list)
    model: ModelInfo | None = None
    method: str = (
        "LSTM (NeuralHydrology) trained on Caravan basins. It forecasts flow as a ratio "
        "to the river's 1997-2010 mean, driven by ERA5 weather and soil for the past year "
        "and the ECMWF IFS forecast for the next 7 days at this point, plus GloFAS flow "
        "up to today. The ratio is scaled by this GloFAS cell's mean flow. The band is the "
        "10th-90th percentile of errors on held-out basins."
    )
    sources: list[SourceInfo] = Field(default_factory=list)


class GoogleForecastValue(ApiModel):
    start: datetime | None = None
    end: datetime | None = None
    value: float | None = None


class GoogleGauge(ApiModel):
    gauge_id: str
    site_name: str | None = None
    river: str | None = None
    source: str | None = None
    lat: float
    lon: float
    distance_km: float
    quality_verified: bool | None = None
    has_model: bool | None = None
    severity: str | None = Field(
        default=None, description="EXTREME, SEVERE, ABOVE_NORMAL, NO_FLOODING or UNKNOWN"
    )
    trend: str | None = Field(default=None, description="RISE, FALL or NO_CHANGE")
    issued_time: datetime | None = None
    forecast_issued_time: datetime | None = None
    forecast: list[GoogleForecastValue] = Field(
        default_factory=list,
        description="Latest forecast; units are set by the gauge's model and not returned here",
    )


class GoogleFloodResponse(ApiModel):
    lat: float
    lon: float
    status: Status
    reason: str | None = None
    gauges: list[GoogleGauge] = Field(default_factory=list)
    search_radius_km: float
    official_url: str = "https://sites.research.google/floods/"
    source: SourceInfo


class SatelliteResult(ApiModel):
    id: str
    scene_id: str
    datetime: str
    cloud_cover: float | None = None
    bounds: tuple[float, float, float, float] = Field(description="west, south, east, north")
    water_fraction: float | None = None
    model: str
    note: str | None = None
    overlay_url: str


class SatelliteResponse(ApiModel):
    lat: float
    lon: float
    status: Status
    reason: str | None = None
    results: list[SatelliteResult] = Field(default_factory=list)
    source: SourceInfo


class ExplainRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    question: str | None = Field(default=None, max_length=500)
    units: Literal["metric", "imperial"] = "metric"


class ExplainResponse(ApiModel):
    lat: float
    lon: float
    generated_at: datetime
    disclaimer: str = DISCLAIMER
    status: Status
    reason: str | None = None
    answer: str | None = None
    model: str | None = None
    tools_used: list[str] = Field(default_factory=list)
    unverified_numbers: list[str] = Field(
        default_factory=list,
        description="Numbers in the answer that do not appear in any tool result. "
        "Shown to the user as a warning.",
    )


class GroundResponse(ApiModel):
    lat: float
    lon: float
    generated_at: datetime
    disclaimer: str = DISCLAIMER
    soil: SoilBlock
    groundwater: GroundwaterBlock
