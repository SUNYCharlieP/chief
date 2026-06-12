import { describe, it, expect } from "vitest";
import {
  PENDING_ACTION_KINDS,
  STAKES,
  stakesForKind,
} from "../convex/pendingActionKinds.js";

describe("pending action kinds + stakes", () => {
  it("pins the kind set (drift guard against the validator)", () => {
    expect([...PENDING_ACTION_KINDS]).toEqual([
      "skills.append",
      "youtube.brainstorm",
      "reminder.add",
      "job.draft_application",
      "habit.confirm",
      "calendar.add",
      "message.send",
    ]);
  });

  it("message.send is high-stakes; everything else is low", () => {
    expect(stakesForKind("message.send")).toBe("high");
    for (const k of PENDING_ACTION_KINDS) {
      if (k === "message.send") continue;
      expect(stakesForKind(k)).toBe("low");
    }
    expect(stakesForKind("calendar.add")).toBe("low");
  });

  it("stakes are exactly low | high", () => {
    expect([...STAKES]).toEqual(["low", "high"]);
  });
});
