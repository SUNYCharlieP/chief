import { convex } from "./convex-client.js";
import { api } from "../convex/_generated/api.js";
import { submitReminderAdd, humanDate } from "./reminders-write.js";
import { draftApplicationFraming, type JobDraftInput } from "./job-draft.js";

// The draft-and-ask action layer. A pending action (created by a staging tool,
// e.g. stage_reminder) is surfaced to Charlie as an "action" card and executes
// ONLY on his explicit approval — never on creation. Approval is identity-tied:
// the approve/reject endpoints verify the actionId is the conversation's single
// active pending action, so a stray "yes"/tap can't approve the wrong one.
//
// Reusable: a new action kind = a new case in executeAction + a description in
// actionCardFor. The job watcher's "draft application framing" plugs in here.

export interface ActionCard {
  type: "action";
  actionId: string;
  kind: string;
  title: string; // short label, e.g. "Add reminder"
  description: string; // exactly what approving will do
  expiresAt: number; // epoch ms
}

interface PendingAction {
  actionId: string;
  kind: string;
  entry: string;
  pitch: string;
  expiresAt: number;
  createdAt: number;
}

// Build the action card the app renders (approve/reject). Description states
// exactly what executing will do, derived from the drafted payload.
export function actionCardFor(action: PendingAction): ActionCard {
  let title = "Action";
  let description = action.pitch || "";
  if (action.kind === "reminder.add") {
    title = "Add reminder";
    try {
      const r = JSON.parse(action.entry) as { title: string; dueISO: string; list: string; amount?: string | null };
      description = `Add “${r.title}”${r.amount ? ` (${r.amount})` : ""} due ${humanDate(r.dueISO)} to ${r.list}`;
    } catch {
      description = "Add a reminder";
    }
  } else if (action.kind === "job.draft_application") {
    title = "Draft application";
    try {
      const j = JSON.parse(action.entry) as JobDraftInput;
      description = `Draft application framing for ${j.title} at ${j.company} (I draft only — never apply)`;
    } catch {
      description = "Draft application framing for this role (I draft only — never apply)";
    }
  }
  return {
    type: "action",
    actionId: action.actionId,
    kind: action.kind,
    title,
    description,
    expiresAt: action.expiresAt,
  };
}

// Execute the drafted action. Dispatch by kind; reuses the real capability
// (reminder add goes through submitReminderAdd, with its date guard + requestId
// confirm). Shared by the "yes" reply gate and the approve endpoint.
export async function executeAction(action: PendingAction): Promise<{ ok: boolean; reply: string }> {
  switch (action.kind) {
    case "reminder.add": {
      let req: { title: string; dueISO: string; list: string; amount?: string | null };
      try {
        req = JSON.parse(action.entry);
      } catch {
        return { ok: false, reply: "That reminder draft was malformed; nothing was added." };
      }
      const res = await submitReminderAdd(req);
      return res.confirmed
        ? { ok: true, reply: `Added to ${req.list}, due ${res.due}. ✓` }
        : { ok: false, reply: `Submitted, but I could NOT confirm “${req.title}” landed in ${req.list}. Do not count on it.` };
    }
    case "job.draft_application": {
      let j: JobDraftInput;
      try {
        j = JSON.parse(action.entry);
      } catch {
        return { ok: false, reply: "That job draft was malformed; nothing was drafted." };
      }
      // Drafts framing for Charlie to use — NEVER applies or sends.
      return draftApplicationFraming(j);
    }
    default:
      return { ok: false, reply: `Don't know how to execute action kind "${action.kind}".` };
  }
}

// Approve by identity: the actionId must be the conversation's single active
// (pending, unexpired) action. Marks committed BEFORE executing so a double-tap
// can't double-run, executes, and persists a confirmation message.
export async function approvePendingAction(
  conversationId: string,
  actionId: string,
): Promise<{ ok: boolean; reply: string }> {
  const active = await convex.query(api.pendingActions.getActive, { conversationId });
  if (!active || active.actionId !== actionId) {
    return { ok: false, reply: "That action is no longer pending — it was already decided, expired, or replaced." };
  }
  await convex.mutation(api.pendingActions.setStatus, { actionId, status: "committed" });
  const result = await executeAction(active);
  await convex.mutation(api.messages.send, {
    conversationId,
    role: "assistant",
    content: result.reply,
    complete: true,
  });
  return result;
}

export async function rejectPendingAction(
  conversationId: string,
  actionId: string,
): Promise<{ ok: boolean; reply: string }> {
  const active = await convex.query(api.pendingActions.getActive, { conversationId });
  if (!active || active.actionId !== actionId) {
    return { ok: false, reply: "That action is no longer pending." };
  }
  await convex.mutation(api.pendingActions.setStatus, { actionId, status: "rejected" });
  const reply = "Discarded — nothing was changed.";
  await convex.mutation(api.messages.send, {
    conversationId,
    role: "assistant",
    content: reply,
    complete: true,
  });
  return { ok: true, reply };
}
