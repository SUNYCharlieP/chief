// Adzuna job source for the job-intel watcher. Plain REST (no Composio, unlike
// Linear): structured JSON, no scraping. Free-tier credentials live in
// .env.local as ADZUNA_APP_ID / ADZUNA_APP_KEY (get them at developer.adzuna.com).
//
// This module owns the SOURCE + the cheap PRE-FILTER (salary floor, location,
// relevance). It deliberately has NO LLM in it: the strong-model scoring lives
// in job-scoring.ts so the volume reduction stays free. Both scripts/prove-jobs.ts
// (Phase 1 prove) and server/job-observer.ts (Phase 2) import from here so the
// fetch + filter rules have a single source of truth.

const APP_ID = process.env.ADZUNA_APP_ID ?? "";
const APP_KEY = process.env.ADZUNA_APP_KEY ?? "";
const COUNTRY = process.env.ADZUNA_COUNTRY ?? "us";
const MAX_DAYS_OLD = Number(process.env.CHIEF_JOB_MAX_DAYS_OLD ?? 30);
const RESULTS_PER_PAGE = 50;

export const SALARY_FLOOR = Number(process.env.CHIEF_JOB_SALARY_FLOOR ?? 80_000);
export const CAP_N = Number(process.env.CHIEF_JOB_CAP ?? 15);

export function adzunaConfigured(): boolean {
  return Boolean(APP_ID && APP_KEY);
}

// Bounded query set. Adzuna charges one call per query; keep it small. Buffalo
// metro searches use a radius; the remote search drops `where` and leans on the
// remote keyword, with the actual remote check done in the pre-filter below.
export const QUERIES: Array<{ label: string; what: string; where?: string; distanceKm?: number }> = [
  { label: "buffalo-pm", what: "project manager", where: "Buffalo", distanceKm: 48 },
  { label: "buffalo-construction-pm", what: "construction project manager", where: "Buffalo", distanceKm: 64 },
  { label: "buffalo-construction-mgr", what: "construction manager", where: "Buffalo", distanceKm: 64 },
  { label: "remote-construction-pm", what: "construction project manager remote" },
];

export interface JobListing {
  id: string;
  title: string;
  company: string;
  locationName: string;
  area: string[];
  salaryMin?: number;
  salaryMax?: number;
  salaryDisclosed: boolean;
  created?: string;
  url: string;
  description: string;
  category?: string;
  query: string;
  relevance: number;
}

function normalize(r: Record<string, unknown>, query: string): JobListing {
  const company = (r.company as Record<string, unknown>)?.display_name;
  const loc = r.location as Record<string, unknown> | undefined;
  const areaRaw = Array.isArray(loc?.area) ? (loc!.area as unknown[]) : [];
  const salaryMin = typeof r.salary_min === "number" ? r.salary_min : undefined;
  const salaryMax = typeof r.salary_max === "number" ? r.salary_max : undefined;
  const title = String(r.title ?? "").replace(/<[^>]+>/g, "").trim();
  const description = String(r.description ?? "").replace(/<[^>]+>/g, "").trim();
  return {
    id: String(r.id ?? ""),
    title,
    company: String(company ?? "(unknown)"),
    locationName: String(loc?.display_name ?? ""),
    area: areaRaw.map((a) => String(a)),
    salaryMin,
    salaryMax,
    // Adzuna sends "0" when the salary comes from the listing, "1" when it
    // predicted/estimated it. Only "0" counts as disclosed.
    salaryDisclosed: String(r.salary_is_predicted ?? "1") === "0",
    created: typeof r.created === "string" ? r.created : undefined,
    url: String(r.redirect_url ?? ""),
    description,
    category: (r.category as Record<string, unknown>)?.label
      ? String((r.category as Record<string, unknown>).label)
      : undefined,
    query,
    relevance: 0,
  };
}

export async function fetchQuery(q: (typeof QUERIES)[number]): Promise<JobListing[]> {
  const params = new URLSearchParams({
    app_id: APP_ID,
    app_key: APP_KEY,
    results_per_page: String(RESULTS_PER_PAGE),
    what: q.what,
    max_days_old: String(MAX_DAYS_OLD),
    "content-type": "application/json",
  });
  if (q.where) params.set("where", q.where);
  if (q.distanceKm) params.set("distance", String(q.distanceKm));

  const url = `https://api.adzuna.com/v1/api/jobs/${COUNTRY}/search/1?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Adzuna [${q.label}] HTTP ${res.status}: ${body.slice(0, 160)}`);
  }
  const data = (await res.json()) as { results?: unknown[] };
  const raw = Array.isArray(data.results) ? data.results : [];
  return raw.map((r) => normalize(r as Record<string, unknown>, q.label)).filter((l) => l.id);
}

export interface FetchResult {
  listings: JobListing[];
  perQuery: Array<{ label: string; what: string; where?: string; count: number }>;
  errors: string[];
}

// Run the full query set and dedupe by listing id within the run (the same
// listing often appears under more than one query). Per-query errors are
// collected, not thrown, so one bad query doesn't sink the run.
export async function fetchAndDedup(): Promise<FetchResult> {
  const byId = new Map<string, JobListing>();
  const perQuery: FetchResult["perQuery"] = [];
  const errors: string[] = [];
  for (const q of QUERIES) {
    try {
      const listings = await fetchQuery(q);
      for (const l of listings) if (!byId.has(l.id)) byId.set(l.id, l);
      perQuery.push({ label: q.label, what: q.what, where: q.where, count: listings.length });
    } catch (err) {
      errors.push(String(err));
      perQuery.push({ label: q.label, what: q.what, where: q.where, count: 0 });
    }
  }
  return { listings: [...byId.values()], perQuery, errors };
}

// ---------------------------------------------------------------------------
// PRE-FILTER rules (cheap, no LLM)
// ---------------------------------------------------------------------------
const BUFFALO_METRO = [
  "buffalo", "amherst", "cheektowaga", "tonawanda", "west seneca", "lancaster",
  "hamburg", "orchard park", "lockport", "depew", "kenmore", "williamsville",
  "niagara falls", "grand island", "erie county", "niagara county",
];

export function isBuffaloMetro(l: JobListing): boolean {
  const hay = `${l.locationName} ${l.area.join(" ")}`.toLowerCase();
  return BUFFALO_METRO.some((t) => hay.includes(t));
}

export function isRemote(l: JobListing): boolean {
  const hay = `${l.title} ${l.locationName} ${l.description}`.toLowerCase();
  if (/\b(no|not|non)[ -]?remote\b|remote not (?:available|offered)/.test(hay)) return false;
  return /\bremote\b|work from home|\bwfh\b|fully remote|remote[- ]first/.test(hay);
}

// Disclosed-salary floor. Never filter on a predicted estimate. Keep when the
// top of the disclosed range can clear the floor.
export function passesSalary(l: JobListing): boolean {
  if (!l.salaryDisclosed) return true;
  const top = l.salaryMax ?? l.salaryMin;
  if (top == null) return true;
  return top >= SALARY_FLOOR;
}

// Soft warn: salary is an ESTIMATE (not disclosed) whose top is below the floor.
// We do NOT drop these; the observer flags them in the push so the user knows
// the number is Adzuna's guess, not the employer's.
export function isSubFloorEstimate(l: JobListing): boolean {
  if (l.salaryDisclosed) return false;
  const top = l.salaryMax ?? l.salaryMin;
  return top != null && top < SALARY_FLOOR;
}

const CONSTRUCTION_TERMS = [
  "construction", "contractor", "subcontractor", "general contractor", " gc ",
  "build", "builder", "jobsite", "job site", "field", "trades", "renovation",
  "remodel", "flooring", "superintendent", "estimating", "estimator", "owner's rep",
];
const PM_TERMS = ["project manager", "project management", "project coordinator", "operations manager", " pm "];

export function relevanceScore(l: JobListing): number {
  const title = ` ${l.title.toLowerCase()} `;
  const desc = ` ${l.description.toLowerCase()} `;
  let score = 0;
  for (const t of CONSTRUCTION_TERMS) {
    if (title.includes(t)) score += 6;
    if (desc.includes(t)) score += 2;
  }
  for (const t of PM_TERMS) {
    if (title.includes(t)) score += 3;
    if (desc.includes(t)) score += 1;
  }
  return score;
}

export function salaryLabel(l: JobListing): string {
  if (l.salaryMin == null && l.salaryMax == null) return "no salary";
  const k = (n?: number) => (n == null ? "?" : `$${Math.round(n / 1000)}k`);
  const range = l.salaryMin === l.salaryMax ? k(l.salaryMin) : `${k(l.salaryMin)}-${k(l.salaryMax)}`;
  return `${range} ${l.salaryDisclosed ? "(disclosed)" : "(est.)"}`;
}
