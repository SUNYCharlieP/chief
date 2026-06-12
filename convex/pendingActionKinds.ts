import { v } from "convex/values";

// Single source of truth for the draft-and-ask action kinds and their stakes.
// Both the schema (pendingActions table) and the create mutation import the
// validator here so the two can never drift; the server imports the type and
// stakesForKind to render/route. A convex-test exercises create() with every
// kind in PENDING_ACTION_KINDS, which fails if the validator ever falls behind
// the tuple.
export const PENDING_ACTION_KINDS = [
  "skills.append",
  "youtube.brainstorm",
  "reminder.add",
  "job.draft_application",
  "habit.confirm",
  "calendar.add", // JAR-26: add an event to Charlie's own calendar (low stakes)
  "message.send", // JAR-26: send an iMessage to an allowlisted recipient (high stakes)
] as const;
export type PendingActionKind = (typeof PENDING_ACTION_KINDS)[number];

// Explicit literals (not a spread of .map) so the union type stays precise.
// Kept in lockstep with PENDING_ACTION_KINDS by test/pending-action-kinds.test.ts
// and the convex-test that creates every kind.
export const pendingActionKindValidator = v.union(
  v.literal("skills.append"),
  v.literal("youtube.brainstorm"),
  v.literal("reminder.add"),
  v.literal("job.draft_application"),
  v.literal("habit.confirm"),
  v.literal("calendar.add"),
  v.literal("message.send"),
);

// Stakes drive the surface the app renders the action on: low = inline card
// (today's behavior), high = modal + (future) lock-screen alert. The chain that
// stages an action never knows which container shows it; the renderer routes on
// this field alone.
export const STAKES = ["low", "high"] as const;
export type Stakes = (typeof STAKES)[number];
export const stakesValidator = v.union(v.literal("low"), v.literal("high"));

// High-stakes kinds: anything that acts on a third party or is hard to take
// back. Sending a message to someone other than Charlie is the first such kind;
// writing to Charlie's own calendar is low-stakes (reversible, only affects him).
const HIGH_STAKES_KINDS: ReadonlySet<PendingActionKind> = new Set(["message.send"]);

export function stakesForKind(kind: PendingActionKind): Stakes {
  return HIGH_STAKES_KINDS.has(kind) ? "high" : "low";
}
