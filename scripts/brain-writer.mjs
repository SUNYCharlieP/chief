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
// After it writes the canonical, the existing brain-mirror rsync propagates the
// change into /Users/Shared/Brain, where the Chief server picks it up.

import { readdir, readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SPOOL_DIR = process.env.CHIEF_BRAIN_SPOOL_DIR ?? "/Users/Shared/chief-brain-spool";
const CANONICAL_SKILLS =
  process.env.CHIEF_BRAIN_CANONICAL ??
  join(homedir(), "Library/Mobile Documents/com~apple~CloudDocs/Brain/Skills.md");
const BACKUP_DIR = process.env.CHIEF_BRAIN_BACKUP_DIR ?? join(homedir(), ".chief-brain-backups");

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
