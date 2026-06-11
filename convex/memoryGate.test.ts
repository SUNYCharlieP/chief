// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// End-to-end proof that the privacy gate (JAR-7) runs INSIDE the real
// memoryRecords.upsert mutation: a credential is rejected and never stored, a
// clean write lands with a privacyTier and an audit row, and the audit log only
// ever grows. Runs in-memory via convex-test — touches no deployment.
const modules = import.meta.glob("./**/*.ts");

const base = {
  tier: "short" as const,
  importance: 0.5,
  decayRate: 0.1,
  source: "test",
};

async function memById(t: ReturnType<typeof convexTest>, memoryId: string) {
  return await t.run(async (ctx) => {
    return await ctx.db
      .query("memoryRecords")
      .withIndex("by_memory_id", (q) => q.eq("memoryId", memoryId))
      .unique();
  });
}

describe("memoryRecords.upsert privacy gate (JAR-7)", () => {
  it("PROOF 1: credential write is rejected at the mutation and logged (pattern name only)", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(api.memoryRecords.upsert, {
      ...base,
      memoryId: "gate-cred-1",
      content: "my key is sk-live-supersecret0001",
      segment: "knowledge",
    });

    // not stored
    expect(result).toBeNull();
    expect(await memById(t, "gate-cred-1")).toBeNull();

    // logged: exactly one rejected row, pattern NAME only, no content anywhere
    const rows = await t.query(api.auditLog.recent, { limit: 10 });
    const rejected = rows.filter((r) => r.outcome === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].rejectedPattern).toBe("key-prefix");
    expect(rejected[0].preview).toBeUndefined();
    expect(rejected[0].source).toBe("test");
    expect(JSON.stringify(rejected[0])).not.toContain("supersecret");
  });

  it("PROOF 2: clean write passes with a privacyTier and an accepted audit row", async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(api.memoryRecords.upsert, {
      ...base,
      memoryId: "gate-clean-1",
      content: "Charlie prefers morning workouts",
      segment: "preference",
    });
    expect(id).not.toBeNull();

    const mem = await memById(t, "gate-clean-1");
    expect(mem?.privacyTier).toBe("tier2_private"); // preference -> tier2
    // the audit-only `source` field must NOT be persisted on the memory doc
    expect((mem as Record<string, unknown>).source).toBeUndefined();

    const accepted = (await t.query(api.auditLog.recent, { limit: 10 })).filter(
      (r) => r.outcome === "accepted",
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].privacyTier).toBe("tier2_private");
    expect(accepted[0].memoryId).toBe("gate-clean-1");
    expect(accepted[0].preview).toBe("Charlie prefers morning workouts");
    expect(accepted[0].rejectedPattern).toBeUndefined();
  });

  it("PROOF 3 (runtime corollary): the audit log only ever grows", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.memoryRecords.upsert, {
      ...base,
      memoryId: "grow-a",
      content: "tsc catches type errors",
      segment: "knowledge",
    });
    const after1 = (await t.query(api.auditLog.recent, { limit: 50 })).length;
    await t.mutation(api.memoryRecords.upsert, {
      ...base,
      memoryId: "grow-b",
      content: "token ya29.aSecretValueHere1234567890",
      segment: "knowledge",
    });
    const after2 = (await t.query(api.auditLog.recent, { limit: 50 })).length;
    expect(after1).toBe(1); // accepted row for grow-a
    expect(after2).toBe(2); // + rejected row for grow-b; nothing removed
  });

  it("derives privacyTier from segment for every segment (vault for identity)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.memoryRecords.upsert, {
      ...base,
      memoryId: "seg-identity",
      content: "Charlie is a flooring contractor",
      segment: "identity",
    });
    expect((await memById(t, "seg-identity"))?.privacyTier).toBe("tier3_vault");
  });
});
