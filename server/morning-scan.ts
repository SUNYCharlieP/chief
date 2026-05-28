import { Cron } from "croner";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { sendImessage } from "./imessage.js";
import { loadBrain, getBrainBlock } from "./brain.js";
import {
  listConfiguredSources,
  createFeedTools,
  type FeedSource,
} from "./integrations/rss-loader.js";
import { getRuntimeConfig } from "./runtime-config.js";
import { runAgentRuntime } from "./runtimes/index.js";
import { getUserTimezone } from "./timezone-config.js";
import { EMPTY_USAGE, type UsageTotals } from "./usage.js";

// Phase 8 morning automation.
//   - Scan cron (default 5am local): fast-pass every registered RSS source,
//     keyword-prefilter against the brain, Haiku-score the shortlist in one
//     batched call, persist scored candidates, format a Socratic check-in
//     from the top-3 nominations, stash the formatted text on the scanRun.
//   - Surface cron (default 7am local): retrieve the most-recent completed
//     scan, send its formattedCheckIn via iMessage, or send "no items today"
//     if nothing crossed the threshold.
//
// Single LLM batch for scoring + a single LLM call for formatting keeps cost
// well under the daily budget. The per-source budget concept lives in
// dailyScanCost but the architecture (batched scoring) makes hitting the
// per-source cap effectively impossible at current source counts — we keep
// the tracking machinery so future expensive sources can be capped.

const SIGNAL_THRESHOLD = Number(process.env.CHIEF_SIGNAL_THRESHOLD ?? 70);
const DAILY_SCAN_BUDGET_USD = Number(process.env.CHIEF_DAILY_SCAN_BUDGET_USD ?? 2.0);
const PER_SOURCE_DAILY_BUDGET_USD = Number(
  process.env.CHIEF_PER_SOURCE_DAILY_BUDGET_USD ?? 0.5,
);
const SCAN_CRON = process.env.CHIEF_SCAN_CRON ?? "0 5 * * *";
const SURFACE_CRON = process.env.CHIEF_SURFACE_CRON ?? "0 7 * * *";
const HAIKU_MODEL = process.env.CHIEF_SCAN_MODEL ?? "claude-haiku-4-5-20251001";
const SINCE_WINDOW_HOURS = Number(process.env.CHIEF_SCAN_WINDOW_HOURS ?? 24);
const AUDIT_LOG_PATH = resolve(homedir(), "Library/Logs/chief-scan-audit.md");

let scanCron: Cron | null = null;
let surfaceCron: Cron | null = null;

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function todayLocalDate(timezone: string): string {
  // en-CA gives YYYY-MM-DD which sorts correctly and is unambiguous.
  return new Date().toLocaleDateString("en-CA", { timeZone: timezone });
}

const KEYWORD_STOPWORDS = new Set([
  "the", "this", "that", "these", "those", "with", "from", "what", "when",
  "where", "which", "would", "could", "should", "your", "their", "there",
  "have", "been", "into", "more", "than", "also", "only", "even", "ever",
  "very", "still", "just", "much", "many", "some", "most", "such", "like",
  "about", "after", "before", "between", "through", "during", "without",
  "above", "below", "again", "against", "because", "while",
  "charlie", "chief", "brain", "memory", "context", "skills", "agents",
  "identity", "operational", "file", "files",
]);

function extractBrainKeywords(brain: string): string[] {
  // Mix of capitalized terms (likely proper nouns: project names, tools)
  // and longer lowercase words (likely topical content).
  const caps = brain.match(/\b[A-Z][a-zA-Z0-9-]{2,}\b/g) ?? [];
  const lowers = brain.match(/\b[a-z][a-zA-Z0-9-]{4,}\b/g) ?? [];
  const merged = [...caps, ...lowers].map((w) => w.toLowerCase());
  const filtered = merged.filter((w) => !KEYWORD_STOPWORDS.has(w));
  return [...new Set(filtered)];
}

function keywordHits(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const k of keywords) {
    if (lower.includes(k)) hits.push(k);
  }
  return hits;
}

interface FastPassItem {
  title: string;
  url: string;
  pubDate?: string | null;
  isoDate?: string | null;
  commentsUrl?: string | null;
  excerpt?: string | null;
}

interface ShortlistItem extends FastPassItem {
  source: string;
  keywordMatches: string[];
}

async function fastPassSource(
  source: FeedSource,
): Promise<{ items: FastPassItem[]; error?: string }> {
  const tools = createFeedTools(source);
  const fastPass = tools.find((t) => t.name === source.fastPassTool);
  if (!fastPass) return { items: [], error: `no fast-pass tool for ${source.name}` };
  const since = new Date(Date.now() - SINCE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const r = await fastPass.handle({ since });
  if (r.success === false) {
    return { items: [], error: r.text };
  }
  try {
    const parsed = JSON.parse(r.text) as { items?: FastPassItem[] };
    return { items: parsed.items ?? [] };
  } catch (err) {
    return { items: [], error: `parse error: ${String(err)}` };
  }
}

interface ScoredItemFromLlm {
  index: number;
  score: number;
  reasons: string[];
  competesWith: string[];
}

function parseScoringJson(text: string): ScoredItemFromLlm[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as { scored?: ScoredItemFromLlm[] };
    return Array.isArray(parsed.scored) ? parsed.scored : [];
  } catch {
    return [];
  }
}

async function recordUsage(
  source: "morning-scan-scoring" | "morning-scan-format",
  runId: string,
  usage: UsageTotals,
  durationMs: number,
): Promise<void> {
  if (usage.costUsd <= 0 && usage.inputTokens <= 0) return;
  await convex.mutation(api.usageRecords.record, {
    source,
    runId,
    runtime: undefined,
    billingMode: undefined,
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    costUsd: usage.costUsd,
    durationMs,
  });
}

interface ScoredCandidate {
  candidateId: string;
  source: string;
  title: string;
  url: string;
  pubDate?: string | null;
  excerpt?: string | null;
  score: number;
  reasons: string[];
  competesWith: string[];
  decision: "nominated" | "dropped" | "competes";
}

const SCORING_SYSTEM = `You score candidate items against Charlie's CANONICAL BRAIN for a morning surface check-in. Return STRICT JSON only, no prose, no preamble.`;

function buildScoringPrompt(brain: string, items: ShortlistItem[]): string {
  return `# CANONICAL BRAIN

${brain}

# SCORING RUBRIC

For each item below, return:
  score (0-100): how likely Charlie cares RIGHT NOW given his active projects and current focus.
  reasons (1-3 short strings): why this item matched or didn't. Name brain content that pattern-matched. No vague reasons.
  competesWith (array of strings): list active projects from Context.md / Memory.md this item would compete with for Charlie's attention (e.g. "Arca", "Chief", "school", "VDC pivot"). Empty array if none.

Scoring guidance:
- 80-100: directly relevant to an active project (Memory.md top of mind, Context.md Active Tracks) OR a stated learning target (Skills.md focus areas) AND nothing competes.
- 60-79: tangentially relevant, interesting but not immediately actionable.
- 40-59: mild relevance, not worth interrupting him for.
- 0-39: noise.
- COMPETES-WITH RULE: if the item would pull him toward starting a new project that competes with already-active work (Charlie's stated failure pattern is starting projects he doesn't finish), set score < 40 regardless of relevance and populate competesWith with the conflicting project name.

Return JSON:
{"scored": [
  {"index": 0, "score": 85, "reasons": ["..."], "competesWith": []},
  {"index": 1, "score": 30, "reasons": ["..."], "competesWith": ["Arca"]}
]}

# ITEMS

${items
  .map(
    (it, idx) =>
      `[${idx}] source=${it.source} score-hint-matches=${JSON.stringify(it.keywordMatches)}\n  title=${JSON.stringify(it.title)}\n  url=${it.url}\n  pubDate=${it.pubDate ?? ""}`,
  )
  .join("\n\n")}`;
}

const FORMAT_SYSTEM = `You are Chief, formatting a morning surface check-in for Charlie. Return only the message body (plain iMessage text). No preamble. No JSON. No "here's the message" prefix.`;

function buildFormatPrompt(
  brain: string,
  candidates: ScoredCandidate[],
): string {
  return `Format the candidate(s) below as ONE morning Socratic check-in.

Procedure (from .claude/skills/socratic-checkin/SKILL.md):
1. ONE sentence finding for the top item. No setup, no "I noticed", no preamble.
2. 3 to 5 sharp questions about THAT top item. Each names a specific tradeoff or unknown, anchors to active work (Context.md) or his standards (Memory.md / Agents.md), forces a specific answer. One question per question, no stacked compounds.
3. If more candidates exist beyond #1, add a brief "also caught" line with their titles and a reply hint like \`say "#2" for the [short-name]\`. Do NOT Socratic-format them; one line per item.

Voice rules (non-negotiable):
- No em dashes. Commas, periods, parens.
- No flattery, no "I'd love", no "great", no "I'm sorry", no padding.
- Direct, peer-level. Default to short.
- No closer ("What's the call?", "Let me know"). The numbered questions are themselves the close.

# CANONICAL BRAIN (for voice + content matching)

${brain}

# CANDIDATES (highest score first)

${candidates
  .map(
    (c, idx) =>
      `[#${idx + 1}] score=${c.score}\n  title=${JSON.stringify(c.title)}\n  url=${c.url}\n  reasons=${JSON.stringify(c.reasons)}`,
  )
  .join("\n\n")}

Return only the iMessage body text.`;
}

async function appendAuditLog(section: string): Promise<void> {
  try {
    await mkdir(dirname(AUDIT_LOG_PATH), { recursive: true });
    await appendFile(AUDIT_LOG_PATH, section + "\n\n", "utf8");
  } catch (err) {
    console.warn(`[morning-scan] failed to write audit log: ${String(err)}`);
  }
}

export interface ScanReport {
  runId: string;
  date: string;
  sourcesTouched: string[];
  itemsScanned: number;
  itemsShortlisted: number;
  itemsScored: number;
  itemsNominated: number;
  totalCostUsd: number;
  elapsedMs: number;
  budgetExceeded: boolean;
  formattedCheckIn: string | null;
  errors: string[];
}

export async function runMorningScan(): Promise<ScanReport> {
  const started = Date.now();
  const runId = randomId("scan");
  const timezone = (await getUserTimezone()) ?? "UTC";
  const date = todayLocalDate(timezone);

  await convex.mutation(api.scanRuns.create, { runId, kind: "scan" });

  const report: ScanReport = {
    runId,
    date,
    sourcesTouched: [],
    itemsScanned: 0,
    itemsShortlisted: 0,
    itemsScored: 0,
    itemsNominated: 0,
    totalCostUsd: 0,
    elapsedMs: 0,
    budgetExceeded: false,
    formattedCheckIn: null,
    errors: [],
  };

  // Declared at function scope so the catch block and all audit-log call
  // sites can render whatever was scored before a failure.
  const candidates: ScoredCandidate[] = [];

  try {
    await loadBrain();
    const brain = getBrainBlock();
    if (!brain) {
      report.errors.push("brain is empty");
      await convex.mutation(api.scanRuns.update, {
        runId,
        status: "failed",
        error: "brain empty at scan time",
        elapsedMs: Date.now() - started,
      });
      await appendAuditLog(buildAuditEntry(report, candidates));
      return report;
    }
    const keywords = extractBrainKeywords(brain);
    const sources = listConfiguredSources();

    const shortlist: ShortlistItem[] = [];

    for (const source of sources) {
      report.sourcesTouched.push(source.name);
      const existing = await convex.query(api.dailyScanCost.getForDateSource, {
        date,
        source: source.name,
      });
      if (existing?.hitBudgetCap) {
        report.errors.push(`${source.name}: budget cap already hit today, skipping`);
        continue;
      }
      const { items, error } = await fastPassSource(source);
      if (error) {
        report.errors.push(`${source.name} fast-pass: ${error}`);
        await convex.mutation(api.dailyScanCost.recordCost, {
          date,
          source: source.name,
          costUsd: 0,
          scanAttempted: true,
          scanSucceeded: false,
        });
        continue;
      }
      await convex.mutation(api.dailyScanCost.recordCost, {
        date,
        source: source.name,
        costUsd: 0,
        scanAttempted: true,
        scanSucceeded: true,
      });
      report.itemsScanned += items.length;
      for (const item of items) {
        const matches = keywordHits(`${item.title} ${item.excerpt ?? ""}`, keywords);
        if (matches.length === 0) continue;
        shortlist.push({ ...item, source: source.name, keywordMatches: matches });
      }
    }

    report.itemsShortlisted = shortlist.length;

    if (shortlist.length === 0) {
      report.elapsedMs = Date.now() - started;
      await convex.mutation(api.scanRuns.update, {
        runId,
        status: "completed",
        sources: report.sourcesTouched,
        itemsScanned: report.itemsScanned,
        itemsScored: 0,
        itemsNominated: 0,
        totalCostUsd: 0,
        elapsedMs: report.elapsedMs,
        formattedCheckIn: "",
      });
      await appendAuditLog(buildAuditEntry(report, candidates));
      return report;
    }

    // Batched scoring call.
    const runtimeConfig = await getRuntimeConfig();
    const callConfig = { ...runtimeConfig, model: HAIKU_MODEL };
    const scoringStart = Date.now();
    const scoringPrompt = buildScoringPrompt(brain, shortlist);
    const scoringResult = await runAgentRuntime(callConfig, {
      prompt: scoringPrompt,
      systemPrompt: SCORING_SYSTEM,
      tools: [],
      mode: "background",
    });
    const scoringElapsed = Date.now() - scoringStart;
    const scoringUsage = scoringResult.usage ?? { ...EMPTY_USAGE, model: HAIKU_MODEL };
    report.totalCostUsd += scoringUsage.costUsd ?? 0;
    await recordUsage("morning-scan-scoring", runId, scoringUsage, scoringElapsed);

    const scored = parseScoringJson(scoringResult.text);
    report.itemsScored = scored.length;
    if (scored.length === 0) {
      report.errors.push("scoring LLM returned no parseable items");
    }

    for (const s of scored) {
      const item = shortlist[s.index];
      if (!item) continue;
      const competesWith = Array.isArray(s.competesWith) ? s.competesWith : [];
      const score = Number(s.score) || 0;
      const decision: ScoredCandidate["decision"] =
        competesWith.length > 0
          ? "competes"
          : score >= SIGNAL_THRESHOLD
            ? "nominated"
            : "dropped";
      const cand: ScoredCandidate = {
        candidateId: randomId("cand"),
        source: item.source,
        title: item.title,
        url: item.url,
        pubDate: item.pubDate ?? null,
        excerpt: item.excerpt ?? null,
        score,
        reasons: Array.isArray(s.reasons) ? s.reasons.slice(0, 5) : [],
        competesWith,
        decision,
      };
      candidates.push(cand);
      await convex.mutation(api.scanCandidates.create, {
        candidateId: cand.candidateId,
        scanRunId: runId,
        source: cand.source,
        title: cand.title,
        url: cand.url,
        pubDate: cand.pubDate ?? undefined,
        excerpt: cand.excerpt ?? undefined,
        score: cand.score,
        scoreReasons: cand.reasons,
        competesWith: cand.competesWith,
        status: decision,
      });
      // Competes items don't surface in the morning check-in; they flow into
      // the observation log so the weekly self-report can review what Chief
      // flagged as tempting-but-conflicting. Dedup by date+url so the same
      // item on the same day records once.
      if (decision === "competes") {
        await convex.mutation(api.observations.recordIfNew, {
          observationId: `obs_competes_${cand.candidateId}`,
          kind: "competes-flag",
          source: "morning-scan",
          summary: `[competes: ${cand.competesWith.join(", ")}] ${cand.title}`,
          detail: JSON.stringify({
            url: cand.url,
            score: cand.score,
            reasons: cand.reasons,
            competesWith: cand.competesWith,
          }),
          observedAt: Date.now(),
          dedupKey: `competes:${date}:${cand.url}`,
        });
      }
    }

    const nominated = candidates
      .filter((c) => c.competesWith.length === 0 && c.score >= SIGNAL_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    report.itemsNominated = nominated.length;

    if (nominated.length > 0) {
      const formatStart = Date.now();
      const formatResult = await runAgentRuntime(callConfig, {
        prompt: buildFormatPrompt(brain, nominated),
        systemPrompt: FORMAT_SYSTEM,
        tools: [],
        mode: "background",
      });
      const formatElapsed = Date.now() - formatStart;
      const formatUsage = formatResult.usage ?? { ...EMPTY_USAGE, model: HAIKU_MODEL };
      report.totalCostUsd += formatUsage.costUsd ?? 0;
      await recordUsage("morning-scan-format", runId, formatUsage, formatElapsed);
      report.formattedCheckIn = formatResult.text.trim();
    }

    if (report.totalCostUsd > DAILY_SCAN_BUDGET_USD) {
      report.budgetExceeded = true;
      report.errors.push(
        `total cost ${report.totalCostUsd.toFixed(4)} exceeded daily budget ${DAILY_SCAN_BUDGET_USD}`,
      );
    }

    report.elapsedMs = Date.now() - started;
    await convex.mutation(api.scanRuns.update, {
      runId,
      status: "completed",
      sources: report.sourcesTouched,
      itemsScanned: report.itemsScanned,
      itemsScored: report.itemsScored,
      itemsNominated: report.itemsNominated,
      totalCostUsd: report.totalCostUsd,
      elapsedMs: report.elapsedMs,
      formattedCheckIn: report.formattedCheckIn ?? "",
    });
    await appendAuditLog(buildAuditEntry(report, candidates));
    return report;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.errors.push(message);
    report.elapsedMs = Date.now() - started;
    await convex.mutation(api.scanRuns.update, {
      runId,
      status: "failed",
      error: message,
      elapsedMs: report.elapsedMs,
      itemsScanned: report.itemsScanned,
    });
    await appendAuditLog(buildAuditEntry(report, candidates));
    return report;
  }
}

export interface SurfaceReport {
  runId: string;
  sentTo: string | null;
  bodyChars: number;
  source: "scan-formatted" | "no-items" | "scan-missing";
  elapsedMs: number;
  error?: string;
}

export async function runMorningSurface(): Promise<SurfaceReport> {
  const started = Date.now();
  const runId = randomId("surf");
  await convex.mutation(api.scanRuns.create, { runId, kind: "surface" });

  const contact = process.env.CHIEF_CONTACT ?? "";
  if (!contact) {
    const error = "CHIEF_CONTACT not set; nothing to surface to";
    await convex.mutation(api.scanRuns.update, {
      runId,
      status: "failed",
      error,
      elapsedMs: Date.now() - started,
    });
    return { runId, sentTo: null, bodyChars: 0, source: "scan-missing", elapsedMs: 0, error };
  }

  const latest = await convex.query(api.scanRuns.latestCompletedScan, {});
  let body: string;
  let source: SurfaceReport["source"];

  if (latest && latest.formattedCheckIn && latest.formattedCheckIn.trim().length > 0) {
    body = latest.formattedCheckIn.trim();
    source = "scan-formatted";
    const cands = await convex.query(api.scanCandidates.topNominatedForRun, {
      scanRunId: latest.runId,
      limit: 3,
    });
    const now = Date.now();
    for (const c of cands) {
      await convex.mutation(api.scanCandidates.setStatus, {
        candidateId: c.candidateId,
        status: "surfaced",
        surfacedAt: now,
      });
    }
  } else if (latest) {
    body = "no items today";
    source = "no-items";
  } else {
    body = "no items today";
    source = "scan-missing";
  }

  try {
    await sendImessage(contact, body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const elapsed = Date.now() - started;
    await convex.mutation(api.scanRuns.update, {
      runId,
      status: "failed",
      error: message,
      elapsedMs: elapsed,
      surfaceLog: body,
    });
    return { runId, sentTo: contact, bodyChars: body.length, source, elapsedMs: elapsed, error: message };
  }

  const elapsed = Date.now() - started;
  await convex.mutation(api.scanRuns.update, {
    runId,
    status: "completed",
    elapsedMs: elapsed,
    surfaceLog: body,
  });
  await appendAuditLog(
    buildSurfaceAuditEntry({ runId, sentTo: contact, body, source, elapsed }),
  );
  return { runId, sentTo: contact, bodyChars: body.length, source, elapsedMs: elapsed };
}

function buildAuditEntry(report: ScanReport, candidates: ScoredCandidate[]): string {
  const ts = new Date().toISOString();
  const lines = [
    `## SCAN ${report.runId} @ ${ts}`,
    `- date: ${report.date}`,
    `- sources: ${report.sourcesTouched.join(", ") || "(none)"}`,
    `- itemsScanned: ${report.itemsScanned}`,
    `- itemsShortlisted: ${report.itemsShortlisted}`,
    `- itemsScored: ${report.itemsScored}`,
    `- itemsNominated: ${report.itemsNominated}`,
    `- totalCostUsd: ${report.totalCostUsd.toFixed(4)}`,
    `- elapsedMs: ${report.elapsedMs}`,
    `- budgetExceeded: ${report.budgetExceeded}`,
    `- threshold: ${SIGNAL_THRESHOLD}`,
  ];
  if (report.errors.length > 0) {
    lines.push(`- errors:`);
    for (const e of report.errors) lines.push(`  - ${e}`);
  }
  if (candidates.length > 0) {
    const sorted = [...candidates].sort((a, b) => b.score - a.score);
    lines.push(`- scored items (${sorted.length}, sorted by score desc):`);
    for (const c of sorted) {
      lines.push(`  - [${c.score}] ${c.decision} | ${JSON.stringify(c.title)} | ${c.source}`);
      lines.push(`    url: ${c.url}`);
      if (c.reasons.length > 0) lines.push(`    reasons: ${JSON.stringify(c.reasons)}`);
      if (c.competesWith.length > 0) {
        lines.push(`    competesWith: ${JSON.stringify(c.competesWith)}`);
      }
    }
  }
  if (report.formattedCheckIn) {
    lines.push("- formattedCheckIn:");
    for (const ln of report.formattedCheckIn.split("\n")) {
      lines.push(`  > ${ln}`);
    }
  }
  return lines.join("\n");
}

function buildSurfaceAuditEntry(opts: {
  runId: string;
  sentTo: string;
  body: string;
  source: SurfaceReport["source"];
  elapsed: number;
}): string {
  const ts = new Date().toISOString();
  const lines = [
    `## SURFACE ${opts.runId} @ ${ts}`,
    `- sentTo: ${opts.sentTo}`,
    `- source: ${opts.source}`,
    `- elapsedMs: ${opts.elapsed}`,
    `- body:`,
  ];
  for (const ln of opts.body.split("\n")) lines.push(`  > ${ln}`);
  return lines.join("\n");
}

export async function startMorningScan(): Promise<void> {
  if (scanCron || surfaceCron) {
    console.warn("[morning-scan] already started");
    return;
  }
  const timezone = (await getUserTimezone()) ?? "UTC";
  scanCron = new Cron(SCAN_CRON, { timezone }, async () => {
    console.log(`[morning-scan] scan tick at ${new Date().toISOString()}`);
    try {
      const report = await runMorningScan();
      console.log(
        `[morning-scan] scan complete runId=${report.runId} scanned=${report.itemsScanned} nominated=${report.itemsNominated} cost=$${report.totalCostUsd.toFixed(4)}`,
      );
    } catch (err) {
      console.error("[morning-scan] scan tick error", err);
    }
  });
  surfaceCron = new Cron(SURFACE_CRON, { timezone }, async () => {
    console.log(`[morning-scan] surface tick at ${new Date().toISOString()}`);
    try {
      const report = await runMorningSurface();
      console.log(
        `[morning-scan] surface complete runId=${report.runId} source=${report.source} chars=${report.bodyChars}`,
      );
    } catch (err) {
      console.error("[morning-scan] surface tick error", err);
    }
  });
  console.log(
    `[morning-scan] scheduled: scan=${SCAN_CRON} surface=${SURFACE_CRON} tz=${timezone} threshold=${SIGNAL_THRESHOLD}`,
  );
}

export function stopMorningScan(): void {
  if (scanCron) {
    scanCron.stop();
    scanCron = null;
  }
  if (surfaceCron) {
    surfaceCron.stop();
    surfaceCron = null;
  }
}
