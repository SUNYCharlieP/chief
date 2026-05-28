import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { stripEmDashes } from "./text-style.js";

// Stage A local-write executor. Chief (running as user "Chief") cannot write
// the brain files (owned by charlie), so the only thing this does is drop an
// append-request into a shared spool dir. A separate charlie-owned launchd
// agent (com.chief.brain-writer) is the sole authority that validates the
// request and appends to the canonical iCloud Skills.md; the existing
// brain-mirror then rsyncs it into the mirror this process reads. We confirm
// the round-trip by polling the mirror, never by trusting the request.

const SPOOL_DIR = process.env.CHIEF_BRAIN_SPOOL_DIR ?? "/Users/Shared/chief-brain-spool";
const MIRROR_DIR = process.env.CHIEF_BRAIN_DIR ?? "/Users/Shared/Brain";

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
  // The mirror Skills.md this process can see and verified the round-trip
  // against. The durable write lands in the canonical iCloud brain, which the
  // brain-mirror rsyncs here; we report the path we can actually confirm.
  mirrorPath: string;
  bytes: number;
  requestId: string;
}

export async function appendSkillEntry(rawEntry: string): Promise<AppendResult> {
  // Last step before the bytes leave for the spool: strip em/en dashes so the
  // written Skills.md obeys the no-em-dash rule regardless of what the model
  // drafted. Everything downstream (bytes, hash, payload, mirror poll) uses the
  // cleaned entry.
  const entry = stripEmDashes(rawEntry);
  const requestId = randomId("bw");
  const bytes = Buffer.byteLength(entry, "utf8");
  await mkdir(SPOOL_DIR, { recursive: true });

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

  const confirmed = await pollMirrorForEntry(entry);
  return { confirmed, mirrorPath: resolve(MIRROR_DIR, "Skills.md"), bytes, requestId };
}

async function pollMirrorForEntry(entry: string): Promise<boolean> {
  const mirrorSkills = resolve(MIRROR_DIR, "Skills.md");
  const needle = entry.trim();
  for (let i = 0; i < POLL_TRIES; i++) {
    try {
      const body = await readFile(mirrorSkills, "utf8");
      if (body.includes(needle)) return true;
    } catch {
      // mirror not readable yet; retry
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
