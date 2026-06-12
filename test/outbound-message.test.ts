import { describe, it, expect } from "vitest";
import { parseContactsConfig } from "../server/contacts.js";
import { sendToContact } from "../server/outbound-message.js";

const BOOK = parseContactsConfig(
  JSON.stringify([{ names: ["wife"], handle: "+15555550199", display: "Partner" }]),
);

describe("sendToContact — screened, isolated, dry-run stops before the real send", () => {
  it("allowlisted + clean + dryRun returns ok WITHOUT sending", async () => {
    const r = await sendToContact("wife", "see you at 7", { dryRun: true, book: BOOK });
    expect(r).toEqual({ ok: true, recipient: "Partner", dryRun: true });
  });

  it("non-allowlisted recipient never reaches the send path", async () => {
    const r = await sendToContact("stranger", "hi", { dryRun: true, book: BOOK });
    expect(r).toEqual({ ok: false, reason: "recipient-not-allowlisted" });
  });

  it("credential in the body is blocked before send, with the pattern name", async () => {
    const r = await sendToContact("wife", "the key is sk-live-zzz00001", { dryRun: true, book: BOOK });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("key-prefix");
  });
});
