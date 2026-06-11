// JAR-7 — the privacy module: the foundation every memory write passes through.
// Pure (no Convex-runtime or node imports), so BOTH the Convex mutation (the
// structural gate) and the server (redact.ts, brain-write.ts) import it — one
// source of truth, exactly like convex/habits/streak.ts. Pure-function-first.

// ---- Tier union — closed, single-sourced (the streak.ts idiom) --------------
// PRIVACY tiers. Orthogonal to memoryRecords' existing `tier` (retention:
// short/long/permanent) and `segment` (category). Tier 4 is NOT a member: it
// exists ONLY as structural absence — credential-shaped content is REJECTED at
// the gate, never assigned a tier and never stored. A `@ts-expect-error` test
// asserts "tier4" is unconstructable.
export const MEMORY_TIERS = ["tier1_knowledge", "tier2_private", "tier3_vault"] as const;
export type MemoryTier = (typeof MEMORY_TIERS)[number];

export const MEMORY_SEGMENTS = [
  "identity",
  "preference",
  "correction",
  "relationship",
  "project",
  "knowledge",
  "context",
] as const;
export type MemorySegment = (typeof MEMORY_SEGMENTS)[number];

// Privacy tier derived from segment. ONE named function so it's trivial to
// retune when real data shows mis-tiering. Most-private (vault) =
// identity/relationship/correction; private = preference/project/context;
// knowledge is the shareable tier.
const SEGMENT_TIER: Record<MemorySegment, MemoryTier> = {
  knowledge: "tier1_knowledge",
  preference: "tier2_private",
  project: "tier2_private",
  context: "tier2_private",
  identity: "tier3_vault",
  relationship: "tier3_vault",
  correction: "tier3_vault",
};

export function tierForSegment(segment: MemorySegment): MemoryTier {
  return SEGMENT_TIER[segment];
}

// ---- Tier-4 denylist — the shared credential-pattern library ----------------
// THE single source of credential patterns: redact.ts imports these (masking)
// and the gate uses them (rejection). Source strings (no global flag) so a fresh
// RegExp is built per use — no lastIndex statefulness between .test() and
// .replace(). Email/phone are PII (redacted, NOT rejected) and live in redact.ts.
export interface CredentialPattern {
  name: string;
  source: string; // regex body, no flags
  flags: string; // base flags (e.g. "i"); callers add "g" for replace
  mask: string; // redaction replacement
}

export const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  // specific shapes first, generic catch-alls last (so a key isn't masked as a
  // bare token).
  { name: "jwt", source: String.raw`\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+)?`, flags: "", mask: "<jwt>" },
  { name: "oauth-ya29", source: String.raw`\bya29\.[A-Za-z0-9_-]{10,}`, flags: "", mask: "<token>" },
  { name: "key-prefix", source: String.raw`\b(?:sk-|ghp_|gho_|github_pat_|xox[baprs]-|AKIA|AuthKey_)[A-Za-z0-9_-]+`, flags: "", mask: "<key>" },
  { name: "bearer", source: String.raw`\bBearer\s+[A-Za-z0-9._-]+`, flags: "i", mask: "Bearer <token>" },
  // Narrow contextual password rule only (a fuzzy matcher would reject prose).
  { name: "password-context", source: String.raw`(?:password|passwd|pwd)\s*[:=]\s*\S+`, flags: "i", mask: "<credential>" },
  { name: "long-hex", source: String.raw`\b[A-Fa-f0-9]{32,}\b`, flags: "", mask: "<hex>" },
  { name: "long-opaque", source: String.raw`\b[A-Za-z0-9_-]{40,}\b`, flags: "", mask: "<token>" },
];

// The first credential pattern that matches, or null. Fresh RegExp each call.
export function findCredential(text: string): string | null {
  for (const p of CREDENTIAL_PATTERNS) {
    if (new RegExp(p.source, p.flags).test(text)) return p.name;
  }
  return null;
}

// ---- The gate ---------------------------------------------------------------
export type Classification =
  | { ok: true; tier: MemoryTier }
  | { ok: false; rejected: string }; // rejected = the credential pattern name (tier 4)

// Credential-shaped content is REJECTED outright — never redacted-and-stored
// (the structural version of the leak). Clean content gets a privacy tier from
// its segment.
export function classifyMemory(content: string, segment: MemorySegment): Classification {
  const credential = findCredential(content);
  if (credential) return { ok: false, rejected: credential };
  return { ok: true, tier: tierForSegment(segment) };
}

// ---------------------------------------------------------------------------
// Audit rows. The audit log records every gate decision. The cardinal rule:
// a REJECTED row logs the credential pattern NAME, never the credential
// content (logging the rejected secret would be a second leak). That rule is
// enforced here by the type system, not by reviewer vigilance: the input is a
// discriminated union, so a "rejected" row is structurally incapable of
// carrying content/preview, and an "accepted" row carries only its tier, the
// memoryId it landed at, and a short preview of the (already-clean) content.
// ---------------------------------------------------------------------------

export const AUDIT_PREVIEW_MAX = 80;

// A one-line, length-capped preview of clean content for accepted audit rows.
// Only ever called on content that already passed the gate, so there is no
// credential to leak; this just keeps the audit log readable and bounded.
export function previewOf(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length <= AUDIT_PREVIEW_MAX
    ? oneLine
    : oneLine.slice(0, AUDIT_PREVIEW_MAX - 1) + "…";
}

// The auditLog row minus `at` (the Convex write stamps the time). Mirrors the
// auditLog table validator in schema.ts.
export interface AuditRow {
  source: string;
  outcome: "accepted" | "rejected";
  privacyTier?: MemoryTier;
  memoryId?: string;
  preview?: string;
  rejectedPattern?: string;
}

// Discriminated input: a rejected row can ONLY be built from a pattern name; an
// accepted row can ONLY be built with a tier, memoryId, and preview. There is
// no way to attach content to a rejected row — that is the leak prevention.
export type AuditRowInput =
  | { source: string; outcome: "rejected"; rejectedPattern: string }
  | {
      source: string;
      outcome: "accepted";
      privacyTier: MemoryTier;
      memoryId: string;
      preview: string;
    };

export function buildAuditRow(input: AuditRowInput): AuditRow {
  if (input.outcome === "rejected") {
    // Pattern name only. No content, no preview — by construction.
    return { source: input.source, outcome: "rejected", rejectedPattern: input.rejectedPattern };
  }
  return {
    source: input.source,
    outcome: "accepted",
    privacyTier: input.privacyTier,
    memoryId: input.memoryId,
    preview: input.preview,
  };
}
