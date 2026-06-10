import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { habitSourceValidator } from "../schema";
import { summarizeHabit, habitDetail, sortHabits } from "./summary";
import { isWithinRepairWindow, resolveMetricRow } from "./streak";

// Habit tracker — Phase 3 (JAR-3) persistence bridge: list / create /
// setDay / archive, called by the express layer (which owns auth and the
// user's timezone — `today` always arrives as an argument, because Convex
// runs in UTC and a habit day is a wall-clock day).
//
// Auto habits are NOT written here: their rows come from the metrics resolver
// (step 2) off app-shipped readings. setDay guards on source.type === "manual"
// so the two write paths can't cross.

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function assertDateKey(label: string, value: string): void {
  if (!DATE_KEY.test(value)) throw new Error(`${label} must be YYYY-MM-DD, got "${value}"`);
}

export const list = query({
  args: {
    today: v.string(),
    gridDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertDateKey("today", args.today);
    const unsorted = await ctx.db
      .query("habits")
      .withIndex("by_archived", (q) => q.eq("archivedAt", undefined))
      .take(100);
    const habits = sortHabits(unsorted); // user-arranged order

    const out = [];
    for (const habit of habits) {
      // Bounded read: 400 rows ≈ 13 months of dailies. currentStreak is exact
      // (it walks back only to the last miss); longestStreak is windowed.
      const logsDesc = await ctx.db
        .query("habitLog")
        .withIndex("by_habit_and_date", (q) => q.eq("habitId", habit._id))
        .order("desc")
        .take(400);
      // Today's resolvedAt rides along so the app can render "done · <time>"
      // durably (not just at tap time). null when today is unlogged.
      const todayLog = logsDesc.find((l) => l.date === args.today);
      const entries = logsDesc.reverse().map((l) => ({ date: l.date, status: l.status }));
      const stats = summarizeHabit({
        entries,
        today: args.today,
        goalPeriod: habit.goalPeriod,
        weeklyTarget: habit.weeklyTarget,
        gridDays: args.gridDays,
      });
      out.push({
        id: habit._id,
        name: habit.name,
        icon: habit.icon,
        source: habit.source,
        goalPeriod: habit.goalPeriod,
        todayResolvedAt: todayLog?.resolvedAt ?? null,
        ...stats,
      });
    }
    return out;
  },
});

// Detail view for one habit. Lifetime math spans all logs (bounded read);
// grid + weekday cover the selected window. createdAt is returned raw — express
// owns the timezone and turns it into the local startDate + daysTracked +
// completionRate, keeping all tz conversion in one layer (same reason `today`
// is always an argument).
export const detail = query({
  args: {
    habitId: v.id("habits"),
    today: v.string(),
    window: v.number(),
  },
  handler: async (ctx, args) => {
    assertDateKey("today", args.today);
    const habit = await ctx.db.get(args.habitId);
    if (!habit || habit.archivedAt) return null;

    // All-time read for lifetime stats. 2000 rows ≈ 5+ years of dailies; logged
    // if ever hit so we'd know to paginate.
    const logsDesc = await ctx.db
      .query("habitLog")
      .withIndex("by_habit_and_date", (q) => q.eq("habitId", args.habitId))
      .order("desc")
      .take(2000);
    if (logsDesc.length === 2000) {
      console.warn(`[habits.detail] ${args.habitId} hit the 2000-row cap`);
    }
    const entries = logsDesc.reverse().map((l) => ({ date: l.date, status: l.status }));
    // Per-day metric value (auto habits), so the app's auto repair rows can
    // show the evidence reading alongside status.
    const valueByDate = new Map<string, number>();
    for (const l of logsDesc) if (l.value !== undefined) valueByDate.set(l.date, l.value);

    const d = habitDetail({
      entries,
      today: args.today,
      goalPeriod: habit.goalPeriod,
      weeklyTarget: habit.weeklyTarget,
      window: args.window,
    });
    const gridWithValue = d.grid.map((g) => ({ ...g, value: valueByDate.get(g.date) ?? null }));

    return {
      habit: {
        id: habit._id,
        name: habit.name,
        icon: habit.icon,
        source: habit.source,
        goalPeriod: habit.goalPeriod,
      },
      createdAt: habit.createdAt,
      // Earliest logged day (ascending entries), so express can floor the
      // tracked-span at whichever is earlier — createdAt or a backfilled day
      // logged before the habit existed (the repair window allows that).
      firstLoggedDate: entries[0]?.date ?? null,
      ...d,
      grid: gridWithValue,
    };
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    icon: v.string(),
    source: habitSourceValidator,
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    if (!name) throw new Error("habit name required");
    // Everything the builder creates is daily (Phase 2 ruling); the weekly
    // control arrives with a real weekly habit, not speculatively.
    return await ctx.db.insert("habits", {
      name,
      icon: args.icon,
      goalPeriod: "daily",
      source: args.source,
      createdAt: Date.now(),
    });
  },
});

// setDay — the single manual write path (replaces logCompletion). Sets one
// day to completed / missed / unknown:
//   * "unknown" DELETES the row (a logged day reverted to never-logged; the
//     streak walker treats absence as transparent, so this is the true undo).
//   * "completed" / "missed" upsert with resolvedAt. The refined invariant
//     holds: a manual miss carries resolvedAt as its evidence (the user's
//     explicit answer); value stays auto-only.
// The date must fall inside the trailing repair window (enforced in code, not
// just by the future-date check) — manual habits only; auto days are resolver-
// owned. The app's confirm-on-change is a UI concern and lives app-side.
export const setDay = mutation({
  args: {
    habitId: v.id("habits"),
    date: v.string(),
    today: v.string(),
    status: v.union(v.literal("completed"), v.literal("missed"), v.literal("unknown")),
  },
  handler: async (ctx, args) => {
    assertDateKey("date", args.date);
    assertDateKey("today", args.today);
    if (args.date > args.today) throw new Error("cannot set a future date");
    if (!isWithinRepairWindow(args.date, args.today)) {
      throw new Error("date is outside the editable 7-day window");
    }

    const habit = await ctx.db.get(args.habitId);
    if (!habit || habit.archivedAt) throw new Error("habit not found");
    if (habit.source.type !== "manual") {
      throw new Error("auto habits resolve from synced metrics, not manual edits");
    }

    const existing = await ctx.db
      .query("habitLog")
      .withIndex("by_habit_and_date", (q) =>
        q.eq("habitId", args.habitId).eq("date", args.date),
      )
      .unique();

    if (args.status === "unknown") {
      if (existing) await ctx.db.delete(existing._id);
      return null;
    }
    if (existing) {
      await ctx.db.patch(existing._id, { status: args.status, resolvedAt: Date.now() });
      return existing._id;
    }
    return await ctx.db.insert("habitLog", {
      habitId: args.habitId,
      date: args.date,
      status: args.status,
      resolvedAt: Date.now(),
      createdAt: Date.now(),
    });
  },
});

// Metrics ingest (step 2 auto-fill). The phone is the only thing that can read
// HealthKit, so it POSTs the trailing window's readings here and the server
// resolves each active auto habit per posted day. A reading absent from a day's
// payload writes NOTHING for that habit-day (it stays unknown — never forced to
// a miss). Re-posting a day is idempotent (upsert). Days must be in the repair
// window and STRICTLY PAST: today and future are rejected, because a partial
// day must not resolve (steps aren't done yet at 9am).
//
// NOTE on window: a posted day must satisfy isWithinRepairWindow AND be < today,
// i.e. today-6 .. today-1 (the repair window minus today). One window
// definition shared with manual repair — flag if a literal 7-days-ending-
// yesterday was meant instead.
export const recordMetrics = mutation({
  args: {
    today: v.string(),
    days: v.array(
      v.object({
        date: v.string(),
        readings: v.record(v.string(), v.number()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    assertDateKey("today", args.today);
    for (const day of args.days) {
      assertDateKey("date", day.date);
      if (day.date >= args.today) throw new Error("metrics are for past days only");
      if (!isWithinRepairWindow(day.date, args.today)) {
        throw new Error("date is outside the editable 7-day window");
      }
    }

    const habits = await ctx.db
      .query("habits")
      .withIndex("by_archived", (q) => q.eq("archivedAt", undefined))
      .take(100);

    let written = 0;
    for (const day of args.days) {
      for (const habit of habits) {
        if (habit.source.type === "manual") continue; // auto only
        const reading = day.readings[habit.source.metric];
        const row = resolveMetricRow({
          comparator: habit.source.comparator,
          threshold: habit.source.threshold,
          value: reading,
        });
        if (!row) continue; // absent / unresolvable -> write nothing

        const existing = await ctx.db
          .query("habitLog")
          .withIndex("by_habit_and_date", (q) =>
            q.eq("habitId", habit._id).eq("date", day.date),
          )
          .unique();
        if (existing) {
          await ctx.db.patch(existing._id, {
            status: row.status,
            value: row.value,
            resolvedAt: Date.now(),
          });
        } else {
          await ctx.db.insert("habitLog", {
            habitId: habit._id,
            date: day.date,
            status: row.status,
            value: row.value,
            resolvedAt: Date.now(),
            createdAt: Date.now(),
          });
        }
        written++;
      }
    }
    return { written };
  },
});

// Persist the tracker's habit order. Takes the full ordered list of active
// habit ids and writes sortOrder = position. Ignores unknown/archived ids.
export const reorder = mutation({
  args: { habitIds: v.array(v.id("habits")) },
  handler: async (ctx, args) => {
    for (let i = 0; i < args.habitIds.length; i++) {
      const h = await ctx.db.get(args.habitIds[i]);
      if (h && !h.archivedAt) await ctx.db.patch(args.habitIds[i], { sortOrder: i });
    }
    return null;
  },
});

export const archive = mutation({
  args: { habitId: v.id("habits") },
  handler: async (ctx, args) => {
    const habit = await ctx.db.get(args.habitId);
    if (!habit) throw new Error("habit not found");
    await ctx.db.patch(args.habitId, { archivedAt: Date.now() });
    return null;
  },
});
