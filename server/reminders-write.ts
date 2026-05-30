import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Reminders WRITE executor (Phase 2). Chief can't write Reminders (cross-user +
// GUI-context), so it drops an add-request into a shared spool; the charlie-side
// reminders-writer applies it in the GUI session and re-snapshots. We confirm by
// polling the refreshed snapshot for the new reminder, never a blind success.
// Add-only.

const SPOOL_DIR = process.env.CHIEF_REMINDERS_SPOOL_DIR ?? "/Users/Shared/chief-reminders/spool";
const SNAPSHOT =
  process.env.CHIEF_REMINDERS_SNAPSHOT ?? "/Users/Shared/chief-reminders/reminders.json";
const POLL_TRIES = 24;
const POLL_INTERVAL_MS = 500;

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface ReminderAddRequest {
  title: string;
  dueISO: string;
  list: string;
  amount?: string | null;
}

export interface AddResult {
  confirmed: boolean;
  requestId: string;
  due: string; // human absolute date, for the confirmation message
}

// Format an absolute human date from the ISO components (no Date parsing of the
// whole string, to stay locale/TZ-proof). e.g. "Friday, May 30 2026".
export function humanDate(dueISO: string): string {
  const m = dueISO.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dueISO;
  const [, y, mo, d] = m;
  const local = new Date(Number(y), Number(mo) - 1, Number(d)); // local construction, TZ-safe
  return local.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// Deterministic date guard: reject a past dueISO or one whose weekday doesn't
// match what the user said. Pure + injectable `now` so it's testable. The
// em-dash-strip philosophy for dates: enforced in code, not prompt+vigilance.
export function checkReminderDate(
  dueISO: string,
  statedWeekday?: string,
  now: Date = new Date(),
): { ok: true } | { ok: false; reason: string } {
  const m = dueISO.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) {
    return { ok: false, reason: `dueISO "${dueISO}" is not a full YYYY-MM-DD date. Recompute the absolute date against today and call stage_reminder again.` };
  }
  const dueLocal = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const fmt = (dt: Date) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  if (dueLocal.getTime() < todayLocal.getTime()) {
    return { ok: false, reason: `Rejected: ${fmt(dueLocal)} is in the PAST (today is ${fmt(todayLocal)}). A reminder is never for a past date. Recompute against today (mind the YEAR) and call stage_reminder again.` };
  }
  if (statedWeekday) {
    const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const statedIdx = names.indexOf(statedWeekday.trim().toLowerCase());
    if (statedIdx >= 0 && statedIdx !== dueLocal.getDay()) {
      return { ok: false, reason: `Rejected: ${fmt(dueLocal)} is a ${names[dueLocal.getDay()]}, but Charlie said "${statedWeekday}". Today is ${fmt(todayLocal)}. Recompute the correct ${statedWeekday} date and call again.` };
    }
  }
  return { ok: true };
}

export async function submitReminderAdd(req: ReminderAddRequest): Promise<AddResult> {
  const requestId = randomId("rem");
  await mkdir(SPOOL_DIR, { recursive: true });
  const payload = JSON.stringify({
    op: "reminder.add",
    title: req.title,
    dueISO: req.dueISO,
    list: req.list,
    amount: req.amount ?? null,
    requestId,
    createdAt: Date.now(),
  });
  // Atomic publish: dotfile the writer ignores, then rename to *.json.
  const tmp = resolve(SPOOL_DIR, `.${requestId}.tmp`);
  const finalPath = resolve(SPOOL_DIR, `${requestId}.json`);
  await writeFile(tmp, payload, "utf8");
  await rename(tmp, finalPath);

  const confirmed = await pollSnapshot(requestId);
  return { confirmed, requestId, due: humanDate(req.dueISO) };
}

// Confirm THIS specific write landed by matching the requestId the writer
// stamped into the new reminder's notes. Matching on title+list would
// false-confirm against a PRE-EXISTING reminder with the same title (e.g. a
// recurring "Pay X" already in Bills) even when this write failed. Identity,
// not a fuzzy proxy.
async function pollSnapshot(requestId: string): Promise<boolean> {
  const marker = `chief-req:${requestId}`;
  for (let i = 0; i < POLL_TRIES; i++) {
    try {
      const snap = JSON.parse(await readFile(SNAPSHOT, "utf8")) as {
        reminders?: Array<{ notes?: string | null }>;
      };
      if ((snap.reminders ?? []).some((r) => (r.notes ?? "").includes(marker))) return true;
    } catch {
      /* snapshot not ready; retry */
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}
