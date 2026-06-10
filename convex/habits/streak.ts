// Habit tracker — Phase 1 standalone core (no Convex imports).
//
// This is the pure, testable heart of the feature: status resolution for
// auto-sourced metrics + streak/flame computation. Phase 2 wires the Convex
// schema and functions on top of these helpers; nothing in this file touches
// ctx, db, or the network, so it runs identically in vitest and in Convex.
//
// Design invariants this file enforces:
//   * "unknown" is transparent — it never breaks a streak and never extends
//     one. Only "completed" increments; only "missed" breaks. A day (or week)
//     with no row at all is treated as "unknown".
//   * "missed" always carries evidence upstream: resolvedAt, plus the metric
//     value for auto sources. Manual habits have no value — their evidence is
//     the user's explicit answer (resolvedAt alone). A not-yet-synced auto
//     metric resolves to "unknown", never a miss.
//   * The set of auto metrics is CLOSED (HABIT_METRICS below). There is no
//     weight / calorie / intake metric, so an intake habit is structurally
//     unconstructable — the type does not admit one. This is the guardrail.

// Canonical literal tuples. These are the single source of truth for every
// closed enum in the feature. The Convex schema (schema.ts) builds its
// validators by mapping over these exact tuples, so the DB can never accept a
// value the pure core doesn't model, and vice versa — no drift.
export const HABIT_STATUSES = ["completed", "missed", "unknown"] as const;
export const COMPARATORS = ["gte", "lte"] as const;
export const GOAL_PERIODS = ["daily", "weekly"] as const;
export const HABIT_SOURCE_TYPES = ["manual", "oura-auto", "healthkit-auto"] as const;

export type HabitStatus = (typeof HABIT_STATUSES)[number];
export type Comparator = (typeof COMPARATORS)[number];
export type GoalPeriod = (typeof GOAL_PERIODS)[number];
export type HabitSourceType = (typeof HABIT_SOURCE_TYPES)[number];

// The closed metric set. Phase 2's schema METRIC union is derived from
// HABIT_METRIC_KEYS, so adding (say) "body_weight" would require a deliberate
// edit here + the schema deploy dance — it can never arrive through data. Each
// metric pins its unit and the comparator that makes "goal met" read correctly.
export const HABIT_METRIC_KEYS = [
  "sleep_duration",
  "wake_time",
  "mindful_minutes",
  "steps",
  "resting_hr",
] as const;

export type HabitMetric = (typeof HABIT_METRIC_KEYS)[number];

export const HABIT_METRICS: Record<
  HabitMetric,
  { unit: string; comparator: Comparator; label: string }
> = {
  sleep_duration: { unit: "minutes", comparator: "gte", label: "Sleep duration" },
  wake_time: { unit: "minutes-past-midnight", comparator: "lte", label: "Wake time" },
  mindful_minutes: { unit: "minutes", comparator: "gte", label: "Mindful minutes" },
  steps: { unit: "count", comparator: "gte", label: "Steps" },
  resting_hr: { unit: "bpm", comparator: "lte", label: "Resting heart rate" },
};

export const DEFAULT_FLAME_THRESHOLDS = [3, 7, 30, 100] as const;

export interface DayEntry {
  date: string; // "YYYY-MM-DD" in Charlie's local calendar
  status: HabitStatus;
}

export interface StreakResult {
  currentStreak: number; // days for daily habits, weeks for weekly habits
  longestStreak: number;
  flameCount: number; // how many flame thresholds the current streak clears
}

// ---------------------------------------------------------------------------
// wake_time encoding
//
// A clock time is NOT a magnitude — comparing raw "07:45" vs "07:00" as
// numbers is nonsense, and a naive number breaks across midnight. We store
// wake_time as MINUTES PAST LOCAL MIDNIGHT (integer 0..1439). In that space an
// earlier wake is genuinely a smaller number, so the comparator does not
// invert: "woke at or before 07:00" is simply `value <= 420`, inclusive.
//   05:30 -> 330 <= 420  -> completed
//   07:00 -> 420 <= 420  -> completed (boundary is inclusive)
//   07:45 -> 465 <= 420  -> missed
// wake_time is interpreted as a morning metric within the local calendar day
// it is logged against (the first out-of-bed time HealthKit reports for that
// date); we do not attempt to model post-noon or shift-work wakes.
// ---------------------------------------------------------------------------

export function clockToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Resolve a single auto-sourced day to a status. A null/undefined value means
// the metric has not synced yet -> "unknown" (never a miss). Comparison is
// inclusive on both sides so the goal boundary counts as met.
// Later refinement (accepted v1 trade-off): same-day wake_time resolution —
// a wake result is final by morning but resolves on the next day's sync.
export function resolveAutoStatus(args: {
  comparator: Comparator;
  threshold: number;
  value: number | null | undefined;
}): HabitStatus {
  const { comparator, threshold, value } = args;
  if (value === null || value === undefined) return "unknown";
  const met = comparator === "gte" ? value >= threshold : value <= threshold;
  return met ? "completed" : "missed";
}

// ---------------------------------------------------------------------------
// Pure date helpers. We anchor every date at UTC noon and do only whole-day
// arithmetic, which sidesteps DST/timezone drift. Inputs/outputs are always
// zero-padded "YYYY-MM-DD", so lexical string order == chronological order.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function parseDay(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12);
}

function toDay(ms: number): string {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date: string, n: number): string {
  return toDay(parseDay(date) + n * MS_PER_DAY);
}

// Monday-anchored start of the week containing `date`.
function weekStart(date: string): string {
  const ms = parseDay(date);
  const dow = new Date(ms).getUTCDay(); // 0=Sun .. 6=Sat
  const sinceMonday = (dow + 6) % 7;
  return toDay(ms - sinceMonday * MS_PER_DAY);
}

function statusOn(map: Map<string, HabitStatus>, date: string): HabitStatus {
  return map.get(date) ?? "unknown"; // no row == unknown == transparent
}

// ---------------------------------------------------------------------------
// The single streak walker. Given a chronological list of period statuses
// (earliest first), compute current streak (walking backward from the most
// recent period), longest streak, and the flame tier. unknown is transparent
// in both directions.
// ---------------------------------------------------------------------------

function walk(statuses: HabitStatus[], thresholds: readonly number[]): StreakResult {
  let current = 0;
  for (let i = statuses.length - 1; i >= 0; i--) {
    const s = statuses[i];
    if (s === "completed") current++;
    else if (s === "missed") break;
    // unknown: transparent, keep walking
  }

  let longest = 0;
  let run = 0;
  for (const s of statuses) {
    if (s === "completed") {
      run++;
      if (run > longest) longest = run;
    } else if (s === "missed") {
      run = 0;
    }
    // unknown: run unchanged
  }

  const flameCount = thresholds.filter((t) => current >= t).length;
  return { currentStreak: current, longestStreak: longest, flameCount };
}

// Daily habits: one period == one calendar day, from the earliest logged day
// through `today`. Absent days inside the span are unknown (transparent).
function dailyStatuses(map: Map<string, HabitStatus>, today: string): HabitStatus[] {
  const dates = [...map.keys()].sort();
  if (dates.length === 0) return [];
  const earliest = dates[0] < today ? dates[0] : today;
  const out: HabitStatus[] = [];
  for (let d = earliest; d <= today; d = addDays(d, 1)) out.push(statusOn(map, d));
  return out;
}

// Weekly habits: one period == one Monday-anchored week. A week is:
//   * "completed" once `completed >= weeklyTarget`.
//   * "unknown" (transparent) if the current in-progress week, OR a past week
//     where the unknown/absent days COULD still have reached the target had
//     they been completions (completed + unknown >= target). Unknown is never
//     a miss — same invariant as daily, lifted to the week.
//   * "missed" only when it is arithmetically impossible for the week to have
//     met target given what is known (completed + unknown < target).
function weekStatus(
  map: Map<string, HabitStatus>,
  start: string,
  today: string,
  target: number,
): HabitStatus {
  let completed = 0;
  let bestCase = 0; // completed + unknown (days that aren't known failures)
  for (let i = 0; i < 7; i++) {
    const day = addDays(start, i);
    if (day > today) break; // future days don't exist yet
    const s = statusOn(map, day);
    if (s === "completed") {
      completed++;
      bestCase++;
    } else if (s === "unknown") {
      bestCase++;
    }
  }
  if (completed >= target) return "completed";
  if (start === weekStart(today)) return "unknown"; // in progress, never a miss
  return bestCase < target ? "missed" : "unknown";
}

function weeklyStatuses(
  map: Map<string, HabitStatus>,
  today: string,
  target: number,
): HabitStatus[] {
  const dates = [...map.keys()].sort();
  if (dates.length === 0) return [];
  const current = weekStart(today);
  const out: HabitStatus[] = [];
  for (let w = weekStart(dates[0]); w <= current; w = addDays(w, 7)) {
    out.push(weekStatus(map, w, today, target));
  }
  return out;
}

export function computeStreak(
  entries: DayEntry[],
  opts: {
    today: string;
    goalPeriod?: GoalPeriod;
    weeklyTarget?: number;
    flameThresholds?: readonly number[];
  },
): StreakResult {
  const thresholds = opts.flameThresholds ?? DEFAULT_FLAME_THRESHOLDS;
  const map = new Map<string, HabitStatus>();
  for (const e of entries) map.set(e.date, e.status);

  const statuses =
    (opts.goalPeriod ?? "daily") === "weekly"
      ? weeklyStatuses(map, opts.today, opts.weeklyTarget ?? 1)
      : dailyStatuses(map, opts.today);

  return walk(statuses, thresholds);
}
