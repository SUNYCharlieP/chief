#!/usr/bin/env node
// Charlie-side calendar mirror (Phase 3). Runs the compiled EventKit helper as
// charlie (in the GUI session, where the Calendar grant applies), wraps its
// expanded-events JSON with window metadata, and writes a snapshot Chief reads.
// Same hand-off shape as the reminders mirror.

import { execFile } from "node:child_process";
import { mkdir, writeFile, rename, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const HELPER = process.env.CHIEF_CALENDAR_HELPER ?? join(homedir(), ".chief-bin/calendar-helper");
const WINDOW_DAYS = Number(process.env.CHIEF_CALENDAR_WINDOW_DAYS ?? 60);
const OUT_DIR = process.env.CHIEF_CALENDAR_SNAPSHOT_DIR ?? "/Users/Shared/chief-calendar";
const OUT_FILE = join(OUT_DIR, "calendar.json");
const LOG = process.env.CHIEF_CALENDAR_MIRROR_LOG ?? join(homedir(), "Library/Logs/chief-calendar-mirror.log");

async function log(msg) {
  try {
    await appendFile(LOG, `${new Date().toISOString()} ${msg}\n`, "utf8");
  } catch {
    /* best effort */
  }
}

function runHelper() {
  return new Promise((resolve) => {
    execFile(
      HELPER,
      [],
      {
        timeout: 60000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, CHIEF_CALENDAR_WINDOW_DAYS: String(WINDOW_DAYS) },
      },
      (err, stdout, stderr) => resolve({ err, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" }),
    );
  });
}

async function main() {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + WINDOW_DAYS * 86400000);
  const base = {
    generatedAt: now.toISOString(),
    windowDays: WINDOW_DAYS,
    windowStart: now.toISOString(),
    windowEnd: windowEnd.toISOString(),
  };

  const { err, stdout, stderr } = await runHelper();
  let snapshot;
  if (err) {
    const denied = /CALENDAR_ACCESS_DENIED/.test(stderr) || err.code === 2;
    snapshot = {
      ...base,
      accessDenied: denied,
      error: denied
        ? "Calendar access not granted to the helper. Allow the 'access Calendar' prompt, or grant it in Privacy & Security -> Calendars."
        : `helper failed: ${stderr.slice(0, 300) || err.message}`,
      calendars: [],
      sources: [],
      events: [],
    };
    await log(snapshot.error);
  } else {
    let parsed = { events: [], calendars: [], sources: [] };
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      await log(`parse failed: ${e}`);
    }
    snapshot = { ...base, accessDenied: false, ...parsed };
    await log(`wrote ${parsed.events?.length ?? 0} events from sources [${(parsed.sources ?? []).join(", ")}] (window ${WINDOW_DAYS}d)`);
  }

  await mkdir(OUT_DIR, { recursive: true, mode: 0o700 }); // JAR-24: keep the snapshot dir 0700
  const tmp = `${OUT_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
  await rename(tmp, OUT_FILE);
}

main().catch(async (err) => {
  await log(`fatal: ${err}`);
  process.exitCode = 1;
});
