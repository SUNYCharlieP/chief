import { convex } from "./convex-client.js";
import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import { submitReminderAdd, humanDate } from "./reminders-write.js";
import { draftApplicationFraming, type JobDraftInput } from "./job-draft.js";
import { appendSkillEntry, CredentialRejectedError } from "./brain-write.js";
import { sendToContact } from "./outbound-message.js";
import { parseCalendarEntry } from "./calendar-entry.js";
import { submitCalendarAdd } from "./calendar-write.js";
import { stakesForKind, type PendingActionKind, type Stakes } from "../convex/pendingActionKinds.js";

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
  stakes: Stakes; // surface routing: low = inline card, high = modal (JAR-26)
  title: string; // short label, e.g. "Add reminder"
  description: string; // exactly what approving will do
  expiresAt: number; // epoch ms
}

interface PendingAction {
  actionId: string;
  kind: string;
  stakes?: Stakes; // set at create; defaulted from kind for older rows
  entry: string;
  pitch: string;
  expiresAt: number;
  createdAt: number;
  candidateId?: string; // skills.append: the skillCandidate this resolves
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
  } else if (action.kind === "habit.confirm") {
    title = "Confirm habit";
    try {
      const h = JSON.parse(action.entry) as { name: string; date: string };
      description = `Did you ${h.name} yesterday (${h.date})? Approve = done, reject = missed.`;
    } catch {
      description = "Confirm whether you did this habit yesterday.";
    }
  } else if (action.kind === "skills.append") {
    title = "Add skill";
    // The entry IS the drafted Skills.md markdown; show it so approval is
    // informed — approving writes exactly this to the canonical brain.
    description = `Add this to your skills (writes to Skills.md on approve):\n\n${action.entry}`;
  } else if (action.kind === "message.send") {
    title = "Send message";
    try {
      const m = JSON.parse(action.entry) as { display: string; text: string };
      description = `Send to ${m.display}:\n\n“${m.text}”`;
    } catch {
      description = "Send a message.";
    }
  } else if (action.kind === "calendar.add") {
    title = "Add to calendar";
    const parsed = parseCalendarEntry(action.entry);
    if (parsed.ok) {
      const e = parsed.entry;
      const t = e.startISO.match(/T(\d{2}):(\d{2})/);
      const time = t ? ` ${Number(t[1]) % 12 || 12}:${t[2]} ${Number(t[1]) < 12 ? "AM" : "PM"}` : "";
      description = `Add “${e.title}” to your calendar on ${humanDate(e.startISO)}${time}${e.location ? ` at ${e.location}` : ""}`;
    } else {
      description = "Add an event to your calendar.";
    }
  }
  return {
    type: "action",
    actionId: action.actionId,
    kind: action.kind,
    // Route the surface on stakes; default from the kind for rows created before
    // the field existed, so an old high-stakes kind can never fall back to inline.
    stakes: action.stakes ?? stakesForKind(action.kind as PendingActionKind),
    title,
    description,
    expiresAt: action.expiresAt,
  };
}

// Execute the drafted action. Dispatch by kind; reuses the real capability
// (reminder add goes through submitReminderAdd, with its date guard + requestId
// confirm). Shared by the "yes" reply gate and the approve endpoint.
//
// messageKind (optional) tags the persisted confirmation message so GET
// /messages can render it as something other than plain prose — e.g. job draft
// output comes back as "draft.application" so the app shows a copyable block.
export async function executeAction(
  action: PendingAction,
): Promise<{ ok: boolean; reply: string; messageKind?: string }> {
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
      // Drafts framing for Charlie to use — NEVER applies or sends. On success
      // tag the message as draft output so the app renders a copyable block.
      const res = await draftApplicationFraming(j);
      return res.ok ? { ...res, messageKind: "draft.application" } : res;
    }
    case "habit.confirm": {
      // Approve = "yes, I did it" -> log yesterday completed. (Reject writes
      // missed; see rejectPendingAction.)
      let h: { habitId: string; date: string; name: string; today: string };
      try {
        h = JSON.parse(action.entry);
      } catch {
        return { ok: false, reply: "That habit confirmation was malformed; nothing was logged." };
      }
      try {
        await convex.mutation(api.habits.functions.setDay, {
          habitId: h.habitId as Id<"habits">,
          date: h.date,
          today: h.today,
          status: "completed",
        });
        return { ok: true, reply: `Logged “${h.name}” done for ${h.date}. ✓` };
      } catch (err) {
        return { ok: false, reply: `Couldn't log “${h.name}”: ${String(err)}` };
      }
    }
    case "skills.append": {
      // Approve = write the drafted entry to the canonical Skills.md, via the
      // spool + GUI-session brain-writer (the only authority that can write
      // iCloud). appendSkillEntry confirms the round-trip against the canonical
      // file before returning. On success, mark the candidate skilled.
      const entry = action.entry?.trim() ?? "";
      if (!entry) return { ok: false, reply: "That skill draft was empty; nothing was written." };
      let res;
      try {
        res = await appendSkillEntry(entry);
      } catch (err) {
        // Privacy gate (JAR-7): credential-shaped content is rejected before any
        // write. Report it (pattern name only); never echo the content.
        if (err instanceof CredentialRejectedError) {
          return { ok: false, reply: `Not written: the skill draft looked like it contained a credential (${err.pattern}) and was rejected.` };
        }
        throw err;
      }
      if (!res.confirmed) {
        return { ok: false, reply: "Submitted the skill, but I could NOT confirm it landed in Skills.md. Not counting it as written." };
      }
      if (action.candidateId) {
        await convex
          .mutation(api.skillCandidates.setStatus, { candidateId: action.candidateId, status: "skilled" })
          .catch(() => {});
      }
      return { ok: true, reply: "Added to your Skills.md. ✓" };
    }
    case "message.send": {
      let m: { recipientName: string; display: string; text: string };
      try {
        m = JSON.parse(action.entry);
      } catch {
        return { ok: false, reply: "That message draft was malformed; nothing was sent." };
      }
      // Re-screen + send (defense in depth — the allowlist + credential guard run
      // again here, not just at stage). sendToContact resolves the recipient fresh
      // and is isolated from the Charlie poll loop. Reject-and-log on a miss; log
      // the accepted send too — both via the append-only recordDecision (the
      // reason is a fixed label/pattern name, never the message body).
      const res = await sendToContact(m.recipientName, m.text);
      if (!res.ok) {
        await convex
          .mutation(api.auditLog.recordDecision, {
            source: "message.send",
            outcome: "rejected",
            reason: res.reason,
            recipient: m.display,
          })
          .catch(() => {});
        return { ok: false, reply: `Not sent (${res.reason}).` };
      }
      await convex
        .mutation(api.auditLog.recordDecision, {
          source: "message.send",
          outcome: "accepted",
          recipient: res.recipient,
        })
        .catch(() => {});
      return { ok: true, reply: `Sent to ${res.recipient}. ✓` };
    }
    case "calendar.add": {
      const parsed = parseCalendarEntry(action.entry);
      if (!parsed.ok) {
        return { ok: false, reply: `That calendar draft was malformed: ${parsed.error}.` };
      }
      // Spool + the charlie-side calendar-writer (EventKit). Confirms the
      // round-trip via the writer's per-request sentinel before claiming success.
      const res = await submitCalendarAdd(parsed.entry);
      return res.confirmed
        ? { ok: true, reply: `Added “${parsed.entry.title}” to your calendar. ✓` }
        : { ok: false, reply: `Submitted, but I could NOT confirm “${parsed.entry.title}” landed on your calendar. Don't count on it.` };
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
    ...(result.messageKind ? { kind: result.messageKind } : {}),
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
  // For a habit confirmation, "no" is evidence: write yesterday MISSED (the
  // refined invariant — a manual miss carries resolvedAt, the user's answer).
  // Every other kind: reject just discards.
  let reply = "Discarded — nothing was changed.";
  if (active.kind === "habit.confirm") {
    try {
      const h = JSON.parse(active.entry) as { habitId: string; date: string; name: string; today: string };
      await convex.mutation(api.habits.functions.setDay, {
        habitId: h.habitId as Id<"habits">,
        date: h.date,
        today: h.today,
        status: "missed",
      });
      reply = `Logged “${h.name}” missed for ${h.date}. Your “no” is the record.`;
    } catch {
      /* malformed entry: fall back to plain discard */
    }
  } else if (active.kind === "skills.append" && active.candidateId) {
    // "No" to a skill suggestion: decline the candidate so it never resurfaces.
    await convex
      .mutation(api.skillCandidates.setStatus, { candidateId: active.candidateId, status: "declined" })
      .catch(() => {});
    reply = "Skipped — won't suggest that one again.";
  }
  await convex.mutation(api.messages.send, {
    conversationId,
    role: "assistant",
    content: reply,
    complete: true,
  });
  return { ok: true, reply };
}
