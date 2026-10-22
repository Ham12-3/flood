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
