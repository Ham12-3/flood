from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

_API_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    """Runtime settings. Values come from the environment or the repo-root .env."""

    model_config = SettingsConfigDict(
        env_file=(_API_DIR.parent / ".env", _API_DIR / ".env"),
        env_prefix="FLOODSCOPE_",
        extra="ignore",
    )

    cache_dir: Path = _API_DIR / ".cache"
    # Trained forecast model (forecast_lstm.onnx + .json); see ml/notebooks/train_colab.ipynb.
    model_dir: Path = _API_DIR.parent / "ml" / "artifacts"
    # Prithvi satellite water maps (written by ml/floodscope_ml/satellite.py).
    satellite_dir: Path = _API_DIR.parent / "ml" / "satellite_results"
    # Claude model for /api/explain. The key is read from .env too (the SDK itself only
    # sees real environment variables); without it the SDK's own credential lookup runs.
    claude_model: str = "claude-sonnet-5-5"
    anthropic_api_key: str | None = Field(default=None, validation_alias="ANTHROPIC_API_KEY")
    # Google Flood Forecasting (waitlist). Feature is off while this is empty.
    google_flood_api_key: str | None = None
    cors_origins: str = "http://localhost:3000"
    # Any localhost port, so dev servers that move off :3000 still work.
    cors_origin_regex: str = r"^http://(localhost|127\.0\.0\.1):\d+$"
    user_agent: str = "FloodScope3D/0.1 (+https://github.com/; flood exploration app)"
    http_timeout_s: float = 20.0

    open_meteo_flood_url: str = "https://flood-api.open-meteo.com/v1/flood"
    open_meteo_forecast_url: str = "https://api.open-meteo.com/v1/forecast"
    open_meteo_archive_url: str = "https://archive-api.open-meteo.com/v1/archive"
    open_meteo_geocoding_url: str = "https://geocoding-api.open-meteo.com/v1/search"
    copernicus_dem_url: str = "https://copernicus-dem-30m.s3.amazonaws.com"
    jrc_hazard_url: str = (
        "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/CEMS-GLOFAS/flood_hazard"
    )
    ea_flood_url: str = "https://environment.data.gov.uk/flood-monitoring"

    # Cache lifetimes in seconds.
    ttl_forecast: int = 6 * 3600
    ttl_ea: int = 5 * 60
    ttl_static: int = 30 * 24 * 3600

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
