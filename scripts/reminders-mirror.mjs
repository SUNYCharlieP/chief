#!/usr/bin/env node
// Charlie-side reminders mirror (calendar Phase 1, Option C). Runs AS charlie
// via the launchd agent com.chief.reminders-mirror, so it reads charlie's
// Reminders Core Data store with normal POSIX access (the Chief user can't,
// 0700 home), parses it, and writes a JSON snapshot to a shared location the
// Chief server reads. Same hand-off shape as com.chief.brain-mirror.
//
// Read-only on the Reminders store. Atomic snapshot publish (write tmp +
// rename) so the reader never sees a partial file.

import { readdir, mkdir, writeFile, rename, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const APPLE_EPOCH_OFFSET = 978307200; // 1970->2001-01-01 UTC, in seconds
const STORE_DIR =
  process.env.CHIEF_REMINDERS_STORE_DIR ??
  join(homedir(), "Library/Group Containers/group.com.apple.reminders/Container_v1/Stores");
const OUT_DIR = process.env.CHIEF_REMINDERS_SNAPSHOT_DIR ?? "/Users/Shared/chief-reminders";
const OUT_FILE = join(OUT_DIR, "reminders.json");
const LOG = process.env.CHIEF_REMINDERS_MIRROR_LOG ?? join(homedir(), "Library/Logs/chief-reminders-mirror.log");

async function log(msg) {
  try {
    await appendFile(LOG, `${new Date().toISOString()} ${msg}\n`, "utf8");
  } catch {
    /* best effort */
  }
}

function toIso(due) {
  if (due == null || !Number.isFinite(due)) return null;
  return new Date(Math.round((due + APPLE_EPOCH_OFFSET) * 1000)).toISOString();
}

async function main() {
  const reminders = [];
  const errors = [];
  let storesScanned = 0;
  let storesWithReminders = 0;

  let files = [];
  try {
    files = (await readdir(STORE_DIR)).filter((f) => /^Data-.*\.sqlite$/.test(f));
  } catch (err) {
    errors.push(`cannot read store dir ${STORE_DIR}: ${err}`);
  }

  for (const f of files) {
    storesScanned += 1;
    let db = null;
    try {
      db = new DatabaseSync(join(STORE_DIR, f), { readOnly: true });
      const rows = db
        .prepare(
          `SELECT r.ZTITLE AS title, r.ZDUEDATE AS due, r.ZALLDAY AS allday,
                  r.ZCOMPLETED AS completed, l.ZNAME AS list
           FROM ZREMCDREMINDER r
           LEFT JOIN ZREMCDBASELIST l ON r.ZLIST = l.Z_PK
           WHERE r.ZCOMPLETED = 0 AND r.ZTITLE IS NOT NULL`,
        )
        .all();
      if (rows.length > 0) storesWithReminders += 1;
      for (const row of rows) {
        reminders.push({
          title: row.title,
          due: toIso(row.due),
          allDay: Boolean(row.allday),
          completed: Boolean(row.completed),
          list: row.list ?? "(no list)",
          store: f,
        });
      }
    } catch (err) {
      errors.push(`${f}: ${err}`);
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  reminders.sort((a, b) => {
    if (a.due && b.due) return a.due.localeCompare(b.due);
    if (a.due) return -1;
    if (b.due) return 1;
    return 0;
  });

  const snapshot = {
    generatedAt: new Date().toISOString(),
    storesScanned,
    storesWithReminders,
    count: reminders.length,
    errors,
    reminders,
  };

  await mkdir(OUT_DIR, { recursive: true });
  const tmp = `${OUT_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
  await rename(tmp, OUT_FILE);
  await log(`wrote ${reminders.length} reminders from ${storesWithReminders}/${storesScanned} stores${errors.length ? `; errors: ${errors.length}` : ""}`);
}

main().catch(async (err) => {
  await log(`fatal: ${err}`);
  process.exitCode = 1;
});
