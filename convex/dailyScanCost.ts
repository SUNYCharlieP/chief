import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Per-day per-source cost aggregation for budget enforcement. The morning
// scan checks the current total before each LLM call and aborts the source
// (sets hitBudgetCap=true) when cumulative cost would exceed the per-source
// daily budget.

export const recordCost = mutation({
  args: {
    date: v.string(),
    source: v.string(),
    costUsd: v.number(),
    scanAttempted: v.boolean(),
    scanSucceeded: v.boolean(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("dailyScanCost")
      .withIndex("by_date_source", (q) =>
        q.eq("date", args.date).eq("source", args.source),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        totalUsd: existing.totalUsd + args.costUsd,
        scansAttempted: existing.scansAttempted + (args.scanAttempted ? 1 : 0),
        scansSucceeded: existing.scansSucceeded + (args.scanSucceeded ? 1 : 0),
        updatedAt: Date.now(),
      });
      return existing._id;
    }
    return await ctx.db.insert("dailyScanCost", {
      date: args.date,
      source: args.source,
      totalUsd: args.costUsd,
      scansAttempted: args.scanAttempted ? 1 : 0,
      scansSucceeded: args.scanSucceeded ? 1 : 0,
      hitBudgetCap: false,
      updatedAt: Date.now(),
    });
  },
});

export const markBudgetCap = mutation({
  args: { date: v.string(), source: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("dailyScanCost")
      .withIndex("by_date_source", (q) =>
        q.eq("date", args.date).eq("source", args.source),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { hitBudgetCap: true, updatedAt: Date.now() });
      return existing._id;
    }
    return await ctx.db.insert("dailyScanCost", {
      date: args.date,
      source: args.source,
      totalUsd: 0,
      scansAttempted: 0,
      scansSucceeded: 0,
      hitBudgetCap: true,
      updatedAt: Date.now(),
    });
  },
});

export const getForDateSource = query({
  args: { date: v.string(), source: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("dailyScanCost")
      .withIndex("by_date_source", (q) =>
        q.eq("date", args.date).eq("source", args.source),
      )
      .unique();
  },
});

export const listForDate = query({
  args: { date: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("dailyScanCost")
      .withIndex("by_date", (q) => q.eq("date", args.date))
      .collect();
  },
});
