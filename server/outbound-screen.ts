import { findCredential } from "../convex/memory/privacy.js";
import { resolveRecipient, type Contact, type ContactBook } from "./contacts.js";

// Two gates before Chief texts a non-Charlie recipient (JAR-26). Pure, so it's
// testable without iMessage or a deploy:
//   1) the recipient must be on the allowlist — the ONLY path, no fallback;
//   2) the body must not carry a credential shape (the JAR-7 findCredential
//      backstop). The approval gate shows Charlie the text, but a pasted key is
//      exactly what a human skims past, so we reject it before it can leave.
//
// A reject carries a REASON that is safe to log: either a fixed label
// ("recipient-not-allowlisted") or the credential PATTERN NAME (never the
// secret itself, same rule as the memory gate).
export type ScreenResult =
  | { ok: true; contact: Contact }
  | { ok: false; reason: string };

export function screenOutbound(book: ContactBook, name: string, text: string): ScreenResult {
  const contact = resolveRecipient(book, name);
  if (!contact) return { ok: false, reason: "recipient-not-allowlisted" };
  const credential = findCredential(text);
  if (credential) return { ok: false, reason: credential }; // pattern name, not the secret
  return { ok: true, contact };
}
