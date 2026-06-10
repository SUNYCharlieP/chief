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

// 0=Sun..6=Sat, UTC-noon anchored so it matches addDays' day keys.
function dayOfWeek(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

export interface WeekdayStat {
  dow: number; // 0=Sun..6=Sat
  completed: number;
  days: number; // occurrences of this weekday in the window
  rate: number; // completed / days, 0..1 (0 when days == 0)
}

export interface HabitDetail {
  completions: number; // all-time completed days
  currentStreak: number;
  bestStreak: number; // all-time longest
  grid: DayEntry[]; // window slice, ascending (app fills absent -> unknown)
  weekday: WeekdayStat[]; // Sun..Sat, always 7
  best: { dow: number; rate: number } | null; // highest-rate weekday with data
  worst: { dow: number; rate: number } | null;
}

// Detail-view math. Lifetime stats (completions, streaks) span the full entry
// set; the grid and weekday rates cover only the selected trailing window.
// Weekday rate counts EVERY occurrence of that weekday in the window as the
// denominator (an unlogged Saturday lowers Saturday) — consistent with the
// lifetime completionRate, which express computes as completions/daysTracked.
export function habitDetail(opts: {
  entries: DayEntry[]; // ascending by date
  today: string;
  goalPeriod: GoalPeriod;
  weeklyTarget?: number;
  window: number; // trailing days incl. today (30 | 90 | 180)
}): HabitDetail {
  const { entries, today, window } = opts;
  const streak = computeStreak(entries, {
    today,
    goalPeriod: opts.goalPeriod,
    weeklyTarget: opts.weeklyTarget,
  });
  const completions = entries.filter((e) => e.status === "completed").length;

  const start = addDays(today, -(window - 1));
  const grid = entries.filter((e) => e.date >= start && e.date <= today);
  const completedDates = new Set(
    grid.filter((e) => e.status === "completed").map((e) => e.date),
  );

  const completedByDow = new Array(7).fill(0);
  const daysByDow = new Array(7).fill(0);
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const dow = dayOfWeek(d);
    daysByDow[dow]++;
    if (completedDates.has(d)) completedByDow[dow]++;
  }

  const weekday: WeekdayStat[] = [];
  for (let dow = 0; dow < 7; dow++) {
    const days = daysByDow[dow];
    weekday.push({
      dow,
      completed: completedByDow[dow],
      days,
      rate: days > 0 ? completedByDow[dow] / days : 0,
    });
  }

  // best/worst over weekdays that actually occur in the window (all do for a
  // 30d+ window, but guard so a tiny window never crowns a zero-data day).
  const withData = weekday.filter((w) => w.days > 0);
  let best: { dow: number; rate: number } | null = null;
  let worst: { dow: number; rate: number } | null = null;
  for (const w of withData) {
    if (!best || w.rate > best.rate) best = { dow: w.dow, rate: w.rate };
    if (!worst || w.rate < worst.rate) worst = { dow: w.dow, rate: w.rate };
  }

  return {
    completions,
    currentStreak: streak.currentStreak,
    bestStreak: streak.longestStreak,
    grid,
    weekday,
    best,
    worst,
  };
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
