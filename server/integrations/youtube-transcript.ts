import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Transcript + metadata via yt-dlp (keyless, on the Chief server). The naive
// dependency-free timedtext fetch is dead (YouTube returns empty without a
// proof-of-origin token), so we offload the brittleness to yt-dlp, which tracks
// YouTube's changes and self-updates. Requires a one-time `brew install yt-dlp`
// on the Chief Mac; if it's absent or fails, callers fall back to description.

// Absolute path by default: the launchd-spawned Chief server doesn't inherit
// Homebrew's bin on PATH, so a bare "yt-dlp" would ENOENT and silently fall
// back to no-transcript. Override with CHIEF_YTDLP_PATH if installed elsewhere.
const YTDLP = process.env.CHIEF_YTDLP_PATH ?? "/opt/homebrew/bin/yt-dlp";
const TIMEOUT_MS = 60_000;

export interface VideoData {
  title: string;
  channel: string;
  description: string;
  chapters: string[];
  transcriptStatus: "full" | "none";
  transcript: string;
}

function run(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP,
      args,
      {
        timeout: TIMEOUT_MS,
        maxBuffer: 24 * 1024 * 1024,
        cwd,
        // yt-dlp shells out to deno/node to solve YouTube's JS challenge for
        // sub downloads. The launchd-spawned server's PATH lacks Homebrew bin,
        // so without this the challenge fails silently and no subs download
        // (metadata still works, masking it as "no transcript"). Put Homebrew
        // bin on the child's PATH so it can find deno/node.
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`,
        },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.slice(0, 300) || err.message));
        else resolve(stdout);
      },
    );
  });
}

// One yt-dlp call: dumps metadata JSON to stdout AND writes the auto/manual
// English subs as json3 to a temp dir. Returns transcript text + metadata.
// Throws only if yt-dlp itself can't run (ENOENT / failure) so callers can fall
// back; a video simply having no captions returns transcriptStatus "none".
export async function fetchVideoData(url: string): Promise<VideoData> {
  const dir = await mkdtemp(join(tmpdir(), "chief-yt-"));
  try {
    // Call 1: download subs (json3). MUST NOT include --dump-json, which
    // implies --simulate and suppresses all file writes (the bug that made
    // every fetch fall back). --skip-download skips only the video stream.
    try {
      await run(
        [
          "-q",
          "--no-warnings",
          "--skip-download",
          "--write-auto-subs",
          "--write-subs",
          "--sub-langs",
          "en.*,en",
          "--sub-format",
          "json3",
          "-o",
          join(dir, "%(id)s.%(ext)s"),
          url,
        ],
        dir,
      );
    } catch {
      /* no subs for this video, or fetch issue -> handled by fallback below */
    }

    // Call 2: metadata only (title/description/chapters). --dump-json's
    // simulate mode is fine here since we want stdout, not files.
    let meta: Record<string, unknown> = {};
    try {
      const stdout = await run(
        ["-q", "--no-warnings", "--skip-download", "--dump-json", url],
        dir,
      );
      const lastLine = stdout.trim().split("\n").pop() || "{}";
      meta = JSON.parse(lastLine) as Record<string, unknown>;
    } catch {
      /* metadata parse optional */
    }
    const title = typeof meta.title === "string" ? meta.title : "";
    // yt-dlp exposes the channel name as `channel`; `uploader` is the next-best
    // fallback (e.g. VEVO topic channels). Either gives the card a real name.
    const channel =
      typeof meta.channel === "string" && meta.channel
        ? meta.channel
        : typeof meta.uploader === "string"
          ? meta.uploader
          : "";
    const description = typeof meta.description === "string" ? meta.description : "";
    const chapters = Array.isArray(meta.chapters)
      ? (meta.chapters as Array<{ title?: string }>).map((c) => c.title ?? "").filter(Boolean)
      : [];

    let transcript = "";
    let transcriptStatus: "full" | "none" = "none";
    const files = await readdir(dir).catch(() => [] as string[]);
    const sub = files.find((f) => f.endsWith(".json3"));
    if (sub) {
      try {
        const j = JSON.parse(await readFile(join(dir, sub), "utf8")) as {
          events?: Array<{ segs?: Array<{ utf8?: string }> }>;
        };
        transcript = (j.events ?? [])
          .flatMap((e) => (e.segs ?? []).map((s) => s.utf8 ?? ""))
          .join("")
          .replace(/\s+/g, " ")
          .trim();
        if (transcript.length > 50) transcriptStatus = "full";
      } catch {
        /* sub parse failed -> treat as none */
      }
    }
    return { title, channel, description, chapters, transcriptStatus, transcript };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
