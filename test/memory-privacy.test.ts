import { describe, it, expect } from "vitest";
import {
  MEMORY_TIERS,
  MEMORY_SEGMENTS,
  tierForSegment,
  findCredential,
  classifyMemory,
  previewOf,
  buildAuditRow,
  AUDIT_PREVIEW_MAX,
  type MemoryTier,
} from "../convex/memory/privacy.js";

describe("tier union — closed, tier4 is structural absence", () => {
  it("has exactly the three privacy tiers", () => {
    expect([...MEMORY_TIERS]).toEqual(["tier1_knowledge", "tier2_private", "tier3_vault"]);
  });

  it("tier4 is UNCONSTRUCTABLE (compile-time + runtime)", () => {
    // @ts-expect-error — "tier4_vault" is not a member of the closed MemoryTier
    // union. If a tier4 were ever added, this line would compile and tsc would
    // flag the now-unused expectation, failing the build. That's the guardrail.
    const attempt: MemoryTier = "tier4_vault";
    void attempt;
    expect([...MEMORY_TIERS]).not.toContain("tier4_vault");
    expect(MEMORY_TIERS).toHaveLength(3);
  });
});

describe("segment -> privacyTier mapping", () => {
  it("knowledge=tier1, preference/project/context=tier2, identity/relationship/correction=tier3", () => {
    expect(tierForSegment("knowledge")).toBe("tier1_knowledge");
    for (const s of ["preference", "project", "context"] as const) {
      expect(tierForSegment(s)).toBe("tier2_private");
    }
    for (const s of ["identity", "relationship", "correction"] as const) {
      expect(tierForSegment(s)).toBe("tier3_vault");
    }
  });

  it("covers every segment (no gaps)", () => {
    for (const s of MEMORY_SEGMENTS) expect(MEMORY_TIERS).toContain(tierForSegment(s));
  });
});

describe("denylist — rejects each credential shape", () => {
  it("flags each credential class by name", () => {
    expect(findCredential("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.SflKxwRJSMeKKF2QT")).toBe("jwt");
    expect(findCredential("access ya29.a0AbCdEf-1234567890_xyz")).toBe("oauth-ya29");
    expect(findCredential("key sk-live-abcdefghijklmnop")).toBe("key-prefix");
    expect(findCredential("Authorization: Bearer abcDEF123ghiJKL")).toBe("bearer");
    expect(findCredential("password: hunter2")).toBe("password-context");
    expect(findCredential("pwd=s3cr3t")).toBe("password-context");
    expect(findCredential("h deadbeefdeadbeefdeadbeefdeadbeef")).toBe("long-hex");
    expect(findCredential("t ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef")).toBe("long-opaque");
  });
});

describe("denylist — does NOT reject benign content (false-positive guards)", () => {
  it("spares ordinary prose, including PII (which is redacted, not rejected)", () => {
    expect(findCredential("Charlie prefers morning workouts")).toBeNull();
    expect(findCredential("I forgot my password again")).toBeNull(); // no :/= -> not a credential
    expect(findCredential("the project deadline is Friday")).toBeNull();
    expect(findCredential("call me at 555-123-4567")).toBeNull(); // phone = PII, not a credential
    expect(findCredential("email me at a@b.com")).toBeNull(); // email = PII, not a credential
  });
});

describe("classifyMemory — the gate", () => {
  it("REJECTS credential-shaped content (tier 4 = reject, never stored)", () => {
    const r = classifyMemory("my key is sk-live-supersecret0001", "knowledge");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejected).toBe("key-prefix");
  });

  it("denylist runs BEFORE the segment mapping (credential in any segment is rejected)", () => {
    expect(classifyMemory("Bearer abcDEF123ghiJKL", "identity").ok).toBe(false);
  });

  it("classifies clean content by segment", () => {
    expect(classifyMemory("Charlie is a flooring contractor", "identity")).toEqual({ ok: true, tier: "tier3_vault" });
    expect(classifyMemory("tsc --noEmit catches type errors", "knowledge")).toEqual({ ok: true, tier: "tier1_knowledge" });
    expect(classifyMemory("Charlie likes dark mode", "preference")).toEqual({ ok: true, tier: "tier2_private" });
  });
});

describe("previewOf — bounded, single-line", () => {
  it("collapses whitespace and leaves short content intact", () => {
    expect(previewOf("  Charlie   likes\n dark   mode ")).toBe("Charlie likes dark mode");
  });
  it("caps length and marks truncation", () => {
    const long = "x".repeat(200);
    const p = previewOf(long);
    expect(p.length).toBe(AUDIT_PREVIEW_MAX);
    expect(p.endsWith("…")).toBe(true);
  });
});

describe("buildAuditRow — rejected rows log the pattern NAME, never content", () => {
  it("a rejected row carries the pattern name and NOTHING else identifying", () => {
    const row = buildAuditRow({ source: "tool", outcome: "rejected", rejectedPattern: "key-prefix" });
    expect(row).toEqual({ source: "tool", outcome: "rejected", rejectedPattern: "key-prefix" });
    // No content-bearing fields on a rejection — by construction.
    expect(row.preview).toBeUndefined();
    expect(row.memoryId).toBeUndefined();
    expect(row.privacyTier).toBeUndefined();
  });

  it("the rejected row never contains the offending content", () => {
    // The caller only ever has the pattern NAME (from classifyMemory), so even
    // by intent it cannot place the secret here. Assert the secret is absent.
    const secret = "sk-live-supersecret0001";
    const row = buildAuditRow({ source: "extraction", outcome: "rejected", rejectedPattern: "key-prefix" });
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(JSON.stringify(row)).not.toContain("supersecret");
  });

  it("an accepted row carries tier, memoryId, and a clean preview", () => {
    const row = buildAuditRow({
      source: "extraction",
      outcome: "accepted",
      privacyTier: "tier2_private",
      memoryId: "mem_abc",
      preview: "Charlie likes dark mode",
    });
    expect(row).toEqual({
      source: "extraction",
      outcome: "accepted",
      privacyTier: "tier2_private",
      memoryId: "mem_abc",
      preview: "Charlie likes dark mode",
    });
    expect(row.rejectedPattern).toBeUndefined();
  });
});
