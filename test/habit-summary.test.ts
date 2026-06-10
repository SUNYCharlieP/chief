import { describe, it, expect } from "vitest";
import { computeStreak, type DayEntry } from "../convex/habits/streak.js";
import { summarizeHabit, daysInMonth } from "../convex/habits/summary.js";

const e = (date: string, status: DayEntry["status"]): DayEntry => ({ date, status });

describe("daysInMonth", () => {
  it("handles 30/31-day months and leap February", () => {
    expect(daysInMonth("2026-06-10")).toBe(30);
    expect(daysInMonth("2026-07-01")).toBe(31);
    expect(daysInMonth("2028-02-15")).toBe(29);
    expect(daysInMonth("2026-02-15")).toBe(28);
  });
});

describe("summarizeHabit", () => {
  it("counts doneThisMonth only within today's month, and streak agrees with the walker", () => {
    const entries = [
      e("2026-05-30", "completed"), // prior month — not in the count
      e("2026-05-31", "completed"),
      e("2026-06-01", "completed"),
      e("2026-06-02", "missed"),
      e("2026-06-03", "completed"),
      e("2026-06-04", "completed"),
      e("2026-06-05", "completed"),
    ];
    const s = summarizeHabit({ entries, today: "2026-06-05", goalPeriod: "daily" });
    expect(s.doneThisMonth).toBe(4); // 06-01, 03, 04, 05
    expect(s.daysThisMonth).toBe(30);
    expect(s.streak).toBe(3); // broken by 06-02
    expect(s.flameCount).toBe(1); // >= 3
  });

  it("returns only the trailing grid window, ascending", () => {
    const entries = [
      e("2026-01-01", "completed"), // far outside any reasonable window
      e("2026-06-08", "completed"),
      e("2026-06-09", "missed"),
      e("2026-06-10", "completed"),
    ];
    const s = summarizeHabit({ entries, today: "2026-06-10", goalPeriod: "daily", gridDays: 7 });
    expect(s.days.map((d) => d.date)).toEqual(["2026-06-08", "2026-06-09", "2026-06-10"]);
  });

  it("ignores future-dated rows in the month count and the grid window", () => {
    const entries = [e("2026-06-09", "completed"), e("2026-06-11", "completed")];
    const s = summarizeHabit({ entries, today: "2026-06-10", goalPeriod: "daily" });
    expect(s.doneThisMonth).toBe(1);
    expect(s.days.map((d) => d.date)).toEqual(["2026-06-09"]);
  });

  it("passes weekly goal config through to the walker", () => {
    // Two completions meet a weekly target of 2 -> the prior week is a streak week.
    const entries = [
      e("2026-06-01", "completed"), // Mon
      e("2026-06-03", "completed"), // Wed
    ];
    const s = summarizeHabit({
      entries,
      today: "2026-06-10",
      goalPeriod: "weekly",
      weeklyTarget: 2,
    });
    expect(s.streak).toBe(1); // completed week; current in-progress week is unknown (transparent)
  });
});

describe("refined missed-evidence invariant (JAR-3 ruling b)", () => {
  // A manual miss carries resolvedAt but NO value. The core never sees either:
  // DayEntry is {date, status} by construction, so a manual missed row is
  // structurally identical to an auto one at streak level — this pins that.
  it("a manual missed row (no value) breaks a streak exactly like an auto miss", () => {
    const entries = [
      e("2026-06-07", "completed"),
      e("2026-06-08", "missed"), // manual miss: evidence is resolvedAt upstream, no value
      e("2026-06-09", "completed"),
      e("2026-06-10", "completed"),
    ];
    const r = computeStreak(entries, { today: "2026-06-10" });
    expect(r.currentStreak).toBe(2);
    expect(r.longestStreak).toBe(2);
  });
});
