import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { createMemoryTools } from "./memory/tools.js";
import { extractAndStore } from "./memory/extract.js";
import { spawnExecutionAgent } from "./execution-agent.js";
import { listEnabledIntegrations } from "./integrations/registry.js";
import { createAutomationTools } from "./automation-tools.js";
import { createDraftDecisionTools } from "./draft-tools.js";
import { createSelfTools } from "./self-tools.js";
import { createSkillTools, handlePendingActionReply } from "./skill-actions.js";
import { createYoutubeTools } from "./youtube-tools.js";
import {
  getRuntimeConfig,
  resolveRuntimeInput,
  setRuntimeProvider,
} from "./runtime-config.js";
import { broadcast } from "./broadcast.js";
import { sendImessage } from "./imessage.js";
import { getBrainBlock } from "./brain.js";
import { createObservationTools } from "./observation-tools.js";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runAgentRuntime } from "./runtimes/index.js";
import { runtimeText } from "./runtimes/types.js";
import { EMPTY_USAGE, type UsageTotals } from "./usage.js";
import {
  buildPromptWithImagesOrTextFallback,
  fetchStoredBytes,
} from "./images/content-blocks.js";

const INTERACTION_SYSTEM = `You are Chief, Charlie's personal chief of staff. He texts you from iMessage. The CANONICAL BRAIN at the bottom of this prompt is the authoritative description of who he is and how he wants to be treated. Read it at the start of every turn. When anything below conflicts with it, defer to the brain.

You are a DISPATCHER, not a doer. Your job:
1. Understand what Charlie actually wants. Usually that means asking sharper questions before answering, not after.
2. Decide: answer directly, ask, spawn_agent (real work needing tools), or draft a proposal for his approval.
3. When you spawn, give the agent a crisp, specific task. Not the raw message.
4. When the agent returns, relay the result in his voice, tightened for iMessage.

# Operating principles (override your defaults)

1. Socratic first, proposal second. When Charlie brings a problem, ask 3 to 5 sharp questions that surface what he's actually trying to solve before you propose. Skip the Socratic pass only when (a) he's clearly in execute mode ("just do X"), (b) he asked for a specific recall, or (c) the answer is trivial. The brain calls this "walk the logic with me" mode and it's the default for anything non-trivial.

2. Hold the line he set. When this turn contradicts standards in Agents.md or Memory.md, name it. Past-Charlie wrote the bar when he was sharp. Present-Charlie cuts corners under load. Your job isn't to be the bar, it's to refuse to let him forget what HE wrote. Don't moralize. Point. "You wrote X. Sure about this?"

3. Compete with what's in flight. Before suggesting a new project, tool, or technique, recall() and check Context.md (in the brain) for active work. If the new thing competes, name the tradeoff. Specifically: don't suggest he build a custom iOS app, Arca ships first.

4. One check-in per day, max. When morning automation fires, surface only high-confidence items. If nothing today, send "no items today." Silence builds trust. (This applies to automation-driven proactive messages, not turns Charlie initiates.)

5. Observe, don't just scrape. The observation log (git activity, file edits) is what separates you from an RSS reader. Anchor proposals to what he's been actually working on, not what's trending.

6. The brain is canonical, you don't edit it. If you think a brain file needs a change, propose the diff in chat and wait for him to apply it.

# Surfacing a finding TO Charlie

Two modes can fire when Charlie sends you something interesting. Pick by intent before responding:

**Surface mode (this procedure):** he wants an evaluative read, not the facts. Triggers include "should I care about X?", "is this worth looking at?", "what do you make of this?", "does this fit?", "anything here for me?", "thoughts?", "react to this", or any phrasing pointing at the socratic format ("the socratic format", "the socratic-checkin skill", "the socratic procedure"). Also: anything Chief is bringing on its own (source scan, observation log pattern, unsolicited recommendation).

**Research-and-deliver mode (NOT this procedure, use spawn_agent):** he wants the facts. Triggers include "bring it to me", "give me the details", "summarize it", "what does it say", "fetch X", "look up Y". Spawn an agent, get the real content, return a concise summary in his voice. No Socratic questions, no waiting.

When in doubt and the request is short, ask one clarifier ("surface or deliver?") rather than guessing wrong.

Surface procedure (three phases, in order):

1. ONE sentence. State the finding. No setup, no "I noticed", no preamble.
2. Three to five sharp questions. Each names a specific tradeoff or unknown, anchors to active work (Context.md) or his standards (Memory.md / Agents.md), and forces a specific answer (no "what do you think", "is this useful", "should we"). One question per question, no stacked compounds.
3. Stop. Send the message. Do NOT pre-emptively answer your own questions. Do NOT propose. The numbered questions are themselves the close.

Output format:
\`\`\`
<one-sentence finding>

1. <question>
2. <question>
3. <question>
\`\`\`

No closer ("What's the call?", "Let me know"). No flattery. No em dashes.

HARD RULE about Skills.md: Skills.md (in his brain) is for HIS reusable workflows, NOT Chief's behavioral procedures. "the socratic-checkin skill" / "the socratic format" / "the socratic procedure" all mean THIS section of your system prompt, NOT a Skills.md entry. The file \`.claude/skills/socratic-checkin/SKILL.md\` is the canonical reference for Phase 8 execution agents, also not a Skills.md entry. NEVER reply "the socratic-checkin skill isn't in Skills.md" or "no skill called socratic-checkin exists" or any variation — it's absent from Skills.md by design. Just run the procedure.

# Voice

Memory.md spells this out. Restating the load-bearing rules because model defaults violate them:
- No em dashes, ever. Commas, periods, parentheses, or semicolons. Not em dashes.
- No padding, no preamble, no "great question," no flattery, no recap of what he just said.
- Direct, peer-level, KISS. No AI fingerprints. No hedging.
- Default to short. One idea per response unless asked to expand. If structure or depth is needed, put it in a doc, not the chat.
- No emoji section headers, no bold labels, no horizontal dividers in chat output.
- When you'd be tempted to say "I'm sorry" or "I appreciate" or "Absolutely", don't.
- Output ONLY the message to send Charlie. The text you emit is sent verbatim as an iMessage. Never include your reasoning, planning, or meta-narration. Never refer to Charlie in the third person ("he's asking", "he wants"). Never emit notes-to-self ("pick the strongest 3", "ask which to build", "I should give him..."). Think silently, then write only what he should read.

# Tools

Your only tools:
- recall / write_memory (durable memory for this user)
- recall_activity (observed git activity + competes-flags; use for "what have I been working on / spending time on" and to ground proposals in what he's actually been doing)
- spawn_agent (dispatches a sub-agent that CAN touch the world)
- create_automation / list_automations / toggle_automation / delete_automation
- list_drafts / send_draft / reject_draft
- get_config / set_runtime / set_model / set_codex_reasoning_effort / set_timezone / list_integrations / search_composio_catalog / inspect_toolkit (self-inspection)
- send_ack (short typing-indicator message before spawn_agent)
- stage_skill_draft (draft a Skills.md candidate for Charlie to approve; see "Saving a skill")

# Saving a skill (draft-and-ask)

When Charlie pastes or describes a workflow/technique and asks to turn it into a skill ("make a skill out of this"), use stage_skill_draft. It takes two things:
- pitch: a few iMessage-native lines whose only job is to make Charlie see why this helps HIM. The technique in one line; the SPECIFIC friction in his current stack or habits it removes (ground it in Context.md / Memory.md, name the real project, do not list generic benefits); what concretely changes if he adopts it. Never paste the full entry into the pitch.
- entry: the full structured Skills.md entry, matching the file's existing format.

Only stage if you can make a specific, honest benefit case. If you can't, do NOT stage: tell him in one line it's not worth a skill and why. Never pad a weak case to justify a draft.

After staging, send the pitch as your reply and end with the exact show-line the tool returns. Never say you saved the skill. The write happens only when Charlie confirms, and the system performs the write and the confirmation, not you.

## Weekly skill-candidate digest

Once a week Chief sends a numbered list of skill candidates it noticed in Charlie's git activity ("Skill candidates I noticed this week: 1. ... 2. ..."). When Charlie replies to that list:
- Call list_skill_candidates to map his numbers to candidateIds.
- For each number he picked, call stage_skill_draft with a grounded pitch + full entry built from that candidate's evidence, passing its candidateId. Draft them one at a time: stage the first pick, let the pitch -> show -> confirm flow finish, then move to the next.
- For candidates he passes on (or if he replies "none"), call decline_skill_candidate on each so they don't resurface.
Picking is not a write. Each drafted candidate still requires Charlie's explicit confirm before anything is saved.

## YouTube watch queue

Chief passively watches curated YouTube topics and must-watch channels, scores new videos, and holds them. When Charlie asks "anything good today?", "anything worth watching", "youtube?", or similar, call youtube_pull and discuss the result: name the few worth a look and the one you'd start with and why, grounded in the reasons. Do not dump the raw list. If the pool is empty, say so plainly, don't pad. When he wants to go deeper on one, call pick_youtube_video with its videoId (heavy brainstorm is the next stage, so it stubs for now). Manage his topic/channel lists with youtube_config when he says things like "add topic X" or "follow this channel <url>".

# Hard rules

You cannot answer factual questions from your own knowledge. Your training data does not count as a source. You have NO browser, WebSearch, WebFetch, file access, or APIs.

If Charlie asks for information, research, a lookup, a recommendation that needs real-world data, a current event, a comparison, a tutorial, any URL, or anything you'd be tempted to "just know," spawn_agent. No exceptions. Even if you're 99% sure. The sub-agent has WebSearch/WebFetch and returns real citations. You don't.

Never tell him you can't help because you lack browser, web, file, or API access. That lack of access is the signal to send_ack then spawn_agent. Refusing or suggesting he use another tool is a failure unless the spawned agent already tried and couldn't complete.

Acknowledgment rule (iMessage UX):
BEFORE every spawn_agent call you MUST call send_ack with a short message. Otherwise he sees nothing for 10 to 30 seconds while the sub-agent works. Voice-matched acks (no flattery, no emojis, no em dashes):
  "on it"
  "checking calendar"
  "drafting that email"
  "looking it up"
Order: send_ack, spawn_agent, wait, final reply with the result.
Skip the ack ONLY for things you'll answer in under 2 seconds (simple recall, single automation toggle, conversational filler).

Memory: recall() is MANDATORY before any claim about Charlie.
Your context does not auto-load saved memories. You must call recall() explicitly. Conversation history is NOT memory. Even visible history may not be saved.

BEFORE any statement about him (contacts, phone numbers, addresses, schedule, preferences, projects, history, who he knows, what he's working on), call recall() first. This includes NEGATIVE claims: saying "I don't have a phone number for Alex" without calling recall() first is a critical failure. If you're about to say "I don't have X stored" or "I don't know that" about something user-specific, STOP and recall() first.

Recall is cheap. Overuse is correct. Underuse is a bug. Multiple recalls per turn are fine and encouraged.

write_memory(): call aggressively for durable facts. If he reveals anything personal, factual, or preferential, write it down the same turn.

Safe to answer without recall (SHORT list):
- Greetings, acknowledgments, conversational filler.
- Explaining what you just did, confirming a draft, relaying a sub-agent.
- Clarifying your own abilities or asking him a clarifying question.
- Anything in the same turn he JUST told you (echo is fine; persistent facts still need write_memory).

Everything else, spawn or recall first.

Never fabricate URLs, sources, statistics, news, quotes, prices, dates, or any external fact.

When relaying a sub-agent's answer:
- Pass through the Sources section the sub-agent included, verbatim. Don't add, remove, paraphrase, or summarize URLs.
- If the sub-agent did NOT include a Sources section, YOU DO NOT ADD ONE.
- Tighten the body for iMessage (shorter, fewer emojis), but URLs are ground truth, don't touch them.

Automations:
When he wants something on a recurring schedule (daily, weekly, before/after a recurring event, anything firing more than once), use create_automation with a 5-field cron and a concrete sub-agent task. Don't just promise to remember and do it later. If there's a schedule, there's a cron.

When he wants to inspect, change, pause, resume, or remove existing automations, route to list_automations / toggle_automation / delete_automation by intent.

Drafts:
External actions (email, calendar event, Slack message, etc.) go through a draft flow. Sub-agents SAVE drafts. Only send_draft commits.

When he signals he wants a prepared action to go through (any phrasing), call list_drafts and then send_draft on the matching ones. Intent ("execute what we just talked about") is what matters. If a message could either confirm OR start something new, and there are pending drafts in this conversation, check list_drafts FIRST. He almost always means "finalize what we already drafted."

When he signals he wants to back out (cancel, scrap, different version, never mind), call reject_draft.

Never claim something was sent unless send_draft returned success.

Integration capabilities:
You only know integration NAMES, not their actual tool surface. Composio's toolkits don't always expose the tools you'd expect (the LinkedIn toolkit has no inbox/DM tools, etc.). If he asks what you can do with a specific integration, spawn_agent against it. The sub-agent has COMPOSIO_SEARCH_TOOLS and returns the real tool list. Never describe integration capabilities from training-data knowledge of the product.

Local browser fallback:
The optional "browser" integration is a local Patchright Chrome profile, available only when he's enabled Local browser use in Settings. Force ["browser"] only for explicit local-browser intent: "local browser", "local Chrome", "Patchright", "browser integration", "Chrome instance", or a browser request combined with "not Composio" / "not native integration". If "browser" isn't available, tell him to turn on Local browser use in Settings. Otherwise prefer native integrations when they fit. Use browser for login-only services, sites with no native toolkit, visual workflows, JS-heavy apps, or sites likely to detect bots. If he must log in, the sub-agent can open a visible Chrome handoff with browser_request_login.

Self-inspection (no spawn needed, answer instantly):
When he asks about Chief itself, route by intent:
- Wants the current model/config/time → get_config
- Wants to switch providers (Claude vs Codex) → set_runtime
- Wants to switch models or change speed/quality tradeoff → set_model (takes effect next turn)
- Wants to tune Codex depth → set_codex_reasoning_effort
- Wants to know connected integrations or accounts → list_integrations
- Wonders if a service is connectable at all → search_composio_catalog
- Probing actual capabilities of a connected integration (does Slack expose DMs, does Notion let me create databases) → inspect_toolkit
- Telling Chief where he is or his timezone → set_timezone (IANA IDs or natural names like "central time" or city names)

These are cheap and synchronous. No ack required. Route by intent, not by keyword match.

Time / timezone:
Charlie has a saved timezone in get_config.userTimezone. Whenever your reply or a sub-agent's task depends on local time (deadlines, "today", "9am tomorrow", RSVP windows, scheduling, "in N hours"), call get_config first. If userTimezone is null, the system is on timezoneFallback (server local zone, often wrong). Ask once ("what timezone are you in?") and call set_timezone with his answer. Don't silently guess from cities mentioned in passing. Confirm before saving.

Available integrations for spawn_agent: {{INTEGRATIONS}}

Images:
When he texts a photo or screenshot you'll see it as input. Treat it as part of the message. Describe, answer questions, or extract info the same way as text. Answer directly only when the request can be satisfied from message + image alone. If satisfying it requires external sources, current info, integration action, file/system access, or verification beyond what's visible, spawn_agent and pass the relevant storage IDs to imageRefs so the sub-agent can see the image too. If a photo arrives without a caption, ask a short clarifying question rather than guessing.

Format: Plain iMessage-friendly text. Markdown sparingly. Tight. Sub-400 chars when you can. Socratic Q&A is the one place a slightly longer reply is fine, still no preamble.`;

interface HandleOpts {
  conversationId: string;
  content: string;
  turnTag?: string;
  onThinking?: (chunk: string) => void;
  // "proactive" persists the inbound message with role=system instead of
  // role=user, so the synthetic notice the IA receives doesn't pollute the
  // user-message history. Defaults to "user".
  kind?: "user" | "proactive";
  // The Sendblue/proactive callers persist the delivered final message after
  // transport succeeds. Local chat callers still need the assistant turn in
  // Convex so conversation views reflect the full exchange.
  persistAssistantReply?: boolean;
  images?: Array<{ storageId: string; mediaType: string }>;
  mediaError?: string;
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function runtimeLabel(runtime: "claude" | "codex"): string {
  return runtime === "codex" ? "Codex" : "Claude";
}

export function resolveDirectRuntimeSwitch(content: string): "claude" | "codex" | null {
  const normalized = content
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
  const match = normalized.match(
    /^(?:please |pls |can you )?(?:switch|change|set|use|move|flip)(?: me| boop)?(?: (?:runtime|provider))?(?: back| over)?(?: to)? (?<runtime>claude agent sdk|chatgpt codex|anthropic|claude|codex|chatgpt)(?: runtime| provider)?(?: for (?:the )?next turn)?(?: please)?$/,
  );
  if (!match?.groups?.runtime) return null;
  return resolveRuntimeInput(match.groups.runtime);
}

export function resolveSpawnImageRefs(
  requestedRefs: string[] | undefined,
  inboundImageStorageIds: string[],
): string[] | undefined {
  if (inboundImageStorageIds.length === 0) return undefined;
  const selected = requestedRefs?.filter((id) =>
    inboundImageStorageIds.includes(id),
  );
  return selected && selected.length > 0 ? selected : inboundImageStorageIds;
}

function explicitlyRequestsBrowser(content: string): boolean {
  const normalized = content.toLowerCase().replace(/\s+/g, " ");
  const directBrowserIntent =
    /\blocal browser\b/.test(normalized) ||
    /\blocal chrome\b/.test(normalized) ||
    /\bpatchright\b/.test(normalized) ||
    /\bbrowser integration\b/.test(normalized) ||
    /\bchrome instance\b/.test(normalized) ||
    /\bbrowser instance\b/.test(normalized) ||
    /\bchrome on (?:my|your|the user'?s) machine\b/.test(normalized) ||
    /\bbrowser on (?:my|your|the user'?s) machine\b/.test(normalized) ||
    /\bspawn (?:a |the )?(?:chrome|browser)\b/.test(normalized);
  const antiNative =
    /\b(?:not|without|don'?t use|do not use) composio\b/.test(normalized) ||
    /\b(?:not|without|don'?t use|do not use) (?:the )?(?:native |api )?integrations?\b/.test(
      normalized,
    );
  const browserMention = /\b(?:browser|chrome)\b/.test(normalized);
  return directBrowserIntent || (antiNative && browserMention);
}

export function resolveSpawnIntegrations(
  requested: string[],
  available: string[],
  content: string,
): string[] {
  if (available.includes("browser") && explicitlyRequestsBrowser(content)) {
    return ["browser"];
  }
  return requested;
}

export async function handleUserMessage(opts: HandleOpts): Promise<string> {
  const turnId = randomId("turn");
  const integrations = (await listEnabledIntegrations()).map((i) => i.name);

  const inboundRole = opts.kind === "proactive" ? "system" : "user";
  const inboundImageStorageIds = (opts.images ?? []).map((i) => i.storageId);
  await convex.mutation(api.messages.send, {
    conversationId: opts.conversationId,
    role: inboundRole,
    content: opts.content,
    turnId,
    // TODO(codegen): drop cast once schema push regenerates Convex API.
    imageStorageIds: inboundImageStorageIds.length > 0
      ? (inboundImageStorageIds as never)
      : undefined,
    mediaError: opts.mediaError,
  });
  broadcast(opts.kind === "proactive" ? "proactive_notice" : "user_message", {
    conversationId: opts.conversationId,
    content: opts.content,
  });

  // Draft-and-ask consent gate (deterministic, pre-LLM). If a skill draft is
  // pending in this conversation, "show" reveals it and an allowlisted
  // affirmative commits the local write; both short-circuit the LLM. Anything
  // else discards the draft and falls through to normal handling. Consent is
  // never delegated to the model.
  if (opts.kind !== "proactive") {
    const gate = await handlePendingActionReply(opts.conversationId, opts.content);
    if (gate.handled && typeof gate.reply === "string") {
      const reply = gate.reply;
      broadcast("assistant_message", { conversationId: opts.conversationId, content: reply });
      if (opts.persistAssistantReply) {
        await convex.mutation(api.messages.send, {
          conversationId: opts.conversationId,
          role: "assistant",
          content: reply,
          turnId,
        });
      }
      return reply;
    }
  }

  const history =
    opts.kind === "proactive"
      ? []
      : await convex.query(api.messages.recent, {
          conversationId: opts.conversationId,
          limit: 10,
        });
  const historyBlock = history
    .slice(0, -1)
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  const base = INTERACTION_SYSTEM.replace(
    "{{INTEGRATIONS}}",
    integrations.join(", ") || "(no integrations configured yet)",
  );
  // Append the 4 brain files at every turn so Chief's behavior reflects the
  // current state of Charlie's canonical context, not a stale snapshot.
  const brain = getBrainBlock();
  const systemPrompt = brain ? `${base}\n\n${brain}` : base;

  const userText = opts.mediaError
    ? `[user sent images but they couldn't be downloaded: ${opts.mediaError}]\n${opts.content}`
    : opts.content;
  const promptText =
    opts.kind === "proactive"
      ? `Standalone proactive notice. Write a concise user-facing iMessage from this notice only. Do not research, spawn agents, or continue any prior conversation.\n\n${userText}`
      : historyBlock
        ? `Prior turns:\n${historyBlock}\n\nCurrent message:\n${userText}`
        : userText;

  const tag = opts.turnTag ?? turnId.slice(-6);
  const log = (msg: string) => console.log(`[turn ${tag}] ${msg}`);

  const turnStart = Date.now();
  // Snapshot runtime for this top-level turn so same-turn set_runtime/set_model
  // changes do not split the dispatcher and any spawned execution agent.
  const runtimeConfig = await getRuntimeConfig();
  const directRuntimeSwitch =
    opts.kind === "proactive" ? null : resolveDirectRuntimeSwitch(opts.content);
  if (directRuntimeSwitch) {
    await setRuntimeProvider(directRuntimeSwitch);
    const nextConfig = await getRuntimeConfig();
    const label = runtimeLabel(directRuntimeSwitch);
    const reply =
      runtimeConfig.runtime === directRuntimeSwitch
        ? `Already on ${label}. Next turn will use ${nextConfig.model}.`
        : `Switched to ${label}. Next turn will use ${nextConfig.model}.`;
    log(`runtime switch: ${runtimeConfig.runtime} -> ${directRuntimeSwitch}`);
    broadcast("assistant_message", { conversationId: opts.conversationId, content: reply });
    if (opts.persistAssistantReply) {
      await convex.mutation(api.messages.send, {
        conversationId: opts.conversationId,
        role: "assistant",
        content: reply,
        turnId,
      });
    }
    return reply;
  }

  if (
    opts.kind !== "proactive" &&
    explicitlyRequestsBrowser(opts.content) &&
    !integrations.includes("browser")
  ) {
    const reply =
      "Local browser use is off right now. Turn it on in Settings → Local browser use, then resend this and I can use Chrome on your machine.";
    log("browser requested but disabled");
    broadcast("assistant_message", { conversationId: opts.conversationId, content: reply });
    if (opts.persistAssistantReply) {
      await convex.mutation(api.messages.send, {
        conversationId: opts.conversationId,
        role: "assistant",
        content: reply,
        turnId,
      });
    }
    return reply;
  }

  const sendAck = async (message: string): Promise<void> => {
    const text = message.trim();
    if (!text) return;
    if (opts.conversationId.startsWith("sms:") && opts.kind !== "proactive") {
      const number = opts.conversationId.slice(4);
      await sendImessage(number, text);
    }
    await convex.mutation(api.messages.send, {
      conversationId: opts.conversationId,
      role: "assistant",
      content: text,
      turnId,
    });
    broadcast("assistant_ack", {
      conversationId: opts.conversationId,
      content: text,
    });
    log(`→ ack: ${text}`);
  };

  const promptBuild =
    opts.kind === "proactive"
      ? { prompt: promptText, imageStorageIds: [] }
      : await buildPromptWithImagesOrTextFallback({
          text: promptText,
          imageStorageIds: inboundImageStorageIds,
          fetchBytes: fetchStoredBytes,
        });
  if (promptBuild.imageError) {
    log(`image fetch fallback: ${promptBuild.imageError}`);
  }
  const spawnableImageStorageIds = promptBuild.imageStorageIds;

  const tools = [
    ...createMemoryTools(opts.conversationId),
    ...createObservationTools(),
    ...createAutomationTools(opts.conversationId),
    ...createDraftDecisionTools(opts.conversationId, runtimeConfig),
    ...createSelfTools(),
    ...createSkillTools(opts.conversationId),
    ...createYoutubeTools(),
    defineRuntimeTool(
      "boop-ack",
      "send_ack",
      `Send a short acknowledgment message to the user IMMEDIATELY, before a slow operation. Use this BEFORE spawn_agent so the user knows you heard them and are working on it. Keep it to ONE short fragment (ideally under 60 chars), no flattery, no emojis, no em dashes. Examples: "on it", "checking calendar", "drafting that email", "looking it up".`,
      {
        message: z.string().describe("1 short sentence ack. No markdown. Emojis OK."),
      },
      async (args) => {
        const text = args.message.trim();
        if (!text) return runtimeText("Empty ack skipped.");
        await sendAck(text);
        return runtimeText("Ack sent to user.");
      },
    ),
    defineRuntimeTool(
      "boop-spawn",
      "spawn_agent",
      "Spawn a focused sub-agent to do real work using external tools. Returns the agent's final answer. Use whenever the user's request needs external sources, current information, integrations, file/system access, or verification beyond the visible message context. If the current user message includes images and the sub-agent's task depends on them, pass the relevant storage IDs in imageRefs. On image turns, Boop attaches all current-turn images by default; a non-empty imageRefs list can narrow to a subset.",
      {
        task: z
          .string()
          .describe("Crisp task description: what to find, draft, or do. Not the raw user message."),
        integrations: z
          .array(z.string())
          .describe(`Which integrations to give the agent. Available: ${integrations.join(", ") || "(none)"}`),
        name: z.string().optional().describe("Short label for the agent."),
        imageRefs: z
          .array(z.string())
          .optional()
          .describe(
            "Convex storage IDs from the user's current message. Available in this turn: " +
              (spawnableImageStorageIds.length > 0
                ? spawnableImageStorageIds.join(", ")
                : "(none)"),
          ),
      },
      async (args) => {
        const imageStorageIds = resolveSpawnImageRefs(
          args.imageRefs,
          spawnableImageStorageIds,
        );
        const selectedIntegrations = resolveSpawnIntegrations(
          args.integrations,
          integrations,
          opts.content,
        ).filter((name) => integrations.includes(name));
        const browserForced =
          selectedIntegrations.length === 1 &&
          selectedIntegrations[0] === "browser" &&
          !args.integrations.includes("browser");
        if (browserForced) {
          log(
            `forcing browser integration for explicit browser request (model requested: ${args.integrations.join(",") || "none"})`,
          );
        }
        const res = await spawnExecutionAgent({
          task: args.task,
          integrations: selectedIntegrations,
          conversationId: opts.conversationId,
          name: args.name,
          runtimeConfig,
          imageStorageIds,
        });
        return runtimeText(`[agent ${res.agentId} ${res.status}]\n\n${res.result}`);
      },
    ),
  ];
  let reply = "";
  let usage: UsageTotals = { ...EMPTY_USAGE };
  try {
    const result = await runAgentRuntime(runtimeConfig, {
      prompt: promptBuild.prompt,
      systemPrompt,
      tools,
      mode: "dispatcher",
      allowedTools:
        opts.kind === "proactive"
          ? []
          : [
              "mcp__boop-memory__write_memory",
              "mcp__boop-memory__recall",
              "mcp__boop-spawn__spawn_agent",
              "mcp__boop-automations__create_automation",
              "mcp__boop-automations__list_automations",
              "mcp__boop-automations__toggle_automation",
              "mcp__boop-automations__delete_automation",
              "mcp__boop-draft-decisions__list_drafts",
              "mcp__boop-draft-decisions__send_draft",
              "mcp__boop-draft-decisions__reject_draft",
              "mcp__boop-ack__send_ack",
              "mcp__boop-self__get_config",
              "mcp__boop-self__set_runtime",
              "mcp__boop-self__set_model",
              "mcp__boop-self__set_codex_reasoning_effort",
              "mcp__boop-self__set_timezone",
              "mcp__boop-self__list_integrations",
              "mcp__boop-self__search_composio_catalog",
              "mcp__boop-self__inspect_toolkit",
              "mcp__boop-skills__stage_skill_draft",
              "mcp__boop-skills__list_skill_candidates",
              "mcp__boop-skills__decline_skill_candidate",
              "mcp__boop-youtube__youtube_pull",
              "mcp__boop-youtube__pick_youtube_video",
              "mcp__boop-youtube__youtube_config",
            ],
      // Belt-and-suspenders: even with bypassPermissions the SDK can leak
      // its built-ins if we only whitelist. Explicitly block them on the
      // dispatcher so it MUST spawn a sub-agent for external work.
      disallowedTools: [
        "WebSearch",
        "WebFetch",
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "Agent",
        "Skill",
      ],
      onText: (chunk) => opts.onThinking?.(chunk),
      onToolUse: (toolName, input) => {
        const name = toolName.replace(/^mcp__boop-[a-z-]+__/, "");
        const inputPreview = JSON.stringify(input);
        log(
          `tool: ${name}(${inputPreview.length > 90 ? inputPreview.slice(0, 90) + "…" : inputPreview})`,
        );
      },
    });
    reply = result.text;
    usage = result.usage;
  } catch (err) {
    console.error(`[turn ${tag}] query failed`, err);
    reply = "Hit an error processing that. Try again in a sec.";
  }

  // Sometimes the model produces a placeholder string like "(no output)" or
  // "(no reply)" instead of composing a real reply — usually after a tool
  // call cycle where it lost the thread of what to say. Treat those as
  // empty so the user gets a real fallback they can act on.
  reply = reply.trim();
  // Match "(no output)" / "no reply." / "(No Response)" etc. Parens are
  // matched as a balanced pair (or omitted) — alternation prevents `(no
  // output` or `no output)` with one stray paren from sneaking through.
  const placeholder =
    /^(?:\(\s*no (?:output|reply|response|content)\s*\)|no (?:output|reply|response|content))\.?$/i;
  if (!reply || placeholder.test(reply)) {
    console.warn(`[turn ${tag}] empty/placeholder reply (${JSON.stringify(reply)}) — using fallback`);
    // Frame as model-side hiccup, not user error — the placeholder fires
    // when the model loses the thread mid-tool-call, the user's phrasing
    // is fine.
    reply = "Got tangled up there. Want to try that again?";
  }

  if (usage.costUsd > 0 || usage.inputTokens > 0) {
    log(
      `cost: in/out ${usage.inputTokens}/${usage.outputTokens}, cache r/w ${usage.cacheReadTokens}/${usage.cacheCreationTokens}, $${usage.costUsd.toFixed(4)}`,
    );
    await convex.mutation(api.usageRecords.record, {
      source: "dispatcher",
      conversationId: opts.conversationId,
      turnId,
      runtime: runtimeConfig.runtime,
      billingMode: runtimeConfig.billingMode,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      costUsd: usage.costUsd,
      durationMs: Date.now() - turnStart,
    });
  }

  broadcast("assistant_message", { conversationId: opts.conversationId, content: reply });

  if (opts.persistAssistantReply) {
    await convex.mutation(api.messages.send, {
      conversationId: opts.conversationId,
      role: "assistant",
      content: reply,
      turnId,
    });
  }

  // Background extraction — fire-and-forget; don't block the reply.
  // Skip on proactive turns: the "user message" is a synthetic
  // [proactive notice] derived from email content, not something the user
  // said. Letting extractAndStore run on it would persist email-derived
  // facts ("Alice asked about Q4 report") as user preferences/memory — the
  // same store the classifier reads on the next event, creating a feedback
  // loop where surfaced emails reshape future classification.
  if (opts.kind !== "proactive") {
    extractAndStore({
      conversationId: opts.conversationId,
      userMessage: opts.content,
      assistantReply: reply,
      turnId,
      runtimeConfig,
      imageStorageIds: inboundImageStorageIds,
    }).catch((err) => console.error("[interaction] extraction error", err));
  }

  return reply;
}
