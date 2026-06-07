import { convex } from "./convex-client.js";
import { api } from "../convex/_generated/api.js";

// Rich link cards. When a message contains plain URL(s), we fetch each link's
// Open Graph metadata and emit a structured `card` (type "link") on GET /messages
// — same additive pattern as the video card (attachVideo). The message text is
// untouched (fallback); the card is extra.
//
// SECURITY: the fetched page HTML is UNTRUSTED DATA. We extract ONLY the OG/meta
// fields below and render them as text; page content is never interpreted as
// instructions. We also fetch http(s) only, block loopback/private hosts (light
// SSRF guard), time out, and cap the bytes read.

export interface LinkPreview {
  url: string;
  title: string;
  description?: string;
  image?: string;
  source: string; // og:site_name, else domain
}

export interface LinkCard {
  type: "link";
  links: LinkPreview[];
}

const MAX_LINKS = 6;
const FETCH_TIMEOUT_MS = 5000;
const MAX_HTML_BYTES = 512 * 1024;
const MEM_TTL_MS = 6 * 60 * 60 * 1000; // in-process positive cache
const SETTINGS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // persistent positive cache
const NEG_TTL_MS = 24 * 60 * 60 * 1000; // negative cache (failed/no-OG)

interface CacheEntry { at: number; preview: LinkPreview | null }

// In-process cache + in-flight dedupe so repeated polls never refetch. The
// Convex `settings` kv (key "ogcache:<url>") persists across restarts.
const mem = new Map<string, CacheEntry>();
const inflight = new Set<string>();

const URL_RE = /\bhttps?:\/\/[^\s<>()]+/gi;

function hostOf(u: string): string | null {
  try { return new URL(u).hostname.toLowerCase(); } catch { return null; }
}

// youtube/adzuna are rendered by the video/job cards — leave them alone.
function isSpecial(host: string): boolean {
  return /(?:^|\.)youtube\.com$|(?:^|\.)youtu\.be$|(?:^|\.)adzuna\./.test(host);
}

function isBlockedHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".local") || host === "0.0.0.0" || host === "::1") return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

// Distinct, order-preserved http(s) URLs worth carding (excludes youtube/adzuna
// and loopback/private hosts).
export function extractRichUrls(content: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of content.matchAll(URL_RE)) {
    const u = m[0].replace(/[.,);!?]+$/, ""); // trim trailing punctuation
    const host = hostOf(u);
    if (!host || isSpecial(host) || isBlockedHost(host) || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

function clean(s: string, max: number): string {
  const t = s
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function metaContent(html: string, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tag = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]*>`, "i"))?.[0];
    const c = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    if (c) return c;
  }
  return undefined;
}

async function fetchPreview(url: string): Promise<LinkPreview | null> {
  const host = hostOf(url);
  if (!host || isBlockedHost(host)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": "ChiefBot/1.0 (+link-preview)", accept: "text/html" },
    });
    if (!res.ok) return null;
    if (!/text\/html|application\/xhtml/i.test(res.headers.get("content-type") ?? "")) return null;
    const buf = await res.arrayBuffer();
    const html = Buffer.from(buf.slice(0, MAX_HTML_BYTES)).toString("utf8");
    // Extract ONLY these fields. Untrusted data -> text, never instructions.
    const title = clean(
      metaContent(html, "og:title") ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? host,
      200,
    );
    if (!title) return null;
    const description = metaContent(html, "og:description", "description");
    const image = metaContent(html, "og:image", "og:image:url", "og:image:secure_url");
    return {
      url,
      title,
      description: description ? clean(description, 400) : undefined,
      image: image && /^https?:\/\//i.test(image) ? image : undefined,
      source: clean(metaContent(html, "og:site_name") ?? host, 60),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Cached lookup: returns the preview, null (cached negative), or undefined
// (unknown — caller should trigger a background fetch and try again next poll).
async function cachedPreview(url: string): Promise<LinkPreview | null | undefined> {
  const m = mem.get(url);
  if (m && Date.now() - m.at < (m.preview ? MEM_TTL_MS : NEG_TTL_MS)) return m.preview;
  try {
    const raw = await convex.query(api.settings.get, { key: `ogcache:${url}` });
    if (raw) {
      const entry = JSON.parse(raw) as CacheEntry;
      if (Date.now() - entry.at < (entry.preview ? SETTINGS_TTL_MS : NEG_TTL_MS)) {
        mem.set(url, entry);
        return entry.preview;
      }
    }
  } catch {
    /* settings read failed; treat as unknown */
  }
  return undefined;
}

function triggerFetch(url: string): void {
  if (inflight.has(url)) return;
  inflight.add(url);
  void (async () => {
    const preview = await fetchPreview(url);
    const entry: CacheEntry = { at: Date.now(), preview };
    mem.set(url, entry);
    try {
      await convex.mutation(api.settings.set, { key: `ogcache:${url}`, value: JSON.stringify(entry) });
    } catch {
      /* persist best-effort */
    }
    inflight.delete(url);
  })();
}

// Build the link card for a message (or null). Non-blocking: uncached URLs kick
// off a background fetch and fill in on a later poll, so GET /messages never
// waits on the network. One card per message; the app renders a single link as a
// full card and multiple as a compact list.
export async function linkCardFor(content: string): Promise<LinkCard | null> {
  // A job (adzuna) message is rendered by the job card — don't also card its links.
  if (/adzuna\./i.test(content)) return null;
  const urls = extractRichUrls(content);
  if (urls.length === 0) return null;
  const capped = urls.slice(0, MAX_LINKS);
  if (urls.length > MAX_LINKS) {
    console.log(`[link-cards] ${urls.length} links in message; carding first ${MAX_LINKS}, rest stay inline`);
  }
  const links: LinkPreview[] = [];
  for (const u of capped) {
    const p = await cachedPreview(u);
    if (p === undefined) { triggerFetch(u); continue; } // appears next poll
    if (p) links.push(p);
  }
  return links.length > 0 ? { type: "link", links } : null;
}
