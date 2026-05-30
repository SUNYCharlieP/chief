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

  const confirmed = await pollSnapshot(req.title, req.list);
  return { confirmed, requestId, due: humanDate(req.dueISO) };
}

async function pollSnapshot(title: string, list: string): Promise<boolean> {
  for (let i = 0; i < POLL_TRIES; i++) {
    try {
      const snap = JSON.parse(await readFile(SNAPSHOT, "utf8")) as {
        reminders?: Array<{ title: string; list: string }>;
      };
      if ((snap.reminders ?? []).some((r) => r.title === title && r.list === list)) return true;
    } catch {
      /* snapshot not ready; retry */
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}
