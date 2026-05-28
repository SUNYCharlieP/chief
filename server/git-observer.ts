import { Cron } from "croner";
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { homedir } from "node:os";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";

// Phase 9 git observer. Periodically walks the git repos under
// CHIEF_OBSERVE_ROOT and records each new commit as an observation. Runs in
// the chief user but reads Charlie's repos directly (the Developer dir is
// world-readable / 755 and not TCC-protected, unlike Library).
//
// CHIEF_OBSERVE_ROOT MUST be set in the chief user's .env.local to the
// absolute path of Charlie's projects (e.g. /Users/charlie/Developer). The
// default (~/Developer) only works when chief and the projects share a user.

const OBSERVE_ROOT = process.env.CHIEF_OBSERVE_ROOT?.trim() || `${homedir()}/Developer`;
const OBSERVE_CRON = process.env.CHIEF_OBSERVE_CRON ?? "0 */6 * * *";
const OBSERVE_LOOKBACK = process.env.CHIEF_OBSERVE_LOOKBACK ?? "2 days ago";
const GIT_TIMEOUT_MS = 15_000;
const UNIT = "\x1f"; // field separator
const REC = "\x1e"; // record separator

let observerCron: Cron | null = null;

function git(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolve_, reject) => {
    execFile(
      "git",
      ["-C", repoPath, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message));
        else resolve_(stdout);
      },
    );
  });
}

async function discoverRepos(root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    console.warn(`[git-observer] cannot read OBSERVE_ROOT=${root}: ${String(err)}`);
    return [];
  }
  const repos: string[] = [];
  for (const name of entries) {
    const dir = resolve(root, name);
    try {
      const gitDir = resolve(dir, ".git");
      const s = await stat(gitDir);
      if (s.isDirectory()) repos.push(dir);
    } catch {
      // not a repo, skip
    }
  }
  return repos;
}

interface CommitObservation {
  sha: string;
  isoDate: string;
  author: string;
  subject: string;
}

async function commitsForRepo(repoPath: string): Promise<CommitObservation[]> {
  // %H sha, %aI author ISO date, %an author name, %s subject.
  const format = ["%H", "%aI", "%an", "%s"].join(UNIT) + REC;
  let out: string;
  try {
    out = await git(repoPath, [
      "log",
      "--all",
      "--no-merges",
      `--since=${OBSERVE_LOOKBACK}`,
      `--pretty=format:${format}`,
    ]);
  } catch (err) {
    console.warn(`[git-observer] git log failed for ${repoPath}: ${String(err)}`);
    return [];
  }
  const commits: CommitObservation[] = [];
  for (const record of out.split(REC)) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const [sha, isoDate, author, subject] = trimmed.split(UNIT);
    if (!sha) continue;
    commits.push({
      sha,
      isoDate: isoDate ?? "",
      author: author ?? "",
      subject: subject ?? "",
    });
  }
  return commits;
}

export interface ObserveReport {
  root: string;
  reposScanned: number;
  commitsSeen: number;
  newObservations: number;
  errors: string[];
  elapsedMs: number;
}

export async function runGitObserver(): Promise<ObserveReport> {
  const started = Date.now();
  const report: ObserveReport = {
    root: OBSERVE_ROOT,
    reposScanned: 0,
    commitsSeen: 0,
    newObservations: 0,
    errors: [],
    elapsedMs: 0,
  };

  const repos = await discoverRepos(OBSERVE_ROOT);
  if (repos.length === 0) {
    report.errors.push(`no git repos found under ${OBSERVE_ROOT}`);
    report.elapsedMs = Date.now() - started;
    return report;
  }

  for (const repoPath of repos) {
    report.reposScanned += 1;
    const repo = basename(repoPath);
    const commits = await commitsForRepo(repoPath);
    report.commitsSeen += commits.length;
    for (const c of commits) {
      const observedAt = c.isoDate ? new Date(c.isoDate).getTime() : Date.now();
      const dateLabel = c.isoDate ? c.isoDate.slice(0, 10) : "?";
      try {
        const result = await convex.mutation(api.observations.recordIfNew, {
          observationId: `obs_${c.sha.slice(0, 12)}`,
          kind: "git-commit",
          source: repo,
          summary: `[${repo}] ${c.subject} (${c.author}, ${dateLabel})`,
          detail: JSON.stringify({ sha: c.sha, author: c.author, isoDate: c.isoDate }),
          observedAt: Number.isFinite(observedAt) ? observedAt : Date.now(),
          dedupKey: `git:${repo}:${c.sha}`,
        });
        if (result.created) report.newObservations += 1;
      } catch (err) {
        report.errors.push(`${repo}/${c.sha.slice(0, 8)}: ${String(err)}`);
      }
    }
  }

  report.elapsedMs = Date.now() - started;
  return report;
}

export function startGitObserver(): void {
  if (observerCron) {
    console.warn("[git-observer] already started");
    return;
  }
  observerCron = new Cron(OBSERVE_CRON, async () => {
    try {
      const report = await runGitObserver();
      console.log(
        `[git-observer] tick: repos=${report.reposScanned} commits=${report.commitsSeen} new=${report.newObservations} (${report.elapsedMs}ms)`,
      );
      if (report.errors.length > 0) {
        console.warn(`[git-observer] errors: ${report.errors.slice(0, 5).join("; ")}`);
      }
    } catch (err) {
      console.error("[git-observer] tick error", err);
    }
  });
  console.log(`[git-observer] scheduled: cron=${OBSERVE_CRON} root=${OBSERVE_ROOT} lookback="${OBSERVE_LOOKBACK}"`);
  // Run once on boot so there's data without waiting for the first tick.
  runGitObserver()
    .then((r) =>
      console.log(
        `[git-observer] initial run: repos=${r.reposScanned} commits=${r.commitsSeen} new=${r.newObservations}`,
      ),
    )
    .catch((err) => console.error("[git-observer] initial run failed", err));
}

export function stopGitObserver(): void {
  if (observerCron) {
    observerCron.stop();
    observerCron = null;
  }
}
