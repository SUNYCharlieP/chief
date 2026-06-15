import { convex } from "./convex-client.js";
import { api } from "../convex/_generated/api.js";
import { getRuntimeConfig } from "./runtime-config.js";
import { runAgentRuntime } from "./runtimes/index.js";

// JAR-40 (Three-Link Drill phase 2): the drill loop. Surface a due concept,
// grade the spoken transcript on STRUCTURE (never correctness), generate the
// model answer fresh at grade time (so it cannot reach the client before the
// user has spoken — the protocol half of the locked gate), and bump the dumb
// fixed-step spacing ladder.

export const DRILL_MODEL = process.env.CHIEF_DRILL_MODEL ?? "claude-opus-4-8";

// Dev-only. Read ONLY from the env here, never from a request body, so a real
// build (env unset) can never surface a concept off its due date.
export function drillForceEnabled(): boolean {
  return process.env.CHIEF_DRILL_FORCE === "1";
}

export function threeLinkPrompt(concept: string): string {
  return `Explain this out loud, from memory, in three links — fact, then mechanism, then consequence:\n\n${concept}`;
}

export interface DrillPrompt {
  conceptId: string;
  domain: string;
  concept: string;
  prompt: string; // NO answer here — the model answer does not exist client-side yet
}

// Surface one due concept as a drill prompt (no answer). null if nothing is due.
export async function getDueDrill(force: boolean): Promise<DrillPrompt | null> {
  const c = await convex.query(api.concepts.due, { force });
  if (!c) return null;
  return { conceptId: c.conceptId, domain: c.domain, concept: c.concept, prompt: threeLinkPrompt(c.concept) };
}

export interface Grade {
  factPresent: boolean;
  mechanismPresent: boolean;
  consequencePresent: boolean;
  hedged: boolean;
  trailedOff: boolean;
  fancyPhraseSwap: boolean;
  sharpeningNote: string;
}

const GRADING_SYSTEM = `Grade HOW Charlie explained this concept out loud, NOT whether he was correct.
You are training a speaking muscle, not checking facts. Never say whether the
content was right or wrong. Never praise.

He was asked to explain it in three links: fact, then mechanism, then consequence.
The concept is given for CONTEXT ONLY — do NOT grade it against the concept for
correctness.

Assess ONLY the structure of the explanation:
- factPresent: did he state what it is?
- mechanismPresent: did he explain how it works?
- consequencePresent: did he give why it matters / when it bites?
- hedged: did he hand-wave instead of explain ("so this basically means that",
  "it kind of just works")?
- trailedOff: did it lose energy or trail off at the end instead of landing?
- fancyPhraseSwap: did he name-drop a term in place of an actual explanation?
- sharpeningNote: ONE concrete note to deliver it tighter next time. About
  delivery and structure only, never about whether the content was right. No
  praise, no em dashes, plain text.

Return ONLY JSON:
{"factPresent":bool,"mechanismPresent":bool,"consequencePresent":bool,"hedged":bool,"trailedOff":bool,"fancyPhraseSwap":bool,"sharpeningNote":"..."}`;

function gradingPrompt(concept: string, transcript: string): string {
  return `Concept (CONTEXT ONLY, do not grade for correctness): ${concept}\n\nHis spoken transcript:\n${transcript}`;
}

const MODEL_ANSWER_SYSTEM = `Write a clean three-link model answer for this concept: fact, then mechanism,
then consequence. It is shown only AFTER Charlie has spoken his own attempt, as a
reference for what a tight explanation sounds like. Tight and concrete, peer tone,
no preamble, no praise, no em dashes, plain text. Three short beats, nothing else.`;

function parseGrade(text: string): Grade | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (typeof o.sharpeningNote !== "string") return null;
    const b = (x: unknown) => x === true;
    return {
      factPresent: b(o.factPresent),
      mechanismPresent: b(o.mechanismPresent),
      consequencePresent: b(o.consequencePresent),
      hedged: b(o.hedged),
      trailedOff: b(o.trailedOff),
      fancyPhraseSwap: b(o.fancyPhraseSwap),
      sharpeningNote: String(o.sharpeningNote),
    };
  } catch {
    return null;
  }
}

function randomId(): string {
  return `rep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface DrillResult {
  grade: Grade;
  modelAnswer: string;
  nextDue: number | null;
}

// Grade a spoken transcript, save the rep, bump the ladder, and return the grade
// plus the freshly-generated model answer (which only exists from here on).
export async function gradeDrill(
  c: { conceptId: string; domain: string; concept: string },
  transcript: string,
): Promise<DrillResult> {
  const cfg = await getRuntimeConfig();

  const g = await runAgentRuntime(
    { ...cfg, model: DRILL_MODEL },
    { prompt: gradingPrompt(c.concept, transcript), systemPrompt: GRADING_SYSTEM, tools: [], mode: "background" },
  );
  const grade = parseGrade((g.text ?? "").trim());
  if (!grade) throw new Error("grading failed to parse");

  const clean =
    grade.factPresent && grade.mechanismPresent && grade.consequencePresent &&
    !grade.hedged && !grade.trailedOff && !grade.fancyPhraseSwap;

  // Generated fresh, only now — the protocol half of the locked gate.
  const ma = await runAgentRuntime(
    { ...cfg, model: DRILL_MODEL },
    { prompt: `Concept: ${c.concept}`, systemPrompt: MODEL_ANSWER_SYSTEM, tools: [], mode: "background" },
  );
  const modelAnswer = (ma.text ?? "").trim();

  const bump = await convex.mutation(api.concepts.recordDrill, { conceptId: c.conceptId, clean });
  await convex.mutation(api.reps.create, {
    repId: randomId(),
    conceptId: c.conceptId,
    domain: c.domain as "swift-arch" | "saas-arch" | "apple-dev" | "arm",
    transcript,
    factPresent: grade.factPresent,
    mechanismPresent: grade.mechanismPresent,
    consequencePresent: grade.consequencePresent,
    hedged: grade.hedged,
    trailedOff: grade.trailedOff,
    fancyPhraseSwap: grade.fancyPhraseSwap,
    sharpeningNote: grade.sharpeningNote,
    drilledAt: Date.now(),
  });

  return { grade, modelAnswer, nextDue: bump.nextDue };
}
