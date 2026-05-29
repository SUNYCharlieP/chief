import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "./runtimes/types.js";
import { resolveChannelId, channelFeedUrl } from "./integrations/youtube.js";
import { analyzeVideo } from "./youtube-analyze.js";

const PULL_THRESHOLD = Number(process.env.YOUTUBE_PULL_THRESHOLD ?? 58);

export function createYoutubeTools(conversationId: string): RuntimeTool[] {
  return [
    defineRuntimeTool(
      "boop-youtube",
      "youtube_pull",
      'Read the held YouTube pool when Charlie asks "anything good today?", "anything worth watching", "youtube?", etc. Returns held, unexpired videos worth surfacing (must-watch uploads always included; others above the relevance bar), ranked best-first with scores and reasons. Discuss them: name the few worth a look and the one you would start with and why. Do NOT just dump the list.',
      {},
      async () => {
        const held = await convex.query(api.youtubeVideos.listForPull, { limit: 25 });
        const items = held
          .filter((v) => v.isMustWatch || v.score >= PULL_THRESHOLD)
          .map((v) => ({
            videoId: v.videoId,
            title: v.title,
            channel: v.channelTitle,
            url: v.url,
            score: v.score,
            mustWatch: v.isMustWatch,
            reasons: v.scoreReasons,
            source: v.source,
          }));
        if (items.length === 0) {
          return runtimeText(
            JSON.stringify({ count: 0, note: "Nothing in the pool worth surfacing right now." }),
          );
        }
        return runtimeText(JSON.stringify({ count: items.length, items }, null, 2));
      },
    ),
    defineRuntimeTool(
      "boop-youtube",
      "analyze_youtube_video",
      `THE tool for any reference to a YouTube video Chief surfaced or holds, or a pasted YouTube link. Use it for ALL of: "that video", "the video you suggested", "pull up that video", "go deeper on it", "brainstorm on that video", "analyze this video", "tell me about that video", or any youtube.com / youtu.be URL. It picks the video, fetches its transcript (yt-dlp), and returns an honest summary (flagged low-confidence when there are no captions), then gates a deeper brainstorm behind Charlie's explicit yes. This is the correct, structural choice for a video Chief surfaced or a YouTube URL. NEVER use spawn_agent for those, spawn_agent is for external web/integration research only.`,
      {
        video: z
          .string()
          .optional()
          .describe('A videoId, a YouTube URL, or omit (or "that") for the most recently surfaced video.'),
      },
      async ({ video }) => {
        const r = await analyzeVideo(conversationId, video ?? "");
        if (r.error) return runtimeText(r.error, false);
        return runtimeText(
          `Analyzed "${r.title}". transcript=${r.transcriptStatus} confidence=${r.confidence}.\n\nSUMMARY:\n${r.summary}\n\nRelay this summary to Charlie verbatim-ish, then end your reply with exactly:\nReply "yes" to brainstorm how this fits your stack (anything else skips).`,
        );
      },
    ),
    defineRuntimeTool(
      "boop-youtube",
      "youtube_config",
      'Manage Charlie\'s YouTube discovery inputs. action="list" shows topics + channels. "add_topic"/"remove_topic" take a topic string. "add_channel" takes a channel URL or @handle (resolved to a channel id). "remove_channel" takes the channel name. Use when he says "add topic agentic coding", "follow this channel <url>", "list my youtube sources", "drop topic X".',
      {
        action: z.enum(["list", "add_topic", "remove_topic", "add_channel", "remove_channel"]),
        value: z.string().optional().describe("Topic text, channel URL/@handle, or channel name to remove."),
      },
      async ({ action, value }) => {
        if (action === "list") {
          const all = await convex.query(api.youtubeSources.list, {});
          const topics = all.filter((s) => s.kind === "topic").map((s) => s.value);
          const channels = all.filter((s) => s.kind === "channel").map((s) => `${s.value} (${s.channelId ?? "unresolved"})`);
          return runtimeText(JSON.stringify({ topics, channels }, null, 2));
        }
        if (!value) return runtimeText(`action ${action} needs a value.`, false);
        if (action === "add_topic") {
          await convex.mutation(api.youtubeSources.add, { kind: "topic", value });
          return runtimeText(`Topic added: "${value}".`);
        }
        if (action === "remove_topic") {
          const r = await convex.mutation(api.youtubeSources.remove, { kind: "topic", value });
          return runtimeText(r.removed ? `Topic removed: "${value}".` : `No topic "${value}".`);
        }
        if (action === "add_channel") {
          const channelId = await resolveChannelId(value);
          if (!channelId) {
            return runtimeText(
              `Could not resolve a channel id from "${value}". Paste a URL containing /channel/UC..., or set YOUTUBE_API_KEY to resolve @handles.`,
              false,
            );
          }
          await convex.mutation(api.youtubeSources.add, {
            kind: "channel",
            value,
            channelId,
            feedUrl: channelFeedUrl(channelId),
          });
          return runtimeText(`Channel added: "${value}" (${channelId}).`);
        }
        // remove_channel
        const r = await convex.mutation(api.youtubeSources.remove, { kind: "channel", value });
        return runtimeText(r.removed ? `Channel removed: "${value}".` : `No channel "${value}".`);
      },
    ),
  ];
}
