import { describe, it, expect } from "vitest";
import { recentMiss, type DayEntry } from "../convex/habits/streak.js";

const e = (date: string, status: DayEntry["status"]): DayEntry => ({ date, status });

// recentMiss is the streak-break nudge source: the most recent missed day and
// the completed run it broke (unknown transparent). The express layer nudges
// only when that miss is YESTERDAY and the run was >= 3.
describe("recentMiss", () => {
  it("finds the latest miss and the streak it broke", () => {
    const log = [
      e("2026-06-05", "completed"),
      e("2026-06-06", "completed"),
      e("2026-06-07", "completed"),
      e("2026-06-08", "completed"), // a 4-day run...
      e("2026-06-09", "missed"), // ...broken here (yesterday, today=06-10)
    ];
    expect(recentMiss(log, "2026-06-10")).toEqual({ date: "2026-06-09", brokenStreak: 4 });
  });

  it("unknown gaps are transparent in the broken-run count", () => {
    const log = [
      e("2026-06-05", "completed"),
      // 06-06 unlogged (unknown)
      e("2026-06-07", "completed"),
      e("2026-06-08", "completed"), // run of 3 completed across an unknown gap
      e("2026-06-09", "missed"),
    ];
    expect(recentMiss(log, "2026-06-10")).toEqual({ date: "2026-06-09", brokenStreak: 3 });
  });

  it("a tiny broken run does not qualify (caller gates on >= 3)", () => {
    const log = [e("2026-06-08", "completed"), e("2026-06-09", "missed")];
    const r = recentMiss(log, "2026-06-10");
    expect(r).toEqual({ date: "2026-06-09", brokenStreak: 1 }); // < 3, caller skips
  });

  it("no miss -> null (no-data history never nudges)", () => {
    expect(recentMiss([e("2026-06-09", "completed")], "2026-06-10")).toBeNull();
    expect(recentMiss([], "2026-06-10")).toBeNull();
  });

  it("an older miss is reported with its date — caller's freshness gate rejects it", () => {
    const log = [
      e("2026-06-03", "completed"),
      e("2026-06-04", "completed"),
      e("2026-06-05", "completed"),
      e("2026-06-06", "missed"), // an old break, not yesterday
      e("2026-06-09", "completed"),
    ];
    // latest miss is 06-06, not yesterday (06-09) -> caller won't nudge.
    expect(recentMiss(log, "2026-06-10")).toEqual({ date: "2026-06-06", brokenStreak: 3 });
  });
});
