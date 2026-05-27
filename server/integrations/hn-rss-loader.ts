import { z } from "zod";
import Parser from "rss-parser";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { registerIntegration } from "./registry.js";

const MCP_NAMESPACE = "hn_rss";
const RUNTIME_NAMESPACE = "hn_rss";

const HN_RSS_URL = process.env.HN_RSS_URL ?? "https://news.ycombinator.com/rss";
const USER_AGENT = "Chief/0.1 (personal chief-of-staff bot)";
const FETCH_TIMEOUT_MS = 15_000;
const FULL_BODY_MAX_CHARS = 4_000;

interface FastPassItem {
  title: string;
  url: string;
  pubDate: string | null;
  commentsUrl: string | null;
  isoDate: string | null;
}

interface RawHnItem {
  title?: string;
  link?: string;
  pubDate?: string;
  isoDate?: string;
  comments?: string;
  guid?: string;
}

let parserInstance: Parser<unknown, RawHnItem> | null = null;
function parser(): Parser<unknown, RawHnItem> {
  if (!parserInstance) {
    parserInstance = new Parser<unknown, RawHnItem>({
      headers: { "User-Agent": USER_AGENT },
      timeout: FETCH_TIMEOUT_MS,
      customFields: { item: ["comments"] },
    });
  }
  return parserInstance;
}

async function fetchFeed(): Promise<RawHnItem[]> {
  const feed = await parser().parseURL(HN_RSS_URL);
  return (feed.items ?? []) as RawHnItem[];
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

function toFastPass(item: RawHnItem): FastPassItem {
  return {
    title: item.title ?? "(no title)",
    url: item.link ?? "",
    pubDate: item.pubDate ?? null,
    isoDate: item.isoDate ?? null,
    commentsUrl: item.comments ?? null,
  };
}

export function createHnRssTools(namespace = RUNTIME_NAMESPACE): RuntimeTool[] {
  return [
    defineRuntimeTool(
      namespace,
      "hn_recent",
      "Fast pass: list Hacker News front-page posts. Returns title, URL, pubDate, ISO date, and HN comments URL for each item. Optionally filter to items with pubDate >= `since` (ISO8601). Use for surfacing/scanning before drilling in. Does NOT fetch article bodies — call hn_full for that.",
      {
        since: z
          .string()
          .optional()
          .describe(
            "ISO8601 timestamp (inclusive lower bound on pubDate). If omitted, returns all front-page items.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe("Maximum items to return (default 30, the HN RSS feed cap)."),
      },
      async ({ since, limit }) => {
        try {
          const items = await fetchFeed();
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
          const out = filtered.slice(0, cap).map(toFastPass);
          return runtimeText(
            JSON.stringify({ count: out.length, items: out }, null, 2),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return runtimeText(`[hn_rss error] ${msg}`, false);
        }
      },
    ),
    defineRuntimeTool(
      namespace,
      "hn_full",
      "Full fetch: download the linked article URL from an hn_recent item and return its body as plain text (HTML stripped, truncated to 4000 chars). For HN-internal posts (Ask HN, Show HN), the URL is the HN discussion page and you get the HN page content. For external articles, you get the article body.",
      {
        url: z
          .string()
          .url()
          .describe("Article URL from an hn_recent item (the `url` field, not commentsUrl)."),
      },
      async ({ url }) => {
        try {
          const html = await fetchUrlText(url);
          const body = stripHtml(html);
          return runtimeText(JSON.stringify({ url, body }, null, 2));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return runtimeText(`[hn_rss error] ${msg}`, false);
        }
      },
    ),
  ];
}

export function createHnRssMcp() {
  return createClaudeMcpServer(MCP_NAMESPACE, createHnRssTools(MCP_NAMESPACE));
}

export function registerHnRssIntegration(): void {
  registerIntegration({
    name: "hn_rss",
    description:
      "Hacker News front-page RSS feed. Use to scan or surface recent posts (hn_recent), and to fetch the body of a specific linked article (hn_full). Stable RSS source that requires no API key. Phase 7 source for Chief.",
    isEnabled: async () => true,
    createServer: async () => createHnRssMcp(),
    createTools: async () => createHnRssTools(),
  });
  console.log("[hn_rss] registered Hacker News RSS integration");
}
