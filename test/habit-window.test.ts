import { describe, it, expect } from "vitest";
import { daysBetween, isWithinRepairWindow } from "../convex/habits/streak.js";

describe("daysBetween", () => {
  it("counts whole days in either direction, DST-safe", () => {
    expect(daysBetween("2026-06-10", "2026-06-10")).toBe(0);
    expect(daysBetween("2026-06-04", "2026-06-10")).toBe(6);
    expect(daysBetween("2026-06-10", "2026-06-04")).toBe(-6);
    // across a US DST spring-forward (2026-03-08) — still whole days
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
    // across month + year boundary
    expect(daysBetween("2025-12-30", "2026-01-02")).toBe(3);
  });
});

describe("isWithinRepairWindow (7-day trailing, today inclusive)", () => {
  const today = "2026-06-10";

  it("accepts today and the six prior days", () => {
    expect(isWithinRepairWindow("2026-06-10", today)).toBe(true); // today, delta 0
    expect(isWithinRepairWindow("2026-06-09", today)).toBe(true); // delta 1
    expect(isWithinRepairWindow("2026-06-04", today)).toBe(true); // delta 6, far edge
  });

  it("rejects the day just past the window", () => {
    expect(isWithinRepairWindow("2026-06-03", today)).toBe(false); // delta 7
    expect(isWithinRepairWindow("2026-05-10", today)).toBe(false);
  });

  it("rejects future dates", () => {
    expect(isWithinRepairWindow("2026-06-11", today)).toBe(false); // delta -1
  });

  it("handles a window that straddles a month boundary", () => {
    // today = Jun 2 -> window reaches back to May 27
    expect(isWithinRepairWindow("2026-05-27", "2026-06-02")).toBe(true); // delta 6
    expect(isWithinRepairWindow("2026-05-26", "2026-06-02")).toBe(false); // delta 7
  });
});
