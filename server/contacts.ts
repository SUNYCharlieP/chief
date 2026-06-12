// Recipient allowlist (JAR-26). This is the security boundary for a brand-new
// capability — Chief sending iMessages to people other than Charlie. The
// allowlist is the ONLY path to a recipient: there is no fallback "resolve
// whoever" lookup (no macOS Contacts query), so a name that isn't configured
// resolves to null and the caller MUST reject + log it (same reject-and-log
// shape as the JAR-7 privacy gate). The config doubles as the resolver and the
// gate: if you're not in the book, Chief cannot text you.
//
// The book is loaded from the CHIEF_CONTACTS env var (a JSON array), NEVER from
// a committed file — real handles are PII and this is a public repo. Format:
//   [{ "names": ["wife", "partner"], "handle": "+1...", "display": "Partner" }]
// Fail closed: missing or malformed config yields an EMPTY book, so no recipient
// resolves until it is deliberately configured.

export interface Contact {
  handle: string; // iMessage handle: phone (+E.164) or the chat identifier
  display: string; // human label shown on the approval card (never the raw handle)
  names: string[]; // lowercased aliases this contact answers to
}

export interface ContactBook {
  byName: Map<string, Contact>;
}

export function parseContactsConfig(raw: string | undefined): ContactBook {
  const byName = new Map<string, Contact>();
  if (!raw || !raw.trim()) return { byName };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { byName }; // malformed -> empty book (fail closed)
  }
  if (!Array.isArray(parsed)) return { byName };
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const handle = typeof o.handle === "string" ? o.handle.trim() : "";
    const display = typeof o.display === "string" ? o.display.trim() : "";
    const rawNames = Array.isArray(o.names)
      ? o.names
      : typeof o.name === "string"
        ? [o.name]
        : [];
    const names = rawNames
      .filter((n): n is string => typeof n === "string")
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean);
    // An entry missing any of handle/display/names is incomplete and ignored —
    // we never half-resolve a recipient.
    if (!handle || !display || names.length === 0) continue;
    const contact: Contact = { handle, display, names };
    for (const n of names) byName.set(n, contact);
  }
  return { byName };
}

// The ONLY path to a recipient. A name not in the book returns null — there is
// no fallback. Callers treat null as "reject and log", never as "send anyway".
export function resolveRecipient(book: ContactBook, name: string): Contact | null {
  const key = (name ?? "").trim().toLowerCase();
  if (!key) return null;
  return book.byName.get(key) ?? null;
}

// Process-wide book, loaded once from the environment at import time.
export const CONTACT_BOOK = parseContactsConfig(process.env.CHIEF_CONTACTS);
