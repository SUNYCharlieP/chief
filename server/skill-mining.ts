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
  tokens: string[]; // normalized action tokens, deduped
  steps: string[]; // a few representative shell steps (truncated)
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

// Tokenize every command in a (possibly chained) Bash invocation. Recovers the
// real command behind a leading `cd …`, but emits ONLY allowlisted programs —
// so the token space can't fill with code fragments, secrets, or PII.
export function commandTokens(cmd: string): string[] {
  const out = new Set<string>();
  for (const seg of splitCommands(cmd)) {
    const tok = normalizeCommand(seg);
    if (tok && KNOWN_PROGRAMS.has(tok.split(":")[0].toLowerCase())) out.add(tok);
  }
  return [...out];
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
          const toks = commandTokens(cmd);
          for (const tok of toks) tokens.add(`cmd:${tok}`);
          if (toks.length > 0 && steps.length < 8) steps.push(clip(redact(cmd.replace(/\s+/g, " ")), 90));
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

  return { sessionId, gist, tokens: [...tokens], steps };
}

// ---- Stage 2: clustering = GATE 1 (pure) ------------------------------------

export interface Candidate {
  patternKey: string;
  anchor: string;
  tokens: string[]; // anchor + co-occurring recurring tokens
  sessions: string[]; // distinct sessions (occurrences)
  occurrences: number;
}

// Anchor each candidate on a recurring cmd: token, attach the recurring tokens
// that co-occur in at least half its sessions, then dedup + subsume + cap.
// GATE 1 lives here: only signatures in >= minOccurrences DISTINCT sessions
// survive, and the model is never invoked on anything that didn't.
export function clusterCandidates(
  signatures: SessionSignature[],
  opts: { minOccurrences?: number; maxCandidates?: number } = {},
): Candidate[] {
  const minOcc = opts.minOccurrences ?? MIN_OCCURRENCES;
  const maxCandidates = opts.maxCandidates ?? MAX_CANDIDATES;

  const tokenSessions = new Map<string, Set<string>>();
  const sigById = new Map<string, Set<string>>();
  for (const s of signatures) {
    const set = new Set(s.tokens);
    sigById.set(s.sessionId, set);
    for (const tok of set) {
      let bag = tokenSessions.get(tok);
      if (!bag) tokenSessions.set(tok, (bag = new Set()));
      bag.add(s.sessionId);
    }
  }

  const recurring = new Set(
    [...tokenSessions].filter(([, set]) => set.size >= minOcc).map(([t]) => t),
  );
  const anchors = [...recurring].filter((t) => t.startsWith("cmd:"));

  const candidates: Candidate[] = [];
  for (const anchor of anchors) {
    const sessions = [...(tokenSessions.get(anchor) ?? [])];
    if (sessions.length < minOcc) continue;
    const coCount = new Map<string, number>();
    for (const sid of sessions) {
      for (const tok of sigById.get(sid) ?? []) {
        if (tok !== anchor && recurring.has(tok)) coCount.set(tok, (coCount.get(tok) ?? 0) + 1);
      }
    }
    const half = Math.ceil(sessions.length / 2);
    const coTokens = [...coCount].filter(([, c]) => c >= half).map(([t]) => t).sort();
    const tokens = [anchor, ...coTokens];
    candidates.push({
      patternKey: `claude:${createHash("sha1").update(tokens.join("|")).digest("hex").slice(0, 12)}`,
      anchor,
      tokens,
      sessions: sessions.sort(),
      occurrences: sessions.length,
    });
  }

  candidates.sort((a, b) => b.occurrences - a.occurrences || a.anchor.localeCompare(b.anchor));
  const kept: Candidate[] = [];
  for (const c of candidates) {
    if (kept.some((k) => k.tokens.join("|") === c.tokens.join("|"))) continue;
    const subsumed = kept.some((k) => {
      const ks = new Set(k.sessions);
      let overlap = 0;
      for (const s of c.sessions) if (ks.has(s)) overlap++;
      return overlap / c.sessions.length >= SUBSUME_OVERLAP;
    });
    if (subsumed) continue;
    kept.push(c);
  }
  return kept.slice(0, maxCandidates);
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

You receive a JSON array of candidates. Each has: patternKey, signals
(normalized action tokens that recurred across sessions), occurrences (how many
DISTINCT sessions), and up to 3 examples (the user's intent gist + representative
shell steps).

For EACH candidate, return one object with exactly these fields:
  "patternKey": echo it back unchanged
  "isReusableWorkflow": boolean — true ONLY if the signals describe a coherent,
     repeatable multi-step procedure worth writing down (e.g. "archive, bump
     build number, export, upload to TestFlight"). false for incidental
     co-occurrence, one-off debugging, or generic editing/searching.
  "confidence": number 0..1 — your confidence it is a real reusable workflow.
  "skillTitle": short imperative title, e.g. "Ship a TestFlight build".
  "skillEntry": a concise Skills.md entry — a single "### <title>" markdown
     heading followed by a tight numbered list of the actual steps. No preamble.
  "pitch": one sentence proposing it, e.g. "Want me to save the TestFlight
     ship steps as a skill?"

Be conservative: when in doubt, low confidence. Output ONLY the JSON array.`;

interface Bundle {
  patternKey: string;
  signals: string[];
  occurrences: number;
  examples: { gist: string; steps: string[] }[];
}

function buildBundles(candidates: Candidate[], sigById: Map<string, SessionSignature>): Bundle[] {
  return candidates.map((c) => ({
    patternKey: c.patternKey,
    signals: c.tokens,
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
