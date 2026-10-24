/**
 * The JRC permanent-water mask is on a 90 m grid. Sampled onto 30 m terrain, its edge
 * cells often land on riverbanks, and the DEM there (a surface model) can be trees or
 * rooftops many metres above the water. Used as-is, those cells would seed "+1 m"
 * floods from rooftop height and draw water floating over banks.
 *
 * Keep a mask cell only if its ground is within `toleranceM` of the lowest masked
 * ground within `radius` cells (about one JRC pixel), i.e. it is at the water surface.
 * The DEM flattens rivers and lakes, so true water cells sit at that minimum.
 */
export function refineWaterMask(
  ground: Float32Array,
  mask: Uint8Array,
  nx: number,
  ny: number,
  radius = 3,
  toleranceM = 0.5,
): Uint8Array {
  const n = nx * ny;
  const masked = new Float32Array(n);
  for (let i = 0; i < n; i++) masked[i] = mask[i] && Number.isFinite(ground[i]) ? ground[i] : Infinity;

  // Separable min filter: rows, then columns.
  const rowMin = new Float32Array(n);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      let m = Infinity;
      for (let k = Math.max(0, x - radius); k <= Math.min(nx - 1, x + radius); k++) m = Math.min(m, masked[y * nx + k]);
      rowMin[y * nx + x] = m;
    }
  }
  const out = new Uint8Array(n);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (masked[i] === Infinity) continue;
      let m = Infinity;
      for (let k = Math.max(0, y - radius); k <= Math.min(ny - 1, y + radius); k++) m = Math.min(m, rowMin[k * nx + x]);
      if (masked[i] <= m + toleranceM) out[i] = 1;
    }
  }
  return out;
}
