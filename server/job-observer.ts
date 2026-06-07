import { Cron } from "croner";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { getRuntimeConfig } from "./runtime-config.js";
import { runAgentRuntime } from "./runtimes/index.js";
import { getUserTimezone } from "./timezone-config.js";
import { deliverOutbound } from "./delivery.js";
import type { UsageTotals } from "./usage.js";
import {
  CAP_N,
  SALARY_FLOOR,
  adzunaConfigured,
  fetchAndDedup,
  isBuffaloMetro,
  isRemote,
  isSubFloorEstimate,
  passesSalary,
  relevanceScore,
  salaryLabel,
  type JobListing,
} from "./integrations/adzuna.js";
import { SCORE_MODEL, SCORING_SYSTEM, parseVerdict, scoringPrompt } from "./job-scoring.js";

// Phase 2 job-intel observer. Polls Adzuna hourly during waking hours, drops
// obvious misses with the cheap pre-filter (no LLM), scores only NEW survivors
// with the strong model, and pushes the moment one scores "keep" — immediately,
// NOT batched into the morning briefing (job postings fill fast). Each listing
// is scored exactly once ever (dedup by observation dedupKey job:<adzunaId>).
//
// Prove-then-integrate: the source + pre-filter + rubric were eyeballed as a
// standalone script (scripts/prove-jobs.ts) before this folded them into Chief.

// Hourly at minute 0 from 8am through 9pm (21:00), in the user's timezone.
const OBSERVE_CRON = process.env.CHIEF_JOB_OBSERVE_CRON ?? "0 8-21 * * *";
const START_HOUR = Number(process.env.CHIEF_JOB_START_HOUR ?? 8);
const END_HOUR = Number(process.env.CHIEF_JOB_END_HOUR ?? 21);
const PRIMED_KEY = "job_observer_primed";
const DEDUP_LOOKBACK_MS = 35 * 86_400_000; // a touch beyond Adzuna's max_days_old

let observerCron: Cron | null = null;

function localHour(tz: string, d = new Date()): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(d);
  return Number(h) % 24; // some engines render midnight as "24"
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

// Push body: title, company, location, salary if disclosed, the one-line why,
// listing URL — everything the app needs to render the card and let Charlie tap
// through and apply fast. Soft-warns when the salary is an estimate below floor.
function buildBody(l: JobListing, why: string): string {
  const lines = [
    `${l.title} — ${l.company}`,
    `${l.locationName || "Remote / location n/a"} · ${salaryLabel(l)}`,
    `why: ${why}`,
  ];
  if (isSubFloorEstimate(l)) {
    lines.push(`note: salary is an estimate below the $${SALARY_FLOOR / 1000}k floor (not disclosed by employer)`);
  }
  lines.push(l.url);
  return lines.join("\n");
}

export interface JobObserveReport {
  configured: boolean;
  withinHours: boolean;
  primedBefore: boolean;
  fetched: number;
  survivors: number; // passed pre-filter + dedupe, before the cap
  scored: number;
  keeps: number;
  drops: number;
  pushed: number;
  llmCalls: number;
  costUsd: number;
  errors: string[];
  elapsedMs: number;
}

function emptyReport(): JobObserveReport {
  return {
    configured: false,
    withinHours: false,
    primedBefore: false,
    fetched: 0,
    survivors: 0,
    scored: 0,
    keeps: 0,
    drops: 0,
    pushed: 0,
    llmCalls: 0,
    costUsd: 0,
    errors: [],
    elapsedMs: 0,
  };
}

export async function runJobObserver(): Promise<JobObserveReport> {
  const started = Date.now();
  const report = emptyReport();

  report.configured = adzunaConfigured();
  if (!report.configured) {
    report.errors.push("ADZUNA_APP_ID / ADZUNA_APP_KEY unset; job observer is a no-op.");
    report.elapsedMs = Date.now() - started;
    return report;
  }

  // Waking-hours gate. The cron already restricts to 8am-9pm, but a boot run or
  // a manual /observe/jobs/run trigger isn't cron-gated — gate here so no push
  // ever fires outside the window regardless of how the run was started.
  const tz = await getUserTimezone();
  const hour = localHour(tz);
  report.withinHours = hour >= START_HOUR && hour <= END_HOUR;
  if (!report.withinHours) {
    report.elapsedMs = Date.now() - started;
    return report;
  }

  // First-run priming: on the very first in-window run, record the current
  // backlog of keeps into the dedup ledger WITHOUT pushing, so a fresh deploy
  // doesn't flood the phone with a pile of already-open listings. Only listings
  // that appear AFTER priming push live.
  const primedRaw = await convex.query(api.settings.get, { key: PRIMED_KEY });
  const primed = primedRaw === "true";
  report.primedBefore = primed;

  // SOURCE
  const fetchResult = await fetchAndDedup();
  report.fetched = fetchResult.listings.length;
  report.errors.push(...fetchResult.errors);

  // Dedup ledger: listings we've already scored (keep or drop) never score
  // again. Load recent job-posting dedupKeys within Adzuna's freshness window.
  const recentObs = await convex.query(api.observations.recent, {
    kind: "job-posting",
    sinceMs: started - DEDUP_LOOKBACK_MS,
    limit: 1000,
  });
  const seen = new Set(recentObs.map((o) => o.dedupKey));

  // PRE-FILTER (cheap, no LLM): salary floor, location, dedupe, rank, cap.
  const survivors: JobListing[] = [];
  for (const l of fetchResult.listings) {
    if (seen.has(`job:${l.id}`)) continue;
    if (!passesSalary(l)) continue;
    if (!(isBuffaloMetro(l) || isRemote(l))) continue;
    l.relevance = relevanceScore(l);
    survivors.push(l);
  }
  survivors.sort((a, b) => b.relevance - a.relevance);
  report.survivors = survivors.length;
  const toScore = survivors.slice(0, CAP_N);

  if (toScore.length === 0) {
    // The common case: most polls find nothing new and cost only the Adzuna
    // calls. Prime the flag even on an empty first run so we don't keep treating
    // future runs as "first".
    if (!primed) await convex.mutation(api.settings.set, { key: PRIMED_KEY, value: "true" });
    report.elapsedMs = Date.now() - started;
    return report;
  }

  // SCORE (strong model, only the new survivors).
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
  const contact = process.env.CHIEF_CONTACT ?? "";

  for (const l of toScore) {
    let verdict: "keep" | "drop";
    let why: string;
    try {
      const res = await runAgentRuntime(callConfig, {
        prompt: scoringPrompt(l),
        systemPrompt: SCORING_SYSTEM,
        tools: [],
        mode: "background",
      });
      report.llmCalls += 1;
      usage = addUsage(usage, res.usage);
      ({ verdict, why } = parseVerdict(res.text));
    } catch (err) {
      report.errors.push(`score ${l.id}: ${String(err)}`);
      continue; // don't record on failure, so it retries next run
    }

    report.scored += 1;
    if (verdict === "keep") report.keeps += 1;
    else report.drops += 1;

    // Record into the dedup ledger so this listing never scores again.
    try {
      const observedAt = l.created ? new Date(l.created).getTime() : Date.now();
      await convex.mutation(api.observations.recordIfNew, {
        observationId: `obs_job_${l.id}`,
        kind: "job-posting",
        source: "adzuna",
        summary: `[job ${verdict}] ${l.title} — ${l.company} (${l.locationName || "remote"})`,
        detail: JSON.stringify({
          adzunaId: l.id,
          verdict,
          why,
          company: l.company,
          location: l.locationName,
          salary: salaryLabel(l),
          subFloorEstimate: isSubFloorEstimate(l),
          url: l.url,
          query: l.query,
        }),
        observedAt: Number.isFinite(observedAt) ? observedAt : Date.now(),
        dedupKey: `job:${l.id}`,
      });
    } catch (err) {
      report.errors.push(`record ${l.id}: ${String(err)}`);
    }

    // SURFACE: push the moment a new listing scores keep — immediately, not
    // batched. During priming we record but don't push (see above).
    if (verdict === "keep" && primed) {
      try {
        const delivery = await deliverOutbound({
          contact,
          body: buildBody(l, why),
          pushTitle: "Job match",
        });
        if (delivery.delivered) report.pushed += 1;
        else report.errors.push(`deliver ${l.id}: not delivered (${delivery.pushReason ?? "?"})`);
      } catch (err) {
        report.errors.push(`deliver ${l.id}: ${String(err)}`);
      }

      // SEAM (future): draft-application-framing action. When the draft-and-ask
      // action layer exists, this is where Chief would offer to draft tailored
      // application framing for this keep (mapping Charlie's field/ownership
      // experience onto the listing). Surface-only for now — Chief NEVER
      // auto-applies. Build nothing here until that action layer exists.
    }
  }

  // Cost logging: one row per run so the trend is watchable in usageRecords.
  report.costUsd = usage.costUsd;
  if (report.llmCalls > 0) {
    try {
      await convex.mutation(api.usageRecords.record, {
        source: "job-observer",
        runId: `job-${started}`,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        costUsd: usage.costUsd,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      report.errors.push(`usage record: ${String(err)}`);
    }
  }

  if (!primed) await convex.mutation(api.settings.set, { key: PRIMED_KEY, value: "true" });

  report.elapsedMs = Date.now() - started;
  return report;
}

export function startJobObserver(): void {
  if (observerCron) {
    console.warn("[job-observer] already started");
    return;
  }
  void (async () => {
    const timezone = await getUserTimezone();
    observerCron = new Cron(OBSERVE_CRON, { timezone }, async () => {
      try {
        const r = await runJobObserver();
        console.log(
          `[job-observer] tick: fetched=${r.fetched} survivors=${r.survivors} scored=${r.scored} ` +
            `keep=${r.keeps} pushed=${r.pushed} calls=${r.llmCalls} cost=$${r.costUsd.toFixed(4)}` +
            `${r.primedBefore ? "" : " (primed silently)"} (${r.elapsedMs}ms)`,
        );
        if (r.errors.length > 0) {
          console.warn(`[job-observer] errors: ${r.errors.slice(0, 5).join("; ")}`);
        }
      } catch (err) {
        console.error("[job-observer] tick error", err);
      }
    });
    console.log(`[job-observer] scheduled: cron=${OBSERVE_CRON} tz=${timezone} model=${SCORE_MODEL} cap=${CAP_N}`);
    // Run once on boot. The waking-hours gate + priming keep this safe: outside
    // 8am-9pm it no-ops, and the first-ever run primes silently (no push flood).
    runJobObserver()
      .then((r) =>
        console.log(
          `[job-observer] initial run: configured=${r.configured} withinHours=${r.withinHours} ` +
            `scored=${r.scored} keep=${r.keeps} pushed=${r.pushed}${r.primedBefore ? "" : " (primed silently)"}`,
        ),
      )
      .catch((err) => console.error("[job-observer] initial run failed", err));
  })();
}

export function stopJobObserver(): void {
  if (observerCron) {
    observerCron.stop();
    observerCron = null;
  }
}
