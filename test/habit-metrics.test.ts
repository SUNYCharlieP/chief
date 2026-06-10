import { describe, it, expect } from "vitest";
import { resolveMetricRow } from "../convex/habits/streak.js";

// resolveMetricRow is the pure heart of the metrics resolver: given an auto
// habit's goal and a day's reading, what row (if any) to write. The DB-level
// behaviors (idempotent re-post, absent leaves prior row, late day heals a
// gap, window edges) are integration concerns proven by curl; this pins the
// per-(habit,day) decision.
describe("resolveMetricRow", () => {
  it("met goal -> completed, carrying the value (gte)", () => {
    // steps >= 8000
    expect(resolveMetricRow({ comparator: "gte", threshold: 8000, value: 9200 }))
      .toEqual({ status: "completed", value: 9200 });
  });

  it("met goal -> completed (lte, e.g. wake_time <= 420)", () => {
    expect(resolveMetricRow({ comparator: "lte", threshold: 420, value: 402 }))
      .toEqual({ status: "completed", value: 402 });
  });

  it("boundary is inclusive -> completed", () => {
    expect(resolveMetricRow({ comparator: "lte", threshold: 420, value: 420 }))
      .toEqual({ status: "completed", value: 420 });
    expect(resolveMetricRow({ comparator: "gte", threshold: 8000, value: 8000 }))
      .toEqual({ status: "completed", value: 8000 });
  });

  it("unmet goal -> missed, still carrying the value (evidence)", () => {
    expect(resolveMetricRow({ comparator: "gte", threshold: 8000, value: 5100 }))
      .toEqual({ status: "missed", value: 5100 });
    expect(resolveMetricRow({ comparator: "lte", threshold: 420, value: 465 }))
      .toEqual({ status: "missed", value: 465 });
  });

  it("absent reading -> null (write NOTHING; the day stays unknown)", () => {
    expect(resolveMetricRow({ comparator: "gte", threshold: 8000, value: undefined })).toBeNull();
    expect(resolveMetricRow({ comparator: "gte", threshold: 8000, value: null })).toBeNull();
  });

  it("never returns unknown — a present reading always resolves to a row", () => {
    const row = resolveMetricRow({ comparator: "gte", threshold: 1, value: 0 });
    expect(row).not.toBeNull();
    expect(row?.status).toBe("missed"); // 0 < 1, but it's evidence, not absence
  });
});
