// Chief calendar helper (Phase 3). Runs as charlie via the calendar-mirror.
// Uses EventKit so macOS expands recurrence + exceptions + modified instances
// natively (we never hand-expand rules). Outputs JSON to stdout: expanded
// iCloud events in a forward window, each with a machine ISO (local offset) AND
// a human local-time string so the consumer never UTC-mis-renders.
//
// Needs the Calendar TCC grant (kTCCServiceCalendar). Exits 2 if denied.

import EventKit
import Foundation

struct OutEvent: Codable {
    let title: String
    let start: String       // ISO8601 with local offset, e.g. 2026-05-30T12:00:00-04:00
    let startLocal: String  // human local, e.g. "Sat, May 30, 12:00 PM EDT"
    let end: String
    let endLocal: String
    let allDay: Bool
    let calendar: String
    let location: String?
    let recurringInstance: Bool
}
struct Out: Codable {
    let events: [OutEvent]
    let calendars: [String]
    let sources: [String]
}

func fail(_ msg: String, _ code: Int32) -> Never {
    FileHandle.standardError.write(Data((msg + "\n").utf8))
    exit(code)
}

let store = EKEventStore()
let sema = DispatchSemaphore(value: 0)
var granted = false
if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { ok, _ in granted = ok; sema.signal() }
} else {
    store.requestAccess(to: .event) { ok, _ in granted = ok; sema.signal() }
}
sema.wait()
guard granted else { fail("CALENDAR_ACCESS_DENIED", 2) }

let env = ProcessInfo.processInfo.environment
let windowDays = Int(env["CHIEF_CALENDAR_WINDOW_DAYS"] ?? "60") ?? 60
let sourceFilter = (env["CHIEF_CALENDAR_SOURCES"] ?? "iCloud")
    .lowercased()
    .split(separator: ",")
    .map { $0.trimmingCharacters(in: .whitespaces) }
    .filter { !$0.isEmpty }

let now = Date()
let end = Calendar.current.date(byAdding: .day, value: windowDays, to: now) ?? now

// Sources are env-driven (CHIEF_CALENDAR_SOURCES, substring match on
// EKSource.title). EventKit reads all locally-synced accounts, so adding a
// source is just one more token in the filter, no per-account API.
let wantedCals = store.calendars(for: .event).filter { c in
    sourceFilter.contains { c.source.title.lowercased().contains($0) }
}
let calNames = wantedCals.map { $0.title }.sorted()
let srcNames = Array(Set(wantedCals.map { $0.source.title })).sorted()

let isoFmt = ISO8601DateFormatter()
isoFmt.timeZone = TimeZone.current
isoFmt.formatOptions = [.withInternetDateTime]

let humanFmt = DateFormatter()
humanFmt.dateFormat = "EEE, MMM d, h:mm a zzz"
humanFmt.timeZone = TimeZone.current
let dayFmt = DateFormatter()
dayFmt.dateFormat = "EEE, MMM d"
dayFmt.timeZone = TimeZone.current
// ISO date-only for all-day events, so the Chief-side withinDays filter
// (new Date(start)) can parse them and they aren't silently dropped.
let isoDayFmt = DateFormatter()
isoDayFmt.dateFormat = "yyyy-MM-dd"
isoDayFmt.timeZone = TimeZone.current

var out: [OutEvent] = []
if !wantedCals.isEmpty {
    let pred = store.predicateForEvents(withStart: now, end: end, calendars: wantedCals)
    // events(matching:) returns EXPANDED occurrences with exceptions + modified
    // instances already applied by EventKit.
    for ev in store.events(matching: pred) {
        let startISO = ev.isAllDay ? isoDayFmt.string(from: ev.startDate) : isoFmt.string(from: ev.startDate)
        let endISO = ev.isAllDay ? isoDayFmt.string(from: ev.endDate) : isoFmt.string(from: ev.endDate)
        let startH = ev.isAllDay ? dayFmt.string(from: ev.startDate) + " (all day)" : humanFmt.string(from: ev.startDate)
        let endH = ev.isAllDay ? dayFmt.string(from: ev.endDate) + " (all day)" : humanFmt.string(from: ev.endDate)
        out.append(OutEvent(
            title: ev.title ?? "(no title)",
            start: startISO, startLocal: startH,
            end: endISO, endLocal: endH,
            allDay: ev.isAllDay,
            calendar: ev.calendar.title,
            location: ev.location,
            recurringInstance: ev.hasRecurrenceRules
        ))
    }
}
out.sort { $0.start < $1.start }

do {
    let data = try JSONEncoder().encode(Out(events: out, calendars: calNames, sources: srcNames))
    FileHandle.standardOutput.write(data)
} catch {
    fail("ENCODE_ERROR: \(error)", 3)
}
