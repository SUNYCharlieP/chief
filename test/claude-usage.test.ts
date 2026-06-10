import { describe, it, expect } from "vitest";
import { aggregateUsage, type UsageRecord } from "../server/claude-usage.js";

// Terse record builder. Defaults to a live (non-sidechain, non-synthetic)
// assistant line so each test overrides only what it exercises.
function rec(p: Partial<UsageRecord> & Pick<UsageRecord, "sessionId" | "localDate">): UsageRecord {
  return {
    hour: 13,
    kind: "assistant",
    model: "claude-opus-4-8",
    synthetic: false,
    sidechain: false,
    toolResult: false,
    outputTokens: 0,
    inputTokens: 0,
    ...p,
  };
}

// A session needs a user line to count; pair an assistant line with one.
function session(id: string, date: string, extra: Partial<UsageRecord> = {}): UsageRecord[] {
  return [
    rec({ sessionId: id, localDate: date, kind: "user", model: null }),
    rec({ sessionId: id, localDate: date, ...extra }),
  ];
}

describe("aggregateUsage — counting + filtering", () => {
  it("counts a real session: one user + one assistant message", () => {
    const r = aggregateUsage(session("s1", "2026-06-10"), { today: "2026-06-10" });
    expect(r.sessions).toBe(1);
    expect(r.messages).toBe(2);
  });

  it("drops sidechain (subagent) sessions entirely", () => {
    const records = [
      ...session("real", "2026-06-10"),
      rec({ sessionId: "sub", localDate: "2026-06-10", kind: "user", model: null, sidechain: true }),
      rec({ sessionId: "sub", localDate: "2026-06-10", sidechain: true, outputTokens: 999 }),
    ];
    const r = aggregateUsage(records, { today: "2026-06-10" });
    expect(r.sessions).toBe(1);
    expect(r.outputTokens).toBe(0); // sidechain tokens excluded
  });

  it("drops the <synthetic> pseudo-model from tokens and favorite", () => {
    const records = [
      ...session("s1", "2026-06-10", { model: "claude-opus-4-8", outputTokens: 100 }),
      rec({ sessionId: "s1", localDate: "2026-06-10", model: "<synthetic>", synthetic: true, outputTokens: 5000 }),
    ];
    const r = aggregateUsage(records, { today: "2026-06-10" });
    expect(r.outputTokens).toBe(100);
    expect(r.favoriteModel).toBe("claude-opus-4-8");
  });

  it("does not count tool_result lines as messages (CC logs them as type:user)", () => {
    const records = [
      ...session("s1", "2026-06-10"), // 1 real prompt + 1 assistant = 2 messages
      rec({ sessionId: "s1", localDate: "2026-06-10", kind: "user", model: null, toolResult: true }),
      rec({ sessionId: "s1", localDate: "2026-06-10", kind: "user", model: null, toolResult: true }),
    ];
    const r = aggregateUsage(records, { today: "2026-06-10" });
    expect(r.messages).toBe(2);
  });

  it("ignores a session with no user message (e.g. orphan/empty log)", () => {
    const records = [rec({ sessionId: "ghost", localDate: "2026-06-10", outputTokens: 50 })];
    const r = aggregateUsage(records, { today: "2026-06-10" });
    expect(r.sessions).toBe(0);
    expect(r.messages).toBe(0);
    expect(r.outputTokens).toBe(0);
  });
});

describe("aggregateUsage — tokens", () => {
  it("headline = output; secondary = input+output (cache never enters)", () => {
    // cache lives only in cache_* fields the normalizer drops; records here
    // already exclude it, so input is the real prompt input only.
    const records = session("s1", "2026-06-10", { outputTokens: 300, inputTokens: 40 });
    const r = aggregateUsage(records, { today: "2026-06-10" });
    expect(r.outputTokens).toBe(300);
    expect(r.totalTokens).toBe(340);
  });
});

describe("aggregateUsage — streaks (consecutive local days)", () => {
  it("current streak counts back from today", () => {
    const records = [
      ...session("a", "2026-06-08"),
      ...session("b", "2026-06-09"),
      ...session("c", "2026-06-10"),
    ];
    const r = aggregateUsage(records, { today: "2026-06-10" });
    expect(r.currentStreak).toBe(3);
    expect(r.longestStreak).toBe(3);
    expect(r.activeDays).toBe(3);
  });

  it("yesterday still counts as current (today not yet active)", () => {
    const records = [...session("a", "2026-06-08"), ...session("b", "2026-06-09")];
    const r = aggregateUsage(records, { today: "2026-06-10" });
    expect(r.currentStreak).toBe(2);
  });

  it("a >1-day gap zeroes the current streak but keeps the longest", () => {
    const records = [
      ...session("a", "2026-06-01"),
      ...session("b", "2026-06-02"),
      ...session("c", "2026-06-03"),
      ...session("d", "2026-06-07"), // gap; today is 06-10 -> not current
    ];
    const r = aggregateUsage(records, { today: "2026-06-10" });
    expect(r.currentStreak).toBe(0);
    expect(r.longestStreak).toBe(3);
  });

  it("multiple sessions on one day are a single active day", () => {
    const records = [...session("a", "2026-06-10"), ...session("b", "2026-06-10")];
    const r = aggregateUsage(records, { today: "2026-06-10" });
    expect(r.sessions).toBe(2);
    expect(r.activeDays).toBe(1);
    expect(r.currentStreak).toBe(1);
  });
});

describe("aggregateUsage — peak hour + favorite model + grid", () => {
  it("peak hour is the local hour with the most messages", () => {
    const records = [
      ...session("a", "2026-06-10", { hour: 9 }),
      rec({ sessionId: "a", localDate: "2026-06-10", hour: 18 }),
      rec({ sessionId: "a", localDate: "2026-06-10", hour: 18 }),
    ];
    // user line defaults to hour 13; assistants at 9,18,18 -> 18 wins.
    const r = aggregateUsage(records, { today: "2026-06-10" });
    expect(r.peakHour).toBe(18);
  });

  it("favorite model is the most-used by message count", () => {
    const records = [
      ...session("a", "2026-06-10", { model: "claude-sonnet-4-6" }),
      rec({ sessionId: "a", localDate: "2026-06-10", model: "claude-opus-4-8" }),
      rec({ sessionId: "a", localDate: "2026-06-10", model: "claude-opus-4-8" }),
    ];
    const r = aggregateUsage(records, { today: "2026-06-10" });
    expect(r.favoriteModel).toBe("claude-opus-4-8");
  });

  it("perDay is ascending and carries per-day message counts for the grid", () => {
    const records = [...session("a", "2026-06-09"), ...session("b", "2026-06-10")];
    const r = aggregateUsage(records, { today: "2026-06-10" });
    expect(r.perDay.map((d) => d.date)).toEqual(["2026-06-09", "2026-06-10"]);
    expect(r.perDay[0].count).toBe(2);
    expect(r.firstDay).toBe("2026-06-09");
  });
});

describe("aggregateUsage — empty", () => {
  it("returns zeros and nulls on no records", () => {
    const r = aggregateUsage([], { today: "2026-06-10" });
    expect(r).toMatchObject({
      sessions: 0,
      messages: 0,
      outputTokens: 0,
      totalTokens: 0,
      activeDays: 0,
      currentStreak: 0,
      longestStreak: 0,
      peakHour: null,
      favoriteModel: null,
      firstDay: null,
    });
    expect(r.perDay).toEqual([]);
  });
});
