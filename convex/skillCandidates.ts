import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const statusV = v.union(
  v.literal("collected"),
  v.literal("surfaced"),
  v.literal("drafting"),
  v.literal("skilled"),
  v.literal("declined"),
);

// Upsert a detected pattern by patternKey. New patterns become "collected".
// Existing patterns only get their occurrences/lastSeen refreshed; a candidate
// already surfaced/drafting/skilled/declined is NOT flipped back to collected,
// which is how suppression of declined patterns works.
export const upsertByPattern = mutation({
  args: {
    candidateId: v.string(),
    patternKey: v.string(),
    title: v.string(),
    rationale: v.string(),
    evidence: v.string(),
    occurrences: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("skillCandidates")
      .withIndex("by_pattern_key", (q) => q.eq("patternKey", args.patternKey))
      .unique();
    const now = Date.now();
    if (existing) {
      const patch: Record<string, unknown> = {
        occurrences: args.occurrences,
        lastSeenAt: now,
      };
      // Only refresh display fields while still collected (not yet acted on).
      if (existing.status === "collected") {
        patch.title = args.title;
        patch.rationale = args.rationale;
        patch.evidence = args.evidence;
      }
      await ctx.db.patch(existing._id, patch);
      return { created: false, status: existing.status };
    }
    await ctx.db.insert("skillCandidates", {
      candidateId: args.candidateId,
      patternKey: args.patternKey,
      title: args.title,
      rationale: args.rationale,
      evidence: args.evidence,
      status: "collected",
      occurrences: args.occurrences,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    return { created: true, status: "collected" };
  },
});

export const listByStatus = query({
  args: { status: statusV, limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("skillCandidates")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .collect();
    rows.sort((a, b) => (a.surfaceOrder ?? 0) - (b.surfaceOrder ?? 0) || a.firstSeenAt - b.firstSeenAt);
    return rows.slice(0, args.limit ?? 50);
  },
});

export const get = query({
  args: { candidateId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("skillCandidates")
      .withIndex("by_candidate_id", (q) => q.eq("candidateId", args.candidateId))
      .unique();
  },
});

export const setStatus = mutation({
  args: {
    candidateId: v.string(),
    status: statusV,
    surfaceOrder: v.optional(v.number()),
    surfacedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("skillCandidates")
      .withIndex("by_candidate_id", (q) => q.eq("candidateId", args.candidateId))
      .unique();
    if (!row) return null;
    const patch: Record<string, unknown> = { status: args.status };
    if (args.surfaceOrder !== undefined) patch.surfaceOrder = args.surfaceOrder;
    if (args.surfacedAt !== undefined) patch.surfacedAt = args.surfacedAt;
    if (args.status === "skilled" || args.status === "declined") patch.decidedAt = Date.now();
    await ctx.db.patch(row._id, patch);
    return row._id;
  },
});

// Sweep prior-cycle surfaced candidates to declined: if it was surfaced in a
// past digest and not picked (still "surfaced") by the next run, the user
// passed on it. Suppresses weekly resurfacing.
export const sweepSurfaced = mutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("skillCandidates")
      .withIndex("by_status", (q) => q.eq("status", "surfaced"))
      .collect();
    for (const r of rows) {
      await ctx.db.patch(r._id, { status: "declined", decidedAt: Date.now() });
    }
    return { swept: rows.length };
  },
});
