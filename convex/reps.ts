import { mutation } from "./_generated/server";
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
    drilledAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("reps", args);
    return { repId: args.repId };
  },
});
