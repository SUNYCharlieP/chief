import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const upsert = mutation({
  args: {
    videoId: v.string(),
    title: v.string(),
    channelTitle: v.string(),
    url: v.string(),
    transcriptStatus: v.union(v.literal("full"), v.literal("partial"), v.literal("none")),
    transcript: v.string(),
    summary: v.string(),
    confidence: v.union(v.literal("high"), v.literal("low")),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("youtubeAnalysis")
      .withIndex("by_video_id", (q) => q.eq("videoId", args.videoId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args, createdAt: Date.now() });
      return existing._id;
    }
    return await ctx.db.insert("youtubeAnalysis", { ...args, createdAt: Date.now() });
  },
});

export const get = query({
  args: { videoId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("youtubeAnalysis")
      .withIndex("by_video_id", (q) => q.eq("videoId", args.videoId))
      .unique();
  },
});
