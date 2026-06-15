import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { domainValidator } from "./conceptDomains";

// JAR-39 (Three-Link Drill phase 1): the concept store. Learn mode SELECTS a
// concept, teaches it, and saves it here at selection time so it enters the
// spacing system before the lesson can be closed early (avoidance stays out of
// Charlie's hands). Phase 2 reads dueDate to surface drills and bumps it after.

// JAR-40 (phase 2): fixed-step spacing ladder in days, bumped on each drill.
const LADDER = [2, 5, 10];

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

// JAR-40 (phase 2): surface ONE due concept for a drill. dueDate <= now, learned
// status, oldest-due first. A concept learned today has dueDate = now+2d, so it
// can't appear here (the no-same-day rule, structural). null if nothing is due.
// `force` (dev-only; the server only sets it from an env flag, never from the
// app) surfaces the newest concept regardless of due date for the gate demo.
export const due = query({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    if (args.force) {
      const rows = await ctx.db.query("concepts").withIndex("by_learned").order("desc").take(10);
      return rows.find((r) => r.status === "learned") ?? null;
    }
    const now = Date.now();
    const rows = await ctx.db
      .query("concepts")
      .withIndex("by_due", (q) => q.lte("dueDate", now))
      .order("asc")
      .take(20);
    return rows.find((r) => r.status === "learned") ?? null;
  },
});

// JAR-40 (phase 2): the dumb fixed-step bump after a graded drill. A clean rep
// advances one rung up the ladder; otherwise step back one (never below 0).
// dueDate = now + LADDER[step] days. One decision, no SRS, no ease factors.
export const recordDrill = mutation({
  args: { conceptId: v.string(), clean: v.boolean() },
  handler: async (ctx, args) => {
    const c = await ctx.db
      .query("concepts")
      .withIndex("by_concept", (q) => q.eq("conceptId", args.conceptId))
      .unique();
    if (!c) return { nextDue: null, step: null };
    const cur = c.step ?? 0;
    const step = args.clean ? Math.min(cur + 1, LADDER.length - 1) : Math.max(cur - 1, 0);
    const dueDate = Date.now() + LADDER[step] * 86400000;
    await ctx.db.patch(c._id, { step, dueDate });
    return { nextDue: dueDate, step };
  },
});
