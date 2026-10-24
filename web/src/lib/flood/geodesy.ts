/**
 * WGS84 geodetic -> ECEF -> local east-north-up, matching Cesium's
 * Transforms.eastNorthUpToFixedFrame so meshes built here line up in the scene.
 * Plain maths so it can run in a Web Worker without Cesium.
 */

const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const RAD = Math.PI / 180;

export type Vec3 = [number, number, number];

export function toEcef(latDeg: number, lonDeg: number, h: number): Vec3 {
  const lat = latDeg * RAD;
  const lon = lonDeg * RAD;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  return [(n + h) * cosLat * Math.cos(lon), (n + h) * cosLat * Math.sin(lon), (n * (1 - E2) + h) * sinLat];
}

export interface EnuFrame {
  origin: Vec3;
  east: Vec3;
  north: Vec3;
  up: Vec3;
}

export function enuFrame(latDeg: number, lonDeg: number, h: number): EnuFrame {
  const lat = latDeg * RAD;
  const lon = lonDeg * RAD;
  const sLat = Math.sin(lat);
  const cLat = Math.cos(lat);
  const sLon = Math.sin(lon);
  const cLon = Math.cos(lon);
  return {
    origin: toEcef(latDeg, lonDeg, h),
    east: [-sLon, cLon, 0],
    north: [-sLat * cLon, -sLat * sLon, cLat],
    up: [cLat * cLon, cLat * sLon, sLat],
  };
}

export function toEnu(frame: EnuFrame, p: Vec3): Vec3 {
  const dx = p[0] - frame.origin[0];
  const dy = p[1] - frame.origin[1];
  const dz = p[2] - frame.origin[2];
  const dot = (v: Vec3) => v[0] * dx + v[1] * dy + v[2] * dz;
  return [dot(frame.east), dot(frame.north), dot(frame.up)];
}
