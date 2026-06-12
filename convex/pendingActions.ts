import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { pendingActionKindValidator, stakesValidator } from "./pendingActionKinds";

const statusV = v.union(
  v.literal("pending"),
  v.literal("committed"),
  v.literal("rejected"),
  v.literal("expired"),
);

// Create a new pending action, superseding any still-pending action in the
// same conversation (a fresh draft replaces an undecided one).
export const create = mutation({
  args: {
    actionId: v.string(),
    conversationId: v.string(),
    kind: pendingActionKindValidator,
    stakes: v.optional(stakesValidator),
    pitch: v.string(),
    entry: v.string(),
    targetFile: v.string(),
    sha256: v.string(),
    candidateId: v.optional(v.string()),
    videoId: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const stale = await ctx.db
      .query("pendingActions")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "pending"),
      )
      .collect();
    for (const row of stale) {
      await ctx.db.patch(row._id, { status: "expired", decidedAt: Date.now() });
    }
    return await ctx.db.insert("pendingActions", { ...args, status: "pending" });
  },
});

// The single active (pending, unexpired) action for a conversation, or null.
export const getActive = query({
  args: { conversationId: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("pendingActions")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "pending"),
      )
      .order("desc")
      .take(5);
    return rows.find((r) => r.expiresAt > now) ?? null;
  },
});

export const markShown = mutation({
  args: { actionId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("pendingActions")
      .withIndex("by_action_id", (q) => q.eq("actionId", args.actionId))
      .unique();
    if (!row) return null;
    await ctx.db.patch(row._id, { shownAt: Date.now() });
    return row._id;
  },
});

export const setStatus = mutation({
  args: { actionId: v.string(), status: statusV },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("pendingActions")
      .withIndex("by_action_id", (q) => q.eq("actionId", args.actionId))
      .unique();
    if (!row) return null;
    await ctx.db.patch(row._id, { status: args.status, decidedAt: Date.now() });
    return row._id;
  },
});
