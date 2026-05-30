import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";

// Proactive tier: at most ONE line folded into the 7am check-in, only when the
// day's top held video clears a solid bar. Must-watch uploads do NOT auto-clear
// — they must meet their own (optionally lower) threshold. Most days: null.

const PROACTIVE_THRESHOLD = Number(process.env.YOUTUBE_PROACTIVE_THRESHOLD ?? 85);
const MUSTWATCH_PROACTIVE_THRESHOLD = Number(
  process.env.YOUTUBE_MUSTWATCH_PROACTIVE_THRESHOLD ?? 85,
);

function clears(v: { isMustWatch: boolean; score: number }): boolean {
  return v.isMustWatch
    ? v.score >= MUSTWATCH_PROACTIVE_THRESHOLD
    : v.score >= PROACTIVE_THRESHOLD;
}

// Returns the line PLUS the videoId so the caller can commit "surfaced" only
// after the message is confirmed sent (separating pick from commit avoids
// marking a video surfaced on a send that never went out).
export async function pickProactiveYoutubeLine(): Promise<{ line: string; videoId: string } | null> {
  const held = await convex.query(api.youtubeVideos.listHeld, { limit: 25 });
  // listHeld is already ranked must-watch-first then score desc.
  const top = held.find(clears);
  if (!top) return null;
  const reason = top.scoreReasons[0] ? ` ${top.scoreReasons[0]}.` : "";
  const line = `Worth a watch: ${top.title} (${top.channelTitle}).${reason} ${top.url}`;
  return { line, videoId: top.videoId };
}

// Mark a proactively-surfaced video as surfaced. Call ONLY after a confirmed send.
export async function commitYoutubeSurfaced(videoId: string): Promise<void> {
  await convex.mutation(api.youtubeVideos.setStatus, {
    videoId,
    status: "surfaced",
    surfacedAt: Date.now(),
  });
}
