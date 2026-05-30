import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "./runtimes/types.js";
import { readReminders } from "./integrations/reminders.js";
import { humanDate } from "./reminders-write.js";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Phase 1 read + Phase 2 add (draft-and-ask). No edit/delete.
export function createReminderTools(conversationId: string): RuntimeTool[] {
  return [
    defineRuntimeTool(
      "boop-reminders",
      "read_reminders",
      "Read Charlie's Apple Reminders from his Mac (READ-ONLY). Returns incomplete reminders with title, due date (ISO, null if none), all-day flag, and which list each is on. Use when he asks what's on his reminders, what's due, or what bills are coming up. Optional withinDays limits to reminders due within the next N days. This cannot add, edit, or complete reminders.",
      {
        withinDays: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Only reminders due within the next N days. Omit for all incomplete."),
      },
      async ({ withinDays }) => {
        const r = await readReminders();
        if (r.errors.length > 0 && r.reminders.length === 0) {
          return runtimeText(`Couldn't read Reminders: ${r.errors.join("; ")}`, false);
        }
        let items = r.reminders;
        if (withinDays != null) {
          const cutoff = Date.now() + withinDays * 86400000;
          items = items.filter((x) => x.due && new Date(x.due).getTime() <= cutoff);
        }
        return runtimeText(
          JSON.stringify(
            {
              count: items.length,
              lists: [...new Set(r.reminders.map((x) => x.list))],
              reminders: items.map((x) => ({
                title: x.title,
                due: x.due,
                allDay: x.allDay,
                list: x.list,
              })),
            },
            null,
            2,
          ),
        );
      },
    ),
    defineRuntimeTool(
      "boop-reminders",
      "stage_reminder",
      `Stage a NEW reminder to add (add-only; cannot edit or delete). Call this ONLY after you have resolved all three: a title, an ABSOLUTE due date, and the list. Disambiguate FIRST in conversation:
- If the due date was vague ("this week", "soon"), you must have already asked Charlie to pin it or proposed a specific date and gotten his date.
- If the list was ambiguous, you must have already asked. Infer "Bills" when there's an amount/payee, "Charlie's Personal Tasks" for a clear task; only ask when genuinely unclear. Use an EXISTING list name.
- Resolve relative dates ("Friday", "the 10th", "tomorrow") against today's date into a full ISO date. ALWAYS show the resolved ABSOLUTE date to Charlie in the draft, never the relative phrase.
After this returns, show the draft and ask for a yes. The write happens only on his explicit confirm.`,
      {
        title: z.string().describe("Reminder title, e.g. \"Pay Xfinity $150\"."),
        dueISO: z.string().describe("Absolute due date ISO8601, computed against today (e.g. 2026-05-30T09:00:00)."),
        list: z.string().describe('Existing list name, e.g. "Bills" or "Charlie’s Personal Tasks".'),
        amount: z.string().optional().describe('Dollar amount if it\'s a payment, e.g. "$150".'),
      },
      async ({ title, dueISO, list, amount }) => {
        const actionId = randomId("pa");
        const now = Date.now();
        await convex.mutation(api.pendingActions.create, {
          actionId,
          conversationId,
          kind: "reminder.add",
          pitch: "",
          entry: JSON.stringify({ title, dueISO, list, amount: amount ?? null }),
          targetFile: "",
          sha256: "",
          createdAt: now,
          expiresAt: now + 30 * 60 * 1000,
        });
        return runtimeText(
          `Staged reminder. Show Charlie this exact draft and ask for a yes:\n  Add: ${title}${amount ? ` (${amount})` : ""}\n  Due: ${humanDate(dueISO)}\n  List: ${list}\nThen end with: Reply "yes" to add it (anything else cancels). Do NOT claim it's added; the write happens only on his yes.`,
        );
      },
    ),
  ];
}
