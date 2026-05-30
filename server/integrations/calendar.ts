import { readFile } from "node:fs/promises";

// Calendar READ (Phase 3): Chief reads the JSON snapshot the charlie-side
// calendar-mirror writes (EventKit-expanded iCloud events in a forward window).
// Thin reader, same shape as the reminders snapshot reader. Read-only.

const SNAPSHOT = process.env.CHIEF_CALENDAR_SNAPSHOT ?? "/Users/Shared/chief-calendar/calendar.json";
const STALE_MS = Number(process.env.CHIEF_CALENDAR_STALE_MS ?? 60 * 60 * 1000); // 1h (mirror ~15m)

export interface CalEvent {
  title: string;
  start: string; // ISO with local offset
  startLocal: string; // human local time
  end: string;
  endLocal: string;
  allDay: boolean;
  calendar: string;
  location?: string | null;
  recurringInstance: boolean;
}

export interface CalRead {
  events: CalEvent[];
  generatedAt: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  stale: boolean;
  calendars: string[];
  sources: string[];
  accessDenied: boolean;
  source: string;
  errors: string[];
}

interface Snapshot {
  generatedAt?: string;
  windowStart?: string;
  windowEnd?: string;
  events?: CalEvent[];
  calendars?: string[];
  sources?: string[];
  accessDenied?: boolean;
  error?: string;
}

export async function readCalendar(): Promise<CalRead> {
  let raw: string;
  try {
    raw = await readFile(SNAPSHOT, "utf8");
  } catch (err) {
    return {
      events: [], generatedAt: null, windowStart: null, windowEnd: null, stale: true,
      calendars: [], sources: [], accessDenied: false, source: SNAPSHOT,
      errors: [`calendar snapshot not readable at ${SNAPSHOT}: ${String(err)}. Is the calendar-mirror agent running?`],
    };
  }
  let snap: Snapshot;
  try {
    snap = JSON.parse(raw) as Snapshot;
  } catch (err) {
    return {
      events: [], generatedAt: null, windowStart: null, windowEnd: null, stale: true,
      calendars: [], sources: [], accessDenied: false, source: SNAPSHOT, errors: [`snapshot parse failed: ${String(err)}`],
    };
  }
  const generatedAt = snap.generatedAt ?? null;
  const ageMs = generatedAt ? Date.now() - new Date(generatedAt).getTime() : Infinity;
  return {
    events: Array.isArray(snap.events) ? snap.events : [],
    generatedAt,
    windowStart: snap.windowStart ?? null,
    windowEnd: snap.windowEnd ?? null,
    stale: ageMs > STALE_MS,
    calendars: Array.isArray(snap.calendars) ? snap.calendars : [],
    sources: Array.isArray(snap.sources) ? snap.sources : [],
    accessDenied: Boolean(snap.accessDenied),
    source: SNAPSHOT,
    errors: snap.error ? [snap.error] : [],
  };
}
