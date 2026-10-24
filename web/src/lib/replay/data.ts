/**
 * Storm replay data from the API: the grid, hourly depth frames and the buildings and
 * roads, decoded from the binary files described in api/floodscope/replay/features.py.
 */

export interface ReplayGrid {
  west: number;
  south: number;
  east: number;
  north: number;
  nx: number;
  ny: number;
  dxDeg: number;
  dyDeg: number;
}

export interface ReplayFeatures {
  buildingOffsets: Uint32Array; // vertex offsets, length = buildings + 1
  buildingCells: Uint32Array; // cell of each building's centre
  roadOffsets: Uint32Array; // vertex offsets, length = roads + 1
  buildingCoords: Uint16Array; // quantised x, y pairs
  roadCoords: Uint16Array; // quantised x, y pairs
  roadClasses: Uint8Array;
}

/** Depths in the frames are whole centimetres. */
export const SHOW_CM = 5; // water drawn from 5 cm
export const WET_CM = 10; // water at the door; roads worth avoiding
export const DEEP_CM = 30; // most cars stop
export const MAIN_ROAD_MAX_CLASS = 4; // motorway .. tertiary (see ROAD_CLASSES on the API)
const Q = 65535;

export function decodeFeatures(buf: ArrayBuffer): ReplayFeatures {
  if (buf.byteLength < 16) throw new Error("Buildings and roads file is too short");
  const [nb, nbv, nr, nrv] = new Uint32Array(buf, 0, 4);
  let at = 16;
  const u32 = (n: number) => {
    const a = new Uint32Array(buf, at, n);
    at += n * 4;
    return a;
  };
  const u16 = (n: number) => {
    const a = new Uint16Array(buf, at, n);
    at += n * 2;
    return a;
  };
  const buildingOffsets = u32(nb + 1);
  const buildingCells = u32(nb);
  const roadOffsets = u32(nr + 1);
  const buildingCoords = u16(2 * nbv);
  const roadCoords = u16(2 * nrv);
  const roadClasses = new Uint8Array(buf, at, nr);
  if (at + nr !== buf.byteLength) throw new Error("Buildings and roads file has the wrong length");
  return { buildingOffsets, buildingCells, roadOffsets, buildingCoords, roadCoords, roadClasses };
}

export function decodeFrames(buf: ArrayBuffer, hours: number, grid: ReplayGrid): Uint16Array {
  const expected = hours * grid.nx * grid.ny;
  if (buf.byteLength !== expected * 2) {
    throw new Error(`Depth frames have ${buf.byteLength / 2} values, expected ${expected}`);
  }
  return new Uint16Array(buf);
}

/** Depths (cm) for one hour, as a view into the frames. */
export function frame(frames: Uint16Array, grid: ReplayGrid, hour: number): Uint16Array {
  const n = grid.nx * grid.ny;
  return frames.subarray(hour * n, (hour + 1) * n);
}

export function cellAt(grid: ReplayGrid, lon: number, lat: number): number {
  const col = Math.floor((lon - grid.west) / grid.dxDeg);
  const row = Math.floor((grid.north - lat) / grid.dyDeg);
  if (col < 0 || row < 0 || col >= grid.nx || row >= grid.ny) return -1;
  return row * grid.nx + col;
}

export function qLon(grid: ReplayGrid, q: number): number {
  return grid.west + (q / Q) * (grid.east - grid.west);
}

export function qLat(grid: ReplayGrid, q: number): number {
  return grid.north - (q / Q) * (grid.north - grid.south);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-06-30T17:00" (local wall-clock time from the API) -> "Tue 30 Jun, 17:00". */
export function formatLocalHour(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d, h, mi] = m;
  const weekday = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).getUTCDay();
  return `${DAYS[weekday]} ${Number(d)} ${MONTHS[Number(mo) - 1]}, ${h}:${mi}`;
}
