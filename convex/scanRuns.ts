import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const kindUnion = v.union(v.literal("scan"), v.literal("surface"));
const statusUnion = v.union(
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
);

export const create = mutation({
  args: { runId: v.string(), kind: kindUnion },
  handler: async (ctx, args) => {
    return await ctx.db.insert("scanRuns", {
      runId: args.runId,
      kind: args.kind,
      status: "running",
      startedAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    runId: v.string(),
    status: v.optional(statusUnion),
    sources: v.optional(v.array(v.string())),
    itemsScanned: v.optional(v.number()),
    itemsScored: v.optional(v.number()),
    itemsNominated: v.optional(v.number()),
    totalCostUsd: v.optional(v.number()),
    elapsedMs: v.optional(v.number()),
    error: v.optional(v.string()),
    formattedCheckIn: v.optional(v.string()),
    surfaceLog: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("scanRuns")
      .withIndex("by_run_id", (q) => q.eq("runId", args.runId))
      .unique();
    if (!row) return null;
    const { runId: _runId, ...rest } = args;
    const completed = args.status && args.status !== "running";
    await ctx.db.patch(row._id, {
      ...rest,
      ...(completed ? { completedAt: Date.now() } : {}),
    });
    return row._id;
  },
});

export const latestCompletedScan = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("scanRuns")
      .withIndex("by_kind_status", (q) => q.eq("kind", "scan").eq("status", "completed"))
      .order("desc")
      .take(1);
    return rows[0] ?? null;
  },
});

export const recent = query({
  args: { kind: v.optional(kindUnion), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 25;
    if (args.kind) {
      return await ctx.db
        .query("scanRuns")
        .withIndex("by_kind_status", (q) => q.eq("kind", args.kind!))
        .order("desc")
        .take(limit);
    }
    return await ctx.db
      .query("scanRuns")
      .withIndex("by_started_at")
      .order("desc")
      .take(limit);
  },
});
