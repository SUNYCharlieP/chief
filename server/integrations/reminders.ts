import { readFile } from "node:fs/promises";

// Apple Reminders READ (Phase 1), Option C: Chief reads a JSON snapshot written
// by the charlie-side reminders-mirror (com.chief.reminders-mirror). Chief
// can't read charlie's 0700 Reminders store cross-user (FDA doesn't bypass
// cross-user POSIX), so the privileged read happens as charlie and lands here.
// Read-only.

const SNAPSHOT =
  process.env.CHIEF_REMINDERS_SNAPSHOT ?? "/Users/Shared/chief-reminders/reminders.json";
// Snapshot older than this is flagged stale (the mirror refreshes every ~5m).
const STALE_MS = Number(process.env.CHIEF_REMINDERS_STALE_MS ?? 30 * 60 * 1000);

export interface Reminder {
  title: string;
  due: string | null; // ISO8601, null if no due date
  allDay: boolean;
  completed: boolean;
  list: string;
  store: string;
}

export interface ReadResult {
  reminders: Reminder[];
  generatedAt: string | null;
  stale: boolean;
  source: string;
  errors: string[];
}

interface Snapshot {
  generatedAt?: string;
  reminders?: Reminder[];
  errors?: string[];
}

export async function readReminders(opts?: { includeCompleted?: boolean }): Promise<ReadResult> {
  let raw: string;
  try {
    raw = await readFile(SNAPSHOT, "utf8");
  } catch (err) {
    return {
      reminders: [],
      generatedAt: null,
      stale: true,
      source: SNAPSHOT,
      errors: [`reminders snapshot not readable at ${SNAPSHOT}: ${String(err)}. Is the reminders-mirror agent running?`],
    };
  }

  let snap: Snapshot;
  try {
    snap = JSON.parse(raw) as Snapshot;
  } catch (err) {
    return { reminders: [], generatedAt: null, stale: true, source: SNAPSHOT, errors: [`snapshot parse failed: ${String(err)}`] };
  }

  const generatedAt = snap.generatedAt ?? null;
  const ageMs = generatedAt ? Date.now() - new Date(generatedAt).getTime() : Infinity;
  const all = Array.isArray(snap.reminders) ? snap.reminders : [];
  // The snapshot already holds only incomplete reminders; the filter is a
  // harmless guard if that ever changes.
  const reminders = opts?.includeCompleted ? all : all.filter((r) => !r.completed);

  return {
    reminders,
    generatedAt,
    stale: ageMs > STALE_MS,
    source: SNAPSHOT,
    errors: Array.isArray(snap.errors) ? snap.errors : [],
  };
}
