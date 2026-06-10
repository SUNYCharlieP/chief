import { convex } from "./convex-client.js";
import { api } from "../convex/_generated/api.js";
import { deliverOutbound } from "./delivery.js";

// Phase 3 briefing integration: the morning brief's habit section + the
// manual-habit draft-and-ask staging + the event-driven streak-break nudge.
// Auto habits self-report yesterday; manual habits with no row become a
// one-tap confirmation; a real ≥3 streak ending yesterday fires one nudge.

const CONV = "app:charlie"; // habit cards + nudges live on the app channel

function yesterdayOf(today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12) - 86_400_000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}

// Format a metric reading for the brief. water is stored mL -> shown oz; sleep
// minutes -> h/m; wake minutes-past-midnight -> clock; etc.
function fmtValue(metric: string | null, v: number | null): string {
  if (v == null || metric == null) return "";
  const n = Math.round(v);
  switch (metric) {
    case "wake_time": return ` ${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
    case "sleep_duration": return ` ${Math.floor(n / 60)}h${n % 60}m`;
    case "mindful_minutes": return ` ${n}m`;
    case "resting_hr": return ` ${n}bpm`;
    case "water": return ` ${Math.round(v / 29.5735)}oz`;
    default: return ` ${n}`;
  }
}

// The deterministic habit section text (no LLM). Auto + manual-logged habits
// report yesterday's result; manual habits with no row are listed "to confirm"
// (the actual cards are staged separately). Empty string when no habits.
export async function buildHabitsSection(today: string): Promise<string> {
  const yesterday = yesterdayOf(today);
  const rows = await convex.query(api.habits.functions.briefing, { yesterday, today });
  if (rows.length === 0) return "";

  const lines: string[] = [];
  const toConfirm: string[] = [];
  for (const r of rows) {
    if (r.isManual && r.yesterdayStatus === "unknown") {
      toConfirm.push(r.name);
    } else if (r.yesterdayStatus === "completed") {
      lines.push(`- ${r.name}: done${fmtValue(r.metric, r.yesterdayValue)}, streak ${r.streak}`);
    } else if (r.yesterdayStatus === "missed") {
      lines.push(`- ${r.name}: missed${fmtValue(r.metric, r.yesterdayValue)}`);
    } else {
      lines.push(`- ${r.name}: no data yet`); // auto, not synced — never failure-toned
    }
  }
  if (toConfirm.length > 0) lines.push(`- to confirm: ${toConfirm.join(", ")}`);
  if (lines.length === 0) return "";
  return ["Habits (yesterday):", ...lines].join("\n");
}

// Stage a draft-and-ask for the FIRST manual habit with no row yesterday.
// Sequential per the ruling — one active action; create() supersedes any other
// pending action, and the next confirmation surfaces after this one resolves.
export async function stageHabitConfirmations(today: string): Promise<void> {
  const yesterday = yesterdayOf(today);
  const rows = await convex.query(api.habits.functions.briefing, { yesterday, today });
  const first = rows.find((r) => r.isManual && r.yesterdayStatus === "unknown");
  if (!first) return;

  // Post the confirm prompt as its OWN message and bind the card to it — NOT to
  // the briefing. A message with a card renders card-only in the app, so binding
  // to the briefing would hide the whole brief behind this little card. (Same
  // card-message-then-prompt split the job draft-and-ask uses.)
  await convex.mutation(api.messages.send, {
    conversationId: CONV,
    role: "assistant",
    content: `Did you ${first.name} yesterday (${yesterday})?`,
    complete: true,
  });
  const now = Date.now();
  await convex.mutation(api.pendingActions.create, {
    actionId: `habit-${first.id}-${yesterday}`,
    conversationId: CONV,
    kind: "habit.confirm",
    pitch: `Did you ${first.name} yesterday?`,
    entry: JSON.stringify({ habitId: first.id, date: yesterday, name: first.name, today }),
    targetFile: "",
    sha256: "",
    createdAt: now,
    expiresAt: now + 36 * 3_600_000, // 36h: covers the day it's surfaced
  });
}

// Event-driven streak-break nudge. Called after a metrics ingest: for any habit
// whose ≥3 streak broke YESTERDAY (a missed row = evidence), deliver one factual
// line, deduped per habit+date. No-data days never appear here (no missed row).
export async function runStreakNudges(today: string): Promise<void> {
  const yesterday = yesterdayOf(today);
  const breaks = await convex.query(api.habits.functions.streakBreaks, {
    yesterday,
    today,
    minStreak: 3,
  });
  if (breaks.length === 0) return;
  const contact = process.env.CHIEF_CONTACT ?? "";

  for (const b of breaks) {
    const dedupKey = `habit-nudge:${b.id}:${b.date}`;
    const seen = await convex
      .query(api.proactive.surfacedKeys, { keys: [dedupKey] })
      .catch(() => [] as string[]);
    if (seen.includes(dedupKey)) continue;
    await deliverOutbound({
      contact,
      body: `${b.name}: your ${b.brokenStreak}-day streak ended yesterday. Today is a fresh start.`,
      pushTitle: "Habits",
    });
    await convex.mutation(api.proactive.markSurfaced, { dedupKey, date: today }).catch(() => {});
  }
}
