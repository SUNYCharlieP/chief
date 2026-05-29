// YouTube access for the passive stage.
//   - Topic search: Data API search.list (100 quota units) + videos.list
//     (1 unit) for full descriptions. Needs YOUTUBE_API_KEY (simple key).
//   - Must-watch channels: free RSS (youtube.com/feeds/videos.xml), no key,
//     no quota.
// On quota exhaustion search.list returns HTTP 403 quotaExceeded; we surface
// that as QuotaError so the caller can skip topic-search for the day while
// RSS and the held pool keep working.

const API_BASE = "https://www.googleapis.com/youtube/v3";
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "Chief/0.1 (personal chief-of-staff bot)";

export class QuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaError";
  }
}

export interface VideoCandidate {
  videoId: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  url: string;
}

function apiKey(): string {
  const k = process.env.YOUTUBE_API_KEY?.trim();
  if (!k) throw new Error("YOUTUBE_API_KEY not set");
  return k;
}

export function hasApiKey(): boolean {
  return Boolean(process.env.YOUTUBE_API_KEY?.trim());
}

async function apiGet(path: string, params: Record<string, string>): Promise<unknown> {
  const qs = new URLSearchParams({ ...params, key: apiKey() }).toString();
  const res = await fetch(`${API_BASE}/${path}?${qs}`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 403) {
    const body = await res.text();
    if (/quota/i.test(body)) throw new QuotaError(`YouTube quota exceeded: ${body.slice(0, 200)}`);
    throw new Error(`YouTube 403: ${body.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`YouTube ${path} HTTP ${res.status}`);
  return res.json();
}

// search.list for one topic, newest first, published after `since` (ISO).
export async function searchTopic(
  topic: string,
  sinceIso: string,
  max: number,
): Promise<VideoCandidate[]> {
  const data = (await apiGet("search", {
    part: "snippet",
    q: topic,
    type: "video",
    order: "date",
    publishedAfter: sinceIso,
    maxResults: String(Math.min(max, 50)),
  })) as { items?: Array<{ id?: { videoId?: string }; snippet?: Record<string, string> }> };
  const out: VideoCandidate[] = [];
  for (const it of data.items ?? []) {
    const videoId = it.id?.videoId;
    if (!videoId) continue;
    const s = it.snippet ?? {};
    out.push({
      videoId,
      title: s.title ?? "",
      description: s.description ?? "",
      channelId: s.channelId ?? "",
      channelTitle: s.channelTitle ?? "",
      publishedAt: s.publishedAt ?? "",
      url: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }
  return out;
}

// videos.list to backfill full descriptions (search snippets are truncated).
export async function fetchFullDescriptions(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const data = (await apiGet("videos", {
      part: "snippet",
      id: batch.join(","),
    })) as { items?: Array<{ id?: string; snippet?: { description?: string } }> };
    for (const it of data.items ?? []) {
      if (it.id) map.set(it.id, it.snippet?.description ?? "");
    }
  }
  return map;
}

// Resolve a channel URL/handle to a channelId. Direct extraction from a
// /channel/UC... URL needs no API; @handle resolution uses channels.list.
export async function resolveChannelId(input: string): Promise<string | null> {
  const m = input.match(/\/channel\/(UC[\w-]+)/);
  if (m) return m[1];
  if (/^UC[\w-]{20,}$/.test(input.trim())) return input.trim();
  const handleMatch = input.match(/@([\w.-]+)/);
  const handle = handleMatch ? handleMatch[1] : null;
  if (!handle || !hasApiKey()) return null;
  const data = (await apiGet("channels", {
    part: "id",
    forHandle: handle,
  })) as { items?: Array<{ id?: string }> };
  return data.items?.[0]?.id ?? null;
}

export function channelFeedUrl(channelId: string): string {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

// Parse a channel's RSS feed into candidates. Free, no key. Manual extraction
// is more predictable than rss-parser for the yt:/media: namespaces.
export async function fetchChannelVideos(
  channelId: string,
  channelLabel: string,
): Promise<VideoCandidate[]> {
  const res = await fetch(channelFeedUrl(channelId), {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`channel RSS HTTP ${res.status}`);
  const xml = await res.text();
  const out: VideoCandidate[] = [];
  const entries = xml.split(/<entry>/).slice(1);
  const channelTitle = xml.match(/<title>([^<]*)<\/title>/)?.[1] ?? channelLabel;
  for (const e of entries) {
    const videoId = e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    if (!videoId) continue;
    const title = decodeXml(e.match(/<media:title>([\s\S]*?)<\/media:title>/)?.[1] ?? e.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
    const description = decodeXml(e.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1] ?? "");
    const publishedAt = e.match(/<published>([^<]+)<\/published>/)?.[1] ?? "";
    out.push({
      videoId,
      title,
      description,
      channelId,
      channelTitle,
      publishedAt,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
