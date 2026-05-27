// Generic RSS source loader.
//
// Each entry in FEED_SOURCES registers as its own integration with its own
// MCP server, tool namespace, and fast-pass / full-fetch tool pair. Add new
// feeds by appending to FEED_SOURCES; no per-source loader file required.
//
// Why not Composio (verified 2026-05-27 via direct browse of
// docs.composio.dev/toolkits, ~1000 entries enumerated):
//   - The Composio catalog contains ZERO generic RSS/Atom/Feed/Reader
//     toolkits. Only Listen Notes is feed-adjacent and it's
//     podcast-specific.
//   - RSS doesn't need OAuth, token refresh, or any of the auth machinery
//     Composio provides. A self-contained fetch+parse via rss-parser is
//     simpler and avoids the Composio dependency for unauthenticated
//     sources.
//   - Recheck quarterly: if Composio adds a generic RSS toolkit, reconsider
//     this decision.
//
// Why generic + config array instead of per-source loader files: when the
// only difference between two sources is a URL and tool-name prefix, having
// one rss-loader.ts and a config array is cheaper than two parallel files
// drifting from each other. Per-source loader files become warranted when a
// source needs source-specific scraping, auth, or post-processing that
// doesn't fit a generic config.

import { z } from "zod";
import Parser from "rss-parser";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { registerIntegration } from "./registry.js";

const USER_AGENT = "Chief/0.1 (personal chief-of-staff bot)";
const FETCH_TIMEOUT_MS = 15_000;
const FULL_BODY_MAX_CHARS = 4_000;

export interface FeedSource {
  /** Integration name, also used as the tool namespace base. snake_case. */
  name: string;
  /** Human-friendly source name, used in tool descriptions. */
  displayName: string;
  /** Default feed URL. Overridable via `envVar`. */
  feedUrl: string;
  /** Env var that overrides feedUrl when set. e.g. "HN_RSS_URL". */
  envVar: string;
  /** Fast-pass tool name (lists items, no body fetch). e.g. "hn_recent". */
  fastPassTool: string;
  /** Full-fetch tool name (downloads + strips one URL). e.g. "hn_full". */
  fullFetchTool: string;
  /** True if items have a comments URL distinct from the article link (HN). */
  hasCommentsField: boolean;
  /**
   * "rss" | "atom" | "auto". rss-parser normalizes both formats to
   * `isoDate`, so this is mostly informational, but kept on the config so
   * we can override behavior if a source ships oddly-formatted dates.
   */
  dateFieldFormat: "rss" | "atom" | "auto";
  /** Integration description shown to the dispatcher. */
  description: string;
}

const FEED_SOURCES: FeedSource[] = [
  {
    name: "hn_rss",
    displayName: "Hacker News",
    feedUrl: "https://news.ycombinator.com/rss",
    envVar: "HN_RSS_URL",
    fastPassTool: "hn_recent",
    fullFetchTool: "hn_full",
    hasCommentsField: true,
    dateFieldFormat: "rss",
    description:
      "Hacker News front-page RSS. Stable for 15+ years, no API key, high tech-news density (frequent Anthropic/Claude mentions). Use hn_recent to scan, hn_full to read one article's body.",
  },
  // TODO (Anthropic RSS feed): confirmed NOT available as of 2026-05-27.
  //   - 9 candidate URLs returned HTTP 404 (curl + real browser UA + follow
  //     redirects): /news/rss.xml, /blog/feed, /feed, /news.rss,
  //     /research/feed, /rss.xml, /feed.xml, /atom.xml, /blog/rss.xml.
  //   - Zero `<link rel="alternate" type="application/rss+xml">` or
  //     `application/atom+xml` markers in the HTML of /, /news, /research,
  //     or /engineering.
  //   - Not in Composio's catalog either.
  // Recheck quarterly. If Anthropic ships a feed, append:
  // {
  //   name: "anthropic_rss",
  //   displayName: "Anthropic Blog",
  //   feedUrl: "<URL>",
  //   envVar: "ANTHROPIC_BLOG_RSS_URL",
  //   fastPassTool: "anthropic_recent",
  //   fullFetchTool: "anthropic_full",
  //   hasCommentsField: false,
  //   dateFieldFormat: "rss",
  //   description: "Anthropic's official news blog.",
  // },
];

interface FastPassItem {
  title: string;
  url: string;
  pubDate: string | null;
  isoDate: string | null;
  commentsUrl?: string | null;
}

interface RawFeedItem {
  title?: string;
  link?: string;
  pubDate?: string;
  isoDate?: string;
  comments?: string;
  guid?: string;
}

const parserCache = new Map<string, Parser<unknown, RawFeedItem>>();

function parserFor(source: FeedSource): Parser<unknown, RawFeedItem> {
  const key = source.name;
  let p = parserCache.get(key);
  if (!p) {
    p = new Parser<unknown, RawFeedItem>({
      headers: { "User-Agent": USER_AGENT },
      timeout: FETCH_TIMEOUT_MS,
      customFields: source.hasCommentsField ? { item: ["comments"] } : undefined,
    });
    parserCache.set(key, p);
  }
  return p;
}

function feedUrlFor(source: FeedSource): string {
  return process.env[source.envVar]?.trim() || source.feedUrl;
}

async function fetchFeed(source: FeedSource): Promise<RawFeedItem[]> {
  const feed = await parserFor(source).parseURL(feedUrlFor(source));
  return (feed.items ?? []) as RawFeedItem[];
}

async function fetchUrlText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

function stripHtml(html: string, maxChars = FULL_BODY_MAX_CHARS): string {
  const noScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const text = noScripts
    .replace(/<\/?(p|br|li|tr|h[1-6]|div)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n\n[truncated after ${maxChars} chars]`;
}

function parseSince(raw: unknown): Date | null {
  if (!raw) return null;
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function toFastPass(item: RawFeedItem, source: FeedSource): FastPassItem {
  const out: FastPassItem = {
    title: item.title ?? "(no title)",
    url: item.link ?? "",
    pubDate: item.pubDate ?? null,
    isoDate: item.isoDate ?? null,
  };
  if (source.hasCommentsField) {
    out.commentsUrl = item.comments ?? null;
  }
  return out;
}

export function createFeedTools(
  source: FeedSource,
  namespace = source.name,
): RuntimeTool[] {
  return [
    defineRuntimeTool(
      namespace,
      source.fastPassTool,
      `Fast pass: list ${source.displayName} feed items. Returns title, URL, pubDate, ISO date${
        source.hasCommentsField ? ", and comments URL" : ""
      } for each item. Optionally filter to items with pubDate >= \`since\` (ISO8601). Use for surfacing/scanning before drilling in. Does NOT fetch article bodies — call ${source.fullFetchTool} for that.`,
      {
        since: z
          .string()
          .optional()
          .describe(
            "ISO8601 timestamp (inclusive lower bound on pubDate). If omitted, returns all current items.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe("Maximum items to return (default 30)."),
      },
      async ({ since, limit }) => {
        try {
          const items = await fetchFeed(source);
          const sinceDate = parseSince(since);
          const filtered = sinceDate
            ? items.filter((i) => {
                const when = i.isoDate ?? i.pubDate;
                if (!when) return false;
                const t = new Date(when).getTime();
                return Number.isFinite(t) && t >= sinceDate.getTime();
              })
            : items;
          const cap = limit ?? 30;
          const out = filtered.slice(0, cap).map((i) => toFastPass(i, source));
          return runtimeText(
            JSON.stringify({ source: source.name, count: out.length, items: out }, null, 2),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return runtimeText(`[${source.name} error] ${msg}`, false);
        }
      },
    ),
    defineRuntimeTool(
      namespace,
      source.fullFetchTool,
      `For ANY article URL surfaced by ${source.fastPassTool}, USE THIS INSTEAD of WebFetch. ${source.displayName}-aware deterministic fetch: downloads the URL, strips HTML, truncates to ${FULL_BODY_MAX_CHARS} chars, returns plain text in a predictable JSON shape. WebFetch runs a model to summarize the page (extra LLM cost, variable output); ${source.fullFetchTool} is a single HTTP call with no model in the loop — cheaper, faster, consistent. Use WebFetch ONLY for follow-on URLs that did NOT come from ${source.fastPassTool}.`,
      {
        url: z
          .string()
          .url()
          .describe(`Article URL from a ${source.fastPassTool} item (the \`url\` field).`),
      },
      async ({ url }) => {
        try {
          const html = await fetchUrlText(url);
          const body = stripHtml(html);
          return runtimeText(JSON.stringify({ url, body }, null, 2));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return runtimeText(`[${source.name} error] ${msg}`, false);
        }
      },
    ),
  ];
}

export function createFeedMcp(source: FeedSource) {
  return createClaudeMcpServer(source.name, createFeedTools(source, source.name));
}

function registerFeedSource(source: FeedSource): void {
  registerIntegration({
    name: source.name,
    description: source.description,
    isEnabled: async () => true,
    createServer: async () => createFeedMcp(source),
    createTools: async () => createFeedTools(source),
  });
  console.log(`[rss] registered ${source.displayName} (${source.name})`);
}

export function registerRssIntegrations(): void {
  for (const source of FEED_SOURCES) {
    registerFeedSource(source);
  }
}

/** Exposed for tests / smoke tests. */
export function listConfiguredSources(): readonly FeedSource[] {
  return FEED_SOURCES;
}
