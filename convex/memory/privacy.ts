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
