import { convex } from "./convex-client.js";
import { api } from "../convex/_generated/api.js";
import { getRuntimeConfig } from "./runtime-config.js";
import { runAgentRuntime } from "./runtimes/index.js";

// JAR-39 (Three-Link Drill phase 1): learn mode. `/learn` selects ONE concept
// grounded in Charlie's real recent work (the observation log), teaches it, and
// saves it to the concept store AT SELECTION (so it can't be dodged by closing
// the lesson early). No speaking, grading, or audio — those are phases 2/3.

export const LEARN_MODEL = process.env.CHIEF_LEARN_MODEL ?? "claude-opus-4-8";

type Domain = "swift-arch" | "saas-arch" | "apple-dev" | "arm";

// Weighting is deterministic in code (the "dumb" line): Swift-heavy. The LLM
// only frames a concept in the chosen domain; it never picks the domain.
const DOMAIN_WEIGHTS: [Domain, number][] = [
  ["swift-arch", 50],
  ["saas-arch", 20],
  ["apple-dev", 15],
  ["arm", 15],
];

const DOMAIN_LABEL: Record<Domain, string> = {
  "swift-arch": "Swift architecture (language, memory model, concurrency, protocol-oriented design, patterns)",
  "saas-arch": "SaaS / general software architecture (API design, state, data modeling, backend/Convex grain)",
  "apple-dev": "Apple development (frameworks, App Intents, Foundation Models, platform APIs)",
  "arm": "Apple Silicon / ARM (unified memory, neural engine, on-device inference, why it wins)",
};

function pickDomain(): Domain {
  const total = DOMAIN_WEIGHTS.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [d, w] of DOMAIN_WEIGHTS) if ((r -= w) < 0) return d;
  return "swift-arch";
}

// Observation kinds that carry a teachable signal (real code/ticket movement).
const SELECTION_OBS_KINDS = new Set(["git-commit", "linear-ticket", "github-pr"]);

interface Selected {
  domain: Domain;
  concept: string;
  summary: string;
  sourceObservationId: string | null;
  grounded: boolean;
}

function selectionSystem(domain: Domain): string {
  return `Select ONE concept for Charlie to learn next, drawn from his ACTUAL recent work.
Target domain: ${DOMAIN_LABEL[domain]}.

Pick the single most teachable concept in that domain that ONE of the observations
below actually touches. A concept is specific and explainable: a language feature,
an API, an architecture decision, a hardware behavior. "concurrency" is too vague;
"why actor reentrancy can interleave awaits" is a concept. The test: someone reading
that observation should agree "yes, that change touched this."

Rules:
- Ground it in ONE specific observation. Return its exact observationId. Do NOT
  invent activity that is not in the list.
- If nothing in the list cleanly yields a concept in the target domain, set
  grounded=false and pick a canonical concept in the domain with
  sourceObservationId null. Prefer grounding; fall back only when the list
  genuinely has nothing in this domain.
- One concept, specific enough to later explain in three links (fact, mechanism,
  consequence). Do not repeat anything under "already learned".

Return ONLY a JSON object, no prose:
{"concept":"...","summary":"2-3 sentence essence","sourceObservationId":"<id or null>","grounded":true|false}`;
}

function selectionPrompt(obs: any[], learned: { concept: string }[]): string {
  const obsLines = obs
    .map(
      (o) =>
        `- id=${o.observationId} [${o.kind}] ${new Date(o.observedAt).toISOString().slice(0, 10)}: ${o.summary}` +
        (o.detail ? `\n    ${String(o.detail).slice(0, 300)}` : ""),
    )
    .join("\n");
  const learnedLines = learned.length ? learned.map((l) => `- ${l.concept}`).join("\n") : "(none yet)";
  return `Recent observed activity (newest first):\n${obsLines || "(no recent activity)"}\n\nAlready learned (do not repeat):\n${learnedLines}`;
}

function teachingSystem(): string {
  return `Teach Charlie one concept. LEARN mode.
He is a strong builder (building Jarvis: a Swift iOS app plus a Convex/TS server),
solidifying his depth. Assume working knowledge, skip the 101.

Explain in three beats, the same shape he will later have to reproduce out loud:
1. Fact: what it is, one line.
2. Mechanism: how it actually works under the hood. This is the part that matters.
3. Consequence: why it matters, when it bites, the tradeoff.

Concrete over abstract: one short real example beats three sentences of theory.
Peer tone. No preamble, no "great question", no filler, no em dashes. Plain text,
no markdown headers or bold. End by inviting one follow-up, not a summary. This is
teaching, not a quiz: do NOT ask him to explain it back. That is the drill, later.`;
}

function teachingPrompt(s: Selected, sourceSummary: string | null): string {
  const lines = [`Concept: ${s.concept}`, `Essence: ${s.summary}`, `Domain: ${DOMAIN_LABEL[s.domain]}`];
  if (s.grounded && sourceSummary)
    lines.push(`From his own work: ${sourceSummary}. Ground the explanation in that real change where you can.`);
  return lines.join("\n");
}

function parseSelection(text: string, domain: Domain): Selected | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (!o.concept || !o.summary) return null;
    const sid = o.sourceObservationId && o.sourceObservationId !== "null" ? String(o.sourceObservationId) : null;
    return {
      domain,
      concept: String(o.concept),
      summary: String(o.summary),
      sourceObservationId: sid,
      grounded: Boolean(o.grounded) && sid !== null,
    };
  } catch {
    return null;
  }
}

function randomId(): string {
  return `cpt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function humanDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// Run one learn cycle: select -> save -> teach. Returns the teaching text plus a
// one-line confirmation; the slash framework persists it as the assistant reply.
export async function runLearn(conversationId: string): Promise<string> {
  const domain = pickDomain();
  const sinceMs = Date.now() - 14 * 86400000;
  const allObs = (await convex.query(api.observations.recent, { sinceMs, limit: 40 })) as any[];
  const obs = allObs.filter((o) => SELECTION_OBS_KINDS.has(o.kind));
  const learned = await convex.query(api.concepts.recentLearned, { limit: 30 });

  const cfg = await getRuntimeConfig();
  const sel = await runAgentRuntime(
    { ...cfg, model: LEARN_MODEL },
    { prompt: selectionPrompt(obs, learned), systemPrompt: selectionSystem(domain), tools: [], mode: "background" },
  );
  const selected = parseSelection((sel.text ?? "").trim(), domain);
  if (!selected) return "I couldn't pick a concept to teach just now. Try /learn again.";

  // Ground the teaching in the cited observation. If the model cited an id that
  // is NOT in the real list, it hallucinated the source: downgrade to fallback
  // rather than teach against fabricated work.
  let sourceSummary: string | null = null;
  if (selected.sourceObservationId) {
    const src = obs.find((o) => o.observationId === selected.sourceObservationId);
    if (src) sourceSummary = src.summary;
    else {
      selected.sourceObservationId = null;
      selected.grounded = false;
    }
  }

  const now = Date.now();
  const dueDate = now + 2 * 86400000; // ~2 days; always next-day+ (no-same-day rule)
  await convex.mutation(api.concepts.create, {
    conceptId: randomId(),
    domain: selected.domain,
    concept: selected.concept,
    summary: selected.summary,
    sourceObservationId: selected.sourceObservationId ?? undefined,
    learnedAt: now,
    dueDate,
  });

  const teach = await runAgentRuntime(
    { ...cfg, model: LEARN_MODEL },
    { prompt: teachingPrompt(selected, sourceSummary), systemPrompt: teachingSystem(), tools: [], mode: "background" },
  );
  const teaching =
    (teach.text ?? "").trim() || "(couldn't generate the lesson, but the concept is saved. /learn to retry the teach.)";

  const tag = selected.grounded ? "from your recent work" : "domain pick";
  return `${teaching}\n\n// learned · ${selected.concept} · ${tag} · drill due ${humanDay(dueDate)}`;
}
