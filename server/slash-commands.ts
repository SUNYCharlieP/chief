import { convex } from "./convex-client.js";
import { api } from "../convex/_generated/api.js";
import { runJobObserver } from "./job-observer.js";
import { runMorningSurface } from "./morning-scan.js";
import { handleUserMessage } from "./interaction-agent.js";

// The most recent genuine user turn (skipping slash commands like /retry, /jobs)
// so /retry re-runs the real message, not a command. Returns its text + any
// images it carried, or null if there's nothing to retry.
async function lastRealUserMessage(
  conversationId: string,
): Promise<{ content: string; imageStorageIds?: string[] } | null> {
  const rows = await convex.query(api.messages.list, { conversationId, limit: 30 }); // newest first
  for (const m of rows) {
    if (
      m.role === "user" &&
      m.content.trim().length > 0 &&
      !m.content.trimStart().startsWith("/")
    ) {
      return { content: m.content, imageStorageIds: m.imageStorageIds as string[] | undefined };
    }
  }
  return null;
}

// Slash commands for the app channel. An app:charlie message that starts with
// "/" is parsed here and routed to a handler INSTEAD of the LLM. Adding a
// command is just a new entry in COMMANDS — args are already parsed and passed
// in, so /youtube <url> and /remind <thing> drop in as more handlers (see the
// commented seam at the bottom of COMMANDS).

type SlashHandler = (args: string, conversationId: string) => Promise<string>;

interface Command {
  description: string;
  run: SlashHandler;
}

const COMMANDS: Record<string, Command> = {
  jobs: {
    description: "scan for new job matches now",
    run: async () => {
      const r = await runJobObserver({ force: true });
      if (!r.configured) return "Job watcher isn't configured (Adzuna keys missing).";
      const cost = `${r.llmCalls} LLM call${r.llmCalls === 1 ? "" : "s"}, $${r.costUsd.toFixed(2)}`;
      if (!r.primedBefore) {
        return `Job scan: first run — baselined ${r.baselined} current listing(s); new matches surface from here.`;
      }
      if (r.pushed > 0) {
        return `Job scan: ${r.pushed} new match${r.pushed > 1 ? "es" : ""} surfaced above. (${cost})`;
      }
      if (r.scored > 0) {
        return `Job scan: scored ${r.scored} new listing${r.scored > 1 ? "s" : ""}, none worth surfacing. (${cost})`;
      }
      return "Job scan: nothing new since the last run.";
    },
  },
  brief: {
    description: "send the morning briefing now",
    run: async () => {
      const r = await runMorningSurface();
      if (r.error) return `Couldn't send the briefing: ${r.error}`;
      return "Briefing sent ↑";
    },
  },
  retry: {
    description: "re-run the last turn",
    run: async (_args, conversationId) => {
      const target = await lastRealUserMessage(conversationId);
      if (!target) return "Nothing to retry yet.";
      const images = (target.imageStorageIds ?? []).map((id) => ({
        storageId: id,
        mediaType: "image/jpeg", // only storageId is used; bytes' real type is read at fetch
      }));
      // Re-run the real turn: skip re-persisting the inbound (it's already in the
      // thread) and let handleSlashCommand persist the single returned reply.
      return handleUserMessage({
        conversationId,
        content: target.content,
        images: images.length > 0 ? images : undefined,
        skipPersistInbound: true,
        persistAssistantReply: false,
      });
    },
  },
  // --- Seam for future commands (args already parsed) -----------------------
  // youtube: {
  //   description: "analyze a YouTube URL",
  //   run: async (args, conversationId) => { await analyzeVideo(conversationId, args); return "On it ↑"; },
  // },
  // remind: {
  //   description: "add a reminder",
  //   run: async (args) => { /* create reminder, return confirmation */ },
  // },
};

export function isSlashCommand(content: string): boolean {
  return content.trimStart().startsWith("/");
}

// Parse + route a slash command. Persists the typed "/cmd" as a user message
// (so the thread shows what was sent) and the textual result as an assistant
// message, then returns the result for the completion push. Rich side-effects
// (job-match cards, the briefing) are delivered by the handlers' own paths as
// their own messages. Never throws — a handler error becomes the reply text.
export async function handleSlashCommand(conversationId: string, content: string): Promise<string> {
  const trimmed = content.trim();
  await convex.mutation(api.messages.send, { conversationId, role: "user", content: trimmed });

  const body = trimmed.slice(1); // drop leading "/"
  const sep = body.search(/\s/);
  const name = (sep === -1 ? body : body.slice(0, sep)).toLowerCase();
  const args = sep === -1 ? "" : body.slice(sep + 1).trim();

  const known = Object.keys(COMMANDS).map((c) => `/${c}`).join(", ");
  const command = COMMANDS[name];

  let reply: string;
  if (!command) {
    reply = name ? `Unknown command "/${name}". Known: ${known}` : `Commands: ${known}`;
  } else {
    try {
      reply = await command.run(args, conversationId);
    } catch (err) {
      console.error(`[slash] /${name} failed:`, err);
      reply = `/${name} failed: ${String(err)}`;
    }
  }

  await convex.mutation(api.messages.send, {
    conversationId,
    role: "assistant",
    content: reply,
    complete: true,
  });
  return reply;
}
