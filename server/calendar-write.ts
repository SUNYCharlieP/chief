import { mkdir, readFile, rename, writeFile, unlink, access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { CalendarEntry } from "./calendar-entry.js";

// Calendar WRITE executor (JAR-26). Chief can't write Calendar in-process (the
// EventKit grant lives in charlie's GUI session), so it drops an add-request into
// a user-owned 0700 spool; the charlie-side com.chief.calendar-writer applies it
// via the EventKit write helper and re-snapshots. Add-only — there is no edit or
// delete path, by construction (the writer's allowlist enforces it too).
//
// Confirmation is identity-based: the writer drops a per-request sentinel into
// <spool>/done/<requestId> only after EventKit reports the save succeeded, and we
// poll for THAT file — never a blind success, never a fuzzy title match. (The
// calendar snapshot doesn't carry event notes, so a requestId-in-notes marker
// like the reminders path uses wouldn't be visible; the sentinel is the
// equivalent identity proof without touching the read helper.)

// 0700, user-owned, never /Users/Shared (the JAR-21/24 discipline).
const SPOOL_DIR = process.env.CHIEF_CALENDAR_SPOOL_DIR ?? resolve(homedir(), ".chief-calendar-spool");
const POLL_TRIES = 30;
const POLL_INTERVAL_MS = 500;

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface CalendarAddResult {
  confirmed: boolean;
  requestId: string;
}

export async function submitCalendarAdd(entry: CalendarEntry): Promise<CalendarAddResult> {
  const requestId = randomId("cal");
  await mkdir(SPOOL_DIR, { recursive: true, mode: 0o700 });
  const payload = JSON.stringify({
    op: "calendar.add",
    title: entry.title,
    startISO: entry.startISO,
    endISO: entry.endISO,
    calendar: entry.calendar ?? null,
    location: entry.location ?? null,
    requestId,
    createdAt: Date.now(),
  });
  // Atomic publish: dotfile the writer ignores, then rename to *.json.
  const tmp = resolve(SPOOL_DIR, `.${requestId}.tmp`);
  const finalPath = resolve(SPOOL_DIR, `${requestId}.json`);
  await writeFile(tmp, payload, "utf8");
  await rename(tmp, finalPath);

  const confirmed = await pollDone(requestId);
  return { confirmed, requestId };
}

// Poll for the writer's per-request success sentinel. Cleans it up on hit so the
// done/ dir doesn't accumulate.
async function pollDone(requestId: string): Promise<boolean> {
  const donePath = resolve(SPOOL_DIR, "done", requestId);
  for (let i = 0; i < POLL_TRIES; i++) {
    try {
      await access(donePath);
      await unlink(donePath).catch(() => {});
      return true;
    } catch {
      /* not done yet; retry */
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}
