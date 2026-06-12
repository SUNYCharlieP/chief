// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { PENDING_ACTION_KINDS, stakesForKind } from "./pendingActionKinds";

// In-memory proof (no deployment) that the action-layer schema changes work:
// pendingActions.create accepts every kind in the union including the two new
// JAR-26 kinds and carries the stakes field, and auditLog.recordDecision is an
// append-only log that never receives a message body.
const modules = import.meta.glob("./**/*.ts");

describe("pendingActions.create — every kind + stakes", () => {
  it("creates each kind in the union (drift guard) and getActive returns its stakes", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    for (const kind of PENDING_ACTION_KINDS) {
      const conversationId = `conv-${kind}`;
      await t.mutation(api.pendingActions.create, {
        actionId: `pa-${kind}`,
        conversationId,
        kind,
        stakes: stakesForKind(kind),
        pitch: "p",
        entry: "{}",
        targetFile: "",
        sha256: "",
        createdAt: now,
        expiresAt: now + 3_600_000,
      });
      const active = await t.query(api.pendingActions.getActive, { conversationId });
      expect(active?.kind).toBe(kind);
      expect(active?.stakes).toBe(stakesForKind(kind));
    }
  });

  it("message.send is stored high-stakes; calendar.add low-stakes", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const mk = async (kind: "message.send" | "calendar.add") => {
      await t.mutation(api.pendingActions.create, {
        actionId: `pa-${kind}`,
        conversationId: `c-${kind}`,
        kind,
        stakes: stakesForKind(kind),
        pitch: "",
        entry: "{}",
        targetFile: "",
        sha256: "",
        createdAt: now,
        expiresAt: now + 3_600_000,
      });
      return (await t.query(api.pendingActions.getActive, { conversationId: `c-${kind}` }))?.stakes;
    };
    expect(await mk("message.send")).toBe("high");
    expect(await mk("calendar.add")).toBe("low");
  });
});

describe("auditLog.recordDecision — append-only, body never logged", () => {
  it("logs a rejected send with the reason + recipient display, never a body", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.auditLog.recordDecision, {
      source: "message.send",
      outcome: "rejected",
      reason: "recipient-not-allowlisted",
      recipient: "Stranger",
    });
    const rejected = (await t.query(api.auditLog.recent, { limit: 10 })).filter(
      (r) => r.outcome === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].source).toBe("message.send");
    expect(rejected[0].rejectedPattern).toBe("recipient-not-allowlisted");
    expect(rejected[0].preview).toBe("Stranger");
  });

  it("only grows across accepted + rejected decisions", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.auditLog.recordDecision, { source: "message.send", outcome: "accepted", recipient: "Partner" });
    const after1 = (await t.query(api.auditLog.recent, { limit: 50 })).length;
    await t.mutation(api.auditLog.recordDecision, { source: "message.send", outcome: "rejected", reason: "credential-in-body" });
    const after2 = (await t.query(api.auditLog.recent, { limit: 50 })).length;
    expect(after1).toBe(1);
    expect(after2).toBe(2);
  });
});
