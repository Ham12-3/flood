"""On-disk response cache, keyed by tile/cell and date.

External APIs are rate limited (Open-Meteo free tier: 10k calls/day), so every
client goes through here. Only successful results are cached; errors are retried.
"""

from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TypeVar

import diskcache
from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


class ResponseCache:
    def __init__(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        self._cache = diskcache.Cache(str(directory), size_limit=2 * 1024**3)

    async def get_or_fetch(
        self,
        key: str,
        model: type[T],
        fetch: Callable[[], Awaitable[T]],
        ttl_s: int,
        should_cache: Callable[[T], bool] = lambda _: True,
    ) -> T:
        raw = self._cache.get(key)
        if isinstance(raw, str):
            return model.model_validate_json(raw)
        value = await fetch()
        if should_cache(value):
            self._cache.set(key, value.model_dump_json(), expire=ttl_s)
        return value

    def get_text(self, key: str) -> str | None:
        raw = self._cache.get(key)
        return raw if isinstance(raw, str) else None

    def set_text(self, key: str, value: str, ttl_s: int) -> None:
        self._cache.set(key, value, expire=ttl_s)

    def close(self) -> None:
        self._cache.close()
