// Phase 5: the morning briefing. Deterministic assembly (NO LLM) so exact times
// and bill amounts never pass through a model. Reads the existing reminders +
// calendar snapshots (read-only) and the Open-Meteo weather call. Each section
// is emitted only if it has content (silence per section); the date line is the
// only always-present anchor. Prepended to the existing tech check-in upstream.

import { readFileSync } from "node:fs";
import { readReminders, type Reminder } from "./integrations/reminders.js";
import { readCalendar, type CalEvent } from "./integrations/calendar.js";
import { getTodayWeather } from "./weather.js";

const TZ = process.env.CHIEF_BRIEFING_TZ ?? "America/New_York";
const DUE_DAYS = Number(process.env.CHIEF_BRIEFING_DUE_DAYS ?? 3); // today, +1, +2

// The partner's name is PII and stays OUT of this public repo. It is sourced
// from env, or from a gitignored shared-config file the charlie-side setup
// writes (same /Users/Shared hand-off as the snapshots). If neither is present,
// the partner section is simply disabled (and a blank match never matches all).
function loadPartnerConfig(): { match: string; label: string } {
  const envMatch = process.env.CHIEF_BRIEFING_PARTNER_MATCH;
  if (envMatch) return { match: envMatch.toLowerCase(), label: process.env.CHIEF_BRIEFING_PARTNER_LABEL ?? "Partner" };
  try {
    const path = process.env.CHIEF_BRIEFING_CONFIG ?? "/Users/Shared/chief-config/briefing.json";
    const cfg = JSON.parse(readFileSync(path, "utf8")) as { partnerMatch?: string; partnerLabel?: string };
    if (cfg.partnerMatch) return { match: cfg.partnerMatch.toLowerCase(), label: cfg.partnerLabel ?? "Partner" };
  } catch {
    /* no config: partner section disabled */
  }
  return { match: "", label: "Partner" };
}
const PARTNER = loadPartnerConfig();

// --- timezone-correct date helpers --------------------------------------------

// Local calendar date (YYYY-MM-DD) of a Date in the briefing timezone. en-CA
// renders ISO-style, so this is the canonical local-day key. DST-safe because
// Intl resolves the wall-clock date in TZ.
function localDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// Local day-key for a calendar event: its `start` already carries the local
// offset (timed: ...T11:30:00-04:00) or is date-only (all-day: 2026-05-29), so
// the first 10 chars ARE the local date. No re-parse, no offset drift.
function eventDayKey(e: CalEvent): string {
  return e.start.slice(0, 10);
}

// Enumerate the next N calendar dates as YYYY-MM-DD, starting today. Done in UTC
// integer date math so it can't skip/repeat a date across a DST boundary.
function dateWindow(todayKey: string, days: number): string[] {
  const [y, m, d] = todayKey.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d);
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const t = new Date(base + i * 86400000);
    out.push(`${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`);
  }
  return out;
}

// Human label for a due/event day relative to today: "today", "tomorrow", else
// short weekday ("Sun"). Weekday derived from the calendar date in UTC so it
// matches the date key exactly.
function dayLabel(key: string, todayKey: string, tomorrowKey: string): string {
  if (key === todayKey) return "today";
  if (key === tomorrowKey) return "tomorrow";
  const [y, m, d] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(Date.UTC(y, m - 1, d));
}

// "11:30am", "3pm" from an ISO start, in the briefing timezone.
function timeLabel(iso: string): string {
  const t = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
  return t.replace(":00", "").replace(/\s/g, "").toLowerCase(); // "3:00 PM" -> "3pm"
}

// --- main ---------------------------------------------------------------------

export async function buildBriefing(now: Date = new Date()): Promise<string> {
  const todayKey = localDate(now);
  const window = dateWindow(todayKey, Math.max(1, DUE_DAYS));
  const windowSet = new Set(window);
  const tomorrowKey = window[1] ?? "";

  const [weather, rem, cal] = await Promise.all([
    getTodayWeather().catch(() => null),
    readReminders().catch(() => null),
    readCalendar().catch(() => null),
  ]);

  const sections: string[] = [];

  // 1. DATE + WEATHER
  const dateLine = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(now);
  let header = dateLine;
  if (weather) {
    header += `\n${weather.label}: High ${weather.high} / Low ${weather.low}, ${weather.conditions}`;
  }
  sections.push(header);

  // Reminders: open, with a due date.
  const openDue = (rem?.reminders ?? []).filter(
    (r: Reminder) => !r.completed && r.due,
  );
  const keyOf = (r: Reminder) => localDate(new Date(r.due as string));

  // 2. DUE SOON (next DUE_DAYS days) - actionable, near top. Title verbatim so
  // any "$" amount in the title survives untouched.
  const dueSoon = openDue
    .filter((r) => windowSet.has(keyOf(r)))
    .sort((a, b) => (a.due as string).localeCompare(b.due as string));
  if (dueSoon.length > 0) {
    const lines = dueSoon.map(
      (r) => `- ${r.title} (${dayLabel(keyOf(r), todayKey, tomorrowKey)})`,
    );
    sections.push(["Due soon:", ...lines].join("\n"));
  }

  // 3. PAST-DUE - gentle one-liner, name at most 2, then "+N more". Never the
  // full list, never printed when zero.
  const pastDue = openDue.filter((r) => keyOf(r) < todayKey);
  if (pastDue.length > 0) {
    const names = pastDue.slice(0, 2).map((r) => r.title);
    const extra = pastDue.length - names.length;
    const tail = extra > 0 ? `, +${extra} more` : "";
    sections.push(`Still open: ${pastDue.length} past-due (${names.join(", ")}${tail})`);
  }

  // Calendar: today's events, split mine vs partner by calendar title.
  const todayEvents = (cal?.events ?? [])
    .filter((e) => eventDayKey(e) === todayKey)
    .sort((a, b) => a.start.localeCompare(b.start));
  // Empty match must never match all events (every string includes ""), so guard.
  const isPartner = (e: CalEvent) =>
    PARTNER.match.length > 0 && e.calendar.toLowerCase().includes(PARTNER.match);

  const fmtEvent = (e: CalEvent) => {
    const when = e.allDay ? "(all day)" : timeLabel(e.start);
    const loc = e.location ? ` @ ${e.location}` : "";
    return `- ${e.title} ${when}${loc}`;
  };

  // 4. MY SCHEDULE
  const mine = todayEvents.filter((e) => !isPartner(e));
  if (mine.length > 0) {
    sections.push(["Today:", ...mine.map(fmtEvent)].join("\n"));
  }

  // 5. PARTNER'S SCHEDULE (labeled as theirs)
  const partner = todayEvents.filter(isPartner);
  if (partner.length > 0) {
    sections.push([`${PARTNER.label} today:`, ...partner.map(fmtEvent)].join("\n"));
  }

  return sections.join("\n\n");
}
