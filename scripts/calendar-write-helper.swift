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

// Resolve a calendar's OWNING ACCOUNT to a real email. EKSource.title is just the
// provider ("Google", "iCloud") — useless when two Google accounts are present
// (e.g. cpiazza717 vs Chief's charliepiazza4). But a Google account's own primary
// calendar is named after its email, so the email-named calendar sharing this
// source IS the account identity. Falls back to the source title when there's no
// email-named calendar (e.g. iCloud).
func accountEmail(_ source: EKSource, _ all: [EKCalendar]) -> String {
    if let emailCal = all.first(where: {
        $0.source.sourceIdentifier == source.sourceIdentifier && $0.title.contains("@")
    }) {
        return emailCal.title
    }
    return source.title
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

// Request Calendar access FIRST — before any file work — so even a probe
// invocation (with a throwaway path) triggers the per-binary TCC prompt, which
// is how this binary earns the grant once. Also fails fast on a denied grant.
let store = EKEventStore()
let sema = DispatchSemaphore(value: 0)
var granted = false
if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { ok, _ in granted = ok; sema.signal() }
} else {
    store.requestAccess(to: .event) { ok, _ in granted = ok; sema.signal() }
}
sema.wait()

// Status/grant probe: `calendar-write-helper --status` requests access (firing
// the one-time TCC prompt if undecided), prints the resulting authorization, and
// creates NO event. Use it to grant + verify Calendar access without a write.
if reqPath == "--status" {
    let label: String
    if #available(macOS 14.0, *) {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: label = "fullAccess"
        case .writeOnly: label = "writeOnly"
        case .denied: label = "denied"
        case .restricted: label = "restricted"
        case .notDetermined: label = "notDetermined"
        @unknown default: label = "other"
        }
    } else {
        label = granted ? "authorized" : "denied"
    }
    print("Calendar access: \(label) (granted: \(granted))")
    exit(granted ? 0 : 2)
}

guard granted else { fail("CALENDAR_ACCESS_DENIED", 2) }

// `--calendars`: list the WRITABLE calendars with their owning account, so the
// owner can confirm which one is theirs (and that it's writable). Creates nothing.
if reqPath == "--calendars" {
    let all = store.calendars(for: .event)
    let writable = all.filter { $0.allowsContentModifications }
    for c in writable.sorted(by: { $0.title < $1.title }) {
        print("\(c.title)\t[account: \(accountEmail(c.source, all))]")
    }
    exit(0)
}

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

// Choose the target calendar. A named calendar must exist AND be writable; we
// never silently retarget to the default when the requested one is missing.
// NO fall-through to defaultCalendarForNewEvents (the EventKit system default,
// which on this Mac is a SHARED calendar). A calendar.add MUST name a calendar,
// and the target is matched by NAME + ACCOUNT EMAIL — never the bare provider
// label — so a same-named "Personal" on a different Google account (e.g. Chief's
// charliepiazza4) or a shared account cannot be captured. Structurally
// impossible to land an event on a guessed/shared/wrong-account calendar.
let allCals = store.calendars(for: .event)
let writable = allCals.filter { $0.allowsContentModifications }
guard let raw = req.calendar, !raw.trimmingCharacters(in: .whitespaces).isEmpty else {
    fail("NO_CALENDAR_SPECIFIED: a calendar.add must name a writable calendar", 5)
}
// Accept "Calendar Name|account-email" (the account-qualified form) or a bare
// name. When an email is given it MUST equal the calendar's owning-account email.
let parts = raw.split(separator: "|", maxSplits: 1).map { String($0).trimmingCharacters(in: .whitespaces) }
let wantName = parts[0]
let wantEmail: String? = parts.count > 1 ? parts[1] : nil
let matches = writable.filter {
    norm($0.title) == norm(wantName) && (wantEmail == nil || norm(accountEmail($0.source, allCals)) == norm(wantEmail!))
}
guard matches.count == 1 else {
    if matches.isEmpty {
        let avail = writable.map { "\"\($0.title) [\(accountEmail($0.source, allCals))]\"" }.joined(separator: ", ")
        fail("NO_WRITABLE_CALENDAR matching \"\(raw)\"; available: \(avail)", 4)
    }
    fail("AMBIGUOUS_CALENDAR \"\(raw)\" matches \(matches.count); qualify as \"Name|account-email\"", 4)
}
let targetCal = matches[0]

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
