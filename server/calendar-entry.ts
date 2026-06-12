// calendar.add entry shape (JAR-26). The pure contract for an event Chief will
// write to Charlie's OWN calendar (low stakes). The stage tool builds one of
// these, it rides in the pendingAction.entry as JSON, the approval card renders
// it, and on approve the calendar-writer agent applies it via EventKit. Keeping
// the shape + validation here makes both ends agree and keeps it unit-testable
// without EventKit or a deploy.

export interface CalendarEntry {
  title: string;
  startISO: string; // ISO 8601 datetime
  endISO: string; // ISO 8601 datetime, >= startISO
  calendar?: string; // target calendar name; omitted -> writer uses the default
  location?: string;
}

export type CalendarEntryResult =
  | { ok: true; entry: CalendarEntry }
  | { ok: false; error: string };

function isValidISO(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0 && !Number.isNaN(Date.parse(s));
}

export function buildCalendarEntry(input: {
  title: string;
  startISO: string;
  endISO: string;
  calendar?: string;
  location?: string;
}): CalendarEntryResult {
  const title = (input.title ?? "").trim();
  if (!title) return { ok: false, error: "title is required" };
  if (!isValidISO(input.startISO)) return { ok: false, error: "startISO is not a valid ISO datetime" };
  if (!isValidISO(input.endISO)) return { ok: false, error: "endISO is not a valid ISO datetime" };
  if (Date.parse(input.endISO) < Date.parse(input.startISO)) {
    return { ok: false, error: "endISO is before startISO" };
  }
  const entry: CalendarEntry = { title, startISO: input.startISO, endISO: input.endISO };
  if (input.calendar?.trim()) entry.calendar = input.calendar.trim();
  if (input.location?.trim()) entry.location = input.location.trim();
  return { ok: true, entry };
}

export function serializeCalendarEntry(entry: CalendarEntry): string {
  return JSON.stringify(entry);
}

export function parseCalendarEntry(json: string): CalendarEntryResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "malformed calendar entry JSON" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "calendar entry is not an object" };
  }
  const o = parsed as Record<string, unknown>;
  return buildCalendarEntry({
    title: typeof o.title === "string" ? o.title : "",
    startISO: typeof o.startISO === "string" ? o.startISO : "",
    endISO: typeof o.endISO === "string" ? o.endISO : "",
    calendar: typeof o.calendar === "string" ? o.calendar : undefined,
    location: typeof o.location === "string" ? o.location : undefined,
  });
}
