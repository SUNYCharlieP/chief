import { Cron } from "croner";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { getUserTimezone } from "./timezone-config.js";
import { isLinearConnected, listRecentIssues, type LinearIssue } from "./integrations/linear.js";

// Linear observation source, mirroring the git observer: a deterministic cron
// that records ticket status/title/changes (light tier) into the shared
// observations table. No descriptions/comments here (that's the on-demand
// archival tier). Reads ALL projects, no project filter.

const OBSERVE_CRON = process.env.LINEAR_OBSERVE_CRON ?? "0 3 * * *"; // daily 3am
const FIRST_LOOKBACK_DAYS = Number(process.env.LINEAR_FIRST_LOOKBACK_DAYS ?? 14);
const LAST_CHECK_KEY = "linear_observer_last_check";

let observerCron: Cron | null = null;

export interface LinearObserveReport {
  connected: boolean;
  issuesSeen: number;
  changedSinceLastCheck: number;
  newObservations: number;
  projects: string[];
  errors: string[];
  elapsedMs: number;
}

function compact(iso: string): string {
  return iso.replace(/[^0-9]/g, "").slice(0, 14) || String(Date.now());
}

export async function runLinearObserver(): Promise<LinearObserveReport> {
  const started = Date.now();
  const report: LinearObserveReport = {
    connected: false,
    issuesSeen: 0,
    changedSinceLastCheck: 0,
    newObservations: 0,
    projects: [],
    errors: [],
    elapsedMs: 0,
  };

  report.connected = await isLinearConnected();
  if (!report.connected) {
    report.errors.push("Linear not connected via Composio; skipping (no-op).");
    report.elapsedMs = Date.now() - started;
    return report;
  }

  // since-last-check: stored timestamp, else first-run lookback.
  const stored = await convex.query(api.settings.get, { key: LAST_CHECK_KEY });
  const lastCheck = stored
    ? Number(stored)
    : Date.now() - FIRST_LOOKBACK_DAYS * 86400000;

  let issues: LinearIssue[];
  try {
    issues = await listRecentIssues(100);
  } catch (err) {
    report.errors.push(`listRecentIssues: ${String(err)}`);
    report.elapsedMs = Date.now() - started;
    return report;
  }
  report.issuesSeen = issues.length;
  report.projects = [...new Set(issues.map((i) => i.project))];

  // Changed since last check (client-side filter on updatedAt).
  const changed = issues.filter((i) => {
    const t = new Date(i.updatedAt).getTime();
    return Number.isFinite(t) && t >= lastCheck;
  });
  report.changedSinceLastCheck = changed.length;

  // Prior status per issue, from the existing log, to describe what moved.
  const priorObs = await convex.query(api.observations.recent, {
    kind: "linear-ticket",
    limit: 200,
  });
  const prevStatusById = new Map<string, string>();
  for (const o of priorObs) {
    try {
      const d = JSON.parse(o.detail ?? "{}") as { issueId?: string; status?: string };
      if (d.issueId && !prevStatusById.has(d.issueId)) {
        prevStatusById.set(d.issueId, d.status ?? "");
      }
    } catch {
      /* skip */
    }
  }

  for (const it of changed) {
    const prev = prevStatusById.get(it.id) ?? "";
    const moved = prev && prev !== it.status ? `${prev} to ${it.status}` : prev ? "updated" : "new";
    const observedAt = new Date(it.updatedAt).getTime();
    try {
      const res = await convex.mutation(api.observations.recordIfNew, {
        observationId: `obs_lin_${it.id}_${compact(it.updatedAt)}`,
        kind: "linear-ticket",
        source: it.project,
        summary: `[${it.project} ${it.identifier}] ${it.title} (${it.status}, ${moved})`,
        detail: JSON.stringify({
          issueId: it.id,
          identifier: it.identifier,
          project: it.project,
          status: it.status,
          prevStatus: prev,
          updatedAt: it.updatedAt,
          url: it.url,
        }),
        observedAt: Number.isFinite(observedAt) ? observedAt : Date.now(),
        dedupKey: `linear:${it.id}:${it.updatedAt}`,
      });
      if (res.created) report.newObservations += 1;
    } catch (err) {
      report.errors.push(`${it.identifier}: ${String(err)}`);
    }
  }

  await convex.mutation(api.settings.set, { key: LAST_CHECK_KEY, value: String(started) });
  report.elapsedMs = Date.now() - started;
  return report;
}

export function startLinearObserver(): void {
  if (observerCron) {
    console.warn("[linear-observer] already started");
    return;
  }
  void (async () => {
    const timezone = (await getUserTimezone()) ?? "UTC";
    observerCron = new Cron(OBSERVE_CRON, { timezone }, async () => {
      try {
        const r = await runLinearObserver();
        console.log(
          `[linear-observer] tick: connected=${r.connected} seen=${r.issuesSeen} changed=${r.changedSinceLastCheck} new=${r.newObservations}`,
        );
      } catch (err) {
        console.error("[linear-observer] tick error", err);
      }
    });
    console.log(`[linear-observer] scheduled: cron=${OBSERVE_CRON} tz=${timezone}`);
  })();
}

export function stopLinearObserver(): void {
  if (observerCron) {
    observerCron.stop();
    observerCron = null;
  }
}
