import { describe, it, expect } from "vitest";
import { parseContactsConfig } from "../server/contacts.js";
import { screenOutbound } from "../server/outbound-screen.js";

// Placeholder allowlist only — no real contacts in a public repo.
const BOOK = parseContactsConfig(
  JSON.stringify([{ names: ["wife"], handle: "+15555550199", display: "Partner" }]),
);

describe("screenOutbound — the two gates before Chief texts a non-Charlie recipient", () => {
  it("passes an allowlisted recipient with clean text", () => {
    const r = screenOutbound(BOOK, "wife", "running 10 min late, see you at 7");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.contact.display).toBe("Partner");
  });

  it("rejects a recipient NOT on the allowlist — the only path, no fallback", () => {
    const r = screenOutbound(BOOK, "stranger", "hi");
    expect(r).toEqual({ ok: false, reason: "recipient-not-allowlisted" });
  });

  it("rejects a body carrying a credential shape, logging the pattern NAME not the secret", () => {
    const r = screenOutbound(BOOK, "wife", "here is the key sk-live-supersecret0001");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("key-prefix"); // pattern name
      expect(JSON.stringify(r)).not.toContain("supersecret");
    }
  });

  it("allowlist gate runs before the credential gate (non-allowlisted + credential -> allowlist reason)", () => {
    const r = screenOutbound(BOOK, "stranger", "sk-live-supersecret0001");
    expect(r).toEqual({ ok: false, reason: "recipient-not-allowlisted" });
  });
});
