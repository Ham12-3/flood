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
  const url = `${API_BASE_URL}${path}?${new URLSearchParams(params).toString()}`;
  let resp: Response;
  try {
    resp = await fetch(url, { signal });
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

export function geocode(query: string, signal?: AbortSignal): Promise<GeocodeResponse> {
  return getJson<GeocodeResponse>("/api/geocode", { q: query }, signal);
}
