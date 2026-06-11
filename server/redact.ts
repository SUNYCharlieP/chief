import { CREDENTIAL_PATTERNS } from "../convex/memory/privacy.js";

// PII/secret redactor (JAR-22). One implementation used by every egress path
// that sends content to a model: the ~/.claude skill-miner (gist + steps) and the
// email classifier (body + snippet). Masks emails, phone numbers, and — via the
// SHARED credential-pattern library in convex/memory/privacy.ts (JAR-7) — secrets,
// keys, JWTs, OAuth tokens, and long opaque strings. One source of credential
// patterns, shared with the memory gate's denylist.
//
// Scope note: this guards THIRD-PARTY content. First-party paths (the brain
// files, the user's own iMessages to the assistant) are deliberately NOT run
// through this — redacting the user's own data would degrade what the assistant
// can do (see JAR-22 recon).

// PII patterns are redact-ONLY (email/phone go to a private tier, they are not
// credentials and are not rejected by the memory gate's denylist).
const EMAIL = String.raw`\b[\w.+-]+@[\w-]+\.[\w.-]+\b`;
// Phone: E.164 (+1NNNNNNNNNN) and separator-formatted (NNN-NNN-NNNN, (NNN) NNN-…,
// 1-NNN-…). Separators required so a bare digit run (an order/tracking id) isn't
// masked; the lookbehind avoids matching mid-number.
const PHONE_E164 = String.raw`\+\d{10,15}\b`;
const PHONE_FMT = String.raw`(?<![\w.])(?:1[-.\s])?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?!\w)`;

export function redact(s: string): string {
  // email first; then the shared credential patterns (specific-before-generic
  // order preserved by the library); then phone (independent of credentials).
  let out = s.replace(new RegExp(EMAIL, "g"), "<email>");
  for (const p of CREDENTIAL_PATTERNS) out = out.replace(new RegExp(p.source, `${p.flags}g`), p.mask);
  out = out.replace(new RegExp(PHONE_E164, "g"), "<phone>");
  out = out.replace(new RegExp(PHONE_FMT, "g"), "<phone>");
  return out;
}
