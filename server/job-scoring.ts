// Strong-model scoring for the job-intel watcher. The whole judgment is the
// construction-adjacent-PM vs generic-IT-PM discriminator, with listed
// credentials treated as a SOFT signal (wish-list, commonly waived) rather than
// a hard bar unless the credential genuinely gates the core work. This rubric
// was tuned and eyeballed in Phase 1 against real Buffalo listings; keep it as
// the single source of truth for both the prove script and the observer.
import type { JobListing } from "./integrations/adzuna.js";
import { salaryLabel } from "./integrations/adzuna.js";

export const SCORE_MODEL = process.env.CHIEF_JOB_SCORE_MODEL ?? "claude-opus-4-8";

// The candidate profile is the spine of the scoring judgment. It is biographical
// and stays OUT of this public repo: set CHIEF_JOB_PROFILE in .env.local to the
// real profile. The committed default is a generic placeholder so the scorer
// still runs without it (with weaker discrimination).
const DEFAULT_PROFILE = `The candidate is pivoting into construction project management from a
background in hands-on construction field work and small-business ownership.
Their selling point is that field and ownership experience: running jobs,
managing subs and crews, scheduling, estimating, client/GC relationships,
budgets, and owning P&L on real construction work.`;

const PROFILE = process.env.CHIEF_JOB_PROFILE?.trim() || DEFAULT_PROFILE;

export const SCORING_SYSTEM = `You screen job listings for a candidate pivoting into construction project
management. Decide KEEP or DROP for a single listing.

CANDIDATE PROFILE:
${PROFILE}

THE ONE DISCRIMINATOR THAT MATTERS:
- KEEP construction-adjacent PM / ops / field-leadership roles where 14 years of
  real construction field experience and business-ownership is a direct ASSET:
  construction PM, assistant/project PM at a GC or sub, construction ops manager,
  estimator, project coordinator on real building/trades work, owner's-rep,
  superintendent-to-PM tracks, specialty-trade (flooring, etc.) PM.
- DROP generic IT / software / tech project management (Agile/Scrum/SDLC, JIRA,
  digital product, PMP-in-an-office roles) where construction field experience is
  NOT the asset. These often share the words "project manager" but the
  experience does not transfer; that is the trap to catch.
- DROP roles that are clearly not PM-track and not construction-ops (pure sales,
  pure admin, retail, unrelated industries) unless field/ownership experience is
  the obvious asset.

CREDENTIALS AND LISTED REQUIREMENTS (read these carefully, do not over-react):
Job listings routinely over-ask. A listed requirement is usually a wish-list, not
a real bar. Judge the role on the NATURE OF THE WORK, not on whether the candidate
checks every listed box.
- SOFT signal, DO NOT drop on this alone: "PMP preferred/required," "bachelor's
  degree required," "X years experience," "PE a plus," and similar listed
  requirements. These are commonly waived, and 14 years of field + business-owner
  experience offsets most of them. If the actual work is running the project,
  coordinating trades, scheduling, and owning budget, KEEP it even when the
  candidate would not check every listed requirement.
- HARD gate, legitimate DROP: a credential that is legally or functionally
  required to perform the CORE work, where the work itself is something
  field/ownership experience cannot substitute for. Example: a role whose actual
  job is sealing/stamping structural engineering drawings genuinely needs a PE
  license; a licensed-trade role whose core function is the licensed work itself.
  The test is whether the credential gates the day-to-day WORK, not whether the
  listing happens to mention it.
- A "Senior Bridge Project Manager" whose real job is managing the bridge build,
  trades, schedule, and budget is a KEEP even if it lists a PE preference. The
  same title is a DROP only if the core function is actually PE-stamped design
  work, not project management.

When unsure whether a "project manager" role is construction-adjacent vs generic
IT, look at the industry, the duties, and whether jobsite/field/trades/building
experience is what they want. Favor DROP when it reads as generic office IT-PM,
or when the core work genuinely requires a credential field/ownership experience
cannot replace. Do NOT drop a role whose actual work fits just because the listing
lists aspirational requirements.

Respond with ONLY a compact JSON object, no prose, no markdown fence:
{"verdict":"keep","why":"<=15 words, the specific construction-vs-generic reason"}`;

export function scoringPrompt(l: JobListing): string {
  return `LISTING
Title: ${l.title}
Company: ${l.company}
Location: ${l.locationName || "(n/a)"}
Category: ${l.category ?? "(n/a)"}
Salary: ${salaryLabel(l)}
Description (truncated):
${l.description.slice(0, 1800)}`;
}

export function parseVerdict(text: string): { verdict: "keep" | "drop"; why: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as { verdict?: string; why?: string };
      const verdict = String(obj.verdict ?? "").toLowerCase() === "keep" ? "keep" : "drop";
      return { verdict, why: String(obj.why ?? "").trim() || "(no reason given)" };
    } catch {
      /* fall through */
    }
  }
  return { verdict: "drop", why: `unparseable model output: ${text.slice(0, 80)}` };
}
