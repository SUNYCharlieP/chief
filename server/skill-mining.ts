import { createHash } from "node:crypto";
import { listSessionFiles, readSessionLines } from "./claude-logs.js";
import { getRuntimeConfig } from "./runtime-config.js";
import { runAgentRuntime } from "./runtimes/index.js";

// JAR-16 Stage B detector, rebuilt over the local ~/.claude session logs.
// Replaces the old git-commit term-frequency heuristic. Two gates, BOTH required:
//   Gate 1 (deterministic, pre-model): a workflow signature recurs in >= N
//           DISTINCT sessions. This is the cost wall — the model never sees a
//           session that didn't already repeat.
//   Gate 2 (model): Sonnet judges it a real reusable workflow with confidence
//           >= cutoff. The cutoff is enforced HERE in code; the model scores,
//           the code decides. A candidate surfaces only if BOTH pass.
// Reuses claude-logs.ts (JAR-19) for I/O. Pure stages are exported for tests.

const SCORE_MODEL = process.env.CHIEF_SKILL_SCORE_MODEL ?? "claude-sonnet-4-6";
const MIN_OCCURRENCES = Number(process.env.CHIEF_SKILL_MIN_OCCURRENCES ?? 2); // Gate 1
const CONFIDENCE_CUTOFF = Number(process.env.CHIEF_SKILL_CONFIDENCE ?? 0.7); // Gate 2
const MAX_CANDIDATES = Number(process.env.CHIEF_SKILL_MAX_CANDIDATES ?? 8); // model cost cap
const SUBSUME_OVERLAP = 0.7;
const WINDOW_DAYS = Number(process.env.CHIEF_SKILL_WINDOW_DAYS ?? 30);

// Allowlist of programs that may become workflow tokens. An allowlist (not a
// denylist of generic commands) is the safety wall: a secret, an email, a
// heredoc line, or a code fragment never matches a known program, so it can
// NEVER become a token or reach the model. Extend via CHIEF_SKILL_PROGRAMS.
const KNOWN_PROGRAMS = new Set(
  [
    "git", "xcodebuild", "xcrun", "simctl", "idb", "agvtool", "altool", "notarytool",
    "npm", "npx", "node", "tsx", "tsc", "vitest", "pnpm", "yarn", "bun", "bunx",
    "convex", "curl", "launchctl", "gh", "docker", "cargo", "brew", "make", "cmake",
    "ssh", "scp", "rsync", "osascript", "plutil", "plistbuddy", "security", "pod",
    "xcode-select", "fastlane", "python3", "python", "pip", "pip3", "ruby", "go",
    "swift", "pkill", "devicectl", "xctrace", "instruments", "codesign", "defaults",
    ...(process.env.CHIEF_SKILL_PROGRAMS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  ].map((s) => s.toLowerCase()),
);

// Known programs whose subcommand carries the real signal (git:commit etc.).
const SUBCOMMANDS: Record<string, string[]> = {
  git: ["commit", "push", "pull", "rebase", "merge", "checkout", "clone", "tag", "stash"],
  xcodebuild: ["archive", "build", "test", "clean"],
  convex: ["run", "dev", "deploy", "data", "import"],
  npm: ["run", "install", "test", "ci", "publish"],
  agvtool: ["new-version", "what-version", "new-marketing-version"],
  altool: ["upload-app", "validate-app"],
  launchctl: ["kickstart", "load", "unload", "bootstrap"],
  vitest: ["run"],
  docker: ["build", "run", "push", "compose"],
  cargo: ["build", "test", "run", "publish"],
  gh: ["pr", "release", "repo", "workflow"],
};

type LogLine = {
  type?: unknown;
  isSidechain?: unknown;
  message?: { content?: unknown; [k: string]: unknown };
};

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ---- Stage 1: extraction (pure) ---------------------------------------------

export interface SessionSignature {
  sessionId: string;
  gist: string; // truncated first real user prompt — the intent
  tokens: string[]; // deduped action tokens (cmd + file/path) — context + filter
  sequence: string[]; // ORDERED cmd-token run, adjacent dups collapsed — for n-grams
  steps: string[]; // a few representative shell steps (redacted, truncated)
}

// Normalize a bash command into a stable "prog" or "prog:subcommand" token.
// Unwraps common launchers (npx/xcrun/sudo) so `xcrun altool --upload-app`
// becomes "altool:upload-app", not "xcrun".
export function normalizeCommand(cmd: string): string | null {
  const firstSeg = cmd.trim().split(/[\n;|&]/)[0]?.trim() ?? "";
  const parts = firstSeg.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  let prog = parts[0].split("/").pop() ?? parts[0];
  let rest = parts.slice(1);
  if ((prog === "npx" || prog === "xcrun" || prog === "sudo" || prog === "bunx") && rest.length) {
    prog = rest[0].split("/").pop() ?? rest[0];
    rest = rest.slice(1);
  }
  const subs = SUBCOMMANDS[prog];
  if (subs) {
    const hit = rest.find((r) => subs.includes(r) || subs.includes(r.replace(/^--/, "")));
    if (hit) return `${prog}:${hit.replace(/^--/, "")}`;
  }
  return prog;
}

// Split a Bash invocation into command segments on shell separators, SKIPPING
// heredoc bodies (commit messages, inline python/node — all noise + leak risk).
// Pipes are intentionally NOT split on: pipe stages are almost always generic
// (grep/sort/head) and add only noise.
function splitCommands(cmd: string): string[] {
  const kept: string[] = [];
  let heredocTerm: string | null = null;
  for (const line of cmd.split("\n")) {
    if (heredocTerm !== null) {
      if (line.trim() === heredocTerm) heredocTerm = null;
      continue; // inside a heredoc body — skip entirely
    }
    const hd = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (hd) heredocTerm = hd[1];
    kept.push(line);
  }
  return kept.join("\n").split(/\s*(?:&&|\|\||;|\n)\s*/);
}

// Allowlisted program tokens in EXECUTION ORDER (for sequence/n-gram mining).
// Recovers the real command behind a leading `cd …`, but emits ONLY allowlisted
// programs — so the token space can't fill with code fragments, secrets, or PII.
export function orderedTokens(cmd: string): string[] {
  const out: string[] = [];
  for (const seg of splitCommands(cmd)) {
    const tok = normalizeCommand(seg);
    if (tok && KNOWN_PROGRAMS.has(tok.split(":")[0].toLowerCase())) out.push(tok);
  }
  return out;
}

// Deduped set of the same tokens (bag) — for the "has any action" filter.
export function commandTokens(cmd: string): string[] {
  return [...new Set(orderedTokens(cmd))];
}

// Redact secrets/PII before anything reaches the model bundle or persistence.
// Session logs contain auth tokens, API keys, and emails — none of that leaves
// this module. Applied to the gist and to every example step.
export function redact(s: string): string {
  return s
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "<email>")
    .replace(/\b(?:sk-|ghp_|gho_|github_pat_|xox[baprs]-|AKIA|AuthKey_)[A-Za-z0-9_-]+/g, "<key>")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer <token>")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "<hex>")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "<token>");
}

export function extractSignature(sessionId: string, lines: LogLine[]): SessionSignature {
  let gist = "";
  const tokens = new Set<string>();
  const sequence: string[] = [];
  const steps: string[] = [];

  for (const line of lines) {
    if (line.isSidechain === true) continue;
    const msg = (line.message ?? {}) as { content?: unknown };
    const content = msg.content;

    if (line.type === "user") {
      if (gist) continue;
      const isToolResult = Array.isArray(content) && content.some((b) => (b as { type?: unknown })?.type === "tool_result");
      if (isToolResult) continue;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((b) => (b as { type?: unknown })?.type === "text")
                .map((b) => (b as { text?: string }).text ?? "")
                .join(" ")
            : "";
      if (text.trim()) gist = clip(redact(text.trim().replace(/\s+/g, " ")), 140);
      continue;
    }

    if (line.type !== "assistant" || !Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: unknown; name?: unknown; input?: Record<string, unknown> };
      if (b.type !== "tool_use") continue;
      const name = typeof b.name === "string" ? b.name : "";
      if (name === "Bash") {
        const cmd = b.input?.command;
        if (typeof cmd === "string") {
          const ordered = orderedTokens(cmd);
          for (const tok of ordered) {
            tokens.add(`cmd:${tok}`);
            const ct = `cmd:${tok}`;
            // ordered run, collapse adjacent dups, cap length to bound n-grams
            if (sequence.length < 60 && sequence[sequence.length - 1] !== ct) sequence.push(ct);
          }
          if (ordered.length > 0 && steps.length < 8) steps.push(clip(redact(cmd.replace(/\s+/g, " ")), 90));
        }
      } else if (name === "Edit" || name === "Write" || name === "NotebookEdit") {
        const fp = b.input?.file_path;
        if (typeof fp === "string") {
          const ext = fp.split(".").pop();
          if (ext && /^[a-z0-9]{1,5}$/i.test(ext)) tokens.add(`file:.${ext.toLowerCase()}`);
          const top = fp.match(/\/(server|convex|test|scripts|ChiefApp|Config|src|app)\//)?.[1];
          if (top) tokens.add(`path:${top}`);
        }
      }
    }
  }

  return { sessionId, gist, tokens: [...tokens], sequence, steps };
}

// ---- Stage 2: clustering = GATE 1 (pure) ------------------------------------

export interface Candidate {
  patternKey: string;
  anchor: string;
  tokens: string[]; // the ordered command RUN (the n-gram)
  sessions: string[]; // distinct sessions containing the run (occurrences)
  occurrences: number;
}

const NGRAM_MIN = 2; // a workflow is at least two steps
const NGRAM_MAX = 6;

// Is `small` a contiguous sub-run of `big`?
function isSubrun(small: string[], big: string[]): boolean {
  if (small.length > big.length) return false;
  outer: for (let i = 0; i + small.length <= big.length; i++) {
    for (let j = 0; j < small.length; j++) if (big[i + j] !== small[j]) continue outer;
    return true;
  }
  return false;
}

// Stage 2 = GATE 1, SEQUENCE-based. A workflow is an ORDERED run of commands, so
// we mine recurring contiguous n-grams (length 2..MAX) of each session's command
// sequence. GATE 1: keep only runs recurring in >= minOccurrences DISTINCT
// sessions — the model never sees a run that didn't repeat. Then keep MAXIMAL
// runs (drop a sub-run covered by a longer recurring run over the same sessions)
// and cap. Session-level co-occurrence can't separate workflows that share a
// session; an ordered n-gram can.
export function clusterCandidates(
  signatures: SessionSignature[],
  opts: { minOccurrences?: number; maxCandidates?: number } = {},
): Candidate[] {
  const minOcc = opts.minOccurrences ?? MIN_OCCURRENCES;
  const maxCandidates = opts.maxCandidates ?? MAX_CANDIDATES;

  const gramSessions = new Map<string, Set<string>>();
  const gramTokens = new Map<string, string[]>();
  for (const s of signatures) {
    const seq = s.sequence;
    const seenThisSession = new Set<string>();
    for (let len = NGRAM_MIN; len <= NGRAM_MAX; len++) {
      for (let i = 0; i + len <= seq.length; i++) {
        const gram = seq.slice(i, i + len);
        const key = gram.join(" » ");
        if (seenThisSession.has(key)) continue; // a session counts once per run
        seenThisSession.add(key);
        let bag = gramSessions.get(key);
        if (!bag) {
          gramSessions.set(key, (bag = new Set()));
          gramTokens.set(key, gram);
        }
        bag.add(s.sessionId);
      }
    }
  }

  const grams = [...gramSessions.entries()]
    .filter(([, set]) => set.size >= minOcc)
    .map(([key, set]) => ({
      key,
      tokens: gramTokens.get(key)!,
      sessions: [...set].sort(),
      occurrences: set.size,
    }));

  // Process longest/most-frequent first; drop a run that is a sub-run of an
  // already-kept run over (mostly) the same sessions — keeps the maximal run.
  grams.sort(
    (a, b) => b.tokens.length - a.tokens.length || b.occurrences - a.occurrences || a.key.localeCompare(b.key),
  );
  const kept: typeof grams = [];
  for (const g of grams) {
    const subsumed = kept.some((k) => {
      if (!isSubrun(g.tokens, k.tokens)) return false;
      const ks = new Set(k.sessions);
      let overlap = 0;
      for (const sid of g.sessions) if (ks.has(sid)) overlap++;
      return overlap / g.sessions.length >= SUBSUME_OVERLAP;
    });
    if (!subsumed) kept.push(g);
  }

  // Final ranking for the cap: frequency first, then specificity.
  kept.sort(
    (a, b) => b.occurrences - a.occurrences || b.tokens.length - a.tokens.length || a.key.localeCompare(b.key),
  );
  return kept.slice(0, maxCandidates).map((g) => ({
    patternKey: `claude:${createHash("sha1").update(g.key).digest("hex").slice(0, 12)}`,
    anchor: g.tokens[0],
    tokens: g.tokens,
    sessions: g.sessions,
    occurrences: g.occurrences,
  }));
}

// ---- Stage 3: model scoring = GATE 2 ----------------------------------------

export interface ScoredCandidate {
  patternKey: string;
  tokens: string[];
  occurrences: number;
  sessions: string[]; // provenance: the distinct sessions this came from
  isReusableWorkflow: boolean;
  confidence: number;
  skillTitle: string;
  skillEntry: string;
  pitch: string;
}

// GATE 2 cutoff, enforced in code (pure). The model returns scores; this decides.
export function applyConfidenceGate(scored: ScoredCandidate[], cutoff = CONFIDENCE_CUTOFF): ScoredCandidate[] {
  return scored.filter((c) => c.isReusableWorkflow && c.confidence >= cutoff);
}

const SCORING_SYSTEM = `You review evidence of REPEATED developer workflows mined from a user's local
coding-assistant session logs, and decide which are real, reusable workflows
worth capturing as a "skill" (a short reusable playbook the assistant can follow
next time).

You receive a JSON array of candidates. Each has: patternKey, sequence (an
ORDERED run of commands that recurred across multiple sessions), occurrences
(how many DISTINCT sessions ran it), and up to 3 examples (the user's intent
gist + representative shell steps).

For EACH candidate, return one object with exactly these fields:
  "patternKey": echo it back unchanged
  "isReusableWorkflow": boolean — true ONLY if the ordered sequence is a
     coherent, repeatable procedure worth writing down (e.g. "agvtool bump →
     xcodebuild archive → export → altool upload"). false for an incidental run
     of unrelated commands, one-off debugging, or a generic edit/build/commit
     that isn't a distinctive workflow.
  "confidence": number 0..1 — your confidence it is a real reusable workflow.
  "skillTitle": short imperative title, e.g. "Ship a TestFlight build".
  "skillEntry": a concise Skills.md entry — a single "### <title>" markdown
     heading followed by a tight numbered list of the actual steps. No preamble.
  "pitch": one sentence proposing it, e.g. "Want me to save the TestFlight
     ship steps as a skill?"

Be conservative: when in doubt, low confidence. Output ONLY the JSON array.`;

interface Bundle {
  patternKey: string;
  sequence: string[];
  occurrences: number;
  examples: { gist: string; steps: string[] }[];
}

// The ONLY things that reach the model: the ordered run (allowlisted program
// tokens — no secrets possible) and example gist/steps that were redacted at
// extraction time. No raw log content crosses this boundary.
function buildBundles(candidates: Candidate[], sigById: Map<string, SessionSignature>): Bundle[] {
  return candidates.map((c) => ({
    patternKey: c.patternKey,
    sequence: c.tokens,
    occurrences: c.occurrences,
    examples: c.sessions.slice(0, 3).map((sid) => {
      const sig = sigById.get(sid);
      return { gist: sig?.gist ?? "", steps: (sig?.steps ?? []).slice(0, 4) };
    }),
  }));
}

function parseScored(text: string): Array<Record<string, unknown>> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end < 0) return [];
  try {
    const arr = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ---- Orchestrator ------------------------------------------------------------

export interface MineReport {
  sessionsScanned: number;
  signaturesWithTokens: number;
  candidatesAfterGate1: number;
  scored: ScoredCandidate[]; // ALL scored (pass + fail) — the dry run shows these
  passed: ScoredCandidate[]; // cleared BOTH gates
  modelCalled: boolean;
  cutoff: number;
  minOccurrences: number;
  usage?: unknown;
}

// Read logs -> extract -> cluster (Gate 1) -> score (Gate 2). Does NOT persist
// or write anything; persistence + the morning card are wired separately after
// the dry-run review. `sinceMs` bounds which session files are read (by mtime).
export async function mineSkillCandidates(
  opts: { sinceMs?: number; maxCandidates?: number } = {},
): Promise<MineReport> {
  const sinceMs = opts.sinceMs ?? Date.now() - WINDOW_DAYS * 86_400_000;
  const files = listSessionFiles().filter((f) => f.mtimeMs >= sinceMs);

  const signatures: SessionSignature[] = [];
  for (const f of files) {
    const sig = extractSignature(f.sessionId, readSessionLines(f.path) as LogLine[]);
    if (sig.tokens.length > 0) signatures.push(sig);
  }

  const candidates = clusterCandidates(signatures, { maxCandidates: opts.maxCandidates });
  const sigById = new Map(signatures.map((s) => [s.sessionId, s]));

  const report: MineReport = {
    sessionsScanned: files.length,
    signaturesWithTokens: signatures.length,
    candidatesAfterGate1: candidates.length,
    scored: [],
    passed: [],
    modelCalled: false,
    cutoff: CONFIDENCE_CUTOFF,
    minOccurrences: MIN_OCCURRENCES,
  };

  if (candidates.length === 0) return report; // nothing recurred — zero model spend

  const bundles = buildBundles(candidates, sigById);
  const runtimeConfig = await getRuntimeConfig();
  const res = await runAgentRuntime(
    { ...runtimeConfig, model: SCORE_MODEL },
    { prompt: JSON.stringify(bundles, null, 2), systemPrompt: SCORING_SYSTEM, tools: [], mode: "background" },
  );
  report.modelCalled = true;
  report.usage = res.usage;

  const byKey = new Map(candidates.map((c) => [c.patternKey, c]));
  const scored: ScoredCandidate[] = [];
  for (const raw of parseScored(res.text)) {
    const key = typeof raw.patternKey === "string" ? raw.patternKey : "";
    const cand = byKey.get(key);
    if (!cand) continue;
    scored.push({
      patternKey: key,
      tokens: cand.tokens,
      occurrences: cand.occurrences,
      sessions: cand.sessions,
      isReusableWorkflow: raw.isReusableWorkflow === true,
      confidence: typeof raw.confidence === "number" ? raw.confidence : 0,
      skillTitle: typeof raw.skillTitle === "string" ? raw.skillTitle : "",
      skillEntry: typeof raw.skillEntry === "string" ? raw.skillEntry : "",
      pitch: typeof raw.pitch === "string" ? raw.pitch : "",
    });
  }
  scored.sort((a, b) => b.confidence - a.confidence);
  report.scored = scored;
  report.passed = applyConfidenceGate(scored);
  return report;
}
