/**
 * Shallow-water flood simulation: the local-inertial scheme of Bates et al. (2010),
 * "A simple inertial formulation of the shallow water equations for efficient
 * two-dimensional flood inundation modelling" (LISFLOOD-FP), as used widely for
 * inundation. This CPU version is the reference; shaders.ts runs the same maths on
 * the GPU, and tests check the physics here.
 *
 * Grid: nx * ny cells, row-major, row 0 at the north. Ground z (m), depth h (m).
 * Unit-width fluxes q (m^2/s) live on faces: qx has (nx+1) * ny east-west faces,
 * qy has nx * (ny+1) north-south faces. Positive qx flows east, positive qy flows
 * south (towards increasing row index).
 *
 * Each step:
 *   1. For every face, the flow depth hf = max(eta_a, eta_b) - max(z_a, z_b) and
 *      q <- (q - g hf dt S) / (1 + g dt n^2 |q| / hf^(7/3)),   S = d(eta)/dx.
 *   2. Outer faces let water leave at critical flow, q = h sqrt(g h) (free outflow).
 *   3. h <- h + dt (inflow - outflow) / area + rain dt, kept >= 0.
 */

export const G = 9.81;
export const DRY = 1e-3; // m: faces with less flow depth than this carry no water

export interface SweParams {
  nx: number;
  ny: number;
  dx: number; // cell size east-west, m
  dy: number; // cell size north-south, m
  manning: number; // n, s/m^(1/3)
  rainMmPerHour: number;
  /** m^3/s added at each listed cell (river inflow). */
  inflow: { cell: number; m3s: number }[];
  /** Courant number for the time step (Bates et al. suggest 0.7). */
  alpha: number;
  maxDt: number; // s
}

export interface SweState {
  h: Float32Array;
  qx: Float32Array;
  qy: Float32Array;
  time: number; // simulated seconds
  outflow: number; // m^3 that left through the edges so far
  added: number; // m^3 of rain and inflow added so far
}

export function initialState(nx: number, ny: number): SweState {
  return {
    h: new Float32Array(nx * ny),
    qx: new Float32Array((nx + 1) * ny),
    qy: new Float32Array(nx * (ny + 1)),
    time: 0,
    outflow: 0,
    added: 0,
  };
}

export function stableDt(h: Float32Array, p: SweParams): number {
  let hmax = 0;
  for (let i = 0; i < h.length; i++) if (h[i] > hmax) hmax = h[i];
  if (hmax < DRY) return p.maxDt;
  return Math.min(p.maxDt, (p.alpha * Math.min(p.dx, p.dy)) / Math.sqrt(G * hmax));
}

function faceFlux(q: number, etaA: number, etaB: number, zA: number, zB: number, d: number, dt: number, n: number): number {
  if (!Number.isFinite(zA) || !Number.isFinite(zB)) return 0;
  const hf = Math.max(etaA, etaB) - Math.max(zA, zB);
  if (hf <= DRY) return 0;
  const slope = (etaB - etaA) / d;
  return (q - G * hf * dt * slope) / (1 + (G * dt * n * n * Math.abs(q)) / Math.pow(hf, 7 / 3));
}

function edgeOutflow(h: number): number {
  return h > DRY ? h * Math.sqrt(G * h) : 0;
}

/** Advance one step of length dt (s). Mutates `s`. NaN ground cells never hold water. */
export function step(s: SweState, z: Float32Array, p: SweParams, dt: number): void {
  const { nx, ny, dx, dy, manning: n } = p;
  const { h, qx, qy } = s;
  const eta = (i: number) => z[i] + h[i];

  // 1. East-west faces. Face (x, y) sits on the west side of cell x.
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x <= nx; x++) {
      const f = y * (nx + 1) + x;
      if (x === 0) {
        qx[f] = -edgeOutflow(h[y * nx]); // leaves westward
      } else if (x === nx) {
        qx[f] = edgeOutflow(h[y * nx + nx - 1]); // leaves eastward
      } else {
        const a = y * nx + x - 1;
        const b = a + 1;
        qx[f] = faceFlux(qx[f], eta(a), eta(b), z[a], z[b], dx, dt, n);
      }
    }
  }
  // North-south faces. Face (x, y) sits on the north side of cell row y.
  for (let y = 0; y <= ny; y++) {
    for (let x = 0; x < nx; x++) {
      const f = y * nx + x;
      if (y === 0) {
        qy[f] = -edgeOutflow(h[x]);
      } else if (y === ny) {
        qy[f] = edgeOutflow(h[(ny - 1) * nx + x]);
      } else {
        const a = (y - 1) * nx + x;
        const b = a + nx;
        qy[f] = faceFlux(qy[f], eta(a), eta(b), z[a], z[b], dy, dt, n);
      }
    }
  }

  // 3. Continuity, with rain and river inflow.
  const rain = p.rainMmPerHour / 1000 / 3600;
  const area = dx * dy;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (!Number.isFinite(z[i])) continue;
      const west = qx[y * (nx + 1) + x];
      const east = qx[y * (nx + 1) + x + 1];
      const north = qy[y * nx + x];
      const south = qy[(y + 1) * nx + x];
      const dh = dt * ((west - east) / dx + (north - south) / dy) + rain * dt;
      h[i] = Math.max(0, h[i] + dh);
    }
  }
  for (const { cell, m3s } of p.inflow) {
    if (Number.isFinite(z[cell])) h[cell] += (m3s * dt) / area;
  }

  // Book-keeping for the mass balance.
  let out = 0;
  for (let y = 0; y < ny; y++) out += (-qx[y * (nx + 1)] + qx[y * (nx + 1) + nx]) * dy;
  for (let x = 0; x < nx; x++) out += (-qy[x] + qy[ny * nx + x]) * dx;
  s.outflow += out * dt;
  let wet = 0;
  for (let i = 0; i < z.length; i++) if (Number.isFinite(z[i])) wet++;
  s.added += (rain * wet * area + p.inflow.reduce((a, b) => a + b.m3s, 0)) * dt;
  s.time += dt;
}

export function volume(h: Float32Array, p: Pick<SweParams, "dx" | "dy">): number {
  let v = 0;
  for (let i = 0; i < h.length; i++) v += h[i];
  return v * p.dx * p.dy;
}

/** Run until `untilSeconds` of simulated time (adaptive dt). Returns steps taken. */
export function runUntil(s: SweState, z: Float32Array, p: SweParams, untilSeconds: number, maxSteps = 1_000_000): number {
  let steps = 0;
  while (s.time < untilSeconds && steps < maxSteps) {
    const dt = Math.min(stableDt(s.h, p), untilSeconds - s.time);
    step(s, z, p, dt);
    steps++;
  }
  return steps;
}

/**
 * River inflow cells: the permanent-water cells on the window edge, in the cluster with
 * the highest ground (upstream is usually higher). Returns [] if the river does not
 * cross the window edge.
 */
export function inflowCells(z: Float32Array, water: Uint8Array, nx: number, ny: number): number[] {
  const edge: number[] = [];
  for (let x = 0; x < nx; x++) {
    edge.push(x, (ny - 1) * nx + x);
  }
  for (let y = 1; y < ny - 1; y++) edge.push(y * nx, y * nx + nx - 1);
  const wetEdge = edge.filter((i) => water[i] && Number.isFinite(z[i]));
  if (wetEdge.length === 0) return [];
  // Group edge cells that are next to each other along the edge.
  const visited = new Set<number>();
  const groups: number[][] = [];
  const set = new Set(wetEdge);
  for (const start of wetEdge) {
    if (visited.has(start)) continue;
    const group: number[] = [];
    const stack = [start];
    visited.add(start);
    while (stack.length) {
      const c = stack.pop() as number;
      group.push(c);
      const cx = c % nx;
      const cy = (c - cx) / nx;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const xx = cx + dx;
        const yy = cy + dy;
        if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
        const j = yy * nx + xx;
        if (set.has(j) && !visited.has(j)) {
          visited.add(j);
          stack.push(j);
        }
      }
    }
    groups.push(group);
  }
  const meanZ = (g: number[]) => g.reduce((a, i) => a + z[i], 0) / g.length;
  groups.sort((a, b) => meanZ(b) - meanZ(a));
  return groups[0];
}
