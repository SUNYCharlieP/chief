import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "./runtimes/types.js";
import { appendSkillEntry, sha256 } from "./brain-write.js";

// Stage A draft-and-ask: on-demand Skills.md candidate drafting.
//
// Flow:
//  1. Trigger turn (LLM): the model calls stage_skill_draft with a grounded
//     pitch + the full entry, then replies with the pitch.
//  2. Consent gate (deterministic, pre-LLM): on the next user turn, if an
//     action is pending, "show" reveals the entry, an allowlisted affirmative
//     commits the write, anything else discards. The model never decides
//     consent.

const TTL_MS = 30 * 60 * 1000;
// Whole-message affirmatives. The entire normalized message must equal one of
// these; "yes but change X", "sure?", etc. do NOT consent.
const AFFIRMATIVES = new Set(["yes", "confirm", "approved", "do it"]);
const SHOW_WORD = "show";
const SHOW_LINE = 'Reply "show" to see the full entry, or "yes" to save it to Skills.md.';

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.!]+$/u, "");
}

export function createSkillTools(conversationId: string): RuntimeTool[] {
  return [
    defineRuntimeTool(
      "boop-skills",
      "stage_skill_draft",
      `Draft a Skills.md candidate when Charlie pastes or describes a workflow/technique and asks to save it as a skill ("make a skill out of this").

Produce TWO things:
- pitch: a few iMessage-native lines whose ONLY job is to make Charlie understand why this helps HIM. Include the technique in one line; the SPECIFIC friction in his current stack/workflow it removes (ground it in Context.md / Memory.md, name the real project or habit, not generic benefits); and what concretely changes if he adopts it. Do NOT put the raw Skills.md entry in the pitch.
- entry: the full structured Skills.md entry to append, matching the file's existing format (Name, when-to-use, the procedure).

Only stage if you can make a specific, honest benefit case. If you cannot, do NOT call this tool: tell Charlie it is not worth a skill and why, in one line. Never pad a weak case.

After this tool returns, send the pitch as your reply and end with the exact show-line it gives you. Never claim you saved the skill; the write happens only on Charlie's explicit confirm, handled by the system.`,
      {
        name: z.string().describe("Short kebab-case skill name."),
        pitch: z
          .string()
          .describe(
            "iMessage-native benefit case grounded in the brain files. Not the raw entry.",
          ),
        entry: z
          .string()
          .describe("Full structured Skills.md entry, in the file's existing format."),
      },
      async (args) => {
        const actionId = randomId("pa");
        const now = Date.now();
        await convex.mutation(api.pendingActions.create, {
          actionId,
          conversationId,
          kind: "skills.append",
          pitch: args.pitch,
          entry: args.entry,
          targetFile: "Skills.md",
          sha256: sha256(args.entry),
          createdAt: now,
          expiresAt: now + TTL_MS,
        });
        return runtimeText(
          `Staged skill draft ${actionId}. Reply to Charlie with the pitch text, then on its own final line add exactly:\n${SHOW_LINE}\nDo NOT paste the full entry; it is held until he confirms.`,
        );
      },
    ),
  ];
}

export interface GateResult {
  handled: boolean;
  reply?: string;
}

// Deterministic consent gate. Runs before the LLM on every non-proactive turn.
// Returns handled=false (fall through to normal handling) when there is no
// active pending action OR the message is a discard (anything that is not a
// whole-message affirmative or "show").
export async function handlePendingActionReply(
  conversationId: string,
  content: string,
): Promise<GateResult> {
  const active = await convex.query(api.pendingActions.getActive, { conversationId });
  if (!active) return { handled: false };

  const norm = normalize(content);

  if (AFFIRMATIVES.has(norm)) {
    // Mark committed before the write so a rapid duplicate can't double-commit.
    await convex.mutation(api.pendingActions.setStatus, {
      actionId: active.actionId,
      status: "committed",
    });
    const res = await appendSkillEntry(active.entry);
    const reply = res.confirmed
      ? `Saved to Skills.md (${res.bytes} bytes appended). Verified in the brain at ${res.mirrorPath}.`
      : `Submitted, not yet confirmed. Write request ${res.requestId} is queued (${res.bytes} bytes) but the brain mirror at ${res.mirrorPath} hasn't reflected it yet.`;
    return { handled: true, reply };
  }

  if (norm === SHOW_WORD) {
    await convex.mutation(api.pendingActions.markShown, { actionId: active.actionId });
    return {
      handled: true,
      reply: `Full entry that will be appended to Skills.md:\n\n${active.entry}\n\nReply "yes" to save it. Anything else discards it.`,
    };
  }

  // Anything else: no write. Discard the pending draft and let normal handling
  // take the message (e.g. a revision request re-drafts).
  await convex.mutation(api.pendingActions.setStatus, {
    actionId: active.actionId,
    status: "rejected",
  });
  return { handled: false };
}
