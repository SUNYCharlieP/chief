import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Apple Reminders READ (Phase 1), local-only. Reads the Reminders Core Data
// store directly under the existing Full Disk Access grant -- same mechanism as
// chat.db (node:sqlite, read-only), no new TCC permission and no EventKit/
// osascript (which would need a per-app grant a launchd daemon can't get).
//
// Dates are Core Data timestamps: seconds since 2001-01-01 UTC. unix =
// value + 978307200. Reading the number avoids osascript locale-string parsing.

type DatabaseSync = import("node:sqlite").DatabaseSync;

const APPLE_EPOCH_OFFSET = 978307200;
const STORE_DIR =
  process.env.CHIEF_REMINDERS_STORE_DIR ??
  `${homedir()}/Library/Group Containers/group.com.apple.reminders/Container_v1/Stores`;

export interface Reminder {
  title: string;
  due: string | null; // ISO8601, null if no due date
  allDay: boolean;
  completed: boolean;
  list: string;
  store: string; // which Data-*.sqlite it came from (multi-store visibility)
}

export interface ReadResult {
  reminders: Reminder[];
  storeDir: string;
  storesScanned: number;
  storesWithReminders: number;
  errors: string[];
}

function toIso(due: number | null): string | null {
  if (due == null || !Number.isFinite(due)) return null;
  return new Date(Math.round((due + APPLE_EPOCH_OFFSET) * 1000)).toISOString();
}

export async function readReminders(opts?: { includeCompleted?: boolean }): Promise<ReadResult> {
  const result: ReadResult = {
    reminders: [],
    storeDir: STORE_DIR,
    storesScanned: 0,
    storesWithReminders: 0,
    errors: [],
  };

  let files: string[];
  try {
    files = (await readdir(STORE_DIR)).filter((f) => /^Data-.*\.sqlite$/.test(f));
  } catch (err) {
    result.errors.push(`cannot read store dir ${STORE_DIR}: ${String(err)}`);
    return result;
  }

  const { DatabaseSync } = await import("node:sqlite");
  const where = opts?.includeCompleted
    ? "r.ZTITLE IS NOT NULL"
    : "r.ZCOMPLETED = 0 AND r.ZTITLE IS NOT NULL";

  for (const f of files) {
    result.storesScanned += 1;
    const path = join(STORE_DIR, f);
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const rows = db
        .prepare(
          `SELECT r.ZTITLE AS title, r.ZDUEDATE AS due, r.ZALLDAY AS allday,
                  r.ZCOMPLETED AS completed, l.ZNAME AS list
           FROM ZREMCDREMINDER r
           LEFT JOIN ZREMCDBASELIST l ON r.ZLIST = l.Z_PK
           WHERE ${where}`,
        )
        .all() as Array<{
        title: string;
        due: number | null;
        allday: number | null;
        completed: number | null;
        list: string | null;
      }>;
      if (rows.length > 0) result.storesWithReminders += 1;
      for (const row of rows) {
        result.reminders.push({
          title: row.title,
          due: toIso(row.due),
          allDay: Boolean(row.allday),
          completed: Boolean(row.completed),
          list: row.list ?? "(no list)",
          store: f,
        });
      }
    } catch (err) {
      result.errors.push(`${f}: ${String(err)}`);
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  // Soonest due first; reminders without a due date last.
  result.reminders.sort((a, b) => {
    if (a.due && b.due) return a.due.localeCompare(b.due);
    if (a.due) return -1;
    if (b.due) return 1;
    return 0;
  });
  return result;
}
