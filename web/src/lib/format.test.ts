import { describe, expect, it } from "vitest";
import { annualChance, formatDay, formatLatLon, timeAgo } from "./format";

describe("formatLatLon", () => {
  it("uses hemisphere letters, not signs", () => {
    expect(formatLatLon(51.5005, -0.1218)).toBe("51.5005° N, 0.1218° W");
    expect(formatLatLon(-33.9, 151.2, 1)).toBe("33.9° S, 151.2° E");
  });
});

describe("annualChance", () => {
  it.each([
    [10, "10%"],
    [20, "5%"],
    [50, "2%"],
    [75, "1.3%"],
    [100, "1%"],
    [200, "0.5%"],
    [500, "0.2%"],
  ])("1 in %i years is %s a year", (rp, expected) => {
    expect(annualChance(rp)).toBe(expected);
  });
});

describe("formatDay", () => {
  it("treats API dates as UTC calendar days", () => {
    expect(formatDay("2026-10-21")).toBe("21 Oct");
    expect(formatDay("2026-01-01")).toBe("1 Jan");
  });
});

describe("timeAgo", () => {
  const now = new Date("2026-10-21T18:00:00Z");
  it.each([
    ["2026-10-21T17:59:45Z", "just now"],
    ["2026-10-21T17:45:00Z", "15 min ago"],
    ["2026-10-21T15:00:00Z", "3 h ago"],
    ["2026-10-18T18:00:00Z", "3 days ago"],
  ])("%s -> %s", (iso, expected) => {
    expect(timeAgo(iso, now)).toBe(expected);
  });
});
