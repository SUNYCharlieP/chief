import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const statusUnion = v.union(
  v.literal("pending"),
  v.literal("nominated"),
  v.literal("surfaced"),
  v.literal("dropped"),
  v.literal("competes"),
);

export const create = mutation({
  args: {
    candidateId: v.string(),
    scanRunId: v.string(),
    source: v.string(),
    title: v.string(),
    url: v.string(),
    pubDate: v.optional(v.string()),
    excerpt: v.optional(v.string()),
    score: v.number(),
    scoreReasons: v.array(v.string()),
    competesWith: v.optional(v.array(v.string())),
    status: statusUnion,
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("scanCandidates", {
      ...args,
      scannedAt: Date.now(),
    });
  },
});

export const setStatus = mutation({
  args: {
    candidateId: v.string(),
    status: statusUnion,
    surfacedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("scanCandidates")
      .withIndex("by_candidate_id", (q) => q.eq("candidateId", args.candidateId))
      .unique();
    if (!row) return null;
    const patch: { status: typeof args.status; surfacedAt?: number } = { status: args.status };
    if (args.surfacedAt !== undefined) patch.surfacedAt = args.surfacedAt;
    await ctx.db.patch(row._id, patch);
    return row._id;
  },
});

export const listByScanRun = query({
  args: { scanRunId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("scanCandidates")
      .withIndex("by_scan_run", (q) => q.eq("scanRunId", args.scanRunId))
      .collect();
  },
});

export const topNominatedForRun = query({
  args: { scanRunId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("scanCandidates")
      .withIndex("by_scan_run", (q) => q.eq("scanRunId", args.scanRunId))
      .collect();
    const nominated = all
      .filter((c) => c.status === "nominated")
      .sort((a, b) => b.score - a.score);
    const cap = args.limit ?? 3;
    return nominated.slice(0, cap);
  },
});

export const recentByStatus = query({
  args: {
    status: statusUnion,
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 25;
    const rows = await ctx.db
      .query("scanCandidates")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .order("desc")
      .take(limit);
    return rows;
  },
});
