import { Cron } from "croner";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { getUserTimezone } from "./timezone-config.js";

// GitHub as a READ-ONLY observation source. Mirrors the Linear observer: reads
// remote state since a stored lastCheck and folds MEANINGFUL changes (issues,
// PRs, releases, a rolled-up push) into the observation log via recordIfNew, so
// recall + the proactive layer see remote state. No writes of any kind. If
// GITHUB_TOKEN is unset it no-ops cleanly, so the code deploys before the token.

const OBSERVE_CRON = process.env.GITHUB_OBSERVE_CRON ?? "0 */6 * * *"; // every 6h
const FIRST_LOOKBACK_DAYS = Number(process.env.GITHUB_FIRST_LOOKBACK_DAYS ?? 7);
const MAX_REPOS = Number(process.env.GITHUB_MAX_REPOS ?? 40);
const RATE_FLOOR = Number(process.env.GITHUB_RATE_FLOOR ?? 100); // stop before this
const LAST_CHECK_KEY = "github_observer_last_check";
const API = "https://api.github.com";

// ---- pure mappers (no network/token; unit-tested with sample payloads) -------

export interface ObservationArgs {
  observationId: string;
  kind: "github-issue" | "github-pr" | "github-release" | "github-push";
  source: string;
  summary: string;
  detail: string;
  observedAt: number;
  dedupKey: string;
}

function compact(iso: string): string {
  return iso.replace(/[^0-9]/g, "");
}
function ms(iso: string | null | undefined): number {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : Date.now();
}
function firstLine(s: string): string {
  return (s ?? "").split("\n")[0].trim();
}

// An issue-feed item is a PR when it carries a pull_request object. We split on
// that so PRs and issues become distinct kinds even though /issues returns both.
export function mapIssueOrPr(repoFull: string, item: Record<string, unknown>): ObservationArgs | null {
  const number = Number(item.number);
  if (!Number.isInteger(number)) return null;
  const title = typeof item.title === "string" ? item.title : "(no title)";
  const state = typeof item.state === "string" ? item.state : "open";
  const updatedAt = typeof item.updated_at === "string" ? item.updated_at : "";
  const url = typeof item.html_url === "string" ? item.html_url : "";
  const isPr = item.pull_request != null;

  if (isPr) {
    const pr = item.pull_request as Record<string, unknown>;
    const merged = pr.merged_at != null;
    const status = merged ? "merged" : item.draft === true ? "draft" : state; // open|closed|merged|draft
    return {
      observationId: `obs_gh_pr_${repoFull.replace(/[^a-z0-9]/gi, "_")}_${number}_${compact(updatedAt)}`,
      kind: "github-pr",
      source: repoFull,
      summary: `[${repoFull} PR #${number}] ${title} (${status})`,
      detail: JSON.stringify({ number, status, state, url, updatedAt }),
      observedAt: ms(updatedAt),
      dedupKey: `github:pr:${repoFull}#${number}:${updatedAt}`,
    };
  }
  return {
    observationId: `obs_gh_issue_${repoFull.replace(/[^a-z0-9]/gi, "_")}_${number}_${compact(updatedAt)}`,
    kind: "github-issue",
    source: repoFull,
    summary: `[${repoFull} #${number}] ${title} (${state})`,
    detail: JSON.stringify({ number, state, url, updatedAt }),
    observedAt: ms(updatedAt),
    dedupKey: `github:issue:${repoFull}#${number}:${updatedAt}`,
  };
}

export function mapRelease(repoFull: string, rel: Record<string, unknown>): ObservationArgs | null {
  if (rel.draft === true) return null; // unpublished drafts are not state worth surfacing
  const tag = typeof rel.tag_name === "string" ? rel.tag_name : "";
  if (!tag) return null;
  const name = typeof rel.name === "string" && rel.name ? rel.name : tag;
  const url = typeof rel.html_url === "string" ? rel.html_url : "";
  const published = typeof rel.published_at === "string" ? rel.published_at : "";
  return {
    observationId: `obs_gh_rel_${repoFull.replace(/[^a-z0-9]/gi, "_")}_${tag.replace(/[^a-z0-9]/gi, "_")}`,
    kind: "github-release",
    source: repoFull,
    summary: `[${repoFull} release ${tag}] ${name}`,
    detail: JSON.stringify({ tag, name, url, publishedAt: published, prerelease: rel.prerelease === true }),
    observedAt: ms(published),
    dedupKey: `github:release:${repoFull}:${tag}`,
  };
}

// Rolled-up push: ONE observation per push batch (keyed by head sha), never one
// per commit. Suppressed when the repo already has local git-commit coverage,
// so we never duplicate the local commit stream.
export function mapPushRollup(
  repoFull: string,
  branch: string,
  commits: Array<Record<string, unknown>>,
  locallyCovered: boolean,
): ObservationArgs | null {
  if (locallyCovered || commits.length === 0) return null;
  const head = commits[0];
  const sha = typeof head.sha === "string" ? head.sha : "";
  if (!sha) return null;
  const commitObj = (head.commit ?? {}) as Record<string, unknown>;
  const message = typeof commitObj.message === "string" ? commitObj.message : "";
  const author = (commitObj.author ?? {}) as Record<string, unknown>;
  const date = typeof author.date === "string" ? author.date : "";
  return {
    observationId: `obs_gh_push_${repoFull.replace(/[^a-z0-9]/gi, "_")}_${sha.slice(0, 12)}`,
    kind: "github-push",
    source: repoFull,
    summary: `[${repoFull}] ${commits.length} commit${commits.length === 1 ? "" : "s"} pushed to ${branch}, latest: ${firstLine(message)}`,
    detail: JSON.stringify({ headSha: sha, count: commits.length, branch, latest: firstLine(message) }),
    observedAt: ms(date),
    dedupKey: `github:push:${repoFull}:${sha}`,
  };
}

// ---- network orchestration ---------------------------------------------------

export interface GithubObserveReport {
  ran: boolean;
  reposSeen: number;
  reposActive: number;
  reposProcessed: number;
  reposSkipped: number;
  newObservations: number;
  byKind: Record<string, number>;
  rateLimitRemaining: number | null;
  errors: string[];
  elapsedMs: number;
  note?: string;
}

interface GhClient {
  get(path: string): Promise<{ ok: boolean; status: number; json: unknown; remaining: number | null }>;
  remaining: number | null;
}

function makeClient(token: string): GhClient {
  const headers = {
    Authorization: `Bearer ${token}`, // never logged; only ever a header
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "chief-observer",
  };
  const client: GhClient = {
    remaining: null,
    async get(path: string) {
      const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, { headers });
      const remHeader = res.headers.get("x-ratelimit-remaining");
      const remaining = remHeader != null ? Number(remHeader) : null;
      if (remaining != null) client.remaining = remaining;
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        /* empty body */
      }
      return { ok: res.ok, status: res.status, json, remaining };
    },
  };
  return client;
}

export async function runGithubObserver(): Promise<GithubObserveReport> {
  const started = Date.now();
  const report: GithubObserveReport = {
    ran: false,
    reposSeen: 0,
    reposActive: 0,
    reposProcessed: 0,
    reposSkipped: 0,
    newObservations: 0,
    byKind: {},
    rateLimitRemaining: null,
    errors: [],
    elapsedMs: 0,
  };

  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    report.note = "GITHUB_TOKEN not set; skipping (no error)";
    report.elapsedMs = Date.now() - started;
    return report;
  }
  report.ran = true;
  const gh = makeClient(token);

  const stored = await convex.query(api.settings.get, { key: LAST_CHECK_KEY });
  const lastCheck = stored ? Number(stored) : Date.now() - FIRST_LOOKBACK_DAYS * 86400000;
  const sinceIso = new Date(lastCheck).toISOString();

  // Repos for the push-suppression set: local git-commit sources (folder names).
  const localObs = await convex.query(api.observations.recent, { kind: "git-commit", limit: 200 });
  const localRepoNames = new Set<string>(localObs.map((o: { source: string }) => o.source));

  // List repos (paginated, most-recently-pushed first), filter to active ones.
  const repos: Array<Record<string, unknown>> = [];
  for (let page = 1; page <= 5; page++) {
    const r = await gh.get(
      `/user/repos?affiliation=owner,collaborator&sort=pushed&direction=desc&per_page=100&page=${page}`,
    );
    if (!r.ok || !Array.isArray(r.json)) {
      if (!r.ok) report.errors.push(`list repos page ${page}: HTTP ${r.status}`);
      break;
    }
    repos.push(...(r.json as Array<Record<string, unknown>>));
    if ((r.json as unknown[]).length < 100) break;
  }
  report.reposSeen = repos.length;

  const active = repos
    .filter((repo) => {
      const pushedAt = ms(typeof repo.pushed_at === "string" ? repo.pushed_at : undefined);
      const openIssues = Number(repo.open_issues_count) || 0;
      return pushedAt >= lastCheck || openIssues > 0;
    })
    .slice(0, MAX_REPOS);
  report.reposActive = active.length;

  const bump = (kind: string) => {
    report.byKind[kind] = (report.byKind[kind] ?? 0) + 1;
    report.newObservations += 1;
  };
  const record = async (o: ObservationArgs | null) => {
    if (!o) return;
    try {
      const res = await convex.mutation(api.observations.recordIfNew, o);
      if (res.created) bump(o.kind);
    } catch (err) {
      report.errors.push(`record ${o.dedupKey}: ${String(err)}`);
    }
  };

  for (const repo of active) {
    // Rate-limit guard: stop BEFORE dipping under the floor; never truncate silently.
    if (gh.remaining != null && gh.remaining < RATE_FLOOR) {
      report.reposSkipped = active.length - report.reposProcessed;
      report.note = `stopped early at rate-limit floor (${gh.remaining} left); skipped ${report.reposSkipped} repos`;
      break;
    }
    const full = typeof repo.full_name === "string" ? repo.full_name : "";
    const name = typeof repo.name === "string" ? repo.name : "";
    const branch = typeof repo.default_branch === "string" ? repo.default_branch : "main";
    if (!full) continue;
    report.reposProcessed += 1;

    // Issues + PRs (one feed; mapped to distinct kinds).
    const iss = await gh.get(`/repos/${full}/issues?state=all&since=${encodeURIComponent(sinceIso)}&per_page=50`);
    if (iss.ok && Array.isArray(iss.json)) {
      for (const item of iss.json as Array<Record<string, unknown>>) {
        await record(mapIssueOrPr(full, item));
      }
    } else if (!iss.ok) {
      report.errors.push(`${full} issues: HTTP ${iss.status}`);
    }

    // Releases (latest few; published only).
    const rel = await gh.get(`/repos/${full}/releases?per_page=5`);
    if (rel.ok && Array.isArray(rel.json)) {
      for (const r of rel.json as Array<Record<string, unknown>>) {
        const o = mapRelease(full, r);
        if (o && o.observedAt >= lastCheck) await record(o);
      }
    } else if (!rel.ok && rel.status !== 404) {
      report.errors.push(`${full} releases: HTTP ${rel.status}`);
    }

    // Rolled-up push (suppressed where local git-commit already covers).
    const locallyCovered = localRepoNames.has(name);
    if (!locallyCovered) {
      const com = await gh.get(`/repos/${full}/commits?since=${encodeURIComponent(sinceIso)}&per_page=10`);
      if (com.ok && Array.isArray(com.json)) {
        await record(mapPushRollup(full, branch, com.json as Array<Record<string, unknown>>, false));
      } else if (!com.ok && com.status !== 404 && com.status !== 409) {
        report.errors.push(`${full} commits: HTTP ${com.status}`); // 409 = empty repo
      }
    }
  }

  await convex.mutation(api.settings.set, { key: LAST_CHECK_KEY, value: String(started) });
  report.rateLimitRemaining = gh.remaining;
  report.elapsedMs = Date.now() - started;
  return report;
}

// ---- cron --------------------------------------------------------------------

let observerCron: Cron | null = null;

export function startGithubObserver(): void {
  if (observerCron) {
    console.warn("[github-observer] already started");
    return;
  }
  getUserTimezone()
    .then((timezone) => {
      observerCron = new Cron(OBSERVE_CRON, { timezone: timezone ?? "UTC" }, async () => {
        try {
          const r = await runGithubObserver();
          if (r.ran) {
            console.log(
              `[github-observer] active=${r.reposActive} processed=${r.reposProcessed} new=${r.newObservations} byKind=${JSON.stringify(r.byKind)} rateRemaining=${r.rateLimitRemaining}${r.note ? ` note=${r.note}` : ""}`,
            );
          }
        } catch (err) {
          console.error("[github-observer] tick error", err);
        }
      });
      console.log(`[github-observer] scheduled: cron=${OBSERVE_CRON} tz=${timezone ?? "UTC"}`);
    })
    .catch((err) => console.error("[github-observer] failed to schedule", err));
}
