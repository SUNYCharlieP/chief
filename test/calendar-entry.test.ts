import { describe, it, expect } from "vitest";
import {
  buildCalendarEntry,
  parseCalendarEntry,
  serializeCalendarEntry,
} from "../server/calendar-entry.js";

describe("calendar entry — build + validate", () => {
  it("builds a valid entry and drops empty optionals", () => {
    const r = buildCalendarEntry({
      title: "  Dinner  ",
      startISO: "2026-06-20T18:00:00-04:00",
      endISO: "2026-06-20T20:00:00-04:00",
      calendar: "",
      location: "  The Bistro ",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.title).toBe("Dinner");
      expect(r.entry.calendar).toBeUndefined();
      expect(r.entry.location).toBe("The Bistro");
    }
  });

  it("rejects missing title and invalid / inverted times", () => {
    expect(buildCalendarEntry({ title: "", startISO: "2026-06-20T18:00:00Z", endISO: "2026-06-20T19:00:00Z" }).ok).toBe(false);
    expect(buildCalendarEntry({ title: "x", startISO: "not-a-date", endISO: "2026-06-20T19:00:00Z" }).ok).toBe(false);
    const inverted = buildCalendarEntry({
      title: "x",
      startISO: "2026-06-20T20:00:00Z",
      endISO: "2026-06-20T18:00:00Z",
    });
    expect(inverted.ok).toBe(false);
    if (!inverted.ok) expect(inverted.error).toMatch(/before/);
  });

  it("round-trips through serialize/parse", () => {
    const built = buildCalendarEntry({
      title: "Sync",
      startISO: "2026-07-01T09:00:00Z",
      endISO: "2026-07-01T09:30:00Z",
      calendar: "Work",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const round = parseCalendarEntry(serializeCalendarEntry(built.entry));
    expect(round.ok).toBe(true);
    if (round.ok) expect(round.entry).toEqual(built.entry);
  });

  it("parse rejects malformed JSON and non-objects", () => {
    expect(parseCalendarEntry("{").ok).toBe(false);
    expect(parseCalendarEntry("[]").ok).toBe(false);
    expect(parseCalendarEntry('"string"').ok).toBe(false);
  });
});
