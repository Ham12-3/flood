/**
 * Connected flood fill for the "Custom +X m" scenario.
 *
 * Seeds are permanent-water cells. Each seed's water level is its own ground height
 * plus `rise`. Water spreads to 8-neighbours only while the neighbour's ground is below
 * the level being carried, so a hollow that is not connected to a seed by low ground
 * stays dry.
 *
 * Each cell takes the level of the nearest seed that can reach it (shortest 8-neighbour
 * path through cells below that level). This is the "height above nearest drainage"
 * idea with connectivity: every reach of a sloping river rises by `rise` above its own
 * surface, instead of water from upstream spilling over everything downhill.
 *
 * Runs in a Web Worker. O(n log n) in the number of flooded cells.
 */

const SQRT2 = Math.SQRT2;
const NEIGHBOURS = [
  [-1, -1, SQRT2],
  [0, -1, 1],
  [1, -1, SQRT2],
  [-1, 0, 1],
  [1, 0, 1],
  [-1, 1, SQRT2],
  [0, 1, 1],
  [1, 1, SQRT2],
] as const;

/** Binary min-heap of (key, index) pairs in flat typed arrays. */
class MinHeap {
  private keys: Float64Array;
  private items: Int32Array;
  size = 0;

  constructor(capacity: number) {
    this.keys = new Float64Array(Math.max(16, capacity));
    this.items = new Int32Array(Math.max(16, capacity));
  }

  push(key: number, item: number): void {
    if (this.size === this.keys.length) this.grow();
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.keys[i] = this.keys[parent];
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.keys[i] = key;
    this.items[i] = item;
  }

  /** Removes the top entry and returns its item; read `topKey` first. */
  pop(): number {
    const top = this.items[0];
    const lastKey = this.keys[--this.size];
    const lastItem = this.items[this.size];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && this.keys[child + 1] < this.keys[child]) child++;
      if (this.keys[child] >= lastKey) break;
      this.keys[i] = this.keys[child];
      this.items[i] = this.items[child];
      i = child;
    }
    this.keys[i] = lastKey;
    this.items[i] = lastItem;
    return top;
  }

  get topKey(): number {
    return this.keys[0];
  }

  private grow(): void {
    const keys = new Float64Array(this.keys.length * 2);
    keys.set(this.keys);
    const items = new Int32Array(this.items.length * 2);
    items.set(this.items);
    this.keys = keys;
    this.items = items;
  }
}

export interface FloodFillResult {
  /** Water depth in metres per cell (0 = dry). Row-major, row 0 north. */
  depth: Float32Array;
  seeds: number;
}

/**
 * @param ground heights in metres, NaN = no data (never flooded)
 * @param seedMask 1 where water starts (permanent water)
 * @param rise metres added to each seed's level
 */
export function connectedFlood(
  ground: Float32Array,
  seedMask: Uint8Array,
  nx: number,
  ny: number,
  rise: number,
): FloodFillResult {
  const n = nx * ny;
  if (ground.length !== n || seedMask.length !== n) throw new Error("Grid arrays do not match nx*ny");
  const level = new Float64Array(n).fill(Number.NaN);
  const dist = new Float64Array(n).fill(Infinity);
  const heap = new MinHeap(1024);
  let seeds = 0;
  for (let i = 0; i < n; i++) {
    const z = ground[i];
    if (seedMask[i] && Number.isFinite(z)) {
      level[i] = z + rise;
      dist[i] = 0;
      heap.push(0, i);
      seeds++;
    }
  }

  // Multi-source Dijkstra: the first (nearest) seed front to reach a cell claims it.
  while (heap.size > 0) {
    const d = heap.topKey;
    const i = heap.pop();
    if (d > dist[i]) continue; // stale entry
    const l = level[i];
    const x = i % nx;
    const y = (i - x) / nx;
    for (const [dx, dy, step] of NEIGHBOURS) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
      const j = yy * nx + xx;
      const z = ground[j];
      const nd = d + step;
      if (!Number.isFinite(z) || z >= l || nd >= dist[j]) continue;
      dist[j] = nd;
      level[j] = l;
      heap.push(nd, j);
    }
  }

  const depth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = level[i] - ground[i];
    depth[i] = d > 0 && Number.isFinite(d) ? d : 0;
  }
  return { depth, seeds };
}
