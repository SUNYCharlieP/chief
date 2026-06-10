#!/usr/bin/env tsx
/**
 * Manual trigger for the INTEGRATED job observer (not the prove script). Runs
 * runJobObserver() once in its own process: real Adzuna fetch, pre-filter,
 * dedupe against the Convex ledger, strong-model scoring on new survivors, and
 * the live push path (deliverOutbound -> APNs + persist to app:charlie) on a
 * keep. Use this to confirm end-to-end without waiting for the hourly cron.
 *
 * Not public-facing: it needs local shell access on the server box.
 *
 *   tsx scripts/run-job-observer.ts
 *       One real run. Note: if the whole backlog is already baselined, this
 *       finds 0 new survivors and pushes nothing — that's correct.
 *
 *   tsx scripts/run-job-observer.ts --retest <adzunaId>
 *       Deletes that listing's ledger row first, so the run re-discovers it as
 *       "new", scores it, and (if keep) fires a real push to your phone. Use a
 *       known keep's id (e.g. from `tsx scripts/prove-jobs.ts --sample --fresh`).
 *
 * The waking-hours gate (8am-9pm, user tz) still applies: outside the window the
 * run no-ops (withinHours=false) and nothing pushes.
 */
import "../server/env-setup.js";
import { api } from "../convex/_generated/api.js";
import { convex } from "../server/convex-client.js";
import { runJobObserver } from "../server/job-observer.js";

async function main(): Promise<void> {
  const retestIdx = process.argv.indexOf("--retest");
  if (retestIdx !== -1) {
    const id = process.argv[retestIdx + 1];
    if (!id) {
      console.error("--retest needs an Adzuna listing id, e.g. --retest 5746548572");
      process.exit(2);
    }
    const dedupKey = `job:${id}`;
    const res = await convex.mutation(api.observations.deleteByDedupKey, { dedupKey });
    console.log(`--retest: ${res.deleted ? "removed" : "no such"} ledger row ${dedupKey} (it will re-surface this run)`);
  }

  console.log("running job observer once...");
  const report = await runJobObserver();
  console.log(JSON.stringify(report, null, 2));

  if (!report.configured) console.log("\n=> ADZUNA creds unset; nothing ran.");
  else if (!report.withinHours) console.log("\n=> Outside waking hours (8am-9pm); run no-opped, no push.");
  else if (!report.primedBefore) console.log(`\n=> First run: primed silently (baselined=${report.baselined}), no push by design.`);
  else if (report.pushed > 0) console.log(`\n=> Pushed ${report.pushed} match(es) to your phone. Check it.`);
  else if (report.scored > 0) console.log(`\n=> Scored ${report.scored} new (keep=${report.keeps}), pushed=${report.pushed}.`);
  else console.log("\n=> No new survivors to score (all current listings already in the ledger). Nothing to push.");
}

main().catch((err) => {
  console.error("run-job-observer failed:", err);
  process.exit(1);
});
