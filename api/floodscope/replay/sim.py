"""Rain-on-grid flood simulation for storm replays.

The same local-inertial shallow-water scheme as the browser simulation
(web/src/lib/sim/swe.ts; Bates et al. 2010, LISFLOOD-FP), vectorised with numpy:

  1. For every face, flow depth hf = max(eta_a, eta_b) - max(z_a, z_b) and
     q <- (q - g hf dt S) / (1 + g dt n^2 |q| / hf^(7/3)),   S = d(eta)/dx.
  2. Window edges let water leave at critical flow, q = h sqrt(g h).
  3. h <- h + dt (inflow - outflow) / area + rain dt - drains dt, kept >= 0.

Additions for whole-storm replays:
- Sea cells (the sea or a lagoon joined to the window edge) are held at the hour's
  sea level. Water flows into them only while the land's water surface is higher, so
  a high tide holds water back. The sea never flows onto land: near the coast the
  height map is only good to a metre or two and has no sea walls, and letting the
  tide in floods the shore at every high tide.
- Drains remove a fixed rate everywhere. Near the sea they work less, and they stop
  where the ground is at or below the sea level, because they cannot empty into it.

Grid: row 0 is the north edge. qx[r, c] sits on the west side of cell (r, c) and is
positive eastwards; qy[r, c] sits on the north side of cell (r, c) and is positive
southwards (towards higher row numbers).
"""

import math
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

G = 9.81
DRY = 1e-3  # m: faces with less flow depth than this carry no water
DRAIN_FADE_M = 1.0  # drains reach full rate this far above the sea level


@dataclass(frozen=True)
class SimParams:
    dx: float  # cell size east-west, m
    dy: float  # cell size north-south, m
    manning: float = 0.035
    drain_mm_h: float = 5.0
    alpha: float = 0.7  # Courant number (Bates et al. suggest 0.7)
    max_dt: float = 30.0  # s


WATER_TOL_M = 0.01  # FABDEM water is exactly 0 m


def is_water(z: np.ndarray) -> np.ndarray:
    """FABDEM (like the Copernicus DEM it comes from) sets the sea and coastal lagoons to
    exactly 0 m, and leaves all-ocean tiles out (NaN here). Land below sea level
    (polders) is negative, not 0, so it is not mistaken for water. Inland lakes keep
    their own height and count as land."""
    out: np.ndarray = ~np.isfinite(z) | (np.abs(np.nan_to_num(z, nan=0.0)) <= WATER_TOL_M)
    return out


def aggregate_ground(native: np.ndarray, ky: int, kx: int) -> tuple[np.ndarray, np.ndarray]:
    """Average native pixels into cells of ky x kx pixels.

    Returns (ground, water_fraction). A cell's ground is the mean of its land pixels
    only, so a shoreline cell that is half lagoon keeps its land height instead of a
    blend with the 0 m water; all-water cells get 0 m.
    """
    ny, nx = native.shape[0] // ky, native.shape[1] // kx
    blocks = native[: ny * ky, : nx * kx].reshape(ny, ky, nx, kx)
    water = is_water(blocks)
    land_sum = np.where(water, 0.0, np.nan_to_num(blocks)).sum(axis=(1, 3))
    land_n = (~water).sum(axis=(1, 3))
    ground = np.where(land_n > 0, land_sum / np.maximum(land_n, 1), 0.0)
    fraction: np.ndarray = water.mean(axis=(1, 3))
    return ground, fraction


def sea_mask(z: np.ndarray, water: np.ndarray | None = None) -> np.ndarray:
    """Sea and lagoon cells: water cells joined to the window edge.

    `water` marks water cells (for example "mostly water" from aggregate_ground);
    by default cells that are themselves 0 m or no-data.
    """
    ny, nx = z.shape
    candidate = is_water(z) if water is None else water
    out: np.ndarray = np.zeros(candidate.shape, dtype=bool)
    queue: deque[tuple[int, int]] = deque()
    for r in range(ny):
        for c in (0, nx - 1):
            if candidate[r, c] and not out[r, c]:
                out[r, c] = True
                queue.append((r, c))
    for c in range(nx):
        for r in (0, ny - 1):
            if candidate[r, c] and not out[r, c]:
                out[r, c] = True
                queue.append((r, c))
    while queue:
        r, c = queue.popleft()
        for rr, cc in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)):
            if 0 <= rr < ny and 0 <= cc < nx and candidate[rr, cc] and not out[rr, cc]:
                out[rr, cc] = True
                queue.append((rr, cc))
    absorb_specks(out)
    return out


def absorb_specks(sea: np.ndarray, max_cells: int = 3) -> None:
    """Turn tiny patches of "land" surrounded by sea into sea, in place.

    Fishing stakes, moored boats and jetties lift a few 60 m squares in a lagoon just
    above 0 m; rain would pool on them and count as flooded land.
    """
    ny, nx = sea.shape
    padded = np.pad(sea, 1, constant_values=False)
    sea_neighbours = (
        padded[:-2, 1:-1].astype(int) + padded[2:, 1:-1] + padded[1:-1, :-2] + padded[1:-1, 2:]
    )
    seen = np.zeros_like(sea)
    for r, c in zip(*np.nonzero(~sea & (sea_neighbours >= 2)), strict=True):
        if seen[r, c]:
            continue
        patch = [(int(r), int(c))]
        in_patch = {patch[0]}
        seen[r, c] = True
        enclosed = True
        i = 0
        while i < len(patch) and len(patch) <= max_cells:
            pr, pc = patch[i]
            i += 1
            for rr, cc in ((pr - 1, pc), (pr + 1, pc), (pr, pc - 1), (pr, pc + 1)):
                if not (0 <= rr < ny and 0 <= cc < nx):
                    enclosed = False  # touches the window edge: may be part of bigger land
                elif sea[rr, cc] or (rr, cc) in in_patch:
                    continue
                elif seen[rr, cc]:
                    enclosed = False  # joins land already found to be too big
                else:
                    seen[rr, cc] = True
                    patch.append((rr, cc))
                    in_patch.add((rr, cc))
        if enclosed and len(patch) <= max_cells:
            for pr, pc in patch:
                sea[pr, pc] = True


class Simulation:
    """Water depth on a grid, stepped forward with adaptive time steps."""

    def __init__(self, z: np.ndarray, sea: np.ndarray, params: SimParams) -> None:
        if z.shape != sea.shape:
            raise ValueError("z and sea must have the same shape")
        self.p = params
        self.sea = sea.astype(bool)
        # Sea floors are 0 m (or unknown); everything else must have a height.
        self.z = np.where(self.sea, np.nan_to_num(z, nan=0.0), z).astype("float64")
        if not np.isfinite(self.z).all():
            raise ValueError("land cells must all have a ground height")
        ny, nx = z.shape
        self.h = np.zeros((ny, nx))
        self.qx = np.zeros((ny, nx + 1))
        self.qy = np.zeros((ny + 1, nx))
        self.time = 0.0
        self.outflow_m3 = 0.0  # left through the window edges (not counting the sea)
        self.added_m3 = 0.0  # rain
        self.drained_m3 = 0.0  # drains
        self.sea_exchange_m3 = 0.0  # net water taken in by the sea cells
        self.sea_level = 0.0
        self._drain_factor = np.ones((ny, nx))
        # Faces between land and sea: (sea on the west / north side, sea on the east / south).
        self._sea_x = (self.sea[:, :-1] & ~self.sea[:, 1:], ~self.sea[:, :-1] & self.sea[:, 1:])
        self._sea_y = (self.sea[:-1, :] & ~self.sea[1:, :], ~self.sea[:-1, :] & self.sea[1:, :])
        self.set_sea_level(0.0)

    def set_sea_level(self, level: float) -> None:
        """Hold sea cells at this water surface (m above sea level, i.e. the tide)."""
        self.sea_level = level
        before = self.h[self.sea].sum()
        self.h[self.sea] = np.maximum(level - self.z[self.sea], 0.0)
        self.sea_exchange_m3 -= (self.h[self.sea].sum() - before) * self.p.dx * self.p.dy
        if self.sea.any():
            self._drain_factor = np.clip((self.z - level) / DRAIN_FADE_M, 0.0, 1.0)
            self._drain_factor[self.sea] = 0.0
        else:
            self._drain_factor = np.ones_like(self.z)

    def volume_m3(self) -> float:
        """Water on land (sea cells excluded)."""
        return float(self.h[~self.sea].sum() * self.p.dx * self.p.dy)

    def stable_dt(self) -> float:
        hmax = float(self.h.max())
        if hmax < DRY:
            return self.p.max_dt
        return min(self.p.max_dt, self.p.alpha * min(self.p.dx, self.p.dy) / math.sqrt(G * hmax))

    def step(self, dt: float, rain_m_s: np.ndarray | float) -> None:
        p = self.p
        z, h, n2 = self.z, self.h, p.manning * p.manning
        eta = z + h

        def flux(
            q: np.ndarray, ea: np.ndarray, eb: np.ndarray, za: np.ndarray, zb: np.ndarray, d: float
        ) -> np.ndarray:
            hf = np.maximum(ea, eb) - np.maximum(za, zb)
            wet = hf > DRY
            hfs = np.where(wet, hf, 1.0)
            out = (q - G * hfs * dt * (eb - ea) / d) / (
                1 + G * dt * n2 * np.abs(q) / hfs ** (7 / 3)
            )
            return np.where(wet, out, 0.0)

        self.qx[:, 1:-1] = flux(
            self.qx[:, 1:-1], eta[:, :-1], eta[:, 1:], z[:, :-1], z[:, 1:], p.dx
        )
        self.qy[1:-1, :] = flux(
            self.qy[1:-1, :], eta[:-1, :], eta[1:, :], z[:-1, :], z[1:, :], p.dy
        )
        # One way only: from land into the sea.
        qx, qy = self.qx[:, 1:-1], self.qy[1:-1, :]
        qx[self._sea_x[0]] = np.minimum(qx[self._sea_x[0]], 0.0)
        qx[self._sea_x[1]] = np.maximum(qx[self._sea_x[1]], 0.0)
        qy[self._sea_y[0]] = np.minimum(qy[self._sea_y[0]], 0.0)
        qy[self._sea_y[1]] = np.maximum(qy[self._sea_y[1]], 0.0)

        # Free outflow at the window edges (the sea cells there are held at sea level).
        def edge(hh: np.ndarray, sea: np.ndarray) -> np.ndarray:
            return np.where((hh > DRY) & ~sea, hh * np.sqrt(G * np.maximum(hh, 0.0)), 0.0)

        self.qx[:, 0] = -edge(h[:, 0], self.sea[:, 0])
        self.qx[:, -1] = edge(h[:, -1], self.sea[:, -1])
        self.qy[0, :] = -edge(h[0, :], self.sea[0, :])
        self.qy[-1, :] = edge(h[-1, :], self.sea[-1, :])
        self._limit_outflow(dt)
        out_m3 = (
            (-self.qx[:, 0].sum() + self.qx[:, -1].sum()) * p.dy
            + (-self.qy[0, :].sum() + self.qy[-1, :].sum()) * p.dx
        ) * dt

        dh = dt * (
            (self.qx[:, :-1] - self.qx[:, 1:]) / p.dx + (self.qy[:-1, :] - self.qy[1:, :]) / p.dy
        )
        rain = np.broadcast_to(np.asarray(rain_m_s, dtype="float64"), h.shape)
        land = ~self.sea
        new_h = h + dh + rain * dt
        drain = (p.drain_mm_h / 1000 / 3600) * dt * self._drain_factor
        drained = np.minimum(np.maximum(new_h, 0.0), drain)
        new_h = np.maximum(new_h - drained, 0.0)

        area = p.dx * p.dy
        self.added_m3 += float(rain[land].sum() * dt * area)
        self.drained_m3 += float(drained[land].sum() * area)
        self.outflow_m3 += out_m3
        # Whatever reached the sea cells is taken in; they go back to the sea level.
        sea_in = new_h[self.sea] - h[self.sea] - rain[self.sea] * dt  # flow in, not rain
        self.sea_exchange_m3 += float(sea_in.sum() * area)
        new_h[self.sea] = h[self.sea]
        self.h = new_h
        self.time += dt

    def _limit_outflow(self, dt: float) -> None:
        """Scale down a cell's outgoing fluxes so it cannot give more water than it holds.

        On rough ground the explicit scheme can otherwise drain a cell below zero, and
        clamping the depth back to zero would create water.
        """
        p, qx, qy = self.p, self.qx, self.qy
        out_rate = (
            np.maximum(qx[:, 1:], 0.0) / p.dx  # east faces, flowing east
            + np.maximum(-qx[:, :-1], 0.0) / p.dx  # west faces, flowing west
            + np.maximum(qy[1:, :], 0.0) / p.dy  # south faces, flowing south
            + np.maximum(-qy[:-1, :], 0.0) / p.dy  # north faces, flowing north
        )
        need = out_rate * dt
        factor = np.where(need > self.h, self.h / np.where(need > 0, need, 1.0), 1.0)
        factor[self.sea] = 1.0  # the sea is held at its level, so it never runs dry
        # Each face takes the factor of the cell the water leaves.
        qx[:, 1:-1] *= np.where(qx[:, 1:-1] > 0, factor[:, :-1], factor[:, 1:])
        qx[:, 0] *= factor[:, 0]
        qx[:, -1] *= factor[:, -1]
        qy[1:-1, :] *= np.where(qy[1:-1, :] > 0, factor[:-1, :], factor[1:, :])
        qy[0, :] *= factor[0, :]
        qy[-1, :] *= factor[-1, :]

    def run(
        self,
        seconds: float,
        rain_m_s: np.ndarray | float,
        should_stop: Callable[[], bool] = lambda: False,
    ) -> int:
        """Advance `seconds` of simulated time with constant rain. Returns steps taken."""
        end = self.time + seconds
        steps = 0
        while self.time < end - 1e-9:
            if should_stop():
                raise InterruptedError("simulation stopped")
            self.step(min(self.stable_dt(), end - self.time), rain_m_s)
            steps += 1
        return steps


def bilinear_rain(
    values: np.ndarray,
    point_lons: np.ndarray,
    point_lats: np.ndarray,
    cell_lons: np.ndarray,
    cell_lats: np.ndarray,
) -> np.ndarray:
    """Spread rain from a regular lat/lon grid of points onto the cells.

    values: (hours, n_lat, n_lon) with point_lats descending (north first) and
    point_lons ascending. cell_lons/cell_lats: 2-D cell centre coordinates.
    Returns (hours, ny, nx). Cells outside the points take the nearest edge value.
    """
    _, n_lat, n_lon = values.shape

    def frac(coords: np.ndarray, axis_vals: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        ascending = axis_vals if axis_vals[0] <= axis_vals[-1] else axis_vals[::-1]
        if len(ascending) == 1:
            zeros = np.zeros(coords.shape, dtype=np.int64)
            return zeros, np.zeros(coords.shape)
        pos = np.interp(coords, ascending, np.arange(len(ascending)))
        i0 = np.clip(np.floor(pos).astype(np.int64), 0, len(ascending) - 2)
        t = pos - i0
        if axis_vals[0] > axis_vals[-1]:  # descending: flip indices back
            i0 = len(ascending) - 2 - i0
            t = 1 - t
        return i0, t

    ix, tx = frac(cell_lons, point_lons)
    iy, ty = frac(cell_lats, point_lats)
    ix1 = np.minimum(ix + 1, n_lon - 1)
    iy1 = np.minimum(iy + 1, n_lat - 1)
    v = values
    top = v[:, iy, ix] * (1 - tx) + v[:, iy, ix1] * tx
    bottom = v[:, iy1, ix] * (1 - tx) + v[:, iy1, ix1] * tx
    out: np.ndarray = top * (1 - ty) + bottom * ty
    return out
