// Shared PII/secret redactor (JAR-22). One implementation used by every egress
// path that sends content to a model: the ~/.claude skill-miner (gist + steps)
// and the email classifier (body + snippet). Masks emails, secrets/keys, JWTs,
// OAuth tokens, phone numbers, and long opaque strings.
//
// Scope note: this guards THIRD-PARTY content. First-party paths (the brain
// files, the user's own iMessages to the assistant) are deliberately NOT run
// through this — redacting the user's own data would degrade what the assistant
// can do (see JAR-22 recon).
export function redact(s: string): string {
  return s
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "<email>")
    // JWTs (eyJ…) and Google OAuth (ya29.…) before the generic token rule so
    // they mask cleanly; both prefixes are distinctive -> negligible false-positive.
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+)?/g, "<jwt>")
    .replace(/\bya29\.[A-Za-z0-9_-]{10,}/g, "<token>")
    .replace(/\b(?:sk-|ghp_|gho_|github_pat_|xox[baprs]-|AKIA|AuthKey_)[A-Za-z0-9_-]+/g, "<key>")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer <token>")
    // Phone numbers: E.164 (+1NNNNNNNNNN, catches BOOP_USER_PHONE / sms:+1NNN) and
    // separator-formatted (NNN-NNN-NNNN, (NNN) NNN-NNNN, NNN.NNN.NNNN, 1-NNN-…).
    // Separators are REQUIRED in the formatted rule so a bare run of digits (an
    // order/tracking id) isn't masked; the lookbehind avoids matching mid-number.
    .replace(/\+\d{10,15}\b/g, "<phone>")
    .replace(/(?<![\w.])(?:1[-.\s])?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?!\w)/g, "<phone>")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "<hex>")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "<token>");
}
