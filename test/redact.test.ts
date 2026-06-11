import { describe, it, expect } from "vitest";
import { redact } from "../server/redact.js";

describe("redact — existing rules (carried over from the skill-miner)", () => {
  it("masks emails", () => {
    expect(redact("ping user@example.com please")).toBe("ping <email> please");
  });
  it("masks key prefixes", () => {
    expect(redact("key sk-live-abcdefghij")).toContain("<key>");
    expect(redact("AuthKey_FAKEKEY0000")).toContain("<key>");
    expect(redact("ghp_aBcDeFgHiJ123456")).toContain("<key>");
  });
  it("masks Bearer tokens and long hex/opaque strings", () => {
    expect(redact("Authorization: Bearer abcDEF123ghiJKL456")).toContain("Bearer <token>");
    expect(redact("h=deadbeefdeadbeefdeadbeefdeadbeef")).toContain("<hex>");
    expect(redact("t=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef")).toContain("<token>");
  });
  it("leaves ordinary text alone", () => {
    expect(redact("remind me to buy milk tomorrow")).toBe("remind me to buy milk tomorrow");
  });
});

describe("redact — NEW phone rule (JAR-22)", () => {
  it("masks E.164 numbers (BOOP_USER_PHONE / sms:+1NNN shape)", () => {
    expect(redact("call +15551234567 now")).toBe("call <phone> now");
    expect(redact("conv sms:+15551234567")).toContain("<phone>");
  });
  it("masks separator-formatted numbers", () => {
    expect(redact("call 555-123-4567")).toBe("call <phone>");
    expect(redact("call (555) 123-4567")).toBe("call <phone>");
    expect(redact("call 555.123.4567")).toBe("call <phone>");
    expect(redact("call 1-555-123-4567")).toBe("call <phone>");
  });
  it("does NOT mask a bare digit run with no separators (order/tracking id)", () => {
    expect(redact("order 5551234567")).toBe("order 5551234567");
  });
  it("does NOT mask a date as a phone", () => {
    expect(redact("due 2026-06-11")).toBe("due 2026-06-11");
  });
});

describe("redact — NEW JWT / OAuth shapes (JAR-22)", () => {
  it("masks a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM";
    expect(redact(`token ${jwt}`)).toBe("token <jwt>");
  });
  it("masks a Google ya29 OAuth token", () => {
    expect(redact("access ya29.a0AbCdEf-1234567890_xyz")).toContain("<token>");
    expect(redact("access ya29.a0AbCdEf-1234567890_xyz")).not.toContain("ya29.a0");
  });
});

describe("redact — combined third-party email body", () => {
  it("masks email + phone + key together in one body", () => {
    const out = redact("Reach Jane at jane@acme.com or 555-867-5309, key sk-live-supersecret0001");
    expect(out).toContain("<email>");
    expect(out).toContain("<phone>");
    expect(out).toContain("<key>");
    expect(out).not.toContain("jane@acme.com");
    expect(out).not.toContain("555-867-5309");
    expect(out).not.toContain("supersecret");
  });
});
