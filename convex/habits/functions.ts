import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { habitSourceValidator } from "../schema";
import { summarizeHabit } from "./summary";
import { isWithinRepairWindow } from "./streak";

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
    const habits = await ctx.db
      .query("habits")
      .withIndex("by_archived", (q) => q.eq("archivedAt", undefined))
      .take(100);

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

export const archive = mutation({
  args: { habitId: v.id("habits") },
  handler: async (ctx, args) => {
    const habit = await ctx.db.get(args.habitId);
    if (!habit) throw new Error("habit not found");
    await ctx.db.patch(args.habitId, { archivedAt: Date.now() });
    return null;
  },
});
