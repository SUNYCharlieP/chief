import { describe, it, expect } from "vitest";
import { parseContactsConfig, resolveRecipient } from "../server/contacts.js";

// Placeholder handles only (555-01xx is a reserved test range); no real
// contacts in a public repo.
const CONFIG = JSON.stringify([
  { names: ["wife", "partner"], handle: "+15555550199", display: "Partner" },
  { names: ["mom"], handle: "mom@example.com", display: "Mom" },
]);

describe("contact allowlist — the only path to a recipient", () => {
  it("resolves an allowlisted name, case-insensitively, across aliases", () => {
    const book = parseContactsConfig(CONFIG);
    expect(resolveRecipient(book, "wife")).toEqual({
      names: ["wife", "partner"],
      handle: "+15555550199",
      display: "Partner",
    });
    expect(resolveRecipient(book, "PARTNER")?.handle).toBe("+15555550199");
    expect(resolveRecipient(book, "  Mom  ")?.display).toBe("Mom");
  });

  it("returns null for a name NOT on the allowlist — no fallback resolution", () => {
    const book = parseContactsConfig(CONFIG);
    expect(resolveRecipient(book, "stranger")).toBeNull();
    expect(resolveRecipient(book, "+15555550123")).toBeNull(); // a raw handle is not a name
    expect(resolveRecipient(book, "")).toBeNull();
  });

  it("fails closed: missing or malformed config yields an empty book", () => {
    expect(resolveRecipient(parseContactsConfig(undefined), "wife")).toBeNull();
    expect(resolveRecipient(parseContactsConfig(""), "wife")).toBeNull();
    expect(resolveRecipient(parseContactsConfig("not json"), "wife")).toBeNull();
    expect(resolveRecipient(parseContactsConfig('{"not":"an array"}'), "wife")).toBeNull();
  });

  it("ignores incomplete entries (never half-resolves a recipient)", () => {
    const book = parseContactsConfig(
      JSON.stringify([
        { names: ["nohandle"], display: "X" }, // missing handle
        { handle: "+15555550100", display: "Y" }, // missing names
        { names: ["good"], handle: "+15555550101", display: "Good" },
      ]),
    );
    expect(resolveRecipient(book, "nohandle")).toBeNull();
    expect(resolveRecipient(book, "good")?.handle).toBe("+15555550101");
  });
});
