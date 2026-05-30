import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";

// Proactive engagement state: the daily ration counter + mute flag, and the
// anti-nag surfaced-dedupe set. All daily state is keyed by local date string,
// so it self-resets each day (a new date = a fresh row).

export const getDaily = query({
  args: { date: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("proactiveDaily")
      .withIndex("by_date", (q) => q.eq("date", args.date))
      .unique();
  },
});

async function upsertDaily(
  ctx: MutationCtx,
  date: string,
  patch: { countDelta?: number; muted?: boolean },
) {
  const existing = await ctx.db
    .query("proactiveDaily")
    .withIndex("by_date", (q) => q.eq("date", date))
    .unique();
  if (existing) {
    await ctx.db.patch(existing._id, {
      count: existing.count + (patch.countDelta ?? 0),
      muted: patch.muted ?? existing.muted,
      updatedAt: Date.now(),
    });
    return existing._id;
  }
  return await ctx.db.insert("proactiveDaily", {
    date,
    count: patch.countDelta ?? 0,
    muted: patch.muted ?? false,
    updatedAt: Date.now(),
  });
}

// Increment today's ration counter after a proactive ping is actually sent.
export const incrementCount = mutation({
  args: { date: v.string() },
  handler: async (ctx, args) => upsertDaily(ctx, args.date, { countDelta: 1 }),
});

// Set (or clear) the mute flag for a local date.
export const setMuted = mutation({
  args: { date: v.string(), muted: v.boolean() },
  handler: async (ctx, args) => upsertDaily(ctx, args.date, { muted: args.muted }),
});

// Anti-nag dedupe: has this observation's dedupKey already been surfaced?
export const isSurfaced = query({
  args: { dedupKey: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("proactiveSurfaced")
      .withIndex("by_dedup_key", (q) => q.eq("dedupKey", args.dedupKey))
      .unique();
    return row !== null;
  },
});

// Bulk fetch of already-surfaced keys (filter candidates in code in one shot).
export const surfacedKeys = query({
  args: { keys: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: string[] = [];
    for (const key of args.keys) {
      const row = await ctx.db
        .query("proactiveSurfaced")
        .withIndex("by_dedup_key", (q) => q.eq("dedupKey", key))
        .unique();
      if (row) out.push(key);
    }
    return out;
  },
});

// Mark a dedupKey surfaced on SEND, so it never re-fires. Idempotent.
export const markSurfaced = mutation({
  args: { dedupKey: v.string(), date: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("proactiveSurfaced")
      .withIndex("by_dedup_key", (q) => q.eq("dedupKey", args.dedupKey))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("proactiveSurfaced", {
      dedupKey: args.dedupKey,
      date: args.date,
      surfacedAt: Date.now(),
    });
  },
});

// Test-only cleanup so gate tests don't pollute real daily/dedupe state.
export const clearForTest = mutation({
  args: { date: v.string(), dedupKeys: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const daily = await ctx.db
      .query("proactiveDaily")
      .withIndex("by_date", (q) => q.eq("date", args.date))
      .unique();
    if (daily) await ctx.db.delete(daily._id);
    for (const key of args.dedupKeys ?? []) {
      const row = await ctx.db
        .query("proactiveSurfaced")
        .withIndex("by_dedup_key", (q) => q.eq("dedupKey", key))
        .unique();
      if (row) await ctx.db.delete(row._id);
    }
    return null;
  },
});
