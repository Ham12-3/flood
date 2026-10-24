"""Background replay jobs. GET /api/replay starts one if needed and reports progress.

One simulation runs at a time (it is CPU-heavy); data downloads for queued replays can
run meanwhile. Finished replays are read from disk. Failed ones are reported once and
then forgotten, so asking again retries.
"""

import asyncio
import logging
import threading
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import httpx

from floodscope.cache import ResponseCache
from floodscope.config import Settings
from floodscope.models import ReplayResponse
from floodscope.replay.build import (
    ReplayParams,
    build_replay,
    discard,
    load_meta,
    replay_id,
    save_meta,
)

log = logging.getLogger(__name__)


@dataclass
class _Job:
    progress: float = 0.0
    stage: str = "Starting"
    task: "asyncio.Task[None] | None" = field(default=None, repr=False)


class ReplayJobs:
    def __init__(self, root: Path) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self._running: dict[str, _Job] = {}
        self._finished: dict[str, ReplayResponse] = {}  # no_data / error, reported once
        self._sim_lock = asyncio.Semaphore(1)
        self._stop = threading.Event()

    def result_dir(self, rid: str) -> Path | None:
        path = self.root / rid
        return path if (path / "meta.json").exists() else None

    async def request(
        self,
        p: ReplayParams,
        today: date,
        client: httpx.AsyncClient,
        cache: ResponseCache,
        settings: Settings,
    ) -> ReplayResponse:
        rid = replay_id(p, today)
        done = load_meta(self.root, rid)
        if done is not None:
            return done
        if rid in self._finished:
            return self._finished.pop(rid)
        job = self._running.get(rid)
        if job is None:
            job = _Job()
            self._running[rid] = job
            job.task = asyncio.create_task(self._run(rid, p, today, job, client, cache, settings))
        return ReplayResponse(
            status="running",
            id=rid,
            request=p.echo(),
            progress=round(job.progress, 3),
            stage=job.stage,
        )

    async def _run(
        self,
        rid: str,
        p: ReplayParams,
        today: date,
        job: _Job,
        client: httpx.AsyncClient,
        cache: ResponseCache,
        settings: Settings,
    ) -> None:
        tmp = self.root / f".{rid}.tmp"
        discard(tmp)
        tmp.mkdir(parents=True)

        def progress(value: float, stage: str) -> None:
            job.progress, job.stage = value, stage

        try:
            resp = await build_replay(
                p, rid, tmp, client, cache, settings, today, progress, self._sim_lock, self._stop
            )
            if resp.status == "ok":
                save_meta(tmp, resp)
                final = self.root / rid
                discard(final)
                tmp.rename(final)
            else:
                self._finished[rid] = resp
        except InterruptedError:
            pass  # shutting down
        except Exception as exc:  # report any failure to the client instead of hanging
            log.exception("Replay %s failed", rid)
            self._finished[rid] = ReplayResponse(
                status="error",
                id=rid,
                request=p.echo(),
                reason=f"The replay failed: {type(exc).__name__}: {exc}",
            )
        finally:
            discard(tmp)
            self._running.pop(rid, None)

    async def close(self) -> None:
        self._stop.set()
        tasks = [j.task for j in self._running.values() if j.task is not None]
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
