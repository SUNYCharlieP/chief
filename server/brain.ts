import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";

// Canonical context: the 4 markdown files that describe who Chief is talking
// to and how it should behave. Override location with CHIEF_BRAIN_DIR.
//
// Exported as the SINGLE source of truth for the brain location. The read path
// (here), the write-confirm (brain-write.ts) and the skill-detector all import
// this, so they can never diverge onto different defaults. Previously brain-write
// and skill-detector defaulted to the /Users/Shared/Brain mirror while this read
// iCloud directly; that split meant a brain write confirmed against a different
// file than the reader used, so if the mirror froze a real write reported failed.
export const BRAIN_DIR =
  process.env.CHIEF_BRAIN_DIR ??
  `${homedir()}/Library/Mobile Documents/com~apple~CloudDocs/Brain`;

const BRAIN_FILES = ["Agents.md", "Context.md", "Memory.md", "Skills.md"] as const;
const SIZE_BUDGET_BYTES = 50_000;

interface BrainCache {
  block: string;
  loadedAt: number;
  totalBytes: number;
}

let cache: BrainCache | null = null;
let loadInflight: Promise<BrainCache> | null = null;
let watcher: { close: () => Promise<void> | void } | null = null;

function brainPreamble(): string {
  return [
    "# CANONICAL BRAIN",
    "",
    "Charlie maintains four short markdown files describing himself, his current work, his voice/style rules, and reusable skills. These are the highest-priority context for any turn. Read them carefully and let them override your defaults. If anything in the rest of the system prompt conflicts with what's below, defer to what's below.",
    "",
  ].join("\n");
}

async function readOne(name: string): Promise<{ name: string; body: string; bytes: number }> {
  const path = resolve(BRAIN_DIR, name);
  try {
    const body = await readFile(path, "utf8");
    return { name, body: body.trim(), bytes: Buffer.byteLength(body) };
  } catch (err) {
    console.warn(`[brain] missing ${name} at ${path}: ${String(err)}`);
    return {
      name,
      body: `(file not found at ${path})`,
      bytes: 0,
    };
  }
}

export async function loadBrain(): Promise<BrainCache> {
  if (loadInflight) return loadInflight;
  loadInflight = (async () => {
    const sections = await Promise.all(BRAIN_FILES.map(readOne));
    const totalBytes = sections.reduce((acc, s) => acc + s.bytes, 0);
    if (totalBytes > SIZE_BUDGET_BYTES) {
      console.warn(
        `[brain] combined size ${totalBytes} bytes exceeds budget ${SIZE_BUDGET_BYTES}. Tell Charlie before silently shipping a bloated prompt.`,
      );
    }
    const body = sections
      .map((s) => `## ${s.name}\n\n${s.body}`)
      .join("\n\n");
    const block = `${brainPreamble()}\n${body}`;
    const next: BrainCache = { block, loadedAt: Date.now(), totalBytes };
    cache = next;
    console.log(`[brain] loaded ${BRAIN_FILES.length} files (${totalBytes} bytes)`);
    return next;
  })();
  try {
    return await loadInflight;
  } finally {
    loadInflight = null;
  }
}

export function getBrainBlock(): string {
  return cache?.block ?? "";
}

export async function startBrainWatcher(): Promise<void> {
  await loadBrain();
  if (watcher) return;
  try {
    // Lazy-imported so the test runner doesn't try to resolve chokidar
    // during transitive imports.
    const chokidar = await import("chokidar");
    const w = chokidar.watch(BRAIN_DIR, {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
    const isBrainFile = (p: string): boolean => {
      const name = p.split("/").pop() ?? "";
      return (BRAIN_FILES as readonly string[]).includes(name);
    };
    const reload = async (path: string, reason: string) => {
      if (!isBrainFile(path)) return;
      console.log(`[brain] ${reason} ${path.split("/").pop()} — reloading`);
      await loadBrain();
    };
    w.on("change", (p) => reload(p, "change in"));
    w.on("add", (p) => reload(p, "add of"));
    w.on("unlink", (p) => reload(p, "delete of"));
    watcher = { close: () => w.close() };
    console.log(`[brain] watching ${BRAIN_DIR}`);
  } catch (err) {
    console.warn(
      `[brain] chokidar watch failed (${String(err)}). Brain content will be static until restart.`,
    );
  }
}

export async function stopBrainWatcher(): Promise<void> {
  if (watcher) {
    await watcher.close();
    watcher = null;
  }
}
