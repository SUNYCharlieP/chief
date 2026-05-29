// Linear access for the observation log, via the managed Composio connection
// that already ships with boop (authMode "managed", OAuth). Everything here
// runs through composio.tools.execute programmatically — no LLM, like the git
// observer. Action slugs are resolved dynamically from the live toolkit catalog
// (we don't hardcode/guess names), and response shapes are parsed defensively.

import { getComposio, boopUserId, listConnectedToolkits } from "./../composio.js";

const TOOLKIT = "linear";

let slugCache: string[] | null = null;

async function linearSlugs(): Promise<string[]> {
  if (slugCache) return slugCache;
  const composio = getComposio();
  if (!composio) return [];
  const list = (await composio.tools.getRawComposioTools({
    toolkits: [TOOLKIT],
    limit: 500,
  })) as Array<{ slug?: string; name?: string }>;
  slugCache = list.map((t) => t.slug ?? t.name ?? "").filter(Boolean);
  return slugCache;
}

// Find the action slug whose name contains all the given keywords (case-
// insensitive). Returns null if none match, so callers can report it rather
// than guess.
async function resolveSlug(...keywords: string[]): Promise<string | null> {
  const slugs = await linearSlugs();
  const kws = keywords.map((k) => k.toUpperCase());
  return slugs.find((s) => kws.every((k) => s.toUpperCase().includes(k))) ?? null;
}

export async function resolvedLinearSlugs(): Promise<Record<string, string | null>> {
  const slugs = await linearSlugs();
  // Prefer the exact canonical slugs confirmed from the live catalog; fall back
  // to a keyword match so this survives catalog renames. Exact-first avoids the
  // earlier mis-hits (LINEAR_LIST_ISSUE_DRAFTS / LINEAR_GET_ISSUE_DEFAULTS).
  const exact = (...candidates: string[]): string | null =>
    candidates.find((c) => slugs.includes(c)) ?? null;
  return {
    listIssues:
      exact("LINEAR_LIST_LINEAR_ISSUES", "LINEAR_SEARCH_ISSUES", "LINEAR_LIST_ISSUES_BY_TEAM_ID") ??
      (await resolveSlug("LIST", "LINEAR", "ISSUES")),
    getIssue: exact("LINEAR_GET_LINEAR_ISSUE") ?? (await resolveSlug("GET", "LINEAR", "ISSUE")),
    listComments: exact("LINEAR_LIST_LINEAR_COMMENTS", "LINEAR_LIST_COMMENTS"),
    listProjects: exact("LINEAR_LIST_LINEAR_PROJECTS"),
    currentUser: exact("LINEAR_GET_CURRENT_USER") ?? "LINEAR_GET_CURRENT_USER",
  };
}

export async function isLinearConnected(): Promise<boolean> {
  try {
    const connected = await listConnectedToolkits();
    return connected.some(
      (c) => c.slug === TOOLKIT && /active|connected/i.test(String(c.status)),
    );
  } catch {
    return false;
  }
}

async function exec(slug: string, args: Record<string, unknown>): Promise<unknown> {
  const composio = getComposio();
  if (!composio) throw new Error("Composio not configured (COMPOSIO_API_KEY unset)");
  const result = (await composio.tools.execute(slug, {
    userId: boopUserId(),
    arguments: args,
  })) as { data?: unknown; successful?: boolean; error?: unknown };
  if (result.successful === false) {
    throw new Error(`Linear action ${slug} failed: ${JSON.stringify(result.error)}`);
  }
  return result.data ?? result;
}

// Defensive: find an array of issue-like objects anywhere shallow in the data.
function extractArray(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["issues", "nodes", "items", "data", "results"]) {
      const v = obj[key];
      if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
      if (v && typeof v === "object") {
        const nested = extractArray(v);
        if (nested.length) return nested;
      }
    }
  }
  return [];
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  project: string;
  updatedAt: string;
  url: string;
}

function str(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return str(o.name ?? o.title ?? o.identifier ?? "");
  }
  return String(v);
}

function normalizeIssue(raw: Record<string, unknown>): LinearIssue {
  return {
    id: str(raw.id),
    identifier: str(raw.identifier),
    title: str(raw.title),
    status: str(raw.state ?? raw.status ?? raw.stateName),
    project: str(raw.project ?? raw.projectName ?? "(no project)"),
    updatedAt: str(raw.updatedAt ?? raw.updated_at ?? ""),
    url: str(raw.url ?? raw.issueUrl ?? ""),
  };
}

// All issues across ALL projects, newest-updated first. We filter by
// updatedAt client-side so we don't depend on the action's filter arg shape.
export async function listRecentIssues(limit = 100): Promise<LinearIssue[]> {
  const slug = (await resolvedLinearSlugs()).listIssues;
  if (!slug) throw new Error("no Linear list-issues action slug resolved");
  const data = await exec(slug, { first: limit, orderBy: "updatedAt" });
  return extractArray(data).map(normalizeIssue).filter((i) => i.id || i.identifier);
}

export interface LinearDetail {
  issue: LinearIssue;
  description: string;
  comments: Array<{ author: string; body: string; createdAt: string }>;
}

export async function getIssueDetail(identifier: string): Promise<LinearDetail | null> {
  const issues = await listRecentIssues(200);
  const match = issues.find(
    (i) => i.identifier.toLowerCase() === identifier.trim().toLowerCase(),
  );
  if (!match) return null;
  const slugs = await resolvedLinearSlugs();
  let description = "";
  let comments: LinearDetail["comments"] = [];
  if (slugs.getIssue) {
    try {
      const d = (await exec(slugs.getIssue, { issueId: match.id, id: match.id })) as Record<
        string,
        unknown
      >;
      const inner = (d.issue ?? d.data ?? d) as Record<string, unknown>;
      description = str(inner.description ?? inner.body ?? "");
    } catch {
      /* description optional */
    }
  }
  if (slugs.listComments) {
    try {
      const c = await exec(slugs.listComments, { issueId: match.id, id: match.id });
      comments = extractArray(c).map((cm) => ({
        author: str(cm.user ?? cm.author ?? cm.creator),
        body: str(cm.body ?? cm.content),
        createdAt: str(cm.createdAt ?? cm.created_at),
      }));
    } catch {
      /* comments optional */
    }
  }
  return { issue: match, description, comments };
}

// For the build-time status endpoint: raw sample so we can confirm shapes.
export async function linearStatusProbe(): Promise<{
  connected: boolean;
  slugs: Record<string, string | null>;
  sampleCount: number;
  sample: LinearIssue[];
  error?: string;
}> {
  const connected = await isLinearConnected();
  const slugs = await resolvedLinearSlugs();
  if (!connected) return { connected, slugs, sampleCount: 0, sample: [] };
  try {
    const issues = await listRecentIssues(5);
    return { connected, slugs, sampleCount: issues.length, sample: issues.slice(0, 3) };
  } catch (err) {
    return { connected, slugs, sampleCount: 0, sample: [], error: String(err) };
  }
}
