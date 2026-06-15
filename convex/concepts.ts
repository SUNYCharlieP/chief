import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// JAR-39 (Three-Link Drill phase 1): the concept store. Learn mode SELECTS a
// concept, teaches it, and saves it here at selection time so it enters the
// spacing system before the lesson can be closed early (avoidance stays out of
// Charlie's hands). Phase 2 reads dueDate to surface drills; phase 1 only writes.

const domainValidator = v.union(
  v.literal("swift-arch"),
  v.literal("saas-arch"),
  v.literal("apple-dev"),
  v.literal("arm"),
);

// Save a concept at selection time. dueDate is computed by the caller
// (learnedAt + ~2 days) and is always next-day+, which is what enforces the
// no-same-day drill rule downstream.
export const create = mutation({
  args: {
    conceptId: v.string(),
    domain: domainValidator,
    concept: v.string(),
    summary: v.string(),
    sourceObservationId: v.optional(v.string()),
    learnedAt: v.number(),
    dueDate: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("concepts", { ...args, status: "learned" });
    return { conceptId: args.conceptId };
  },
});

// The don't-repeat input for selection: the most recently learned concepts so
// the selection prompt won't re-pick something already taught. Newest first.
export const recentLearned = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 30;
    const rows = await ctx.db
      .query("concepts")
      .withIndex("by_learned")
      .order("desc")
      .take(limit);
    return rows.map((r) => ({ concept: r.concept, domain: r.domain }));
  },
});
