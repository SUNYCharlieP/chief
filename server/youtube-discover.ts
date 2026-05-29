import { Cron } from "croner";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { loadBrain, getBrainBlock } from "./brain.js";
import { getRuntimeConfig } from "./runtime-config.js";
import { runAgentRuntime } from "./runtimes/index.js";
import { getUserTimezone } from "./timezone-config.js";
import {
  searchTopic,
  fetchFullDescriptions,
  fetchChannelVideos,
  resolveChannelId,
  channelFeedUrl,
  hasApiKey,
  QuotaError,
  type VideoCandidate,
} from "./integrations/youtube.js";

// YouTube passive discovery: once-daily watch -> score (Haiku, title+desc) ->
// hold. Topic-search via Data API (quota-bounded); must-watch channels via free
// RSS, always pooled and flagged. No transcripts, no dispatcher.

const HOLD_DAYS = Number(process.env.YOUTUBE_HOLD_DAYS ?? 3);
const TOPIC_CAP = Number(process.env.YOUTUBE_TOPIC_CAP ?? 10);
const LOOKBACK_DAYS = Number(process.env.YOUTUBE_DISCOVER_LOOKBACK_DAYS ?? 2);
const DISCOVER_CRON = process.env.YOUTUBE_DISCOVER_CRON ?? "0 4 * * *"; // 4am daily
const HAIKU_MODEL = process.env.CHIEF_SCAN_MODEL ?? "claude-haiku-4-5-20251001";

let discoverCron: Cron | null = null;

interface PooledCandidate extends VideoCandidate {
  isMustWatch: boolean;
  source: string;
}

interface ScoredItem {
  index: number;
  score: number;
  reasons: string[];
}

const SCORING_SYSTEM =
  "You score candidate YouTube videos against Charlie's interest profile for a high-signal watch queue. Return STRICT JSON only, no prose.";

function buildScoringPrompt(brain: string, topics: string[], items: PooledCandidate[]): string {
  return `# CHARLIE'S PROFILE (brain + tracked topics)

${brain}

Tracked topics he asked to follow: ${topics.length ? topics.join(", ") : "(none configured)"}

# RUBRIC
Score each video 0-100 on how worth Charlie's time it is RIGHT NOW given his profile, judging from title + description + channel ONLY.
- 85-100: directly hits an active interest/stack item, concrete and substantive, not fluff.
- 60-84: relevant and interesting but not a must-watch.
- 40-59: tangential.
- 0-39: noise, clickbait, off-topic, or too shallow.
Bias toward HIGH SIGNAL. Be skeptical of hype titles with thin descriptions. reasons = 1-3 short strings naming what matched or why it's weak.

Return JSON: {"scored":[{"index":0,"score":85,"reasons":["..."]}]}

# VIDEOS
${items
  .map(
    (it, i) =>
      `[${i}] channel=${JSON.stringify(it.channelTitle)} mustWatch=${it.isMustWatch}\n  title=${JSON.stringify(it.title)}\n  description=${JSON.stringify((it.description || "").slice(0, 600))}`,
  )
  .join("\n\n")}`;
}

function parseScoringJson(text: string): ScoredItem[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as { scored?: ScoredItem[] };
    return Array.isArray(parsed.scored) ? parsed.scored : [];
  } catch {
    return [];
  }
}

export interface DiscoverReport {
  apiKeyPresent: boolean;
  topics: string[];
  channels: string[];
  candidatesGathered: number;
  newAfterDedupe: number;
  scored: number;
  held: number;
  quotaHit: boolean;
  errors: string[];
}

async function gatherFromSources(report: DiscoverReport): Promise<PooledCandidate[]> {
  const sources = await convex.query(api.youtubeSources.list, {});
  const topics = sources.filter((s) => s.kind === "topic" && s.enabled).map((s) => s.value);
  const channels = sources.filter((s) => s.kind === "channel" && s.enabled);
  report.topics = topics;
  report.channels = channels.map((c) => c.value);

  const out: PooledCandidate[] = [];
  const sinceIso = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();

  // Topic search (Data API, quota-bounded).
  if (topics.length && hasApiKey()) {
    for (const topic of topics) {
      try {
        const found = await searchTopic(topic, sinceIso, TOPIC_CAP);
        for (const f of found) out.push({ ...f, isMustWatch: false, source: `topic:${topic}` });
      } catch (err) {
        if (err instanceof QuotaError) {
          report.quotaHit = true;
          report.errors.push(`quota hit on topic "${topic}"; stopping topic-search`);
          break;
        }
        report.errors.push(`topic "${topic}": ${String(err)}`);
      }
    }
    // Backfill full descriptions for topic candidates (search snippets truncate).
    try {
      const ids = out.filter((c) => !c.isMustWatch).map((c) => c.videoId);
      if (ids.length) {
        const full = await fetchFullDescriptions(ids);
        for (const c of out) {
          const d = full.get(c.videoId);
          if (d) c.description = d;
        }
      }
    } catch (err) {
      report.errors.push(`description backfill: ${String(err)}`);
    }
  } else if (topics.length) {
    report.errors.push("topics configured but YOUTUBE_API_KEY not set; skipping topic-search");
  }

  // Must-watch channels (free RSS).
  for (const ch of channels) {
    if (!ch.channelId) {
      report.errors.push(`channel "${ch.value}" has no channelId; skipping`);
      continue;
    }
    try {
      const vids = await fetchChannelVideos(ch.channelId, ch.value);
      for (const v of vids) out.push({ ...v, isMustWatch: true, source: `channel:${ch.value}` });
    } catch (err) {
      report.errors.push(`channel "${ch.value}": ${String(err)}`);
    }
  }
  return out;
}

export async function runYoutubeDiscover(
  injected?: PooledCandidate[],
): Promise<DiscoverReport> {
  const report: DiscoverReport = {
    apiKeyPresent: hasApiKey(),
    topics: [],
    channels: [],
    candidatesGathered: 0,
    newAfterDedupe: 0,
    scored: 0,
    held: 0,
    quotaHit: false,
    errors: [],
  };

  await convex.mutation(api.youtubeVideos.sweepExpired, {});

  const gathered = injected ?? (await gatherFromSources(report));
  report.candidatesGathered = gathered.length;
  if (gathered.length === 0) return report;

  // Dedupe by videoId so nothing is re-scored.
  const known = new Set(
    await convex.query(api.youtubeVideos.knownIds, {
      videoIds: gathered.map((c) => c.videoId),
    }),
  );
  // Also dedupe within this batch (same video from two topics).
  const seen = new Set<string>();
  const fresh = gathered.filter((c) => {
    if (known.has(c.videoId) || seen.has(c.videoId)) return false;
    seen.add(c.videoId);
    return true;
  });
  report.newAfterDedupe = fresh.length;
  if (fresh.length === 0) return report;

  // Batched Haiku scoring on title + description.
  await loadBrain();
  const brain = getBrainBlock();
  const runtimeConfig = await getRuntimeConfig();
  const callConfig = { ...runtimeConfig, model: HAIKU_MODEL };
  const result = await runAgentRuntime(callConfig, {
    prompt: buildScoringPrompt(brain, report.topics, fresh),
    systemPrompt: SCORING_SYSTEM,
    tools: [],
    mode: "background",
  });
  const scored = parseScoringJson(result.text);
  report.scored = scored.length;
  const scoreByIndex = new Map(scored.map((s) => [s.index, s]));

  const expiresAt = Date.now() + HOLD_DAYS * 86400000;
  for (let i = 0; i < fresh.length; i++) {
    const c = fresh[i];
    const s = scoreByIndex.get(i);
    const score = s ? Number(s.score) || 0 : 0;
    const reasons = s && Array.isArray(s.reasons) ? s.reasons.slice(0, 3) : [];
    const res = await convex.mutation(api.youtubeVideos.insertIfNew, {
      videoId: c.videoId,
      title: c.title,
      description: c.description ?? "",
      channelId: c.channelId,
      channelTitle: c.channelTitle,
      url: c.url,
      publishedAt: c.publishedAt,
      source: c.source,
      isMustWatch: c.isMustWatch,
      score,
      scoreReasons: reasons,
      expiresAt,
    });
    if (res.created) report.held += 1;
  }
  return report;
}

export async function startYoutubeDiscover(): Promise<void> {
  if (discoverCron) {
    console.warn("[youtube-discover] already started");
    return;
  }
  const timezone = (await getUserTimezone()) ?? "UTC";
  discoverCron = new Cron(DISCOVER_CRON, { timezone }, async () => {
    try {
      const r = await runYoutubeDiscover();
      console.log(
        `[youtube-discover] tick: gathered=${r.candidatesGathered} new=${r.newAfterDedupe} held=${r.held} quotaHit=${r.quotaHit}`,
      );
    } catch (err) {
      console.error("[youtube-discover] tick error", err);
    }
  });
  console.log(`[youtube-discover] scheduled: cron=${DISCOVER_CRON} tz=${timezone}`);
}

export function stopYoutubeDiscover(): void {
  if (discoverCron) {
    discoverCron.stop();
    discoverCron = null;
  }
}

// One-time seed of the source lists from env, only if none exist yet. Topics
// from YOUTUBE_TOPICS (comma-separated), channels from YOUTUBE_CHANNELS
// (comma-separated URLs/@handles, resolved to channel ids).
export async function seedYoutubeSourcesFromEnv(): Promise<void> {
  const existing = await convex.query(api.youtubeSources.list, {});
  if (existing.length > 0) return;
  const topics = (process.env.YOUTUBE_TOPICS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const t of topics) await convex.mutation(api.youtubeSources.add, { kind: "topic", value: t });
  const channels = (process.env.YOUTUBE_CHANNELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const c of channels) {
    try {
      const id = await resolveChannelId(c);
      if (id) {
        await convex.mutation(api.youtubeSources.add, {
          kind: "channel",
          value: c,
          channelId: id,
          feedUrl: channelFeedUrl(id),
        });
      } else {
        console.warn(`[youtube] could not resolve channel id for "${c}"`);
      }
    } catch (err) {
      console.warn(`[youtube] seed channel "${c}" failed: ${String(err)}`);
    }
  }
  if (topics.length || channels.length) {
    console.log(`[youtube] seeded ${topics.length} topics, ${channels.length} channels from env`);
  }
}

// Exposed so the test endpoint can inject fake candidates without the Data API.
export type { PooledCandidate };
