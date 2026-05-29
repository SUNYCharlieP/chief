import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const statusV = v.union(
  v.literal("held"),
  v.literal("surfaced"),
  v.literal("picked"),
  v.literal("aged-out"),
);

// Insert a scored video only if its videoId is new (dedupe). Returns created.
export const insertIfNew = mutation({
  args: {
    videoId: v.string(),
    title: v.string(),
    description: v.string(),
    channelId: v.string(),
    channelTitle: v.string(),
    url: v.string(),
    publishedAt: v.string(),
    source: v.string(),
    isMustWatch: v.boolean(),
    score: v.number(),
    scoreReasons: v.array(v.string()),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("youtubeVideos")
      .withIndex("by_video_id", (q) => q.eq("videoId", args.videoId))
      .unique();
    if (existing) return { created: false };
    await ctx.db.insert("youtubeVideos", {
      ...args,
      status: "held",
      scoredAt: Date.now(),
    });
    return { created: true };
  },
});

// Which of the given videoIds already exist (any status). For pre-score dedupe.
export const knownIds = query({
  args: { videoIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const known: string[] = [];
    for (const id of args.videoIds) {
      const row = await ctx.db
        .query("youtubeVideos")
        .withIndex("by_video_id", (q) => q.eq("videoId", id))
        .unique();
      if (row) known.push(id);
    }
    return known;
  },
});

// Held, unexpired videos ranked must-watch first then score desc.
export const listHeld = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const rows = (
      await ctx.db
        .query("youtubeVideos")
        .withIndex("by_status", (q) => q.eq("status", "held"))
        .collect()
    ).filter((r) => r.expiresAt > now);
    rows.sort(
      (a, b) => Number(b.isMustWatch) - Number(a.isMustWatch) || b.score - a.score,
    );
    return rows.slice(0, args.limit ?? 25);
  },
});

export const get = query({
  args: { videoId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("youtubeVideos")
      .withIndex("by_video_id", (q) => q.eq("videoId", args.videoId))
      .unique();
  },
});

export const setStatus = mutation({
  args: {
    videoId: v.string(),
    status: statusV,
    surfacedAt: v.optional(v.number()),
    pickedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("youtubeVideos")
      .withIndex("by_video_id", (q) => q.eq("videoId", args.videoId))
      .unique();
    if (!row) return null;
    const patch: Record<string, unknown> = { status: args.status };
    if (args.surfacedAt !== undefined) patch.surfacedAt = args.surfacedAt;
    if (args.pickedAt !== undefined) patch.pickedAt = args.pickedAt;
    await ctx.db.patch(row._id, patch);
    return row._id;
  },
});

// Mark held rows past their retention window as aged-out (kept for dedupe).
export const sweepExpired = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = (
      await ctx.db
        .query("youtubeVideos")
        .withIndex("by_status", (q) => q.eq("status", "held"))
        .collect()
    ).filter((r) => r.expiresAt <= now);
    for (const r of rows) await ctx.db.patch(r._id, { status: "aged-out" });
    return { aged: rows.length };
  },
});
