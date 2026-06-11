// Strong-model scoring for the job-intel watcher. The whole judgment is the
// construction-adjacent-PM vs generic-IT-PM discriminator, with listed
// credentials treated as a SOFT signal (wish-list, commonly waived) rather than
// a hard bar unless the credential genuinely gates the core work. This rubric
// was tuned and eyeballed in Phase 1 against real Buffalo listings; keep it as
// the single source of truth for both the prove script and the observer.
import type { JobListing } from "./integrations/adzuna.js";
import { salaryLabel } from "./integrations/adzuna.js";
import { stripEmDashes } from "./text-style.js";

export const SCORE_MODEL = process.env.CHIEF_JOB_SCORE_MODEL ?? "claude-opus-4-8";

// The candidate profile is the spine of the scoring judgment. It is biographical
// and stays OUT of this public repo: set CHIEF_JOB_PROFILE in .env.local to the
// real profile. The committed default is a generic placeholder so the scorer
// still runs without it (with weaker discrimination).
const DEFAULT_PROFILE = `The candidate is moving from hands-on construction into VDC / BIM and
construction-technology coordination. Their asset is construction domain
knowledge (how buildings, trades, and sequencing actually work) applied to
model coordination, clash detection, and digital delivery, NOT field
supervision. They are moving away from field-supervisor roles.`;

// Exported so the application-framing drafter (job-draft.ts) frames Charlie off
// the SAME biographical profile the scorer judged against — one source of truth.
export const PROFILE = process.env.CHIEF_JOB_PROFILE?.trim() || DEFAULT_PROFILE;

export const SCORING_SYSTEM = `You screen job listings for a candidate moving from hands-on construction into
VDC / BIM / construction-technology coordination. Decide KEEP or DROP for one listing.

CANDIDATE PROFILE:
${PROFILE}

THE THESIS — this is the whole judgment:
The candidate's asset is construction DOMAIN KNOWLEDGE — how buildings, trades,
sequencing, and jobsite reality actually work — applied to virtual design, model
coordination, and digital delivery. He is moving AWAY from field supervision.
Frame every "why" around domain knowledge as the BRIDGE into VDC/BIM, NOT around
field-supervision experience.

- KEEP (prime target): VDC / BIM / model-coordination / preconstruction-technology
  roles — VDC Coordinator/Manager, BIM Coordinator/Manager/Specialist, Virtual
  Design & Construction, model/clash coordination, digital delivery, Revit /
  Navisworks / BIM-360 roles, construction-technology. Construction domain
  knowledge is exactly what makes the candidate strong here.
- KEEP (secondary): construction project manager / preconstruction / estimating
  roles at a real builder / GC / AE firm where construction knowledge transfers.
  Relevant, but secondary to VDC/BIM.
- DROP: FIELD-SUPERVISOR roles — Superintendent, Foreman, field lead, site
  supervisor — whose core job is running crews / the field on site. The candidate
  is pivoting AWAY from these; DROP them even though they are "construction." The
  ONLY exception is when the core work is genuinely VDC / model coordination and a
  field-ish word in the title is incidental.
- DROP: generic IT / software / digital-product PM (Agile/Scrum/JIRA, SaaS) with
  no construction or VDC/BIM substance.

CREDENTIALS / LISTED REQUIREMENTS: listings over-ask; a listed requirement is
usually a wish-list, not a real bar. Judge the NATURE OF THE WORK, not whether the
candidate checks every box — do not drop a real VDC/BIM role just because it lists
a degree, a cert, or "X years." Treat a credential as a hard gate only when it
legally / functionally gates the core work (e.g. a PE-stamping design role).

Respond with ONLY a compact JSON object, no prose, no markdown fence:
{"verdict":"keep","why":"<=15 words; name the VDC/BIM-or-domain reason, or why it is field-super / generic"}`;

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
      // Strip em/en dashes for voice consistency (the model uses them in the why).
      return { verdict, why: stripEmDashes(String(obj.why ?? "").trim()) || "(no reason given)" };
    } catch {
      /* fall through */
    }
  }
  return { verdict: "drop", why: `unparseable model output: ${text.slice(0, 80)}` };
}
