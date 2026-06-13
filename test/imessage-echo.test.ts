import { describe, it, expect } from "vitest";
import { noteChiefSend, _isChiefEchoForTest } from "../server/imessage.js";

// JAR-26 outbound isolation: a Chief-originated send must be recognized as a
// self-thread echo so the poller skips it instead of re-running handleUserMessage.
// sendToContact (and sendImessage) call noteChiefSend(body) BEFORE dispatching;
// this proves that makes the matching inbound echo get suppressed. Exercises the
// real isChiefEcho + recentSends, not a mock.
describe("Chief send echo suppression", () => {
  it("a noted send is suppressed (NOT re-processed as inbound)", () => {
    const now = Date.now();
    const text = "JAR-26 outbound isolation " + now; // unique per run
    // Before the send is registered, the same text WOULD be processed as inbound.
    expect(_isChiefEchoForTest(text, now)).toBe(false);
    // sendToContact/sendImessage register the body before the osascript send.
    noteChiefSend(text);
    // Now its echo is recognized + skipped -> never reaches handleUserMessage.
    expect(_isChiefEchoForTest(text, now)).toBe(true);
  });

  it("a genuinely inbound message (never sent by Chief) is NOT suppressed", () => {
    expect(_isChiefEchoForTest("real inbound " + Date.now(), Date.now())).toBe(false);
  });
});
