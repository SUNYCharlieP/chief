import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "./runtimes/types.js";
import { readCalendar } from "./integrations/calendar.js";
import { buildCalendarEntry, serializeCalendarEntry } from "./calendar-entry.js";
import { humanDate } from "./reminders-write.js";
import { stakesForKind } from "../convex/pendingActionKinds.js";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Phase 3 read + JAR-26 add (draft-and-ask). read_calendar is READ-ONLY and
// window-honest; stage_calendar adds an event to Charlie's OWN calendar (add-only,
// low-stakes) and writes only on his explicit approval.
export function createCalendarTools(conversationId: string): RuntimeTool[] {
  return [
    defineRuntimeTool(
      "boop-calendar",
      "read_calendar",
      "Read Charlie's iCloud Calendar events (READ-ONLY, recurrence already expanded). Returns upcoming events with local times and which calendar each is on. Optional withinDays limits to the next N days. IMPORTANT: the snapshot only covers a forward window (windowEnd in the result). If Charlie asks about a date AFTER windowEnd, tell him that's past your calendar window, do NOT say \"nothing scheduled\" (you simply can't see that far yet). Times are local; report them as given in startLocal.",
      {
        withinDays: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Only events within the next N days. Omit for the whole snapshot window."),
      },
      async ({ withinDays }) => {
        const r = await readCalendar();
        if (r.accessDenied) {
          return runtimeText(
            "Calendar access isn't granted to the helper yet (Privacy & Security -> Calendars). Can't read the calendar until that's allowed.",
            false,
          );
        }
        if (r.errors.length > 0 && r.events.length === 0) {
          return runtimeText(`Couldn't read the calendar: ${r.errors.join("; ")}`, false);
        }
        const now = Date.now();
        const windowEndMs = r.windowEnd ? new Date(r.windowEnd).getTime() : Infinity;
        let events = r.events;
        let requestedBeyondWindow = false;
        if (withinDays != null) {
          const cutoff = now + withinDays * 86400000;
          requestedBeyondWindow = cutoff > windowEndMs;
          events = events.filter((e) => new Date(e.start).getTime() <= cutoff);
        }
        return runtimeText(
          JSON.stringify(
            {
              windowEnd: r.windowEnd,
              windowDaysNote: `Snapshot covers through ${r.windowEnd}. Anything after that is PAST MY WINDOW (unknown, not empty).`,
              requestedBeyondWindow,
              stale: r.stale,
              calendars: r.calendars,
              count: events.length,
              events: events.map((e) => ({
                title: e.title,
                startLocal: e.startLocal,
                endLocal: e.endLocal,
                allDay: e.allDay,
                calendar: e.calendar,
                recurring: e.recurringInstance,
                location: e.location ?? undefined,
              })),
            },
            null,
            2,
          ),
        );
      },
    ),
    defineRuntimeTool(
      "boop-calendar",
      "stage_calendar",
      `Stage a NEW event to add to Charlie's OWN calendar (add-only; cannot edit or delete). Resolve the date/time FIRST: convert any relative phrase ("Friday", "next week", "7pm") into a full ISO datetime against today, and show Charlie the ABSOLUTE date/time in the draft. Provide startISO and endISO; if he only gave a start, pick a sensible duration (default +1 hour). Optional calendar name (omit to use his default) and location. After staging, show the draft and ask for a yes; the write happens only on his explicit confirm — never claim it's added before that.`,
      {
        title: z.string().describe('Event title, e.g. "Dinner with Mom".'),
        startISO: z.string().describe("Absolute start ISO8601 computed against today, e.g. 2026-06-20T18:00:00."),
        endISO: z.string().describe("Absolute end ISO8601, after start. Default +1h if only a start was given."),
        calendar: z.string().optional().describe("Target calendar name; omit to use the default."),
        location: z.string().optional().describe("Optional location."),
      },
      async ({ title, startISO, endISO, calendar, location }) => {
        // Default to Charlie's OWN calendar (CHIEF_CALENDAR_DEFAULT) when the
        // model doesn't name one — NEVER the EventKit system default, which on
        // this Mac is a SHARED calendar (someone else's work calendar); an event there
        // is visible to other people. The model may still target a named calendar.
        const targetCalendar = calendar ?? process.env.CHIEF_CALENDAR_DEFAULT;
        if (!targetCalendar) {
          // Reject and ask — never stage a calendar.add that would fall through
          // to a guessed/shared system-default calendar.
          return runtimeText(
            `I won't add this without knowing WHICH calendar, and I won't guess (the system default could be a shared calendar). Ask Charlie which of his calendars to use, then call stage_calendar again with that calendar name.`,
            false,
          );
        }
        const built = buildCalendarEntry({ title, startISO, endISO, calendar: targetCalendar, location });
        if (!built.ok) {
          return runtimeText(`Can't stage that event: ${built.error}. Fix it and call stage_calendar again.`, false);
        }
        const actionId = randomId("pa");
        const now = Date.now();
        await convex.mutation(api.pendingActions.create, {
          actionId,
          conversationId,
          kind: "calendar.add",
          stakes: stakesForKind("calendar.add"),
          pitch: "",
          entry: serializeCalendarEntry(built.entry),
          targetFile: "",
          sha256: "",
          createdAt: now,
          expiresAt: now + 30 * 60 * 1000,
        });
        const e = built.entry;
        return runtimeText(
          `Staged calendar event. Show Charlie this exact draft and ask for a yes:\n  Add: ${e.title}\n  When: ${humanDate(e.startISO)}\n${e.calendar ? `  Calendar: ${e.calendar}\n` : ""}${e.location ? `  Where: ${e.location}\n` : ""}Then end with: Reply "yes" to add it (anything else cancels). Do NOT claim it's added; the write happens only on his yes.`,
        );
      },
    ),
  ];
}
