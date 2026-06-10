import { convex } from "./convex-client.js";
import { api } from "../convex/_generated/api.js";

// JAR-16 morning delivery: surface ONE collected skill candidate as a
// draft-and-ask card. Same shape as the habit confirmation (habits-brief.ts):
// post the pitch as its OWN message and bind the card to THAT message — never to
// the brief, because a message with a card renders card-only and would hide the
// brief. Sequential: if any action is already pending (e.g. a habit confirm took
// today's slot), skip — the candidate stays collected for a later morning.

const CONV = "app:charlie";

export async function stageSkillCandidate(): Promise<void> {
  // One card at a time. A pending habit confirm (or anything) holds the slot.
  const active = await convex.query(api.pendingActions.getActive, { conversationId: CONV }).catch(() => null);
  if (active) return;

  const collected = await convex.query(api.skillCandidates.listByStatus, { status: "collected", limit: 20 });
  if (collected.length === 0) return;

  // Highest-occurrence collected candidate first (most-repeated workflow).
  const pick = [...collected].sort((a, b) => b.occurrences - a.occurrences)[0];
  let entry = "";
  try {
    const ev = JSON.parse(pick.evidence) as { entry?: unknown };
    if (typeof ev.entry === "string") entry = ev.entry.trim();
  } catch {
    /* malformed evidence: nothing to write, skip */
  }
  if (!entry) return;

  await convex.mutation(api.messages.send, {
    conversationId: CONV,
    role: "assistant",
    content: `I noticed a repeated workflow: ${pick.title}. Add it to your skills?`,
    complete: true,
  });

  const now = Date.now();
  await convex.mutation(api.pendingActions.create, {
    actionId: `skill-${pick.candidateId}`,
    conversationId: CONV,
    kind: "skills.append",
    pitch: pick.rationale || `Add "${pick.title}" as a skill?`,
    entry, // the EXACT drafted entry the writer will append on approval
    targetFile: "",
    sha256: "",
    candidateId: pick.candidateId,
    createdAt: now,
    expiresAt: now + 36 * 3_600_000, // 36h: covers the morning it surfaced
  });

  // Mark surfaced — next morning's sweepSurfaced declines it if left un-acted,
  // so a passed-over candidate isn't re-nagged daily.
  await convex.mutation(api.skillCandidates.setStatus, {
    candidateId: pick.candidateId,
    status: "surfaced",
  });
}
