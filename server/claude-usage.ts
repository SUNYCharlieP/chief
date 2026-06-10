import { listSessionFiles, readSessionLines, sessionsSignature } from "./claude-logs.js";

// JAR-19 Claude Code usage stats, aggregated from the raw ~/.claude session
// logs (authoritative; stats-cache.json is only a sanity cross-check). Decisions
// baked in per sign-off:
//  - real interactive sessions only: exclude sidechains (subagent runs) and the
//    "<synthetic>" pseudo-model.
//  - headline = OUTPUT tokens (real generation); secondary = input+output
//    EXCLUDING cache reads (which are ~100× larger and meaningless as a total).
//  - everything bucketed in local time (America/New_York), like the tracker.

const TZ = process.env.CHIEF_USAGE_TZ ?? process.env.CHIEF_BRIEFING_TZ ?? "America/New_York";
const SYNTHETIC = "<synthetic>";

// A normalized per-line record the pure aggregator works on (tz already applied).
export interface UsageRecord {
  sessionId: string;
  localDate: string; // YYYY-MM-DD in TZ
  hour: number; // 0-23 in TZ
  kind: "user" | "assistant";
  model: string | null; // assistant only
  synthetic: boolean;
  sidechain: boolean;
  toolResult: boolean; // user lines that are tool_result blocks, not real prompts
  outputTokens: number;
  inputTokens: number;
}

export interface UsageStats {
  sessions: number;
  messages: number;
  outputTokens: number; // headline
  totalTokens: number; // input + output, excluding cache
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  peakHour: number | null; // 0-23 local
  favoriteModel: string | null;
  firstDay: string | null;
  perDay: { date: string; count: number }[]; // ascending; for the grid
}

// --- pure aggregation (vitest-able; tz already resolved into each record) -----

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12) + n * 86_400_000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}

// Longest run of consecutive active days, and the current run ending today or
// yesterday (a gap of >1 day means the current streak is 0 — same forgiveness
// as "yesterday still counts" but no further).
function streaks(activeDays: string[], today: string): { current: number; longest: number } {
  if (activeDays.length === 0) return { current: 0, longest: 0 };
  const set = new Set(activeDays);
  const sorted = [...set].sort();

  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    run = sorted[i] === addDays(sorted[i - 1], 1) ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  const last = sorted[sorted.length - 1];
  let current = 0;
  if (last === today || last === addDays(today, -1)) {
    current = 1;
    let cursor = last;
    while (set.has(addDays(cursor, -1))) {
      current++;
      cursor = addDays(cursor, -1);
    }
  }
  return { current, longest };
}

export function aggregateUsage(records: UsageRecord[], opts: { today: string }): UsageStats {
  // Real interactive messages only: drop sidechains, the <synthetic> model, and
  // tool_result lines (Claude Code logs those as type:"user" too — counting them
  // overstates "messages" by ~40% and diverges from CC's own totals).
  const live = records.filter((r) => !r.sidechain && !r.synthetic && !r.toolResult);
  // A counted session has at least one real user prompt.
  const userSessions = new Set(live.filter((r) => r.kind === "user").map((r) => r.sessionId));
  const counted = live.filter((r) => userSessions.has(r.sessionId));

  const byDay = new Map<string, number>();
  const byHour = new Array(24).fill(0);
  const byModel = new Map<string, number>();
  let outputTokens = 0;
  let totalTokens = 0;

  for (const r of counted) {
    byDay.set(r.localDate, (byDay.get(r.localDate) ?? 0) + 1);
    byHour[r.hour]++;
    if (r.kind === "assistant") {
      outputTokens += r.outputTokens;
      totalTokens += r.outputTokens + r.inputTokens;
      if (r.model) byModel.set(r.model, (byModel.get(r.model) ?? 0) + 1);
    }
  }

  const activeDays = [...byDay.keys()].sort();
  const { current, longest } = streaks(activeDays, opts.today);

  let peakHour: number | null = null;
  let peakCount = -1;
  for (let h = 0; h < 24; h++) if (byHour[h] > peakCount) (peakCount = byHour[h]), (peakHour = h);
  if (peakCount <= 0) peakHour = null;

  let favoriteModel: string | null = null;
  let favCount = -1;
  for (const [m, c] of byModel) if (c > favCount) (favCount = c), (favoriteModel = m);

  return {
    sessions: userSessions.size,
    messages: counted.length,
    outputTokens,
    totalTokens,
    activeDays: activeDays.length,
    currentStreak: current,
    longestStreak: longest,
    peakHour,
    favoriteModel,
    firstDay: activeDays[0] ?? null,
    perDay: activeDays.map((date) => ({ date, count: byDay.get(date) ?? 0 })),
  };
}

// --- I/O: read + normalize (tz) + mtime cache ---------------------------------

function localParts(iso: string): { date: string; hour: number } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let hour = parseInt(get("hour"), 10);
  if (hour === 24 || Number.isNaN(hour)) hour = 0;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Turn one session's parsed lines into normalized usage records.
function recordsFor(sessionId: string, lines: Record<string, unknown>[]): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const line of lines) {
    const type = line.type;
    if (type !== "user" && type !== "assistant") continue;
    const ts = line.timestamp;
    if (typeof ts !== "string") continue;
    const lp = localParts(ts);
    if (!lp) continue;
    const sidechain = line.isSidechain === true;
    const msg = (line.message ?? {}) as Record<string, unknown>;
    const model = type === "assistant" && typeof msg.model === "string" ? (msg.model as string) : null;
    const usage = (msg.usage ?? {}) as Record<string, unknown>;
    const content = msg.content;
    const toolResult =
      type === "user" &&
      Array.isArray(content) &&
      content.some((b) => (b as { type?: unknown })?.type === "tool_result");
    out.push({
      sessionId,
      localDate: lp.date,
      hour: lp.hour,
      kind: type,
      model,
      synthetic: model === SYNTHETIC,
      sidechain,
      toolResult,
      outputTokens: num(usage.output_tokens),
      inputTokens: num(usage.input_tokens),
    });
  }
  return out;
}

let cache: { sig: string; stats: UsageStats } | null = null;

// Aggregate all sessions, recomputing only when a log file changed/was added
// (mtime+count signature). `now` is injectable for tests.
export function computeUsageStats(now: Date = new Date()): UsageStats {
  const files = listSessionFiles();
  const sig = sessionsSignature(files);
  if (cache && cache.sig === sig) return cache.stats;

  const records: UsageRecord[] = [];
  for (const f of files) records.push(...recordsFor(f.sessionId, readSessionLines(f.path)));

  const today = localParts(now.toISOString())?.date ?? "";
  const stats = aggregateUsage(records, { today });
  cache = { sig, stats };
  return stats;
}
