// Chief calendar WRITE helper (JAR-26). Runs as charlie via the
// com.chief.calendar-writer agent, where the EventKit grant applies. Reads ONE
// add-request (a JSON file path in argv[1]) and creates a single EKEvent. Add-only
// by construction: there is no edit or delete path here.
//
// Needs the Calendar TCC grant (kTCCServiceCalendar) — the same grant the read
// helper already holds. Exits 2 if denied, nonzero on any other failure (never a
// silent success). On success prints {"ok":true,...} and exits 0.

import EventKit
import Foundation

struct Req: Codable {
    let title: String
    let startISO: String
    let endISO: String
    let calendar: String?
    let location: String?
    let requestId: String
}

func fail(_ msg: String, _ code: Int32) -> Never {
    FileHandle.standardError.write(Data((msg + "\n").utf8))
    exit(code)
}

func norm(_ s: String) -> String {
    return s.replacingOccurrences(of: "\u{2019}", with: "'")
        .replacingOccurrences(of: "\u{2018}", with: "'")
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
}

func parseISO(_ s: String) -> Date? {
    let f1 = ISO8601DateFormatter()
    f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f1.date(from: s) { return d }
    let f2 = ISO8601DateFormatter()
    f2.formatOptions = [.withInternetDateTime]
    if let d = f2.date(from: s) { return d }
    // No offset (e.g. "2026-06-20T18:00:00") — interpret as local time.
    let df = DateFormatter()
    df.timeZone = TimeZone.current
    df.locale = Locale(identifier: "en_US_POSIX")
    for fmt in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm"] {
        df.dateFormat = fmt
        if let d = df.date(from: s) { return d }
    }
    return nil
}

guard CommandLine.arguments.count >= 2 else { fail("USAGE: calendar-write-helper <request.json>", 64) }
let reqPath = CommandLine.arguments[1]

let req: Req
do {
    let data = try Data(contentsOf: URL(fileURLWithPath: reqPath))
    req = try JSONDecoder().decode(Req.self, from: data)
} catch {
    fail("BAD_REQUEST: \(error)", 65)
}

guard let start = parseISO(req.startISO) else { fail("BAD_START: \(req.startISO)", 66) }
guard let end = parseISO(req.endISO) else { fail("BAD_END: \(req.endISO)", 66) }
guard end >= start else { fail("END_BEFORE_START", 66) }

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

// Choose the target calendar. A named calendar must exist AND be writable; we
// never silently retarget to the default when the requested one is missing.
let writable = store.calendars(for: .event).filter { $0.allowsContentModifications }
let targetCal: EKCalendar
if let name = req.calendar, !name.isEmpty {
    guard let match = writable.first(where: { norm($0.title) == norm(name) }) else {
        let avail = writable.map { "\"\($0.title)\"" }.joined(separator: ", ")
        fail("NO_WRITABLE_CALENDAR \"\(name)\"; available: \(avail)", 4)
    }
    targetCal = match
} else if let def = store.defaultCalendarForNewEvents {
    targetCal = def
} else {
    fail("NO_DEFAULT_CALENDAR", 5)
}

let event = EKEvent(eventStore: store)
event.title = req.title
event.startDate = start
event.endDate = end
event.calendar = targetCal
if let loc = req.location, !loc.isEmpty { event.location = loc }
// Identity marker so a future read could attribute the event to this request.
event.notes = "chief-req:\(req.requestId)"

do {
    try store.save(event, span: .thisEvent, commit: true)
} catch {
    fail("SAVE_FAILED: \(error)", 6)
}

let result = "{\"ok\":true,\"requestId\":\"\(req.requestId)\",\"calendar\":\"\(targetCal.title)\"}"
FileHandle.standardOutput.write(Data((result + "\n").utf8))
exit(0)
