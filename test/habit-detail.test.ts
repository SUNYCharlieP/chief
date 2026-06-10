import { describe, it, expect } from "vitest";
import { habitDetail } from "../convex/habits/summary.js";
import type { DayEntry } from "../convex/habits/streak.js";

const e = (date: string, status: DayEntry["status"]): DayEntry => ({ date, status });

// Anchor: 2026-06-10 is a Wednesday (dow 3). Verified: Jan 1 2026 = Thu.
const TODAY = "2026-06-10";

describe("habitDetail — lifetime vs window split", () => {
  it("completions and bestStreak span ALL entries; grid is the window slice", () => {
    const entries = [
      e("2026-01-05", "completed"),
      e("2026-01-06", "completed"),
      e("2026-01-07", "completed"), // a 3-run in January
      e("2026-03-15", "missed"), // a real miss — without it, unknown gaps would
      e("2026-06-08", "completed"), //   fuse the two runs into one (unknown is transparent)
      e("2026-06-09", "completed"),
      e("2026-06-10", "completed"),
    ];
    const d = habitDetail({ entries, today: TODAY, goalPeriod: "daily", window: 7 });
    expect(d.completions).toBe(6); // all-time, the miss isn't a completion
    expect(d.bestStreak).toBe(3); // longest all-time run (Jan or Jun, both 3)
    expect(d.currentStreak).toBe(3); // 06-08..06-10, broken backward by the Mar miss
    // grid only carries the 7-day window (06-04..06-10), so the Jan rows drop
    expect(d.grid.map((g) => g.date)).toEqual(["2026-06-08", "2026-06-09", "2026-06-10"]);
  });
});

describe("habitDetail — weekday aggregation", () => {
  it("every weekday's occurrences sum to the window length", () => {
    const d = habitDetail({ entries: [], today: TODAY, goalPeriod: "daily", window: 14 });
    const total = d.weekday.reduce((s, w) => s + w.days, 0);
    expect(total).toBe(14);
    expect(d.weekday).toHaveLength(7);
  });

  it("rate counts every weekday occurrence as denominator (unlogged lowers it)", () => {
    // 14-day window 2026-05-28..06-10. Two Wednesdays: 06-03, 06-10.
    const entries = [
      e("2026-06-03", "completed"),
      e("2026-06-10", "completed"), // both Wednesdays done -> Wed 2/2
      e("2026-06-06", "missed"), // one Saturday missed; the other Sat unlogged
    ];
    const d = habitDetail({ entries, today: TODAY, goalPeriod: "daily", window: 14 });
    const wed = d.weekday[3];
    expect(wed.days).toBe(2);
    expect(wed.completed).toBe(2);
    expect(wed.rate).toBeCloseTo(1.0);
    const sat = d.weekday[6];
    expect(sat.days).toBe(2); // 05-30 and 06-06
    expect(sat.completed).toBe(0); // missed + unlogged both count against
    expect(sat.rate).toBeCloseTo(0);
  });

  it("best is the highest-rate weekday, worst the lowest, both among days with data", () => {
    const entries = [e("2026-06-03", "completed"), e("2026-06-10", "completed")];
    const d = habitDetail({ entries, today: TODAY, goalPeriod: "daily", window: 14 });
    expect(d.best?.dow).toBe(3); // Wednesday, 2/2 = 1.0
    expect(d.best?.rate).toBeCloseTo(1.0);
    expect(d.worst?.rate).toBeCloseTo(0); // some weekday with 0 completions
  });

  it("a window with zero entries yields null best/worst only if no weekday occurs", () => {
    // 14d window always has all 7 weekdays, so best/worst are non-null at rate 0.
    const d = habitDetail({ entries: [], today: TODAY, goalPeriod: "daily", window: 14 });
    expect(d.best).not.toBeNull();
    expect(d.best?.rate).toBe(0);
  });
});

describe("habitDetail — boundary windows", () => {
  it("a window crossing the year boundary still sums occurrences to its length", () => {
    const d = habitDetail({ entries: [], today: "2026-01-03", goalPeriod: "daily", window: 30 });
    const total = d.weekday.reduce((s, w) => s + w.days, 0);
    expect(total).toBe(30); // spans 2025-12-05..2026-01-03 without drift
  });
});
