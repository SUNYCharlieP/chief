import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { BRAIN_DIR } from "./brain.js";

// Stage B detector. A deterministic, no-ML heuristic over git-commit
// observations: cluster commit subjects by document-frequency of meaningful
// terms, and propose a Skills.md candidate for each recurring term. Runs inside
// the weekly digest job.

const WINDOW_DAYS = Number(process.env.CHIEF_SKILL_WINDOW_DAYS ?? 30);
const DF_THRESHOLD = Number(process.env.CHIEF_SKILL_DF_THRESHOLD ?? 3);
// Same canonical brain the reader and write-confirm use (BRAIN_DIR), not the
// retired /Users/Shared/Brain mirror.
const EXCLUDE_REPOS = new Set(
  (process.env.CHIEF_SKILL_DETECT_EXCLUDE ?? "chief")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
const SUBSUME_OVERLAP = 0.7;

// Generic git verbs + stopwords: high-frequency, low-signal. A term has to
// survive this to be considered a "pattern".
const STOPWORDS = new Set([
  "add", "adds", "added", "fix", "fixes", "fixed", "update", "updates", "updated",
  "remove", "removes", "removed", "refactor", "refactors", "bump", "bumps",
  "tweak", "tweaks", "wip", "merge", "merges", "revert", "reverts", "rename",
  "renames", "move", "moves", "make", "makes", "use", "uses", "using", "support",
  "improve", "improves", "clean", "cleanup", "chore", "test", "tests", "testing",
  "the", "and", "for", "with", "from", "into", "that", "this", "when", "where",
  "what", "which", "into", "onto", "over", "under", "after", "before", "across",
  "via", "per", "not", "but", "all", "any", "new", "old", "via", "out", "off",
  "set", "get", "let", "now", "its", "their", "than", "then", "also", "only",
]);

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Strip "[repo] " prefix and " (author, date)" suffix the observer adds.
function bareSubject(summary: string): string {
  return summary.replace(/^\[[^\]]*\]\s*/, "").replace(/\s*\([^)]*\)\s*$/, "");
}

function tokenize(subject: string): { unigrams: string[]; bigrams: string[] } {
  const words = subject
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  const bigrams: string[] = [];
  for (let i = 0; i < words.length - 1; i++) bigrams.push(`${words[i]} ${words[i + 1]}`);
  return { unigrams: [...new Set(words)], bigrams: [...new Set(bigrams)] };
}

interface TermStat {
  term: string;
  commits: Set<string>; // observationId
  days: Set<string>;
  repos: Set<string>;
  samples: string[];
}

export interface DetectReport {
  windowDays: number;
  observationsScanned: number;
  reposScanned: string[];
  excludedRepos: string[];
  patternsFound: number;
  created: number;
  skippedExistingSkill: string[];
  candidates: Array<{ patternKey: string; title: string; rationale: string; occurrences: number }>;
}

async function activeSkillsText(): Promise<string> {
  try {
    const body = await readFile(resolve(BRAIN_DIR, "Skills.md"), "utf8");
    const idx = body.indexOf("## Active Skills");
    return (idx >= 0 ? body.slice(idx) : body).toLowerCase();
  } catch {
    return "";
  }
}

// A candidate term is "covered" if every word of it already appears in the
// Active Skills section (so we don't re-propose enforce-voice etc.).
function coveredBySkills(term: string, skillsText: string): boolean {
  if (!skillsText) return false;
  return term.split(" ").every((w) => skillsText.includes(w));
}

export async function runSkillDetector(): Promise<DetectReport> {
  const sinceMs = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const rows = await convex.query(api.observations.recent, {
    sinceMs,
    kind: "git-commit",
    limit: 500,
  });

  const report: DetectReport = {
    windowDays: WINDOW_DAYS,
    observationsScanned: 0,
    reposScanned: [],
    excludedRepos: [...EXCLUDE_REPOS],
    patternsFound: 0,
    created: 0,
    skippedExistingSkill: [],
    candidates: [],
  };

  const terms = new Map<string, TermStat>();
  const reposSeen = new Set<string>();

  for (const obs of rows) {
    const repo = (obs.source ?? "").toLowerCase();
    if (EXCLUDE_REPOS.has(repo)) continue;
    reposSeen.add(obs.source);
    report.observationsScanned += 1;
    const subject = bareSubject(obs.summary);
    const day = new Date(obs.observedAt).toISOString().slice(0, 10);
    const { unigrams, bigrams } = tokenize(subject);
    for (const term of [...unigrams, ...bigrams]) {
      let stat = terms.get(term);
      if (!stat) {
        stat = { term, commits: new Set(), days: new Set(), repos: new Set(), samples: [] };
        terms.set(term, stat);
      }
      stat.commits.add(obs.observationId);
      stat.days.add(day);
      stat.repos.add(obs.source);
      if (stat.samples.length < 3) stat.samples.push(subject);
    }
  }
  report.reposScanned = [...reposSeen];

  // Patterns: DF >= threshold across >= 2 distinct days.
  const patterns = [...terms.values()]
    .filter((t) => t.commits.size >= DF_THRESHOLD && t.days.size >= 2)
    .sort((a, b) => b.commits.size - a.commits.size);

  // Collapse overlapping terms: drop a term whose commit set is mostly
  // subsumed by an already-kept (higher-DF) term.
  const kept: TermStat[] = [];
  for (const p of patterns) {
    const subsumed = kept.some((k) => {
      let overlap = 0;
      for (const c of p.commits) if (k.commits.has(c)) overlap += 1;
      return overlap / p.commits.size >= SUBSUME_OVERLAP;
    });
    if (!subsumed) kept.push(p);
  }
  report.patternsFound = kept.length;

  const skillsText = await activeSkillsText();

  for (const p of kept) {
    if (coveredBySkills(p.term, skillsText)) {
      report.skippedExistingSkill.push(p.term);
      continue;
    }
    const repos = [...p.repos];
    const patternKey = `git:${p.term.replace(/\s+/g, "-")}`;
    const title = `Recurring work: "${p.term}"`;
    const rationale = `${p.commits.size} commits in ${WINDOW_DAYS}d mention "${p.term}" across ${repos.join(", ")} (e.g. ${JSON.stringify(p.samples[0] ?? "")}). Possible repeatable skill.`;
    const evidence = JSON.stringify({
      term: p.term,
      count: p.commits.size,
      days: p.days.size,
      repos,
      samples: p.samples,
    });
    const result = await convex.mutation(api.skillCandidates.upsertByPattern, {
      candidateId: randomId("sc"),
      patternKey,
      title,
      rationale,
      evidence,
      occurrences: p.commits.size,
    });
    if (result.created) report.created += 1;
    report.candidates.push({ patternKey, title, rationale, occurrences: p.commits.size });
  }

  return report;
}
