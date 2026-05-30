import { Cron } from "croner";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { sendImessage } from "./imessage.js";
import { loadBrain, getBrainBlock } from "./brain.js";
import { getRuntimeConfig } from "./runtime-config.js";
import { runAgentRuntime } from "./runtimes/index.js";
import { getUserTimezone } from "./timezone-config.js";
import { EMPTY_USAGE } from "./usage.js";

// Proactive engagement: Chief INITIATES (not just responds). The cron is a
// heartbeat; runProactiveCheck() is a gauntlet of STRUCTURAL gates in the send
// path. The model can only nominate a candidate and draft wording; it can never
// send. No fresh observation -> no candidate -> silence. Silence is the default.

const PROACTIVE_CRON = process.env.CHIEF_PROACTIVE_CRON ?? "0 * * * *"; // hourly heartbeat
const HAIKU_MODEL = process.env.CHIEF_SCAN_MODEL ?? "claude-haiku-4-5-20251001";
const MAX_SCORED = 12; // bound LLM cost: only the most recent fresh signals

// One-word ways to pause self-initiation for the rest of the local day. Tight,
// whole-message only (same discipline as the affirmative gate) so a "stop"
// buried in a sentence never trips it.
const MUTE_WORDS = new Set(["mute", "quiet", "not now", "shush", "pause", "quiet today", "mute today"]);

// Knobs read at CALL time (not module load) so tests can vary env per run.
function knobs() {
  return {
    max: Number(process.env.CHIEF_PROACTIVE_DAILY_MAX ?? 3),
    startHour: Number(process.env.CHIEF_PROACTIVE_START ?? 8),
    endHour: Number(process.env.CHIEF_PROACTIVE_END ?? 20),
    threshold: Number(process.env.CHIEF_PROACTIVE_THRESHOLD ?? 70),
    freshHours: Number(process.env.CHIEF_PROACTIVE_FRESH_HOURS ?? 36),
  };
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[\s.!]+$/u, "");
}
function localDate(tz: string, d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: tz });
}
function localHour(tz: string, d = new Date()): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(d);
  return Number(h) % 24; // some engines render midnight as "24"
}

// ---- deterministic mute interception (called pre-LLM from the dispatcher) ----

// If the whole inbound message is a mute keyword, pause self-initiation for the
// rest of the local day and return a confirmation. Otherwise null (fall through
// to normal handling). This NEVER touches a pending draft: it sets a flag and
// returns, so an open confirmation stays open. Resets automatically tomorrow.
export async function handleProactiveMute(content: string): Promise<string | null> {
  if (!MUTE_WORDS.has(normalize(content))) return null;
  const tz = await getUserTimezone();
  await convex.mutation(api.proactive.setMuted, { date: localDate(tz), muted: true });
  return "Muted proactive pings for today. I'll still answer you.";
}

// ---- the worth-it scoring pass (model proposes; code disposes) ----

const PROACTIVE_SYSTEM =
  "You are Chief, deciding whether to PROACTIVELY message Charlie about something you observed. " +
  "You return ONLY a JSON array, no prose. You cannot send anything; you only nominate.";

interface FreshObs {
  dedupKey: string;
  kind: string;
  source: string;
  summary: string;
  detail?: string;
}
interface Nomination {
  index: number;
  worthIt: boolean;
  score: number;
  reason: string;
  message: string;
}

function buildProactivePrompt(brain: string, fresh: FreshObs[]): string {
  const list = fresh
    .map((o, i) => `[${i}] (${o.kind}/${o.source}) ${o.summary}${o.detail ? `\n    detail: ${o.detail}` : ""}`)
    .join("\n");
  return `Charlie's context (his goals, active work, standards):
${brain}

Recent observations Chief noticed (not yet raised with him):
${list}

For EACH observation, decide whether it is worth interrupting Charlie's day with an unprompted message RIGHT NOW.

Return ONLY a JSON array, one object per observation index:
[{"index":0,"worthIt":true,"score":0-100,"reason":"one line","message":"the exact ping text"}]

Hard rules:
- worthIt=true ONLY if the observation is specific, recent, and genuinely worth an interruption. Default to worthIt=false. Silence is the norm; initiation is the exception.
- The message MUST be grounded in the concrete observation: name the repo, ticket, commit, event, or bill. A reflective question is allowed ONLY when the observation earns it.
- FORBIDDEN: manufactured check-ins or generic reflection ("how do you feel about your goals", "just checking in", "how's it going"). If there is no real reason, worthIt=false.
- Voice: peer-level, direct, no preamble, no flattery, no em dashes, at most 2 sentences. You may ask ONE pointed question that ties to the observation.`;
}

function parseNominations(text: string, n: number): Nomination[] {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((r): Nomination | null => {
      const o = r as Record<string, unknown>;
      const index = Number(o.index);
      if (!Number.isInteger(index) || index < 0 || index >= n) return null;
      return {
        index,
        worthIt: Boolean(o.worthIt),
        score: Number(o.score) || 0,
        reason: typeof o.reason === "string" ? o.reason : "",
        message: typeof o.message === "string" ? o.message.trim() : "",
      };
    })
    .filter((x): x is Nomination => x !== null && x.message.length > 0);
}

// ---- the gauntlet ----

export type ProactiveGate =
  | "window"
  | "muted"
  | "ration"
  | "no-fresh-signal"
  | "below-bar"
  | "no-contact"
  | "fired";

export interface ProactiveResult {
  decision: "sent" | "silent";
  gate: ProactiveGate;
  llmSpent: boolean;
  dryRun?: boolean;
  candidate?: { dedupKey: string; summary: string };
  score?: number;
  reason?: string;
  message?: string;
}

export interface ProactiveOpts {
  dryRun?: boolean; // run every gate + the LLM, but don't send or mutate state
  dateOverride?: string; // test against a throwaway date's daily state
  nowOverride?: Date; // test the waking-window gate deterministically
}

export async function runProactiveCheck(opts: ProactiveOpts = {}): Promise<ProactiveResult> {
  const k = knobs();
  const tz = await getUserTimezone();
  const now = opts.nowOverride ?? new Date();
  const date = opts.dateOverride ?? localDate(tz, now);

  // GATE 1: waking-hours window (structural; the cron is only a heartbeat).
  const hour = localHour(tz, now);
  if (hour < k.startHour || hour >= k.endHour) {
    return { decision: "silent", gate: "window", llmSpent: false };
  }

  // GATE 2: mute (whole-day, set by the deterministic keyword interception).
  const daily = await convex.query(api.proactive.getDaily, { date });
  if (daily?.muted) return { decision: "silent", gate: "muted", llmSpent: false };

  // GATE 3: ration ceiling (the 7am briefing never touches this counter).
  if ((daily?.count ?? 0) >= k.max) return { decision: "silent", gate: "ration", llmSpent: false };

  // GATE 4: fresh-signal filter in CODE, before any LLM spend (most ticks free).
  const sinceMs = now.getTime() - k.freshHours * 3600_000;
  const obs = (await convex.query(api.observations.recent, { sinceMs, limit: 50 })) as FreshObs[];
  if (obs.length === 0) return { decision: "silent", gate: "no-fresh-signal", llmSpent: false };
  const surfaced = new Set(
    await convex.query(api.proactive.surfacedKeys, { keys: obs.map((o) => o.dedupKey) }),
  );
  const fresh = obs.filter((o) => !surfaced.has(o.dedupKey)).slice(0, MAX_SCORED);
  if (fresh.length === 0) return { decision: "silent", gate: "no-fresh-signal", llmSpent: false };

  // GATE 5: worth-it bar (LLM runs only now). Model proposes; code disposes.
  await loadBrain();
  const brain = getBrainBlock();
  const runtimeConfig = await getRuntimeConfig();
  const callConfig = { ...runtimeConfig, model: HAIKU_MODEL };
  const result = await runAgentRuntime(callConfig, {
    prompt: buildProactivePrompt(brain, fresh),
    systemPrompt: PROACTIVE_SYSTEM,
    tools: [],
    mode: "background",
  });
  try {
    const usage = result.usage ?? { ...EMPTY_USAGE, model: HAIKU_MODEL };
    if (usage.costUsd > 0 || usage.inputTokens > 0) {
      await convex.mutation(api.usageRecords.record, {
        source: "proactive",
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        costUsd: usage.costUsd,
        durationMs: 0,
      });
    }
  } catch (err) {
    console.warn(`[proactive] usage record failed: ${String(err)}`);
  }

  const nominations = parseNominations(result.text, fresh.length);
  const best = nominations
    .filter((nmn) => nmn.worthIt && nmn.score >= k.threshold)
    .sort((a, b) => b.score - a.score)[0];
  if (!best) return { decision: "silent", gate: "below-bar", llmSpent: true };
  const chosen = fresh[best.index];
  if (!chosen) return { decision: "silent", gate: "below-bar", llmSpent: true };

  const out: ProactiveResult = {
    decision: "sent",
    gate: "fired",
    llmSpent: true,
    candidate: { dedupKey: chosen.dedupKey, summary: chosen.summary },
    score: best.score,
    reason: best.reason,
    message: best.message,
  };

  // Dry run: every gate + the LLM ran, but no send and no state mutation.
  if (opts.dryRun) return { ...out, dryRun: true };

  // GATE 6: the actual send is reached ONLY after every gate passed.
  const contact = process.env.CHIEF_CONTACT ?? "";
  if (!contact) return { ...out, decision: "silent", gate: "no-contact" };
  await sendImessage(contact, best.message);
  // Persist so the dispatcher remembers what it proactively said (no amnesia).
  // This convex row does NOT feed the inbound chat.db poller, so no re-processing.
  await convex.mutation(api.messages.send, {
    conversationId: `sms:${contact}`,
    role: "assistant",
    content: best.message,
  });
  // Anti-nag: mark surfaced on SEND (not on reply) so it never re-fires.
  await convex.mutation(api.proactive.markSurfaced, { dedupKey: chosen.dedupKey, date });
  await convex.mutation(api.proactive.incrementCount, { date });
  return out;
}

// ---- cron heartbeat ----

let proactiveCron: Cron | null = null;

export async function startProactiveEngagement(): Promise<void> {
  if (proactiveCron) {
    console.warn("[proactive] already started");
    return;
  }
  const timezone = (await getUserTimezone()) ?? "UTC";
  proactiveCron = new Cron(PROACTIVE_CRON, { timezone }, async () => {
    try {
      const r = await runProactiveCheck();
      if (r.decision === "sent") {
        console.log(`[proactive] fired (score=${r.score}) ${JSON.stringify(r.candidate?.dedupKey)}`);
      } else if (r.gate !== "no-fresh-signal" && r.gate !== "window") {
        console.log(`[proactive] silent gate=${r.gate} llmSpent=${r.llmSpent}`);
      }
    } catch (err) {
      console.error("[proactive] tick error", err);
    }
  });
  const k = knobs();
  console.log(
    `[proactive] scheduled: cron=${PROACTIVE_CRON} tz=${timezone} window=${k.startHour}-${k.endHour} max/day=${k.max} threshold=${k.threshold}`,
  );
}
