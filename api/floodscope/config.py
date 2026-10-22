from functools import lru_cache
from pathlib import Path

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
    cors_origins: str = "http://localhost:3000"
    # Any localhost port, so dev servers that move off :3000 still work.
    cors_origin_regex: str = r"^http://(localhost|127\.0\.0\.1):\d+$"
    user_agent: str = "FloodScope3D/0.1 (+https://github.com/; flood exploration app)"
    http_timeout_s: float = 20.0

    open_meteo_flood_url: str = "https://flood-api.open-meteo.com/v1/flood"
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
