#!/usr/bin/env node
// Charlie-side Reminders WRITER (calendar Phase 2). Runs AS charlie via the
// launchd agent com.chief.reminders-writer (WatchPaths on the spool), so it can
// add reminders in charlie's GUI context (osascript -> Reminders), which Chief
// can't. SOLE ALLOWLIST AUTHORITY: the only operation is "reminder.add" to an
// existing list. There is no edit/delete path here, by construction.
//
// After a successful add it re-runs the mirror so the snapshot reflects the new
// reminder immediately (the gate on the Chief side polls that snapshot).

import { readdir, readFile, unlink, appendFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SPOOL = process.env.CHIEF_REMINDERS_SPOOL_DIR ?? "/Users/Shared/chief-reminders/spool";
const MIRROR = join(dirname(fileURLToPath(import.meta.url)), "reminders-mirror.mjs");
const NODE = process.env.CHIEF_NODE_PATH ?? "/opt/homebrew/bin/node";
const LOG = process.env.CHIEF_REMINDERS_WRITER_LOG ?? join(homedir(), "Library/Logs/chief-reminders-writer.log");

async function log(msg) {
  try {
    await appendFile(LOG, `${new Date().toISOString()} ${msg}\n`, "utf8");
  } catch {
    /* best effort */
  }
}

function asEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function run(bin, args, opts = {}) {
  return new Promise((res, rej) => {
    execFile(bin, args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) rej(new Error(stderr?.toString().slice(0, 400) || err.message));
      else res(stdout);
    });
  });
}

function buildAppleScript({ title, dueISO, list }) {
  const m = dueISO.match(/(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, min] = m;
  const hh = h ?? "09";
  const mm = min ?? "00";
  // Build the date from components (locale/TZ-proof). day=1 first avoids
  // month-length overflow when changing month/year.
  return [
    "set theDate to current date",
    "set seconds of theDate to 0",
    "set day of theDate to 1",
    `set year of theDate to ${Number(y)}`,
    `set month of theDate to ${Number(mo)}`,
    `set day of theDate to ${Number(d)}`,
    `set hours of theDate to ${Number(hh)}`,
    `set minutes of theDate to ${Number(mm)}`,
    'tell application "Reminders"',
    `  tell list "${asEscape(list)}"`,
    `    make new reminder with properties {name:"${asEscape(title)}", due date:theDate}`,
    "  end tell",
    "end tell",
  ].join("\n");
}

async function processRequest(file) {
  const path = join(SPOOL, file);
  let req;
  try {
    req = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    await log(`bad JSON ${file}, deleting: ${err}`);
    await unlink(path).catch(() => {});
    return;
  }
  // Allowlist: add-only. Anything else is dropped.
  if (req.op !== "reminder.add") {
    await log(`rejected op ${JSON.stringify(req.op)} in ${file} (only reminder.add allowed), deleting`);
    await unlink(path).catch(() => {});
    return;
  }
  if (!req.title || !req.dueISO || !req.list) {
    await log(`incomplete request in ${file} (need title/dueISO/list), deleting`);
    await unlink(path).catch(() => {});
    return;
  }
  const script = buildAppleScript(req);
  if (!script) {
    await log(`unparseable dueISO ${req.dueISO} in ${file}, deleting`);
    await unlink(path).catch(() => {});
    return;
  }
  try {
    await run("/usr/bin/osascript", ["-e", script]);
    await log(`added "${req.title}" to list "${req.list}" due ${req.dueISO}`);
  } catch (err) {
    const msg = String(err);
    const perm = /-1743|not authorized|Not authorized|assistive|automation/i.test(msg);
    await log(
      `FAILED to add "${req.title}": ${msg}${perm ? "  <- looks like the Automation/Reminders grant is missing; Allow the 'control Reminders' prompt or switch to the EventKit helper" : ""}`,
    );
    await unlink(path).catch(() => {});
    return; // do not re-snapshot; nothing changed
  }
  await unlink(path).catch(() => {});
  // Let the Reminders store commit, then re-snapshot so Chief sees it now.
  await new Promise((r) => setTimeout(r, 1500));
  try {
    await run(NODE, [MIRROR]);
    await log("re-snapshot done");
  } catch (err) {
    await log(`re-snapshot failed: ${err}`);
  }
}

async function main() {
  let files;
  try {
    files = await readdir(SPOOL);
  } catch (err) {
    await log(`no spool dir ${SPOOL}: ${err}`);
    return;
  }
  const requests = files.filter((f) => f.endsWith(".json") && !f.startsWith("."));
  for (const f of requests.sort()) await processRequest(f);
}

main().catch(async (err) => {
  await log(`fatal: ${err}`);
  process.exitCode = 1;
});
