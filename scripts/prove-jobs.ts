#!/usr/bin/env tsx
/**
 * Phase 1 prove script for the job-intel watcher.
 *
 * Standalone, no Chief/Convex side effects. Proves the three-layer loop:
 *   SOURCE     Adzuna free-tier REST (structured JSON, no scraping)
 *   PRE-FILTER cheap rules, NO LLM: disclosed-salary floor, location, dedupe, cap
 *   SCORE      strong model (Opus) on the new survivors only, keep/drop + one-line why
 *
 * The whole point of the prove run is eyeballing the construction-adjacent vs
 * generic-IT-PM discrimination on real Buffalo listings. Phase 2 folded the
 * source + pre-filter + rubric into Chief as job-observer.ts; this script and the
 * observer now import the SAME modules (server/integrations/adzuna.ts +
 * server/job-scoring.ts) so the rules never drift. This script does NOT push or
 * persist to the app.
 *
 *   tsx scripts/prove-jobs.ts            # production behavior: top-N by relevance
 *   tsx scripts/prove-jobs.ts --fresh    # ignore the seen-cache, re-score everything
 *   tsx scripts/prove-jobs.ts --sample   # DIAGNOSTIC: stratify across the relevance
 *                                        # range so generic-IT-PM traps reach the
 *                                        # scorer and you can eyeball real DROPs
 *
 * Requires ADZUNA_APP_ID and ADZUNA_APP_KEY in .env.local.
 */
import "../server/env-setup.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRuntimeConfig } from "../server/runtime-config.js";
import { runAgentRuntime } from "../server/runtimes/index.js";
import type { UsageTotals } from "../server/usage.js";
import {
  CAP_N,
  SALARY_FLOOR,
  adzunaConfigured,
  fetchAndDedup,
  isBuffaloMetro,
  isRemote,
  passesSalary,
  relevanceScore,
  salaryLabel,
  type JobListing,
} from "../server/integrations/adzuna.js";
import { SCORE_MODEL, SCORING_SYSTEM, parseVerdict, scoringPrompt } from "../server/job-scoring.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEEN_FILE = resolve(__dirname, "..", ".cache", "job-seen.json");
const FRESH = process.argv.includes("--fresh");
// Diagnostic only. Default production behavior is top-N by relevance (don't
// spend the strong model on obvious misses). --sample instead stratifies the
// survivors across the relevance range so generic-IT-PM traps reach the scorer,
// which is the only way to eyeball the construction-vs-generic discrimination.
const SAMPLE = process.argv.includes("--sample");

// Pick `n` listings spread evenly across a relevance-sorted list, so the set
// spans clear construction matches through low-relevance generic/unrelated ones.
function stratifiedSample(sorted: JobListing[], n: number): JobListing[] {
  if (sorted.length <= n) return sorted;
  const out: JobListing[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(sorted[Math.round((i * (sorted.length - 1)) / (n - 1))]);
  }
  return out;
}

function loadSeen(): Set<string> {
  if (FRESH || !existsSync(SEEN_FILE)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(SEEN_FILE, "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<string>): void {
  mkdirSync(dirname(SEEN_FILE), { recursive: true });
  writeFileSync(SEEN_FILE, JSON.stringify([...seen]), "utf8");
}

function addUsage(a: UsageTotals, b?: UsageTotals): UsageTotals {
  if (!b) return a;
  return {
    model: b.model || a.model,
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    cacheReadTokens: a.cacheReadTokens + (b.cacheReadTokens ?? 0),
    cacheCreationTokens: a.cacheCreationTokens + (b.cacheCreationTokens ?? 0),
    costUsd: a.costUsd + (b.costUsd ?? 0),
  };
}

async function main(): Promise<void> {
  if (!adzunaConfigured()) {
    console.error("Missing ADZUNA_APP_ID / ADZUNA_APP_KEY in .env.local. Get them at developer.adzuna.com.");
    process.exit(2);
  }

  console.log(
    `job-intel prove run  |  floor=$${SALARY_FLOOR / 1000}k  cap=${CAP_N}  model=${SCORE_MODEL}` +
      `${FRESH ? "  [--fresh]" : ""}${SAMPLE ? "  [--sample diagnostic]" : ""}`,
  );

  // SOURCE
  const { listings, perQuery, errors } = await fetchAndDedup();
  for (const q of perQuery) {
    console.log(`  fetched ${String(q.count).padStart(3)} from "${q.what}"${q.where ? ` @ ${q.where}` : ""}`);
  }
  for (const e of errors) console.warn(`  ${e}`);
  const fetched = listings.length;

  // PRE-FILTER
  const seen = loadSeen();
  let skippedSeen = 0;
  let droppedSalary = 0;
  let droppedLocation = 0;
  const survivors: JobListing[] = [];
  for (const l of listings) {
    if (seen.has(l.id)) { skippedSeen += 1; continue; }
    if (!passesSalary(l)) { droppedSalary += 1; continue; }
    if (!(isBuffaloMetro(l) || isRemote(l))) { droppedLocation += 1; continue; }
    l.relevance = relevanceScore(l);
    survivors.push(l);
  }
  survivors.sort((a, b) => b.relevance - a.relevance);
  const capped = SAMPLE ? stratifiedSample(survivors, CAP_N) : survivors.slice(0, CAP_N);
  const overflow = survivors.length - capped.length;

  console.log(
    `\nPRE-FILTER  fetched=${fetched}  already-seen=${skippedSeen}  ` +
      `salary<$${SALARY_FLOOR / 1000}k(disclosed)=${droppedSalary}  off-location=${droppedLocation}  ` +
      `survivors=${survivors.length}  scoring=${capped.length}${overflow > 0 ? ` (capped, ${overflow} not scored)` : ""}`,
  );

  if (capped.length === 0) {
    console.log("\nNo new survivors to score. Nothing to eyeball this run.");
    saveSeen(seen);
    return;
  }

  // SCORE
  const runtimeConfig = await getRuntimeConfig();
  const callConfig = { ...runtimeConfig, model: SCORE_MODEL };
  let usage: UsageTotals = {
    model: SCORE_MODEL,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };
  let calls = 0;

  const scored: Array<{ l: JobListing; verdict: "keep" | "drop"; why: string }> = [];
  for (const l of capped) {
    const res = await runAgentRuntime(callConfig, {
      prompt: scoringPrompt(l),
      systemPrompt: SCORING_SYSTEM,
      tools: [],
      mode: "background",
    });
    calls += 1;
    usage = addUsage(usage, res.usage);
    scored.push({ l, ...parseVerdict(res.text) });
    seen.add(l.id);
  }
  saveSeen(seen);

  // PRINT
  const keeps = scored.filter((s) => s.verdict === "keep");
  const drops = scored.filter((s) => s.verdict === "drop");

  const printRow = (s: { l: JobListing; why: string }) => {
    console.log(`  ${s.l.title}  —  ${s.l.company}`);
    console.log(`     ${s.l.locationName || "(location n/a)"}  |  ${salaryLabel(s.l)}  |  rel=${s.l.relevance}  |  via ${s.l.query}`);
    console.log(`     why: ${s.why}`);
    console.log(`     ${s.l.url}`);
  };

  console.log(`\n===== KEEP (${keeps.length}) =====`);
  if (keeps.length === 0) console.log("  (none)");
  for (const s of keeps) printRow(s);

  console.log(`\n----- DROP (${drops.length}) -----`);
  if (drops.length === 0) console.log("  (none)");
  for (const s of drops) printRow(s);

  const fmt = (n: number) => n.toLocaleString("en-US");
  console.log(
    `\nLLM calls this run: ${calls}  |  in ${fmt(usage.inputTokens)} tok  out ${fmt(usage.outputTokens)} tok  |  cost $${usage.costUsd.toFixed(4)}`,
  );
  console.log(`(eyeball the KEEP/DROP calls above. re-run with --fresh to re-score the same listings.)`);
}

main().catch((err) => {
  console.error("prove-jobs failed:", err);
  process.exit(1);
});
