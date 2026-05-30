import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const kindUnion = v.union(
  v.literal("git-commit"),
  v.literal("competes-flag"),
  v.literal("self-report"),
  v.literal("linear-ticket"),
  v.literal("github-issue"),
  v.literal("github-pr"),
  v.literal("github-release"),
  v.literal("github-push"),
);

// Insert only if the dedupKey hasn't been seen. Returns true if a new row was
// created, false if it already existed. Lets the git observer run on overlap
// windows without double-recording commits.
export const recordIfNew = mutation({
  args: {
    observationId: v.string(),
    kind: kindUnion,
    source: v.string(),
    summary: v.string(),
    detail: v.optional(v.string()),
    observedAt: v.number(),
    dedupKey: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("observations")
      .withIndex("by_dedup_key", (q) => q.eq("dedupKey", args.dedupKey))
      .unique();
    if (existing) return { created: false };
    await ctx.db.insert("observations", {
      ...args,
      recordedAt: Date.now(),
    });
    return { created: true };
  },
});

export const recent = query({
  args: {
    sinceMs: v.optional(v.number()),
    kind: v.optional(kindUnion),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    let rows;
    if (args.kind) {
      rows = await ctx.db
        .query("observations")
        .withIndex("by_kind", (q) => q.eq("kind", args.kind!))
        .order("desc")
        .take(limit * 2);
    } else {
      rows = await ctx.db
        .query("observations")
        .withIndex("by_observed_at")
        .order("desc")
        .take(limit * 2);
    }
    const filtered = args.sinceMs
      ? rows.filter((r) => r.observedAt >= args.sinceMs!)
      : rows;
    return filtered.slice(0, limit);
  },
});

export const countByKind = query({
  args: { kind: kindUnion, sinceMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("observations")
      .withIndex("by_kind", (q) => q.eq("kind", args.kind))
      .collect();
    const filtered = args.sinceMs
      ? rows.filter((r) => r.observedAt >= args.sinceMs!)
      : rows;
    return filtered.length;
  },
});
