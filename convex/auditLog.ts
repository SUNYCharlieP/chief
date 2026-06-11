import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import { type AuditRow, type MemoryTier } from "./memory/privacy";

// Append-only audit log for the memory privacy gate (JAR-7). Every gate
// decision lands here: a REJECTED row records the credential pattern NAME (never
// the content), an ACCEPTED row records the tier, the memoryId, and a short
// preview of the already-clean content.
//
// APPEND-ONLY BY CONSTRUCTION: the ONLY write to the auditLog table in the whole
// codebase is the single ctx.db.insert below. There is no patch and no delete —
// not here, not anywhere. recordAudit is the one funnel; both the in-mutation
// gate (memoryRecords.upsert, which cannot ctx.runMutation from inside a
// mutation) and the public `record` entrypoint go through it, so the guarantee
// lives in exactly one place.
export async function recordAudit(ctx: MutationCtx, row: AuditRow): Promise<void> {
  await ctx.db.insert("auditLog", { ...row, at: Date.now() });
}

// Keep this validator in lockstep with MEMORY_TIERS. The exhaustiveness map
// below fails to compile if a tier is added/removed without updating it.
const privacyTierV = v.union(
  v.literal("tier1_knowledge"),
  v.literal("tier2_private"),
  v.literal("tier3_vault"),
);
const _tierExhaustive: Record<MemoryTier, true> = {
  tier1_knowledge: true,
  tier2_private: true,
  tier3_vault: true,
};
void _tierExhaustive;

// Named append entrypoint. internalMutation (not a public mutation) so audit
// rows can't be forged by an external client — the integrity of an audit log
// depends on only the system writing to it. Insert-only, via recordAudit.
export const record = internalMutation({
  args: {
    source: v.string(),
    outcome: v.union(v.literal("accepted"), v.literal("rejected")),
    privacyTier: v.optional(privacyTierV),
    memoryId: v.optional(v.string()),
    preview: v.optional(v.string()),
    rejectedPattern: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await recordAudit(ctx, args);
  },
});

// Read the most recent audit rows (newest first) for inspection / a future UI.
export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("auditLog")
      .withIndex("by_at")
      .order("desc")
      .take(args.limit ?? 50);
  },
});
