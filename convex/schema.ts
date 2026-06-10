import { defineSchema, defineTable } from "convex/server";
import { v, type Validator } from "convex/values";
import {
  COMPARATORS,
  GOAL_PERIODS,
  HABIT_METRIC_KEYS,
  HABIT_SOURCE_TYPES,
  HABIT_STATUSES,
} from "./habits/streak";

// Build a `v.union(v.literal(...))` validator straight from a canonical tuple
// in streak.ts, preserving the literal member type. This is what keeps the DB
// validator and the pure-core types single-source: the literal strings are
// declared exactly once (in streak.ts), and both the TypeScript types and the
// Convex validators below are derived from the same tuples. Adding/removing a
// value happens in one place and can never drift.
function literalUnion<T extends readonly [string, string, ...string[]]>(
  values: T,
): Validator<T[number]> {
  const members = values.map((value) => v.literal(value));
  return v.union(
    ...(members as [Validator<string>, Validator<string>, ...Validator<string>[]]),
  ) as unknown as Validator<T[number]>;
}

// Closed metric set (sleep_duration | wake_time | mindful_minutes | steps |
// resting_hr | water). `water` (dietaryWater) is the one sanctioned intake
// metric; there is still no weight/calorie/generic-intake literal, so those
// habits stay unconstructable — the validator rejects them at write time.
const habitMetricValidator = literalUnion(HABIT_METRIC_KEYS);
const comparatorValidator = literalUnion(COMPARATORS);
const goalPeriodValidator = literalUnion(GOAL_PERIODS);
// Exported so habits/functions.ts validates its args against the SAME closed
// unions the tables enforce — no drift between API surface and schema.
export const habitStatusValidator = literalUnion(HABIT_STATUSES);

// Auto sources (Oura / HealthKit) share the same metric+comparator+threshold
// shape; manual sources carry no metric. threshold is a plain number in the
// metric's own unit — for wake_time that is minutes past local midnight, so
// "by 07:00" is threshold 420 with comparator "lte" (see streak.ts).
const autoSourceFields = {
  metric: habitMetricValidator,
  comparator: comparatorValidator,
  threshold: v.number(),
};

export const habitSourceValidator = v.union(
  v.object({ type: v.literal(HABIT_SOURCE_TYPES[0]) }), // "manual"
  v.object({ type: v.literal(HABIT_SOURCE_TYPES[1]), ...autoSourceFields }), // "oura-auto"
  v.object({ type: v.literal(HABIT_SOURCE_TYPES[2]), ...autoSourceFields }), // "healthkit-auto"
);

export default defineSchema({
  messages: defineTable({
    conversationId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
    content: v.string(),
    agentId: v.optional(v.string()),
    turnId: v.optional(v.string()),
    createdAt: v.number(),
    imageStorageIds: v.optional(v.array(v.id("_storage"))),
    mediaError: v.optional(v.string()),
    // True only on the terminal reply of a turn (the real done-state). The app
    // keeps its working animation up until it polls a complete=true assistant
    // message, independent of push delivery. Absent on intermediate progress.
    complete: v.optional(v.boolean()),
    // Tags a message whose body is copyable draft output meant to be used
    // elsewhere (e.g. "draft.application" for job application framing). GET
    // /messages turns it into a "draft" card with a one-tap copy. Absent on
    // ordinary messages.
    kind: v.optional(v.string()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_conversation_turn", ["conversationId", "turnId"])
    .index("by_createdAt", ["createdAt"]),

  conversations: defineTable({
    conversationId: v.string(),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    messageCount: v.number(),
    lastActivityAt: v.number(),
  }).index("by_conversation", ["conversationId"]),

  memoryRecords: defineTable({
    memoryId: v.string(),
    content: v.string(),
    tier: v.union(v.literal("short"), v.literal("long"), v.literal("permanent")),
    segment: v.union(
      v.literal("identity"),
      v.literal("preference"),
      v.literal("correction"),
      v.literal("relationship"),
      v.literal("project"),
      v.literal("knowledge"),
      v.literal("context"),
    ),
    importance: v.number(),
    decayRate: v.number(),
    accessCount: v.number(),
    lastAccessedAt: v.number(),
    sourceTurn: v.optional(v.string()),
    lifecycle: v.union(v.literal("active"), v.literal("archived"), v.literal("pruned")),
    supersedes: v.optional(v.array(v.string())),
    embedding: v.optional(v.array(v.float64())),
    // Structured sidecar data (JSON blob). Currently used to carry
    // `corrects` text on correction-segment memories. Intentionally loose
    // so extraction prompts can stash provider-specific hints without
    // schema churn.
    metadata: v.optional(v.string()),
    createdAt: v.number(),
    imageStorageIds: v.optional(v.array(v.id("_storage"))),
  })
    .index("by_memory_id", ["memoryId"])
    .index("by_tier", ["tier"])
    .index("by_segment", ["segment"])
    .index("by_lifecycle", ["lifecycle"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1024,
      filterFields: ["lifecycle"],
    }),

  executionAgents: defineTable({
    agentId: v.string(),
    conversationId: v.optional(v.string()),
    name: v.string(),
    task: v.string(),
    runtime: v.optional(v.union(v.literal("claude"), v.literal("codex"))),
    model: v.optional(v.string()),
    reasoningEffort: v.optional(v.string()),
    billingMode: v.optional(v.union(v.literal("api"), v.literal("codex-subscription"))),
    status: v.union(
      v.literal("spawned"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("paused"),
    ),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    mcpServers: v.array(v.string()),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cacheReadTokens: v.optional(v.number()),
    cacheCreationTokens: v.optional(v.number()),
    costUsd: v.number(),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_agent_id", ["agentId"])
    .index("by_status", ["status"])
    .index("by_conversation", ["conversationId"]),

  // Append-only LLM usage log. Every model call (dispatcher, execution,
  // extract, consolidation) writes a row here so you can query total cost
  // by source, conversation, or time range.
  usageRecords: defineTable({
    source: v.union(
      v.literal("dispatcher"),
      v.literal("execution"),
      v.literal("extract"),
      v.literal("consolidation-proposer"),
      v.literal("consolidation-adversary"),
      v.literal("consolidation-judge"),
      v.literal("proactive"),
      v.literal("morning-scan-scoring"),
      v.literal("morning-scan-format"),
      v.literal("job-observer"),
    ),
    conversationId: v.optional(v.string()),
    turnId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    runId: v.optional(v.string()),
    runtime: v.optional(v.union(v.literal("claude"), v.literal("codex"))),
    billingMode: v.optional(v.union(v.literal("api"), v.literal("codex-subscription"))),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cacheReadTokens: v.number(),
    cacheCreationTokens: v.number(),
    costUsd: v.number(),
    durationMs: v.number(),
    createdAt: v.number(),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_agent", ["agentId"])
    .index("by_source", ["source"]),

  agentLogs: defineTable({
    agentId: v.string(),
    logType: v.union(
      v.literal("thinking"),
      v.literal("tool_use"),
      v.literal("tool_result"),
      v.literal("text"),
      v.literal("error"),
    ),
    toolName: v.optional(v.string()),
    // Composio account aliases targeted by this tool call (e.g. ["gmail_charry-fusc"]).
    // Populated when the input names a specific connected account, so multi-account
    // toolkits make it visible which inbox / workspace was actually hit.
    accounts: v.optional(v.array(v.string())),
    content: v.string(),
    createdAt: v.number(),
  }).index("by_agent", ["agentId"]),

  memoryEvents: defineTable({
    eventType: v.string(),
    conversationId: v.optional(v.string()),
    memoryId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    data: v.string(),
    createdAt: v.number(),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_type", ["eventType"]),

  automations: defineTable({
    automationId: v.string(),
    name: v.string(),
    task: v.string(),
    integrations: v.array(v.string()),
    schedule: v.string(),
    // IANA timezone the cron expression is evaluated in. Stored at create
    // time so changing the user's global timezone later doesn't shift
    // existing automations. Optional for backwards compatibility — pre-TZ
    // automations fall back to the user's current setting at run time.
    timezone: v.optional(v.string()),
    enabled: v.boolean(),
    conversationId: v.optional(v.string()),
    notifyConversationId: v.optional(v.string()),
    lastRunAt: v.optional(v.number()),
    nextRunAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_automation_id", ["automationId"])
    .index("by_enabled", ["enabled"]),

  sendblueDedup: defineTable({
    handle: v.string(),
    claimedAt: v.number(),
  }).index("by_handle", ["handle"]),

  drafts: defineTable({
    draftId: v.string(),
    conversationId: v.string(),
    kind: v.string(),
    summary: v.string(),
    payload: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("rejected"),
      v.literal("expired"),
    ),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
  })
    .index("by_draft_id", ["draftId"])
    .index("by_conversation_status", ["conversationId", "status"]),

  consolidationRuns: defineTable({
    runId: v.string(),
    trigger: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    proposalsCount: v.number(),
    mergedCount: v.number(),
    prunedCount: v.number(),
    notes: v.optional(v.string()),
    // JSON blob: { proposals: [...], decisions: [...], applied: [...] }
    // Captured so you can inspect the reasoning for any historical run.
    details: v.optional(v.string()),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_run_id", ["runId"])
    .index("by_status", ["status"]),

  // Runtime overrides for things normally pinned by env vars (e.g. the Claude
  // model). Lets the user say "use opus" via iMessage and have the next agent
  // run respect it without a redeploy.
  settings: defineTable({
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  automationRuns: defineTable({
    runId: v.string(),
    automationId: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    agentId: v.optional(v.string()),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_automation", ["automationId"])
    .index("by_run_id", ["runId"]),

  // Phase 8: morning-scan candidate pool (per-item scoring against the brain).
  scanCandidates: defineTable({
    candidateId: v.string(),
    scanRunId: v.string(),
    source: v.string(),
    title: v.string(),
    url: v.string(),
    pubDate: v.optional(v.string()),
    excerpt: v.optional(v.string()),
    score: v.number(),
    scoreReasons: v.array(v.string()),
    competesWith: v.optional(v.array(v.string())),
    status: v.union(
      v.literal("pending"),
      v.literal("nominated"),
      v.literal("surfaced"),
      v.literal("dropped"),
      v.literal("competes"),
    ),
    scannedAt: v.number(),
    surfacedAt: v.optional(v.number()),
  })
    .index("by_candidate_id", ["candidateId"])
    .index("by_scan_run", ["scanRunId"])
    .index("by_status", ["status"])
    .index("by_score", ["score"]),

  // Phase 8: per-day per-source cost tracking for budget enforcement.
  dailyScanCost: defineTable({
    date: v.string(), // YYYY-MM-DD in the user's local timezone
    source: v.string(),
    totalUsd: v.number(),
    scansAttempted: v.number(),
    scansSucceeded: v.number(),
    hitBudgetCap: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_date_source", ["date", "source"])
    .index("by_date", ["date"]),

  // Phase 9: observation log. Activity Chief observes about Charlie (git
  // commits, competes-flags from the morning scan, later: self-report
  // answers). Distinct from memoryRecords so raw activity doesn't pollute
  // recall(); the recall_activity tool reads this table directly.
  observations: defineTable({
    observationId: v.string(),
    kind: v.union(
      v.literal("git-commit"),
      v.literal("competes-flag"),
      v.literal("self-report"),
      v.literal("linear-ticket"),
      v.literal("github-issue"),
      v.literal("github-pr"),
      v.literal("github-release"),
      v.literal("github-push"),
      v.literal("job-posting"),
    ),
    source: v.string(), // repo name, "morning-scan", etc.
    summary: v.string(),
    detail: v.optional(v.string()),
    observedAt: v.number(), // when the activity happened (commit date, etc.)
    recordedAt: v.number(), // when Chief recorded it
    // Idempotency key so a re-running observer doesn't double-record. e.g.
    // "git:Arca:<sha>" or "competes:<candidateId>".
    dedupKey: v.string(),
  })
    .index("by_observation_id", ["observationId"])
    .index("by_kind", ["kind"])
    .index("by_dedup_key", ["dedupKey"])
    .index("by_observed_at", ["observedAt"]),

  // Phase 8: audit log of every scan + surface run. `formattedCheckIn` on the
  // scan record is the pre-rendered Socratic check-in body that the 7am
  // surface job retrieves and sends. Empty (or missing) when nothing crossed
  // the signal threshold.
  scanRuns: defineTable({
    runId: v.string(),
    kind: v.union(v.literal("scan"), v.literal("surface")),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    sources: v.optional(v.array(v.string())),
    itemsScanned: v.optional(v.number()),
    itemsScored: v.optional(v.number()),
    itemsNominated: v.optional(v.number()),
    totalCostUsd: v.optional(v.number()),
    elapsedMs: v.optional(v.number()),
    error: v.optional(v.string()),
    formattedCheckIn: v.optional(v.string()),
    surfaceLog: v.optional(v.string()),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_run_id", ["runId"])
    .index("by_kind_status", ["kind", "status"])
    .index("by_started_at", ["startedAt"]),

  // Stage A draft-and-ask action layer. A local-write action Chief has
  // drafted and shown over iMessage, awaiting the user's explicit in-thread
  // confirm. `pitch` is the benefit case the user saw; `entry` is the exact
  // bytes appended to Skills.md on confirm (held in limbo so the commit never
  // re-drafts). Only one action is active per conversation at a time.
  pendingActions: defineTable({
    actionId: v.string(),
    conversationId: v.string(),
    kind: v.union(
      v.literal("skills.append"),
      v.literal("youtube.brainstorm"),
      v.literal("reminder.add"),
      v.literal("job.draft_application"),
    ),
    status: v.union(
      v.literal("pending"),
      v.literal("committed"),
      v.literal("rejected"),
      v.literal("expired"),
    ),
    pitch: v.string(),
    entry: v.string(),
    targetFile: v.string(),
    sha256: v.string(),
    // Stage B: links this draft back to the skillCandidate it came from, so the
    // consent gate can mark that candidate skilled/declined on the outcome.
    candidateId: v.optional(v.string()),
    // YouTube heavy stage: the video a "youtube.brainstorm" gate is waiting on.
    videoId: v.optional(v.string()),
    shownAt: v.optional(v.number()),
    decidedAt: v.optional(v.number()),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_action_id", ["actionId"])
    .index("by_conversation_status", ["conversationId", "status"]),

  // Stage B: observation-driven Skills.md candidates. Patterns the detector
  // found in git activity, collected and surfaced on a weekly digest, then fed
  // into the Stage A draft-and-ask flow on the user's pick. patternKey is the
  // stable dedup/suppression handle: a declined or skilled pattern is never
  // re-proposed.
  skillCandidates: defineTable({
    candidateId: v.string(),
    patternKey: v.string(),
    title: v.string(),
    rationale: v.string(),
    evidence: v.string(), // JSON: term, count, days, repos, sample commit summaries
    status: v.union(
      v.literal("collected"),
      v.literal("surfaced"),
      v.literal("drafting"),
      v.literal("skilled"),
      v.literal("declined"),
    ),
    occurrences: v.number(),
    surfaceOrder: v.optional(v.number()),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
    surfacedAt: v.optional(v.number()),
    decidedAt: v.optional(v.number()),
  })
    .index("by_candidate_id", ["candidateId"])
    .index("by_pattern_key", ["patternKey"])
    .index("by_status", ["status"]),

  // YouTube passive stage: the held pool. Every scored video lands here and
  // ages out after a retention window. videoId is the dedupe key, so the same
  // video is never re-scored.
  youtubeVideos: defineTable({
    videoId: v.string(),
    title: v.string(),
    description: v.string(),
    channelId: v.string(),
    channelTitle: v.string(),
    url: v.string(),
    publishedAt: v.string(),
    source: v.string(), // "topic:<t>" | "channel:<name>"
    isMustWatch: v.boolean(),
    score: v.number(),
    scoreReasons: v.array(v.string()),
    status: v.union(
      v.literal("held"),
      v.literal("surfaced"),
      v.literal("picked"),
      v.literal("aged-out"),
    ),
    scoredAt: v.number(),
    expiresAt: v.number(),
    surfacedAt: v.optional(v.number()),
    pickedAt: v.optional(v.number()),
  })
    .index("by_video_id", ["videoId"])
    .index("by_status", ["status"])
    .index("by_expires_at", ["expiresAt"]),

  // YouTube passive stage: curated discovery inputs. topics drive Data API
  // searches; channels are must-watch creators pulled via free RSS.
  youtubeSources: defineTable({
    kind: v.union(v.literal("topic"), v.literal("channel")),
    value: v.string(), // topic text, or channel display name
    channelId: v.optional(v.string()),
    feedUrl: v.optional(v.string()),
    enabled: v.boolean(),
    addedAt: v.number(),
  }).index("by_kind", ["kind"]),

  // YouTube heavy stage: per-video analysis (transcript + auto summary). Held
  // here, not in per-turn context; loaded only when a brainstorm runs.
  youtubeAnalysis: defineTable({
    videoId: v.string(),
    title: v.string(),
    channelTitle: v.string(),
    url: v.string(),
    transcriptStatus: v.union(v.literal("full"), v.literal("partial"), v.literal("none")),
    transcript: v.string(),
    summary: v.string(),
    confidence: v.union(v.literal("high"), v.literal("low")),
    createdAt: v.number(),
  }).index("by_video_id", ["videoId"]),

  // Proactive engagement: per-day ration counter + mute flag. One row per local
  // date. count is the number of self-initiated pings sent today (the 7am
  // briefing does NOT touch this). muted pauses self-initiation for the day and
  // resets automatically because tomorrow gets a fresh row.
  proactiveDaily: defineTable({
    date: v.string(), // YYYY-MM-DD in the user's local timezone
    count: v.number(),
    muted: v.boolean(),
    updatedAt: v.number(),
  }).index("by_date", ["date"]),

  // Proactive engagement: anti-nag dedupe. A row is written on SEND (not on
  // reply), keyed by the observation's dedupKey, so an already-surfaced
  // observation (or an ignored reflective question) never re-fires.
  proactiveSurfaced: defineTable({
    dedupKey: v.string(),
    date: v.string(),
    surfacedAt: v.number(),
  }).index("by_dedup_key", ["dedupKey"]),

  // Habit tracker — Phase 1. Behavioral habits only: the closed metric union
  // on `source` (derived from HABIT_METRIC_KEYS) admits only water as an intake
  // metric — no weight/calorie member — so those habits cannot be written.
  // `source` is a discriminated
  // union — manual habits carry no metric; oura-auto / healthkit-auto carry a
  // metric + comparator + threshold (threshold is in the metric's own unit;
  // wake_time is minutes past local midnight). weeklyTarget applies only when
  // goalPeriod is "weekly". archivedAt soft-deletes without losing history.
  habits: defineTable({
    name: v.string(),
    icon: v.string(),
    goalPeriod: goalPeriodValidator,
    weeklyTarget: v.optional(v.number()),
    source: habitSourceValidator,
    archivedAt: v.optional(v.number()),
    createdAt: v.number(),
    // User-arranged order on the tracker. Optional: a habit with no sortOrder
    // (never reordered, or created after the last reorder) sorts after placed
    // ones by createdAt. A reorder assigns 0..n across all active habits.
    sortOrder: v.optional(v.number()),
  }).index("by_archived", ["archivedAt"]),

  // One row per habit per day. `status` is the three-state enum from
  // streak.ts: "completed" | "missed" | "unknown". The not-synced invariant
  // lives here — a not-yet-reported auto metric is "unknown" with no `value`
  // and no `resolvedAt`; a reported failure is "missed" and ALWAYS carries
  // `resolvedAt` as evidence. `value` is auto-only: for auto sources a miss
  // also carries the metric reading; a manual miss has no value — its
  // evidence is the user's explicit answer. A missing row is treated as "unknown"
  // by the streak walker, so absence is never a miss. `date` is the local
  // calendar day "YYYY-MM-DD"; `value` is the metric reading for auto sources
  // (e.g. minutes-past-midnight for wake_time).
  habitLog: defineTable({
    habitId: v.id("habits"),
    date: v.string(),
    status: habitStatusValidator,
    value: v.optional(v.number()),
    resolvedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_habit_and_date", ["habitId", "date"])
    .index("by_date", ["date"]),
});
