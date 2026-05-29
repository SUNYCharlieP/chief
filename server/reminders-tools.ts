import { z } from "zod";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "./runtimes/types.js";
import { readReminders } from "./integrations/reminders.js";

// Phase 1: read-only Reminders tool for the dispatcher. No add/edit/delete.
export function createReminderTools(): RuntimeTool[] {
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
  ];
}
