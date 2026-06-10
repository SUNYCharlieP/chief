import { describe, it, expect } from "vitest";
import {
  computeStreak,
  resolveAutoStatus,
  clockToMinutes,
  HABIT_METRICS,
  type DayEntry,
} from "../convex/habits/streak.js";

// Helper: terse entry builder.
const e = (date: string, status: DayEntry["status"]): DayEntry => ({ date, status });

describe("computeStreak — daily", () => {
  it("counts consecutive completed days (completed-increments)", () => {
    const log = [
      e("2026-06-02", "completed"),
      e("2026-06-03", "completed"),
      e("2026-06-04", "completed"),
      e("2026-06-05", "completed"),
      e("2026-06-06", "completed"),
    ];
    const r = computeStreak(log, { today: "2026-06-06" });
    expect(r.currentStreak).toBe(5);
    expect(r.longestStreak).toBe(5);
    expect(r.flameCount).toBe(1); // >=3, <7
  });

  it("treats unknown as transparent, and a not-yet-synced today holds the streak", () => {
    // 06-06 unknown (Oura hasn't synced); today 06-08 has no row at all.
    const log = [
      e("2026-06-05", "completed"),
      e("2026-06-06", "unknown"),
      e("2026-06-07", "completed"),
    ];
    const r = computeStreak(log, { today: "2026-06-08" });
    // back from 06-08(absent->unknown, skip), 06-07 completed(1),
    // 06-06 unknown(skip), 06-05 completed(2) => 2. Unknowns neither break
    // nor extend; today being unsynced does NOT reset to 0.
    expect(r.currentStreak).toBe(2);
    expect(r.longestStreak).toBe(2);
    expect(r.flameCount).toBe(0);
  });

  it("breaks the streak on a missed day (missed-breaks-streak)", () => {
    const log = [
      e("2026-06-01", "completed"),
      e("2026-06-02", "completed"),
      e("2026-06-03", "missed"),
      e("2026-06-04", "completed"),
      e("2026-06-05", "completed"),
      e("2026-06-06", "completed"),
    ];
    const r = computeStreak(log, { today: "2026-06-06" });
    expect(r.currentStreak).toBe(3); // only the run after the miss
    expect(r.longestStreak).toBe(3);
    expect(r.flameCount).toBe(1);
  });

  it("treats a gap with no rows as unknown, not a miss (no-row-treated-as-unknown)", () => {
    // 06-02..06-05 have no rows. Absence must be transparent, never a break.
    const log = [e("2026-06-01", "completed"), e("2026-06-06", "completed")];
    const r = computeStreak(log, { today: "2026-06-06" });
    expect(r.currentStreak).toBe(2);
    expect(r.longestStreak).toBe(2);
  });

  it("does not count the in-progress completed day twice or miss a future-less today", () => {
    const log = [e("2026-06-07", "completed"), e("2026-06-08", "completed")];
    const r = computeStreak(log, { today: "2026-06-08" });
    expect(r.currentStreak).toBe(2);
  });
});

describe("computeStreak — weekly granularity", () => {
  it("streaks in weeks; unknown weeks are transparent, only impossible weeks miss", () => {
    // Monday-anchored weeks (2026-06-08 is a Monday). weeklyTarget = 2.
    const log = [
      // W1 starts 2026-05-04: 2 completed -> week completed
      e("2026-05-04", "completed"),
      e("2026-05-05", "completed"),
      // W2 starts 2026-05-11: 2 completed -> week completed
      e("2026-05-11", "completed"),
      e("2026-05-12", "completed"),
      // W3 starts 2026-05-18: all 7 days missed -> impossible -> week missed
      e("2026-05-18", "missed"),
      e("2026-05-19", "missed"),
      e("2026-05-20", "missed"),
      e("2026-05-21", "missed"),
      e("2026-05-22", "missed"),
      e("2026-05-23", "missed"),
      e("2026-05-24", "missed"),
      // W4 starts 2026-05-25: 2 completed -> week completed
      e("2026-05-25", "completed"),
      e("2026-05-26", "completed"),
      // W5 starts 2026-06-01: 2 completed -> week completed
      e("2026-06-01", "completed"),
      e("2026-06-02", "completed"),
      // Current week starts 2026-06-08: only 1 completed so far (<2) ->
      // in-progress -> unknown (transparent), never a miss.
      e("2026-06-08", "completed"),
    ];
    const r = computeStreak(log, {
      today: "2026-06-08",
      goalPeriod: "weekly",
      weeklyTarget: 2,
    });
    // Weeks: [completed, completed, missed, completed, completed, unknown].
    // Backward: unknown(skip), W5 completed(1), W4 completed(2), W3 missed -> stop.
    expect(r.currentStreak).toBe(2);
    expect(r.longestStreak).toBe(2);
    expect(r.flameCount).toBe(0); // 2 weeks < 3 threshold
  });

  it("does not mark a past week missed when unknown days could have met target", () => {
    // weeklyTarget 3, one past week with 2 completed + 5 absent(unknown):
    // best case 7 >= 3, so the week is unknown (transparent), not a miss.
    const log = [e("2026-06-01", "completed"), e("2026-06-02", "completed")];
    const r = computeStreak(log, {
      today: "2026-06-08",
      goalPeriod: "weekly",
      weeklyTarget: 3,
    });
    expect(r.currentStreak).toBe(0); // no completed week, but nothing broke
    expect(r.longestStreak).toBe(0);
  });
});

describe("resolveAutoStatus + wake_time encoding", () => {
  it("returns unknown when the metric has not synced (null/undefined value)", () => {
    expect(
      resolveAutoStatus({ comparator: "lte", threshold: 420, value: undefined }),
    ).toBe("unknown");
    expect(
      resolveAutoStatus({ comparator: "gte", threshold: 420, value: null }),
    ).toBe("unknown");
  });

  it("wake_time: 'at or before 07:00' is inclusive and does not invert", () => {
    const target = clockToMinutes("07:00"); // 420 minutes past midnight
    const wake = (hhmm: string) =>
      resolveAutoStatus({ comparator: "lte", threshold: target, value: clockToMinutes(hhmm) });

    expect(wake("05:30")).toBe("completed"); // earlier == smaller number == met
    expect(wake("06:59")).toBe("completed");
    expect(wake("07:00")).toBe("completed"); // boundary is inclusive
    expect(wake("07:01")).toBe("missed");
    expect(wake("07:45")).toBe("missed");
  });

  it("gte metrics (sleep, steps) read the other direction", () => {
    // sleep_duration goal: >= 7h (420 min)
    expect(resolveAutoStatus({ comparator: "gte", threshold: 420, value: 480 })).toBe(
      "completed",
    );
    expect(resolveAutoStatus({ comparator: "gte", threshold: 420, value: 419 })).toBe(
      "missed",
    );
  });

  it("the metric set is closed; water is the one sanctioned intake metric, weight/calories still excluded", () => {
    const keys = Object.keys(HABIT_METRICS);
    expect(keys.sort()).toEqual(
      ["mindful_minutes", "resting_hr", "sleep_duration", "steps", "wake_time", "water"].sort(),
    );
    // water (dietaryWater) is a deliberate, sanctioned intake metric (JAR-17).
    // The guardrail still holds for the metrics the original design excluded:
    // no weight, no calories, no generic intake.
    expect(keys).not.toContain("body_weight");
    expect(keys).not.toContain("calories");
    expect(keys).not.toContain("intake");
    // wake_time / resting_hr are lte (lower is better); the rest are gte.
    expect(HABIT_METRICS.wake_time.comparator).toBe("lte");
    expect(HABIT_METRICS.resting_hr.comparator).toBe("lte");
    expect(HABIT_METRICS.sleep_duration.comparator).toBe("gte");
  });
});
