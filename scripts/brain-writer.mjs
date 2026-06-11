#!/usr/bin/env node
// Charlie-side brain writer for the Stage A draft-and-ask action layer.
//
// Runs as user "charlie" (the only user that can write the canonical iCloud
// brain) via the launchd agent com.chief.brain-writer, triggered by WatchPaths
// on the spool dir. The Chief server drops append-requests into the spool; this
// script is the SOLE allowlist authority:
//   - the only permitted operation is appending to the canonical Skills.md;
//   - any path/target/action in the request beyond "skills.append" is ignored;
//   - every write is preceded by a timestamped backup.
// The server reads this canonical file directly and confirms its write against
// it, so the write is visible the moment this append lands — no mirror hop.

import { readdir, readFile, writeFile, rename, mkdir, unlink, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";

// JAR-21: user-owned spool (was world-writable /Users/Shared, an injection
// vector into Skills.md). The launchd plist sets CHIEF_BRAIN_SPOOL_DIR; this is
// the fallback default.
const SPOOL_DIR = process.env.CHIEF_BRAIN_SPOOL_DIR ?? join(homedir(), ".chief-brain-spool");
// Defense in depth: only honor requests OWNED by the trusted uid (this agent's
// own uid by default). Even if the spool perms ever regress to world-writable, a
// request planted by another user is rejected, never appended. The env override
// exists only to exercise the reject branch in a test.
const TRUSTED_UID =
  process.env.CHIEF_BRAIN_OWNER_UID !== undefined ? Number(process.env.CHIEF_BRAIN_OWNER_UID) : process.getuid();
const CANONICAL_SKILLS =
  process.env.CHIEF_BRAIN_CANONICAL ??
  join(homedir(), "Library/Mobile Documents/com~apple~CloudDocs/Brain/Skills.md");
const BACKUP_DIR = process.env.CHIEF_BRAIN_BACKUP_DIR ?? join(homedir(), ".chief-brain-backups");
// JAR-16 write health-check sentinel: proves THIS launchd agent (not an
// interactive shell) can write the iCloud Brain dir, without ever touching
// Skills.md. The brain reader ignores it (not one of the 4 canonical files).
const HEALTHCHECK_FILE = join(dirname(CANONICAL_SKILLS), ".writer-healthcheck");

const ACTIVE_HEADER = "## Active Skills";
const PLACEHOLDER = "(None yet. Build them as the work surfaces them.)";
const MAX_ENTRY_BYTES = 8192;

function log(msg) {
  process.stdout.write(`[brain-writer] ${new Date().toISOString()} ${msg}\n`);
}

function tsStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function safeUnlink(p) {
  try {
    await unlink(p);
  } catch {
    /* already gone */
  }
}

// Insert the entry under "## Active Skills": replace the "(None yet…)"
// placeholder on first use, otherwise append at end of file.
function applyAppend(current, entry) {
  const block = entry.trim();
  if (current.includes(PLACEHOLDER)) {
    return current.replace(PLACEHOLDER, block);
  }
  const trimmed = current.replace(/\s+$/u, "");
  return `${trimmed}\n\n${block}\n`;
}

async function processRequest(file) {
  const path = resolve(SPOOL_DIR, file);

  // Defense in depth (JAR-21): reject any request file not owned by the trusted
  // uid — a planted request from another user is ignored, never appended.
  try {
    const st = await stat(path);
    if (st.uid !== TRUSTED_UID) {
      log(`REJECTED ${file}: owner uid ${st.uid} != trusted ${TRUSTED_UID}; unlinking, not appending`);
      await safeUnlink(path);
      return;
    }
  } catch (err) {
    log(`cannot stat ${file}: ${err}`);
    return;
  }

  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    log(`cannot read ${file}: ${err}`);
    return;
  }

  let req;
  try {
    req = JSON.parse(raw);
  } catch (err) {
    log(`bad JSON ${file}, deleting: ${err}`);
    await safeUnlink(path);
    return;
  }

  // Allowlisted, non-destructive health check (JAR-16): write a sentinel into
  // the iCloud Brain dir and stop. Never reads or writes Skills.md, so it can
  // prove the agent's iCloud write path without risking the real brain.
  if (req.action === "skills.healthcheck") {
    const reqId = typeof req.requestId === "string" ? req.requestId : "?";
    const stamp = `ok ${new Date().toISOString()} req=${reqId}\n`;
    try {
      await writeFile(HEALTHCHECK_FILE, stamp, "utf8");
      log(`healthcheck wrote ${HEALTHCHECK_FILE} (req ${reqId})`);
    } catch (err) {
      log(`healthcheck FAILED writing ${HEALTHCHECK_FILE}: ${err}`);
    }
    await safeUnlink(path);
    return;
  }

  // Sole allowlist authority. Trust nothing in the request except `entry`.
  if (req.action !== "skills.append") {
    log(`rejected action ${JSON.stringify(req.action)} in ${file} (only skills.append allowed), deleting`);
    await safeUnlink(path);
    return;
  }
  const entry = typeof req.entry === "string" ? req.entry.trim() : "";
  if (!entry) {
    log(`empty entry in ${file}, deleting`);
    await safeUnlink(path);
    return;
  }
  if (Buffer.byteLength(entry, "utf8") > MAX_ENTRY_BYTES) {
    log(`entry too large in ${file} (${Buffer.byteLength(entry, "utf8")}B), deleting`);
    await safeUnlink(path);
    return;
  }

  let current;
  try {
    current = await readFile(CANONICAL_SKILLS, "utf8");
  } catch (err) {
    // Leave the request in place so a transient read failure retries next tick.
    log(`cannot read canonical ${CANONICAL_SKILLS}: ${err} (leaving request for retry)`);
    return;
  }

  if (!current.includes(ACTIVE_HEADER)) {
    log(`canonical missing "${ACTIVE_HEADER}" section, refusing to write ${file} (leaving for inspection)`);
    return;
  }

  // Backup before any write.
  await mkdir(BACKUP_DIR, { recursive: true });
  const backup = join(BACKUP_DIR, `Skills.md.${tsStamp()}.bak`);
  await writeFile(backup, current, "utf8");

  const updated = applyAppend(current, entry);
  const tmp = `${CANONICAL_SKILLS}.tmp.${process.pid}`;
  await writeFile(tmp, updated, "utf8");
  await rename(tmp, CANONICAL_SKILLS);
  log(`appended ${Buffer.byteLength(entry, "utf8")}B to ${CANONICAL_SKILLS} (backup ${backup})`);

  await safeUnlink(path);
}

async function main() {
  let files;
  try {
    files = await readdir(SPOOL_DIR);
  } catch (err) {
    log(`no spool dir ${SPOOL_DIR}: ${err}`);
    return;
  }
  const requests = files.filter((f) => f.endsWith(".json") && !f.startsWith("."));
  for (const f of requests.sort()) {
    await processRequest(f);
  }
}

main().catch((err) => {
  log(`fatal: ${err}`);
  process.exitCode = 1;
});
