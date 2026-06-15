import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { domainValidator } from "./conceptDomains";

// JAR-40 (Three-Link Drill phase 2): one row per spoken rep. STRUCTURAL grade
// only — no correctness/score field exists, by design, so grading can't persist
// a "was it right" verdict. audioRef is added in phase 3 (local-only).
export const create = mutation({
  args: {
    repId: v.string(),
    conceptId: v.string(),
    domain: domainValidator,
    transcript: v.string(),
    factPresent: v.boolean(),
    mechanismPresent: v.boolean(),
    consequencePresent: v.boolean(),
    hedged: v.boolean(),
    trailedOff: v.boolean(),
    fancyPhraseSwap: v.boolean(),
    sharpeningNote: v.string(),
    audioRef: v.optional(v.string()), // phase 3: local-only audio file id; nil when capture is off
    drilledAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("reps", args);
    return { repId: args.repId };
  },
});

// JAR-41 (phase 3): newest reps for the history view, by_drilled desc. Reps store
// only conceptId, so resolve the concept text per row (the dataset is small, at
// most ~90 days of reps) for a readable list. audioRef is normalized to null.
export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    const rows = await ctx.db.query("reps").withIndex("by_drilled").order("desc").take(limit);
    const out = [];
    for (const r of rows) {
      const c = await ctx.db
        .query("concepts")
        .withIndex("by_concept", (q) => q.eq("conceptId", r.conceptId))
        .unique();
      out.push({
        repId: r.repId,
        conceptId: r.conceptId,
        concept: c?.concept ?? "(concept removed)",
        domain: r.domain,
        factPresent: r.factPresent,
        mechanismPresent: r.mechanismPresent,
        consequencePresent: r.consequencePresent,
        hedged: r.hedged,
        trailedOff: r.trailedOff,
        fancyPhraseSwap: r.fancyPhraseSwap,
        sharpeningNote: r.sharpeningNote,
        audioRef: r.audioRef ?? null,
        drilledAt: r.drilledAt,
      });
    }
    return out;
  },
});

// JAR-41 (phase 3): 90-day rolloff. Delete reps older than the caller-supplied
// cutoff and RETURN their audioRefs so the app can delete the matching local
// audio files. Metadata and audio prune together; no orphaned files left behind.
export const prune = mutation({
  args: { cutoff: v.number() },
  handler: async (ctx, args) => {
    const old = await ctx.db
      .query("reps")
      .withIndex("by_drilled", (q) => q.lt("drilledAt", args.cutoff))
      .collect();
    const deletedAudioRefs: string[] = [];
    for (const r of old) {
      if (r.audioRef) deletedAudioRefs.push(r.audioRef);
      await ctx.db.delete(r._id);
    }
    return { deleted: old.length, deletedAudioRefs };
  },
});
