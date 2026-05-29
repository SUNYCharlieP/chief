import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const kindV = v.union(v.literal("topic"), v.literal("channel"));

export const list = query({
  args: { kind: v.optional(kindV) },
  handler: async (ctx, args) => {
    if (args.kind) {
      return await ctx.db
        .query("youtubeSources")
        .withIndex("by_kind", (q) => q.eq("kind", args.kind!))
        .collect();
    }
    return await ctx.db.query("youtubeSources").collect();
  },
});

// Add a source if an enabled one with the same kind+value doesn't already exist.
export const add = mutation({
  args: {
    kind: kindV,
    value: v.string(),
    channelId: v.optional(v.string()),
    feedUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = (
      await ctx.db
        .query("youtubeSources")
        .withIndex("by_kind", (q) => q.eq("kind", args.kind))
        .collect()
    ).find((r) => r.value.toLowerCase() === args.value.toLowerCase());
    if (existing) {
      await ctx.db.patch(existing._id, {
        enabled: true,
        channelId: args.channelId ?? existing.channelId,
        feedUrl: args.feedUrl ?? existing.feedUrl,
      });
      return { created: false, id: existing._id };
    }
    const id = await ctx.db.insert("youtubeSources", {
      kind: args.kind,
      value: args.value,
      channelId: args.channelId,
      feedUrl: args.feedUrl,
      enabled: true,
      addedAt: Date.now(),
    });
    return { created: true, id };
  },
});

export const remove = mutation({
  args: { kind: kindV, value: v.string() },
  handler: async (ctx, args) => {
    const row = (
      await ctx.db
        .query("youtubeSources")
        .withIndex("by_kind", (q) => q.eq("kind", args.kind))
        .collect()
    ).find((r) => r.value.toLowerCase() === args.value.toLowerCase());
    if (!row) return { removed: false };
    await ctx.db.delete(row._id);
    return { removed: true };
  },
});
