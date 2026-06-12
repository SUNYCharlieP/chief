#!/usr/bin/env node
// Charlie-side calendar WRITER (JAR-26). Runs AS charlie via the launchd agent
// com.chief.calendar-writer (WatchPaths on the spool), so it can create events in
// charlie's GUI EventKit context, which Chief can't. SOLE ALLOWLIST AUTHORITY:
// the only operation is "calendar.add". There is no edit/delete path here, by
// construction.
//
// On a successful save it drops a per-request sentinel at <spool>/done/<requestId>
// (the Chief side polls for it to confirm THIS write landed) and re-runs the
// calendar mirror so read_calendar reflects the new event immediately.

import { readdir, readFile, unlink, appendFile, stat, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 0700 user-owned spool (JAR-21/24 discipline). This plist has NO
// EnvironmentVariables, so THIS source default is authoritative — keep it and the
// plist WatchPaths in lockstep (the JAR-24 inverted gotcha).
const SPOOL = process.env.CHIEF_CALENDAR_SPOOL_DIR ?? join(homedir(), ".chief-calendar-spool");
const DONE = join(SPOOL, "done");
// Defense in depth: only honor requests OWNED by the trusted uid (this agent's own
// uid by default). A request planted by another user is rejected, never processed.
const TRUSTED_UID =
  process.env.CHIEF_CALENDAR_OWNER_UID !== undefined ? Number(process.env.CHIEF_CALENDAR_OWNER_UID) : process.getuid();
const HELPER = process.env.CHIEF_CALENDAR_WRITE_HELPER ?? join(homedir(), ".chief-bin/calendar-write-helper");
const MIRROR = join(dirname(fileURLToPath(import.meta.url)), "calendar-mirror.mjs");
const NODE = process.env.CHIEF_NODE_PATH ?? "/opt/homebrew/bin/node";
const LOG = process.env.CHIEF_CALENDAR_WRITER_LOG ?? join(homedir(), "Library/Logs/chief-calendar-writer.log");

async function log(msg) {
  try {
    await appendFile(LOG, `${new Date().toISOString()} ${msg}\n`, "utf8");
  } catch {
    /* best effort */
  }
}

function run(bin, args, opts = {}) {
  return new Promise((res, rej) => {
    execFile(bin, args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) rej(new Error(stderr?.toString().slice(0, 400) || err.message));
      else res(stdout);
    });
  });
}

async function processRequest(file) {
  const path = join(SPOOL, file);

  // Defense in depth (JAR-24): reject any request file not owned by the trusted uid.
  try {
    const st = await stat(path);
    if (st.uid !== TRUSTED_UID) {
      await log(`REJECTED ${file}: owner uid ${st.uid} != trusted ${TRUSTED_UID}; unlinking, not processing`);
      await unlink(path).catch(() => {});
      return;
    }
  } catch (err) {
    await log(`cannot stat ${file}: ${err}`);
    return;
  }

  let req;
  try {
    req = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    await log(`bad JSON ${file}, deleting: ${err}`);
    await unlink(path).catch(() => {});
    return;
  }
  // Allowlist: add-only. Anything else is dropped.
  if (req.op !== "calendar.add") {
    await log(`rejected op ${JSON.stringify(req.op)} in ${file} (only calendar.add allowed), deleting`);
    await unlink(path).catch(() => {});
    return;
  }
  if (!req.title || !req.startISO || !req.endISO || !req.requestId) {
    await log(`incomplete request in ${file} (need title/startISO/endISO/requestId), deleting`);
    await unlink(path).catch(() => {});
    return;
  }

  // Hand the request file straight to the EventKit helper (it decodes the fields
  // it needs and ignores the rest). The helper exits 0 only on a committed save.
  try {
    const out = await run(HELPER, [path]);
    await log(`added "${req.title}" (req ${req.requestId}) ${out.toString().trim()}`);
  } catch (err) {
    const msg = String(err);
    const perm = /CALENDAR_ACCESS_DENIED|not authorized|automation/i.test(msg);
    await log(
      `FAILED to add "${req.title}" (req ${req.requestId}): ${msg}${perm ? "  <- Calendar grant missing for the helper" : ""}`,
    );
    await unlink(path).catch(() => {});
    return; // do not signal done; nothing landed
  }

  // Signal confirmation for THIS request (the Chief side polls done/<requestId>).
  try {
    await mkdir(DONE, { recursive: true, mode: 0o700 });
    await writeFile(join(DONE, req.requestId), "", "utf8");
  } catch (err) {
    await log(`could not write done sentinel for ${req.requestId}: ${err}`);
  }
  await unlink(path).catch(() => {});

  // Let EventKit commit, then re-snapshot so read_calendar reflects it now.
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
