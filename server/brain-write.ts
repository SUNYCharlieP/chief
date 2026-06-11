import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { stripEmDashes } from "./text-style.js";
import { BRAIN_DIR } from "./brain.js";

// Stage A local-write executor. The server can't write the canonical brain
// in-process (the write must be backed up + applied under the GUI session), so
// it drops an append-request into a shared spool dir. The charlie-owned launchd
// agent (com.chief.brain-writer) is the sole authority that validates the request
// and appends to the canonical Skills.md. We confirm the round-trip by polling
// that SAME canonical file the reader (brain.ts) loads from (BRAIN_DIR) for our
// unique marker, never by trusting the request. Confirming against the canonical
// (not a downstream mirror) means a write can't report failed just because a
// mirror hop lagged or stopped.

// JAR-21: user-owned spool, NOT /Users/Shared (which was world-writable, an
// injection vector into Skills.md). Created 0700 so only charlie can drop
// requests; the brain-writer also rejects non-owner files as defense in depth.
const SPOOL_DIR = process.env.CHIEF_BRAIN_SPOOL_DIR ?? resolve(homedir(), ".chief-brain-spool");

const POLL_TRIES = 30;
const POLL_INTERVAL_MS = 500;

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export interface AppendResult {
  confirmed: boolean;
  // The canonical Skills.md we verified the round-trip against — the SAME file
  // the brain reader loads from. (Field name kept for callers; it is the
  // canonical brain path now, not a downstream mirror.)
  mirrorPath: string;
  bytes: number;
  requestId: string;
}

export async function appendSkillEntry(rawEntry: string): Promise<AppendResult> {
  // Last step before the bytes leave for the spool: strip em/en dashes so the
  // written Skills.md obeys the no-em-dash rule regardless of what the model
  // drafted. Everything downstream (bytes, hash, payload, mirror poll) uses the
  // cleaned entry.
  const cleaned = stripEmDashes(rawEntry);
  const requestId = randomId("bw");
  // Stamp a unique marker (invisible HTML comment) onto the appended entry so
  // confirmation verifies THIS write landed, not that matching text exists. The
  // old content-match (body.includes(entry)) false-confirmed when an identical
  // entry was already present. The writer appends `entry` verbatim, so the
  // marker rides through into Skills.md and the mirror.
  const marker = `<!-- chief-req:${requestId} -->`;
  const entry = `${cleaned}\n${marker}`;
  const bytes = Buffer.byteLength(entry, "utf8");
  await mkdir(SPOOL_DIR, { recursive: true, mode: 0o700 });

  const payload = JSON.stringify({
    action: "skills.append",
    entry,
    requestId,
    sha256: sha256(entry),
    createdAt: Date.now(),
  });

  // Atomic publish: write to a dotfile the writer ignores, then rename into
  // place so the writer never reads a half-written request.
  const tmp = resolve(SPOOL_DIR, `.${requestId}.tmp`);
  const finalPath = resolve(SPOOL_DIR, `${requestId}.json`);
  await writeFile(tmp, payload, "utf8");
  await rename(tmp, finalPath);

  const confirmed = await pollCanonicalForMarker(marker);
  return { confirmed, mirrorPath: resolve(BRAIN_DIR, "Skills.md"), bytes, requestId };
}

// Confirm THIS write by its unique requestId marker, never by entry content.
// Polls the canonical Skills.md (BRAIN_DIR) — the same file the reader loads —
// so confirmation tracks the durable write directly, with no mirror hop to lag.
async function pollCanonicalForMarker(marker: string): Promise<boolean> {
  const canonicalSkills = resolve(BRAIN_DIR, "Skills.md");
  for (let i = 0; i < POLL_TRIES; i++) {
    try {
      const body = await readFile(canonicalSkills, "utf8");
      if (body.includes(marker)) return true;
    } catch {
      // canonical not readable yet; retry
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
