export type UnitSystem = "metric" | "imperial";

export const FEET_PER_METRE = 3.280839895;
export const CUBIC_FEET_PER_CUBIC_METRE = 35.3146667;

function fmt(value: number, digits: number): string {
  return value.toLocaleString("en-GB", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Lengths: elevation, water depth, gauge levels. */
export function formatLength(metres: number, units: UnitSystem, digits = 1): string {
  return units === "metric"
    ? `${fmt(metres, digits)} m`
    : `${fmt(metres * FEET_PER_METRE, digits)} ft`;
}

/** Small depths: whole centimetres, or inches in imperial (10 cm -> "4 in"). */
export function formatShortLength(metres: number, units: UnitSystem): string {
  return units === "metric" ? `${Math.round(metres * 100)} cm` : `${Math.round(metres * FEET_PER_METRE * 12)} in`;
}

export function lengthValue(metres: number, units: UnitSystem): number {
  return units === "metric" ? metres : metres * FEET_PER_METRE;
}

export function lengthUnit(units: UnitSystem): string {
  return units === "metric" ? "m" : "ft";
}

/** River discharge. Large rivers get no decimals, small streams keep one or two. */
export function formatDischarge(m3s: number, units: UnitSystem): string {
  const value = dischargeValue(m3s, units);
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  return `${fmt(value, digits)} ${dischargeUnit(units)}`;
}

export function dischargeValue(m3s: number, units: UnitSystem): number {
  return units === "metric" ? m3s : m3s * CUBIC_FEET_PER_CUBIC_METRE;
}

export function dischargeUnit(units: UnitSystem): string {
  return units === "metric" ? "m³/s" : "ft³/s";
}

/** Gauge units from the Environment Agency ("m", "mAOD", "m3/s", "l/s", ...). */
export function formatGaugeValue(value: number, unit: string | null | undefined, units: UnitSystem): string {
  const u = (unit ?? "").trim();
  if (units === "imperial" && /^m(ASD|AOD|BDAT)?$/.test(u)) {
    const suffix = u === "m" ? "" : ` ${u.slice(1)}`;
    return `${fmt(value * FEET_PER_METRE, 2)} ft${suffix}`;
  }
  if (units === "imperial" && u === "m3/s") {
    return formatDischarge(value, units);
  }
  const pretty = u === "m3/s" ? "m³/s" : u;
  return `${fmt(value, u === "m3/s" ? 1 : 2)}${pretty ? ` ${pretty}` : ""}`;
}
