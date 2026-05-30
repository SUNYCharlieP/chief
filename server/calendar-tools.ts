import { z } from "zod";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "./runtimes/types.js";
import { readCalendar } from "./integrations/calendar.js";

// Phase 3: read-only calendar. No writes. Window-honest: the snapshot only
// covers a forward window, so a query beyond it returns "past my window", never
// a false "nothing scheduled".
export function createCalendarTools(): RuntimeTool[] {
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
  ];
}
