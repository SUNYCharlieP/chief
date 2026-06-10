import { describe, it, expect } from "vitest";
import { sortHabits } from "../convex/habits/summary.js";
import { resolveMetricRow, HABIT_METRICS } from "../convex/habits/streak.js";

const h = (name: string, createdAt: number, sortOrder?: number | null) => ({
  name,
  createdAt,
  sortOrder,
});

describe("sortHabits (tracker order)", () => {
  it("orders by explicit sortOrder ascending", () => {
    const out = sortHabits([h("c", 1, 2), h("a", 2, 0), h("b", 3, 1)]);
    expect(out.map((x) => x.name)).toEqual(["a", "b", "c"]);
  });

  it("places unordered habits (no sortOrder) after ordered ones, by createdAt", () => {
    const out = sortHabits([
      h("new2", 200, null),
      h("placed1", 50, 1),
      h("placed0", 60, 0),
      h("new1", 100, undefined),
    ]);
    expect(out.map((x) => x.name)).toEqual(["placed0", "placed1", "new1", "new2"]);
  });

  it("is stable for all-unordered: pure createdAt order", () => {
    const out = sortHabits([h("c", 30), h("a", 10), h("b", 20)]);
    expect(out.map((x) => x.name)).toEqual(["a", "b", "c"]);
  });
});

describe("water metric (sixth auto metric)", () => {
  it("is in the closed set with a gte goal in mL", () => {
    expect(HABIT_METRICS.water).toEqual({ unit: "mL", comparator: "gte", label: "Water" });
  });

  it("resolves like any gte metric (stored/compared in mL)", () => {
    // goal 1893 mL (~64 oz)
    expect(resolveMetricRow({ comparator: "gte", threshold: 1893, value: 2000 }))
      .toEqual({ status: "completed", value: 2000 });
    expect(resolveMetricRow({ comparator: "gte", threshold: 1893, value: 1200 }))
      .toEqual({ status: "missed", value: 1200 });
  });
});
