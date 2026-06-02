import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { loadBrain, getBrainBlock } from "./brain.js";
import { getRuntimeConfig } from "./runtime-config.js";
import { runAgentRuntime } from "./runtimes/index.js";
import { fetchVideoData } from "./integrations/youtube-transcript.js";

// YouTube heavy stage core: pick -> transcript -> summary (auto, cheap) ->
// [gate] -> brainstorm. The gate lives in the consent layer; this module does
// the analysis and the brainstorm opening.

const HAIKU_MODEL = process.env.CHIEF_SCAN_MODEL ?? "claude-haiku-4-5-20251001";
const BRAINSTORM_TTL_MS = 30 * 60 * 1000;
const TRANSCRIPT_SUMMARY_CHARS = 12000;
const TRANSCRIPT_BRAINSTORM_CHARS = 8000;

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function extractVideoId(ref: string): string | null {
  const m = ref.match(/(?:v=|youtu\.be\/|\/watch\/|embed\/|shorts\/)([\w-]{11})/);
  if (m) return m[1];
  if (/^[\w-]{11}$/.test(ref.trim())) return ref.trim();
  return null;
}

interface ResolvedVideo {
  videoId: string;
  url: string;
  title: string;
  channelTitle: string;
}

async function resolveVideo(ref: string): Promise<ResolvedVideo | null> {
  const id = extractVideoId(ref);
  if (id) {
    const row = await convex.query(api.youtubeVideos.get, { videoId: id });
    return {
      videoId: id,
      url: row?.url ?? `https://www.youtube.com/watch?v=${id}`,
      title: row?.title ?? "",
      channelTitle: row?.channelTitle ?? "",
    };
  }
  // "that video" / empty -> the most recently surfaced pooled video.
  const pool = await convex.query(api.youtubeVideos.listForPull, { limit: 25 });
  const surfaced = pool
    .filter((v) => v.surfacedAt)
    .sort((a, b) => (b.surfacedAt ?? 0) - (a.surfacedAt ?? 0));
  const pick = surfaced[0] ?? pool[0];
  if (!pick) return null;
  return {
    videoId: pick.videoId,
    url: pick.url,
    title: pick.title,
    channelTitle: pick.channelTitle,
  };
}

async function summarize(
  title: string,
  source: string,
  hasTranscript: boolean,
): Promise<string> {
  const runtimeConfig = await getRuntimeConfig();
  const callConfig = { ...runtimeConfig, model: HAIKU_MODEL };
  const prompt = hasTranscript
    ? `Summarize what this YouTube video actually covers, for Charlie's watch queue.\nTitle: ${title}\n\nTRANSCRIPT (auto-captions):\n${source}\n\nWrite 4-6 sentences on what it covers and the concrete techniques shown. Do not invent specifics that are not in the transcript.`
    : `No transcript was available for this video. Using ONLY the description/chapters below, give a LOW-CONFIDENCE summary of what it is probably about.\nTitle: ${title}\n\nDESCRIPTION/CHAPTERS:\n${source || "(none)"}\n\nBegin the summary with exactly "[low confidence, no transcript]". Be brief and do NOT invent what the video demonstrates; you only have the description.`;
  const result = await runAgentRuntime(callConfig, {
    prompt,
    systemPrompt: "You summarize concisely and honestly. Never fabricate. Never use information beyond what is provided.",
    tools: [],
    mode: "background",
  });
  return result.text.trim();
}

export interface AnalyzeResult {
  error?: string;
  videoId?: string;
  title?: string;
  transcriptStatus?: "full" | "partial" | "none";
  confidence?: "high" | "low";
  summary?: string;
}

export async function analyzeVideo(conversationId: string, ref: string): Promise<AnalyzeResult> {
  const v = await resolveVideo(ref);
  if (!v) return { error: "No video to analyze (no pool video surfaced, and no id/URL given)." };

  let data: Awaited<ReturnType<typeof fetchVideoData>> | null = null;
  try {
    data = await fetchVideoData(v.url);
  } catch {
    data = null; // yt-dlp unavailable or failed -> fall back to pool metadata
  }

  const title = data?.title || v.title || v.videoId;
  // Prefer the channel yt-dlp reports (covers pasted URLs that were never in the
  // discover pool, where v.channelTitle is empty); fall back to the pool row.
  const channelTitle = data?.channel || v.channelTitle || "";
  let transcriptStatus: "full" | "partial" | "none";
  let transcript = "";
  let confidence: "high" | "low";
  let source: string;
  let hasTranscript: boolean;

  if (data && data.transcriptStatus === "full") {
    transcriptStatus = "full";
    transcript = data.transcript;
    confidence = "high";
    source = transcript.slice(0, TRANSCRIPT_SUMMARY_CHARS);
    hasTranscript = true;
  } else {
    // Honest fallback: description + chapters, labeled. Never fabricate.
    confidence = "low";
    hasTranscript = false;
    const desc = data?.description ?? "";
    const chapters = data?.chapters?.length ? `\nChapters: ${data.chapters.join("; ")}` : "";
    source = `${desc}${chapters}`.slice(0, 4000);
    transcriptStatus = source.trim() ? "partial" : "none";
  }

  const summary = await summarize(title, source, hasTranscript);

  await convex.mutation(api.youtubeAnalysis.upsert, {
    videoId: v.videoId,
    title,
    channelTitle,
    url: v.url,
    transcriptStatus,
    transcript,
    summary,
    confidence,
  });

  // Mark the pool row picked (no-op if the URL wasn't in the pool).
  await convex.mutation(api.youtubeVideos.setStatus, {
    videoId: v.videoId,
    status: "picked",
    pickedAt: Date.now(),
  });

  // Gate: a youtube.brainstorm pending action; brainstorm only runs on yes.
  const now = Date.now();
  await convex.mutation(api.pendingActions.create, {
    actionId: randomId("pa"),
    conversationId,
    kind: "youtube.brainstorm",
    pitch: "",
    entry: "",
    targetFile: "",
    sha256: "",
    videoId: v.videoId,
    createdAt: now,
    expiresAt: now + BRAINSTORM_TTL_MS,
  });

  return { videoId: v.videoId, title, transcriptStatus, confidence, summary };
}

// Run by the consent gate when Charlie says yes. Reasons ONLY from the stored
// transcript/summary + brain; no tools, so it cannot spawn research.
export async function runBrainstormOpening(videoId: string): Promise<string> {
  const a = await convex.query(api.youtubeAnalysis.get, { videoId });
  if (!a) return "I don't have an analysis for that video anymore. Re-pick it and I'll fetch it again.";
  await loadBrain();
  const brain = getBrainBlock();
  const runtimeConfig = await getRuntimeConfig(); // Sonnet floor, no silent Opus
  const material =
    a.transcriptStatus === "full"
      ? `Transcript excerpt:\n${a.transcript.slice(0, TRANSCRIPT_BRAINSTORM_CHARS)}`
      : "(No transcript was available; reason only from the summary above and stay explicitly tentative.)";
  const prompt = `${brain}\n\n# VIDEO\nTitle: ${a.title} (${a.channelTitle})\nTranscript confidence: ${a.confidence}\nSummary: ${a.summary}\n${material}\n\nBrainstorm Socratically how the technique in this video could fit Charlie's actual stack and active work (Context.md). Open with ONE concrete finding, then 2-3 sharp questions that tie it to his real projects. Reason ONLY from the material above and the brain; do NOT invent facts and do NOT suggest external research. If transcript confidence is low, keep it tentative and say so.`;
  const result = await runAgentRuntime(runtimeConfig, {
    prompt,
    systemPrompt:
      "You are Chief, brainstorming with Charlie about a video. Socratic, grounded in his brain, no fabrication, no research. Terse, no em dashes, no padding.",
    tools: [],
    mode: "background",
  });
  return result.text.trim();
}
