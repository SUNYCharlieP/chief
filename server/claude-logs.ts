import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Reusable reader over the local Claude Code session logs in ~/.claude/projects.
// JAR-19's usage aggregator is the first consumer; the Skills.md watcher will
// mine the SAME logs later, so this stays a clean primitive: locate sessions,
// parse lines, expose a cheap change-signature. No aggregation logic here.

export function claudeProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

export interface SessionFile {
  sessionId: string; // == filename sans .jsonl
  path: string;
  mtimeMs: number;
}

// Every <sessionId>.jsonl under ~/.claude/projects/<encoded-cwd>/.
export function listSessionFiles(): SessionFile[] {
  const root = claudeProjectsDir();
  if (!existsSync(root)) return [];
  const out: SessionFile[] = [];
  for (const proj of readdirSync(root)) {
    const dir = join(root, proj);
    let entries: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        out.push({ sessionId: name.slice(0, -6), path, mtimeMs: statSync(path).mtimeMs });
      } catch {
        /* file vanished between readdir and stat */
      }
    }
  }
  return out;
}

// Parse a session's JSONL into objects, tolerant of a truncated/partial last
// line (logs are appended live, so a final half-written line is normal).
export function readSessionLines(path: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip a malformed/partial line */
    }
  }
  return out;
}

// Cheap change signature for caching: file count + newest mtime. Statting all
// files is fast; parsing them is the cost we avoid when nothing changed.
export function sessionsSignature(files: SessionFile[]): string {
  let maxMtime = 0;
  for (const f of files) if (f.mtimeMs > maxMtime) maxMtime = f.mtimeMs;
  return `${files.length}:${maxMtime}`;
}
