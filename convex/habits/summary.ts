// Habit tracker — Phase 3 (JAR-3) pure summary assembly. Like streak.ts, this
// file has NO Convex imports: it turns a habit's log entries into the shape
// the tracker screen renders (streak + flames, month counts, grid window), so
// the math is vitest-able without a deployment. functions.ts wires it to the
// database.

import { computeStreak, type DayEntry, type GoalPeriod } from "./streak";

export interface HabitSummaryStats {
  streak: number;
  flameCount: number;
  doneThisMonth: number;
  daysThisMonth: number;
  days: DayEntry[]; // trailing grid window, ascending
}

const MS_PER_DAY = 86_400_000;

// Same UTC-noon day arithmetic as streak.ts (private there): DST-safe whole-day
// math over zero-padded "YYYY-MM-DD" keys, where lexical order == chronological.
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12) + n * MS_PER_DAY);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}

// Day count of the month containing `today` ("day 0 of next month" idiom).
export function daysInMonth(today: string): number {
  const [y, m] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function summarizeHabit(opts: {
  entries: DayEntry[]; // ascending by date
  today: string;
  goalPeriod: GoalPeriod;
  weeklyTarget?: number;
  gridDays?: number; // trailing window returned for the contribution grid
}): HabitSummaryStats {
  const { entries, today } = opts;
  const streak = computeStreak(entries, {
    today,
    goalPeriod: opts.goalPeriod,
    weeklyTarget: opts.weeklyTarget,
  });

  const month = today.slice(0, 7);
  const doneThisMonth = entries.filter(
    (e) => e.date.slice(0, 7) === month && e.status === "completed" && e.date <= today,
  ).length;

  const gridDays = opts.gridDays ?? 120;
  const cutoff = addDays(today, -(gridDays - 1));
  const days = entries.filter((e) => e.date >= cutoff && e.date <= today);

  return {
    streak: streak.currentStreak,
    flameCount: streak.flameCount,
    doneThisMonth,
    daysThisMonth: daysInMonth(today),
    days,
  };
}
