/**
 * WGSL for the local-inertial shallow-water scheme. Same maths as swe.ts (the tested CPU
 * reference): face fluxes, free outflow at the edges, continuity with rain and inflow.
 *
 * Differences forced by the GPU:
 * - No-data ground is uploaded as NO_DATA_Z (a high wall) because WGSL implementations
 *   may assume floats are never NaN.
 * - The time step is chosen on the GPU: `update` records the deepest cell with an atomic
 *   max (positive f32 bit patterns order like u32), then `clockStep` turns it into the
 *   next CFL-limited dt. No CPU round trip per step.
 */

export const NO_DATA_Z = 1.0e6;
export const WORKGROUP = 64;

export const SWE_WGSL = /* wgsl */ `
struct Params {
  nx: u32,
  ny: u32,
  dx: f32,
  dy: f32,
  manning: f32,
  rain: f32,      // m/s
  alpha: f32,
  maxDt: f32,
};

struct Clock {
  dt: f32,
  time: f32,
};

const G: f32 = 9.81;
const DRY: f32 = 1.0e-3;
const WALL: f32 = ${NO_DATA_Z.toExponential()};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> z: array<f32>;
@group(0) @binding(2) var<storage, read_write> h: array<f32>;
@group(0) @binding(3) var<storage, read_write> qx: array<f32>;
@group(0) @binding(4) var<storage, read_write> qy: array<f32>;
@group(0) @binding(5) var<storage, read> inflow: array<f32>;   // m^3/s per cell
@group(0) @binding(6) var<storage, read_write> clock: Clock;
@group(0) @binding(7) var<storage, read_write> hmaxBits: atomic<u32>;

fn faceFlux(q: f32, etaA: f32, etaB: f32, zA: f32, zB: f32, d: f32, dt: f32) -> f32 {
  if (zA >= WALL || zB >= WALL) { return 0.0; }
  let hf = max(etaA, etaB) - max(zA, zB);
  if (hf <= DRY) { return 0.0; }
  let slope = (etaB - etaA) / d;
  return (q - G * hf * dt * slope) / (1.0 + G * dt * P.manning * P.manning * abs(q) / pow(hf, 7.0 / 3.0));
}

fn edgeOutflow(depth: f32) -> f32 {
  if (depth <= DRY) { return 0.0; }
  return depth * sqrt(G * depth);
}

@compute @workgroup_size(${WORKGROUP})
fn fluxX(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = P.nx + 1u;
  let f = gid.x;
  if (f >= w * P.ny) { return; }
  let y = f / w;
  let x = f % w;
  if (x == 0u) { qx[f] = -edgeOutflow(h[y * P.nx]); return; }
  if (x == P.nx) { qx[f] = edgeOutflow(h[y * P.nx + P.nx - 1u]); return; }
  let a = y * P.nx + x - 1u;
  let b = a + 1u;
  qx[f] = faceFlux(qx[f], z[a] + h[a], z[b] + h[b], z[a], z[b], P.dx, clock.dt);
}

@compute @workgroup_size(${WORKGROUP})
fn fluxY(@builtin(global_invocation_id) gid: vec3<u32>) {
  let f = gid.x;
  if (f >= P.nx * (P.ny + 1u)) { return; }
  let y = f / P.nx;
  let x = f % P.nx;
  if (y == 0u) { qy[f] = -edgeOutflow(h[x]); return; }
  if (y == P.ny) { qy[f] = edgeOutflow(h[(P.ny - 1u) * P.nx + x]); return; }
  let a = (y - 1u) * P.nx + x;
  let b = a + P.nx;
  qy[f] = faceFlux(qy[f], z[a] + h[a], z[b] + h[b], z[a], z[b], P.dy, clock.dt);
}

@compute @workgroup_size(${WORKGROUP})
fn update(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.nx * P.ny) { return; }
  if (z[i] >= WALL) { h[i] = 0.0; return; }
  let y = i / P.nx;
  let x = i % P.nx;
  let dt = clock.dt;
  let west = qx[y * (P.nx + 1u) + x];
  let east = qx[y * (P.nx + 1u) + x + 1u];
  let north = qy[y * P.nx + x];
  let south = qy[(y + 1u) * P.nx + x];
  let dh = dt * ((west - east) / P.dx + (north - south) / P.dy)
         + P.rain * dt
         + inflow[i] * dt / (P.dx * P.dy);
  let next = max(0.0, h[i] + dh);
  h[i] = next;
  atomicMax(&hmaxBits, bitcast<u32>(next));
}

@compute @workgroup_size(1)
fn clockStep() {
  clock.time = clock.time + clock.dt;
  let hm = bitcast<f32>(atomicLoad(&hmaxBits));
  var dt = P.maxDt;
  if (hm > DRY) {
    dt = min(P.maxDt, P.alpha * min(P.dx, P.dy) / sqrt(G * hm));
  }
  clock.dt = dt;
  atomicStore(&hmaxBits, 0u);
}
`;
