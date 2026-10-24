import type { components } from "./api-types";

export type PointResponse = components["schemas"]["PointResponse"];
export type Elevation = components["schemas"]["Elevation"];
export type RiverDischarge = components["schemas"]["RiverDischarge"];
export type DischargeDay = components["schemas"]["DischargeDay"];
export type FloodHazard = components["schemas"]["FloodHazard"];
export type HazardDepth = components["schemas"]["HazardDepth"];
export type UKLive = components["schemas"]["UKLive"];
export type EAStation = components["schemas"]["EAStation"];
export type EAWarning = components["schemas"]["EAWarning"];
export type SourceInfo = components["schemas"]["SourceInfo"];
export type Place = components["schemas"]["Place"];
export type GeocodeResponse = components["schemas"]["GeocodeResponse"];
export type SceneResponse = components["schemas"]["SceneResponse"];
export type ForecastScenario = components["schemas"]["ForecastScenario"];
export type ReturnPeriodFitInfo = components["schemas"]["ReturnPeriodFitInfo"];
export type GroundResponse = components["schemas"]["GroundResponse"];
export type SoilLayer = components["schemas"]["SoilLayer"];
export type GroundwaterStation = components["schemas"]["GroundwaterStation"];
export type PredictResponse = components["schemas"]["PredictResponse"];
export type PredictionDay = components["schemas"]["PredictionDay"];
export type ExplainResponse = components["schemas"]["ExplainResponse"];
export type GoogleFloodResponse = components["schemas"]["GoogleFloodResponse"];
export type SatelliteResponse = components["schemas"]["SatelliteResponse"];
export type SatelliteResult = components["schemas"]["SatelliteResult"];
export type ReplayResponse = components["schemas"]["ReplayResponse"];
export type ReplayHour = components["schemas"]["ReplayHour"];

export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000").replace(
  /\/$/,
  "",
);

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function getJson<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  return request<T>(`${API_BASE_URL}${path}?${new URLSearchParams(params).toString()}`, { signal });
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(url, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(`Could not reach the FloodScope API at ${API_BASE_URL}. Is the backend running?`, 0);
  }
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const body: unknown = await resp.json();
      if (body && typeof body === "object" && "detail" in body) detail = String(body.detail);
    } catch {
      // keep statusText
    }
    throw new ApiError(`API error ${resp.status}: ${detail}`, resp.status);
  }
  return (await resp.json()) as T;
}

export function fetchPoint(lat: number, lon: number, signal?: AbortSignal): Promise<PointResponse> {
  return getJson<PointResponse>("/api/point", { lat: lat.toFixed(5), lon: lon.toFixed(5) }, signal);
}

export function fetchScene(lat: number, lon: number, sizeKm: number, signal?: AbortSignal): Promise<SceneResponse> {
  return getJson<SceneResponse>(
    "/api/scene",
    { lat: lat.toFixed(5), lon: lon.toFixed(5), size_km: String(sizeKm) },
    signal,
  );
}

export function fetchGround(lat: number, lon: number, signal?: AbortSignal): Promise<GroundResponse> {
  return getJson<GroundResponse>("/api/ground", { lat: lat.toFixed(5), lon: lon.toFixed(5) }, signal);
}

export function fetchPrediction(lat: number, lon: number, signal?: AbortSignal): Promise<PredictResponse> {
  return getJson<PredictResponse>("/api/predict", { lat: lat.toFixed(5), lon: lon.toFixed(5) }, signal);
}

export function fetchGoogleFlood(lat: number, lon: number, signal?: AbortSignal): Promise<GoogleFloodResponse> {
  return getJson<GoogleFloodResponse>("/api/google-flood", { lat: lat.toFixed(5), lon: lon.toFixed(5) }, signal);
}

export function fetchSatellite(lat: number, lon: number, signal?: AbortSignal): Promise<SatelliteResponse> {
  return getJson<SatelliteResponse>("/api/satellite", { lat: lat.toFixed(5), lon: lon.toFixed(5) }, signal);
}

export function explainPoint(
  body: { lat: number; lon: number; question?: string; units: "metric" | "imperial" },
  signal?: AbortSignal,
): Promise<ExplainResponse> {
  return request<ExplainResponse>(`${API_BASE_URL}/api/explain`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export function geocode(query: string, signal?: AbortSignal): Promise<GeocodeResponse> {
  return getJson<GeocodeResponse>("/api/geocode", { q: query }, signal);
}

export interface ReplayRequest {
  lat: number;
  lon: number;
  start: string; // YYYY-MM-DD, local days
  end: string;
  sizeKm: number;
  rainScale: number;
  drainMmH: number;
}

/** Starts a storm replay if needed; returns its progress or the finished result. */
export function fetchReplay(r: ReplayRequest, signal?: AbortSignal): Promise<ReplayResponse> {
  return getJson<ReplayResponse>(
    "/api/replay",
    {
      lat: String(r.lat),
      lon: String(r.lon),
      start: r.start,
      end: r.end,
      size_km: String(r.sizeKm),
      rain_scale: String(r.rainScale),
      drain_mm_h: String(r.drainMmH),
    },
    signal,
  );
}

/** A binary file from the API (the server sends it gzip-encoded; fetch un-gzips it). */
export async function fetchBinary(path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  let resp: Response;
  try {
    resp = await fetch(`${API_BASE_URL}${path}`, { signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(`Could not reach the FloodScope API at ${API_BASE_URL}. Is the backend running?`, 0);
  }
  if (!resp.ok) throw new ApiError(`API error ${resp.status}: ${resp.statusText}`, resp.status);
  return resp.arrayBuffer();
}
