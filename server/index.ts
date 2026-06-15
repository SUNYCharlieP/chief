import "./env-setup.js";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { addClient } from "./broadcast.js";
import { startImessagePoller, stopImessagePoller } from "./imessage.js";
import { startBrainWatcher, stopBrainWatcher } from "./brain.js";
import { startMorningScan, stopMorningScan, runMorningScan, runMorningSurface } from "./morning-scan.js";
import { startProactiveEngagement, runProactiveCheck } from "./proactive-engagement.js";
import { startGitObserver, stopGitObserver, runGitObserver } from "./git-observer.js";
import { startLinearObserver, stopLinearObserver, runLinearObserver } from "./linear-observer.js";
import { startGithubObserver, runGithubObserver } from "./github-observer.js";
import { startJobObserver, stopJobObserver, runJobObserver } from "./job-observer.js";
import { isSlashCommand, handleSlashCommand } from "./slash-commands.js";
import { linkCardFor } from "./link-cards.js";
import { actionCardFor, approvePendingAction, rejectPendingAction } from "./pending-actions.js";
import { getDueDrill, gradeDrill, drillForceEnabled, getRepHistory } from "./drill.js";
import { authMiddleware, authStartupSummary, wsAuthAllowed } from "./auth.js";
import { processImageUpload } from "./images/upload.js";
import { linearStatusProbe } from "./integrations/linear.js";
import { stopSkillDigest, runSkillDigest } from "./skill-digest.js";
import {
  startYoutubeDiscover,
  stopYoutubeDiscover,
  runYoutubeDiscover,
  seedYoutubeSourcesFromEnv,
  type PooledCandidate,
} from "./youtube-discover.js";
import { pickProactiveYoutubeLine } from "./youtube-surface.js";
import { analyzeVideo } from "./youtube-analyze.js";
import { readReminders } from "./integrations/reminders.js";
import { apnsConfigured, sendPush, storeDeviceToken } from "./apns.js";
import { readCalendar } from "./integrations/calendar.js";
import { api as convexApi } from "../convex/_generated/api.js";
import { convex as convexClient } from "./convex-client.js";
import { getUserTimezone } from "./timezone-config.js";
import { daysBetween } from "../convex/habits/streak.js";
import { runStreakNudges } from "./habits-brief.js";
import { computeUsageStats } from "./claude-usage.js";
import { handleUserMessage } from "./interaction-agent.js";
import { loadIntegrations } from "./integrations/registry.js";
import { startCleanupLoop } from "./memory/clean.js";
import { startAutomationLoop } from "./automations.js";
import { startHeartbeatLoop } from "./heartbeat.js";
import { startConsolidationLoop } from "./consolidation.js";
import { cancelAgent, retryAgent } from "./execution-agent.js";
import { createComposioRouter } from "./composio-routes.js";
import { ensureProactiveWatcher } from "./proactive-email.js";
import { preloadLocalModel } from "./embeddings.js";
import { createMemoryRouter } from "./memory-routes.js";
import { createBrowserRouter } from "./browser-routes.js";
import { closeLocalBrowser } from "./browser/launcher.js";
import { createChangelogRouter } from "./changelog.js";
import {
  getRuntimeConfig,
  resolveModelInput,
  resolveReasoningEffortInput,
  resolveRuntimeInput,
  setCodexReasoningEffort,
  setRuntimeModel,
  setRuntimeProvider,
} from "./runtime-config.js";
import { startImageCleanup } from "./images/clean.js";

async function main() {
  await loadIntegrations();
  startCleanupLoop();
  startAutomationLoop();
  startHeartbeatLoop();
  startConsolidationLoop();
  startImageCleanup();
  // No-op when a paid embedding key is set; otherwise downloads/loads the
  // local BGE-large model in the background so the first user-facing
  // recall() doesn't pay the model-load cost.
  preloadLocalModel();

  // If a stable public URL is configured, register the Composio webhook +
  // Gmail trigger now. For ngrok-based dev, scripts/dev.mjs drives the same
  // function once the ngrok URL is known, so we skip when only the local
  // PORT default is available.
  const stableUrl = process.env.PUBLIC_URL;
  if (stableUrl && !stableUrl.includes("localhost")) {
    ensureProactiveWatcher(stableUrl).catch((err) =>
      console.error("[proactive] startup failed", err),
    );
  }

  const app = express();
  app.use(cors());
  // Composio webhook receiver must read raw bytes for HMAC verification, so
  // its body parser is mounted BEFORE the global express.json. Without this
  // ordering the JSON parser consumes the stream first and the raw buffer
  // arrives empty.
  app.use("/composio/webhook", express.raw({ type: "application/json", limit: "2mb" }));
  // Image upload reads raw bytes (any content-type; the true type is sniffed
  // from magic bytes in processImageUpload). Mounted before express.json so the
  // binary body isn't run through the JSON parser. 11mb cap = the 10mb image
  // limit plus slack; express.raw 413s anything larger before it buffers fully.
  app.use("/upload/image", express.raw({ type: "*/*", limit: "11mb" }));
  app.use(express.json({ limit: "2mb" }));

  // Single-user bearer auth (defense-in-depth behind Tailscale). Mounted after
  // the body parsers and before every route, so it covers all endpoints; /health
  // and the HMAC-verified Composio webhook are exempted inside the middleware.
  // Soft-launch by default (CHIEF_AUTH_MODE=accept): logs but never rejects.
  app.use(authMiddleware);

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "boop-agent" });
  });

  app.get("/runtime-config", async (_req, res) => {
    try {
      res.json(await getRuntimeConfig());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/runtime-config", async (req, res) => {
    try {
      const body = req.body as {
        runtime?: unknown;
        model?: unknown;
        reasoningEffort?: unknown;
      };
      let runtime =
        body.runtime === undefined
          ? undefined
          : resolveRuntimeInput(String(body.runtime));
      if (body.runtime !== undefined && !runtime) {
        res.status(400).json({ error: `Unknown runtime "${String(body.runtime)}"` });
        return;
      }

      if (runtime) {
        await setRuntimeProvider(runtime);
      }

      runtime ??= (await getRuntimeConfig()).runtime;

      if (body.model !== undefined) {
        const model = resolveModelInput(String(body.model), runtime);
        if (!model) {
          res
            .status(400)
            .json({ error: `Unknown ${runtime} model "${String(body.model)}"` });
          return;
        }
        await setRuntimeModel(model, runtime);
      }

      if (body.reasoningEffort !== undefined) {
        const effort = resolveReasoningEffortInput(String(body.reasoningEffort));
        if (!effort) {
          res.status(400).json({
            error: `Unknown Codex reasoning effort "${String(body.reasoningEffort)}"`,
          });
          return;
        }
        await setCodexReasoningEffort(effort);
      }

      res.json(await getRuntimeConfig());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.use("/composio", createComposioRouter());
  app.use("/memory", createMemoryRouter());
  app.use("/browser", createBrowserRouter());
  app.use("/changelog", createChangelogRouter());

  app.post("/agents/:id/cancel", (req, res) => {
    const ok = cancelAgent(req.params.id);
    res.json({ ok });
  });

  app.post("/consolidate", async (_req, res) => {
    try {
      const { runConsolidation } = await import("./consolidation.js");
      // Fire-and-forget so the HTTP request returns immediately.
      runConsolidation("manual").catch((err) =>
        console.error("[consolidation] manual run failed", err),
      );
      res.json({ ok: true, triggered: "manual" });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/agents/:id/retry", async (req, res) => {
    const result = await retryAgent(req.params.id);
    if (!result) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    res.json(result);
  });

  // Debug: trigger an immediate morning scan, bypassing the 5am cron.
  app.post("/scan/run", async (_req, res) => {
    try {
      const report = await runMorningScan();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Debug: trigger an immediate morning surface, bypassing the 7am cron.
  app.post("/scan/surface", async (_req, res) => {
    try {
      const report = await runMorningSurface();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Debug: trigger an immediate git-observer run, bypassing the 6h cron.
  app.post("/observe/run", async (_req, res) => {
    try {
      const report = await runGitObserver();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Debug: run the weekly skill-candidate digest (detect + surface) on demand,
  // bypassing the Sunday cron.
  app.post("/skills/digest/run", async (_req, res) => {
    try {
      const report = await runSkillDigest();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Debug: run the Linear observer on demand, bypassing the daily cron.
  app.post("/observe/linear/run", async (_req, res) => {
    try {
      const report = await runLinearObserver();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Read-only GitHub observer: fold remote issues/PRs/releases/push into the log.
  app.post("/observe/github/run", async (_req, res) => {
    try {
      res.json(await runGithubObserver());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Job-intel observer on demand, bypassing the hourly cron. NOTE: if it finds a
  // new keep and the observer is already primed, this WILL push to the phone.
  app.post("/observe/jobs/run", async (_req, res) => {
    try {
      res.json(await runJobObserver());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Build-time verification: is Linear connected, what action slugs resolved,
  // and a raw sample so we can confirm shapes before testing.
  app.get("/linear/status", async (_req, res) => {
    try {
      res.json(await linearStatusProbe());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Debug: run YouTube discovery on demand. Optional body { seedVideos: [...] }
  // injects fake candidates (each needs videoId/title/description/channelId/
  // channelTitle/url/publishedAt/source/isMustWatch) to exercise scoring + pool
  // without the Data API.
  app.post("/youtube/discover/run", async (req, res) => {
    try {
      const seed = req.body?.seedVideos as PooledCandidate[] | undefined;
      const report = await runYoutubeDiscover(Array.isArray(seed) ? seed : undefined);
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Debug: what the on-demand pull would return (held pool, ranked).
  app.post("/youtube/pull", async (_req, res) => {
    try {
      const held = await convexClient.query(convexApi.youtubeVideos.listHeld, { limit: 25 });
      res.json({ count: held.length, items: held });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Debug: run the heavy-stage analyze (pick -> transcript -> summary -> gate)
  // on demand. Body { video?: id|URL|"that", conversationId? }.
  app.post("/youtube/analyze/run", async (req, res) => {
    try {
      const video = typeof req.body?.video === "string" ? req.body.video : "";
      const conversationId =
        typeof req.body?.conversationId === "string" ? req.body.conversationId : "test:yt-analyze";
      const report = await analyzeVideo(conversationId, video);
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Debug: read the calendar snapshot (read-only, full detail).
  app.post("/calendar/read", async (_req, res) => {
    try {
      res.json(await readCalendar());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Debug: read Apple Reminders (read-only) with full multi-store detail.
  app.post("/reminders/read", async (_req, res) => {
    try {
      res.json(await readReminders());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Debug: the proactive 7am line that would fire (read-only, no commit/send).
  app.post("/youtube/proactive/preview", async (_req, res) => {
    try {
      const pick = await pickProactiveYoutubeLine();
      res.json({ line: pick?.line ?? null });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Debug: force a proactive-engagement tick. Respects EVERY structural gate.
  // Body may pass {dryRun, dateOverride, nowOverride} for gate testing; dryRun
  // runs the gates + LLM but never sends or mutates state.
  app.post("/proactive/check", async (req, res) => {
    try {
      const b = (req.body ?? {}) as { dryRun?: boolean; dateOverride?: string; nowOverride?: string };
      const result = await runProactiveCheck({
        dryRun: b.dryRun,
        dateOverride: b.dateOverride,
        nowOverride: b.nowOverride ? new Date(b.nowOverride) : undefined,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Chat endpoint for local testing and the debug dashboard.
  //
  // The iOS app channel (conversationId "app:*") goes async: a long turn (e.g.
  // 75s video analysis) blows past the app's ~30s socket timeout, so the app
  // gives up even though the reply lands in Convex. Instead we ack with a fast
  // 202, process the turn in the background, persist the assistant reply (as
  // before), and fire a push so the app knows to pull GET /messages. Any other
  // caller keeps the synchronous reply-in-body contract.
  app.post("/chat", async (req, res) => {
    const { conversationId, content } = req.body ?? {};
    if (!conversationId || !content) {
      res.status(400).json({ error: "conversationId and content required" });
      return;
    }

    if (isAppChannel(conversationId)) {
      res.status(202).json({ accepted: true });
      void processAppTurn(conversationId, content);
      return;
    }

    try {
      const reply = await handleUserMessage({
        conversationId,
        content,
        persistAssistantReply: true,
      });
      res.json({ reply });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err) });
    }
  });

  // Photo upload (app channel). Behind the global bearer auth like everything
  // else. Receives a single image as a raw body, validates + (HEIC→JPEG)
  // converts + stores it via processImageUpload, then runs the analysis turn
  // ASYNC (202 ack, model vision in the background, push when done) — same
  // transport as /chat. The uploaded bytes are never served back or executed.
  //
  //   POST /upload/image?conversationId=app:charlie&caption=<urlencoded question>
  //   Authorization: Bearer <token>
  //   Content-Type: image/jpeg | image/png | image/webp | image/heic
  //   body: raw image bytes (<= 10MB)
  // -> 202 {accepted, storageId, mediaType, converted}; the analysis arrives as
  //    an assistant message via GET /messages (+ push), like any turn.
  app.post("/upload/image", async (req, res) => {
    const conversationId = String(req.query.conversationId ?? "");
    if (!conversationId || !isAppChannel(conversationId)) {
      res.status(400).json({ error: "conversationId (app channel, e.g. app:charlie) required" });
      return;
    }
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(415).json({ error: "expected a raw image body (jpeg/png/webp/heic)" });
      return;
    }
    const caption =
      (typeof req.query.caption === "string" ? req.query.caption : req.header("x-image-caption")) ?? "";

    const result = await processImageUpload(body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.reason });
      return;
    }
    res.status(202).json({
      accepted: true,
      storageId: result.storageId,
      mediaType: result.mediaType,
      converted: result.converted,
    });
    // Default question if the user sent the photo with no caption.
    const question =
      caption.trim() ||
      "Analyze this image. Read any visible text/specs/labels and tell me what matters.";
    void processAppTurn(conversationId, question, [
      { storageId: result.storageId, mediaType: result.mediaType },
    ]);
  });

  // --- iOS app transport (built alongside iMessage; no cutover yet) -------

  // Draft-and-ask: approve/reject a pending action by id. The action executes
  // ONLY here, on explicit approval — never on creation. Identity-tied: the
  // actionId must be the conversation's active pending action.
  app.post("/actions/approve", async (req, res) => {
    const { conversationId, actionId } = req.body ?? {};
    if (!conversationId || !actionId) {
      res.status(400).json({ error: "conversationId and actionId required" });
      return;
    }
    try {
      res.json(await approvePendingAction(String(conversationId), String(actionId)));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/actions/reject", async (req, res) => {
    const { conversationId, actionId } = req.body ?? {};
    if (!conversationId || !actionId) {
      res.status(400).json({ error: "conversationId and actionId required" });
      return;
    }
    try {
      res.json(await rejectPendingAction(String(conversationId), String(actionId)));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // --- Three-Link Drill (JAR-40) ------------------------------------------
  // /drill/start surfaces one due concept; the model answer is NOT in the
  // payload (it doesn't exist yet). `force` is read ONLY from the env here,
  // never from the body, so a real build can't surface a concept off due date.
  app.post("/drill/start", async (_req, res) => {
    try {
      const drill = await getDueDrill(drillForceEnabled());
      res.json(drill ? { drill } : { none: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // /drill/grade grades the spoken transcript on structure, generates the model
  // answer fresh (only now), bumps the spacing, saves the rep, and returns the
  // grade + the now-revealed answer.
  app.post("/drill/grade", async (req, res) => {
    const { conceptId, domain, concept, transcript, audioRef } = req.body ?? {};
    if (!conceptId || !domain || !concept || typeof transcript !== "string") {
      res.status(400).json({ error: "conceptId, domain, concept, transcript required" });
      return;
    }
    try {
      res.json(
        await gradeDrill(
          { conceptId: String(conceptId), domain: String(domain), concept: String(concept) },
          transcript,
          typeof audioRef === "string" && audioRef ? audioRef : undefined,
        ),
      );
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // /drill/history prunes reps past the 90-day window (returning the audioRefs
  // whose local files the app should delete) and lists the survivors newest-first.
  app.get("/drill/history", async (_req, res) => {
    try {
      res.json(await getRepHistory());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // --- Habit tracker (JAR-3 persistence bridge) ---------------------------
  // Thin transport over convex/habits/functions.ts. This layer owns the
  // user's timezone: a habit day is a wall-clock day, and Convex runs in UTC,
  // so `today` is computed here and passed down.

  // Local calendar date (YYYY-MM-DD) of an instant in the user's timezone.
  // All tz->date conversion for habits lives here (Convex runs UTC).
  const localDateOf = async (instant: Date): Promise<string> => {
    const tz = await getUserTimezone();
    // en-CA renders ISO-style YYYY-MM-DD (same idiom as briefing.ts).
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);
  };
  const habitToday = (): Promise<string> => localDateOf(new Date());

  app.get("/habits", async (_req, res) => {
    try {
      const today = await habitToday();
      const habits = await convexClient.query(convexApi.habits.functions.list, { today });
      // Fold createdAt + firstLoggedDate into a tz-correct startDate (same rule
      // as detail) so the card grid can start at the habit's creation, never
      // before. Floor at the first logged day for backfill-before-creation.
      const withStart = await Promise.all(
        habits.map(async (h: { createdAt: number; firstLoggedDate: string | null }) => {
          const createdDate = await localDateOf(new Date(h.createdAt));
          const startDate =
            h.firstLoggedDate && h.firstLoggedDate < createdDate ? h.firstLoggedDate : createdDate;
          return { ...h, startDate };
        }),
      );
      res.json({ today, habits: withStart });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Detail view for one habit. window ∈ {30,90,180} (default 30). Express owns
  // the timezone: it turns the habit's createdAt into the local startDate, then
  // daysTracked (span through today) and completionRate (= completions /
  // daysTracked — the honest-mirror denominator: untracked days count). Streaks
  // and the window math come pre-computed from Convex.
  app.get("/habits/:id/detail", async (req, res) => {
    // Loosely typed like the req.body-derived habitId in the other habit routes;
    // Convex's v.id validator is the real check at the mutation/query boundary.
    const habitId: any = req.params.id;
    let window = Number(req.query.window);
    if (window !== 30 && window !== 90 && window !== 180) window = 30;
    try {
      const today = await habitToday();
      const d = await convexClient.query(convexApi.habits.functions.detail, { habitId, today, window });
      if (!d) {
        res.status(404).json({ error: "habit not found" });
        return;
      }
      // Span floors at the earlier of createdAt and the first logged day —
      // a day backfilled before the habit was created still counts as tracked,
      // and the rate can never exceed 100%. Lexical min == chronological for
      // YYYY-MM-DD.
      const createdDate = await localDateOf(new Date(d.createdAt));
      const startDate =
        d.firstLoggedDate && d.firstLoggedDate < createdDate ? d.firstLoggedDate : createdDate;
      const daysTracked = daysBetween(startDate, today) + 1; // inclusive span
      const completionRate = daysTracked > 0 ? Math.round((d.completions / daysTracked) * 100) : 0;
      res.json({
        habit: { ...d.habit, startDate },
        lifetime: {
          daysTracked,
          completions: d.completions,
          completionRate,
          currentStreak: d.currentStreak,
          bestStreak: d.bestStreak,
        },
        window: { days: window, grid: d.grid, weekday: d.weekday, best: d.best, worst: d.worst },
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/habits", async (req, res) => {
    const { name, icon, source } = req.body ?? {};
    if (typeof name !== "string" || !name.trim() || typeof icon !== "string" || !source?.type) {
      res.status(400).json({ error: "name, icon, and source { type, ... } required" });
      return;
    }
    try {
      // The schema's closed-union validator is the real wall for source shape;
      // a malformed metric/comparator/threshold is rejected at write time.
      const id = await convexClient.mutation(convexApi.habits.functions.create, { name, icon, source });
      res.json({ id });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Manual habit day-setter, backed by setDay. Path is legacy-named "log"
  // (shipped builds 14/15 post completed|missed here for the done bar and
  // mark-yesterday); the rebuilt repair UI uses the same route and also posts
  // "unknown" to clear a day. date defaults to today. Window enforced server-
  // side in setDay.
  app.post("/habits/log", async (req, res) => {
    const { habitId, date, status } = req.body ?? {};
    if (!habitId || (status !== "completed" && status !== "missed" && status !== "unknown")) {
      res.status(400).json({ error: "habitId and status (completed|missed|unknown) required" });
      return;
    }
    try {
      const today = await habitToday();
      const id = await convexClient.mutation(convexApi.habits.functions.setDay, {
        habitId,
        date: typeof date === "string" ? date : today,
        today,
        status,
      });
      res.json({ id });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Metrics ingest (step 2). The app POSTs HealthKit-derived readings for the
  // trailing window's PAST days; the server resolves each active auto habit.
  // Body: { days: [{ date: "YYYY-MM-DD", readings: { metricKey: number } }] }.
  app.post("/habits/metrics", async (req, res) => {
    const { days } = req.body ?? {};
    if (!Array.isArray(days)) {
      res.status(400).json({ error: "days (array of { date, readings }) required" });
      return;
    }
    try {
      const today = await habitToday();
      const result = await convexClient.mutation(convexApi.habits.functions.recordMetrics, {
        today,
        days,
      });
      res.json(result);
      // Event-driven streak-break nudge — fires off the resolved data, after
      // the response. Failures are swallowed (a nudge must never break ingest).
      runStreakNudges(today).catch((err) =>
        console.warn(`[habits] streak nudge failed: ${String(err)}`),
      );
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Persist drag-reorder: body { habitIds: [...] } in the new top-to-bottom order.
  app.post("/habits/reorder", async (req, res) => {
    const { habitIds } = req.body ?? {};
    if (!Array.isArray(habitIds)) {
      res.status(400).json({ error: "habitIds (ordered array) required" });
      return;
    }
    try {
      await convexClient.mutation(convexApi.habits.functions.reorder, { habitIds });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/habits/archive", async (req, res) => {
    const { habitId } = req.body ?? {};
    if (!habitId) {
      res.status(400).json({ error: "habitId required" });
      return;
    }
    try {
      await convexClient.mutation(convexApi.habits.functions.archive, { habitId });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Claude Code usage stats (JAR-19), aggregated from the local ~/.claude
  // session logs. Read-only display feed for the app's usage card — NOT a habit
  // (no setDay/metric/log). mtime-cached so it doesn't reparse ~2k log files per
  // request. America/New_York day/hour buckets, same tz discipline as habits.
  app.get("/usage", (_req, res) => {
    try {
      res.json(computeUsageStats());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // The app registers its APNs device token here.
  app.post("/push/register", async (req, res) => {
    const { token, platform, env } = req.body ?? {};
    if (!token || typeof token !== "string") {
      res.status(400).json({ error: "token (string) required" });
      return;
    }
    try {
      await storeDeviceToken(token, platform, env);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Fire a test push. With an explicit/stored token it sends for real; with no
  // token available it probes a placeholder so a BadDeviceToken response proves
  // the JWT/keyId/teamId/topic/HTTP2 handshake (everything but the token) works.
  app.post("/push/test", async (req, res) => {
    if (!apnsConfigured()) {
      res.status(503).json({ ok: false, configured: false, error: "APNs not configured" });
      return;
    }
    const { token, title, body } = req.body ?? {};
    const t = title ?? "Chief";
    const b = body ?? "Test push from the Chief server.";
    let result = await sendPush(t, b, typeof token === "string" ? token : undefined);
    if (!token && result.error === "no device token registered") {
      result = await sendPush(t, b, "0".repeat(64));
      res.json({ ...result, note: "no real device token stored; probed a placeholder to verify credentials" });
      return;
    }
    res.json(result);
  });

  // The iOS app's history sync. Exposes Convex messages.list as the app's exact
  // contract: { messages: [{ id, role, content, at, video? }] } ascending by at
  // (epoch ms), with `since` as an at-cursor (rows strictly newer than it).
  // `video` is an optional { id, title, channel, url } on messages that surface
  // a YouTube video (see attachVideo); absent on every other message.
  app.get("/messages", async (req, res) => {
    const conversationId = String(req.query.conversationId ?? "");
    if (!conversationId) {
      res.status(400).json({ error: "conversationId required" });
      return;
    }
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const sinceRaw = req.query.since;
    const since = sinceRaw != null ? Number(sinceRaw) : null;
    try {
      const rows = await convexClient.query(convexApi.messages.list, { conversationId, limit });
      let messages = rows.map((r) => ({
        id: r._id,
        role: r.role,
        content: r.content,
        at: Math.round(r._creationTime),
        // Terminal reply of a turn. The app keeps its working animation up until
        // it polls a complete=true assistant message (poll-reliable, independent
        // of push). Absent/false on intermediate progress messages.
        complete: r.complete ?? false,
        // Carried through so enrichMessage can turn a draft-tagged message into a
        // copy card; the app ignores the field itself.
        kind: r.kind,
      }));
      if (since != null && !Number.isNaN(since)) {
        messages = messages.filter((m) => m.at > since);
      }
      messages.sort((a, b) => a.at - b.at);
      // Enrich the final set (post-filter) with structured video metadata so the
      // app's video card can show the real title + channel instead of "YouTube
      // video". A message "surfaces" a video when it carries a watch URL (either
      // side of the conversation); we look the id up in the metadata the server
      // already keeps from youtube-discover/analyze. Additive: `video` is present
      // only on surface messages we have metadata for; the {id, role, content,
      // at} shape is unchanged for everything else.
      const enriched = (await Promise.all(messages.map(enrichMessage))) as Array<Record<string, unknown>>;
      // Surface the conversation's single active (pending, unexpired) action as an
      // "action" card on its draft message — the LATEST assistant reply at/after it
      // was staged — so the app can render approve/reject. Latest, not first:
      // some actions (e.g. job.draft_application) stage a card message and then a
      // separate prompt message; the action binds to the prompt, leaving the card
      // (the job match) intact. Identity-tied: the app sends the actionId back,
      // which must still be the active one.
      const activeAction = await convexClient.query(convexApi.pendingActions.getActive, { conversationId });
      if (activeAction) {
        const candidates = enriched.filter(
          (m) => m.role === "assistant" && typeof m.at === "number" && (m.at as number) >= activeAction.createdAt - 1000,
        );
        const target = candidates[candidates.length - 1];
        if (target) target.card = actionCardFor(activeAction);
      }
      res.json({ messages: enriched });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  const server = createServer(app);
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient: (info: { req: import("node:http").IncomingMessage }) => wsAuthAllowed(info.req),
  });
  wss.on("connection", (ws) => {
    addClient(ws);
    ws.send(JSON.stringify({ event: "hello", data: { ok: true }, at: Date.now() }));
  });

  const port = Number(process.env.PORT ?? 3456);
  server.listen(port, () => {
    console.log(`chief server listening on :${port}`);
    console.log(`  ${authStartupSummary()}`);
    console.log(`  health      GET  http://localhost:${port}/health`);
    console.log(`  chat        POST http://localhost:${port}/chat`);
    console.log(`  imessage    poller (CHIEF_CONTACT=${process.env.CHIEF_CONTACT ?? "<unset>"})`);
    console.log(`  websocket   WS   ws://localhost:${port}/ws`);
  });

  startBrainWatcher().catch((err) =>
    console.error("[brain] watcher failed to start", err),
  );

  startImessagePoller().catch((err) =>
    console.error("[imessage] poller failed to start", err),
  );

  startMorningScan().catch((err) =>
    console.error("[morning-scan] scheduler failed to start", err),
  );

  startProactiveEngagement().catch((err) =>
    console.error("[proactive] scheduler failed to start", err),
  );

  startGitObserver();

  startLinearObserver();

  startGithubObserver();

  startJobObserver();

  // JAR-16: the weekly iMessage skill digest is RETIRED. Skill detection now
  // runs inside the morning brief (runSkillMining + a draft-and-ask card on
  // app:charlie), with the digest's sweepSurfaced housekeeping folded in there.
  // startSkillDigest() is intentionally no longer scheduled.

  seedYoutubeSourcesFromEnv()
    .then(() =>
      startYoutubeDiscover().catch((err) =>
        console.error("[youtube-discover] scheduler failed to start", err),
      ),
    )
    .catch((err) => console.error("[youtube] seed failed", err));

  const signalExitCodes = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 } as const;
  let shuttingDown = false;
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      stopImessagePoller();
      stopMorningScan();
      stopGitObserver();
      stopLinearObserver();
      stopJobObserver();
      stopSkillDigest();
      stopYoutubeDiscover();
      void stopBrainWatcher();
      closeLocalBrowser()
        .catch(() => undefined)
        .finally(() => process.exit(signalExitCodes[sig]));
    });
  }
}

// The iOS app talks on conversationId "app:<user>" (e.g. "app:charlie"). That
// channel is the one we run asynchronously — everything else (debug dashboard,
// iMessage transport) stays synchronous.
function isAppChannel(conversationId: string): boolean {
  return conversationId.startsWith("app:");
}

// Run an app turn in the background after the route already acked with 202.
// handleUserMessage still persists the assistant reply to Convex (so GET
// /messages returns it); once it resolves we fire a push to tell the app the
// reply is ready to pull. Nothing awaits this, so it must never throw.
async function processAppTurn(
  conversationId: string,
  content: string,
  images?: Array<{ storageId: string; mediaType: string }>,
): Promise<void> {
  try {
    // App-channel messages starting with "/" are commands, routed to a handler
    // instead of the LLM (see slash-commands.ts). An image turn always goes to
    // the model (vision), never the slash router.
    const useSlash = !(images && images.length > 0) && isSlashCommand(content);
    const reply = useSlash
      ? await handleSlashCommand(conversationId, content)
      : await handleUserMessage({ conversationId, content, persistAssistantReply: true, images });
    if (apnsConfigured()) {
      // Mark this as the turn-complete push so the app can tell the real
      // done-state apart from intermediate progress (which never pushes) and
      // keep its "working" animation up across the whole turn.
      const result = await sendPush("Chief", pushPreview(reply), undefined, {
        event: "turn_complete",
        conversationId,
      });
      if (!result.ok) {
        console.error("[app] push after reply failed:", result.error ?? result.reason ?? result);
      }
    }
  } catch (err) {
    console.error(`[app] background turn for ${conversationId} failed:`, err);
    // Don't leave the app spinning forever (the working animation runs until it
    // polls a complete=true reply). Persist a terminal failure reply so the
    // animation stops and Charlie gets actionable feedback, then push. Both are
    // best-effort and self-guarded: this handler must never throw, and the
    // persist itself can fail if the backend (Convex) is still down — in which
    // case the app falls back to its poll deadline as before.
    const failureReply =
      "Something glitched on my end and I couldn't finish that (a backend hiccup). Please try again.";
    try {
      await convexClient.mutation(convexApi.messages.send, {
        conversationId,
        role: "assistant",
        content: failureReply,
        complete: true,
      });
    } catch (persistErr) {
      console.error(`[app] could not persist failure reply for ${conversationId}:`, persistErr);
    }
    if (apnsConfigured()) {
      try {
        await sendPush("Chief", failureReply, undefined, { event: "turn_complete", conversationId });
      } catch (pushErr) {
        console.error(`[app] failure push for ${conversationId} failed:`, pushErr);
      }
    }
  }
}

// Collapse a reply into a short single-line push body. APNs truncates long
// alerts anyway; the app pulls the full message from GET /messages.
function pushPreview(reply: string): string {
  const flat = reply.replace(/\s+/g, " ").trim();
  if (!flat) return "Your reply is ready.";
  return flat.length > 180 ? `${flat.slice(0, 177)}…` : flat;
}

// --- Video metadata for the app's video card -----------------------------

interface VideoMeta { id: string; title: string; channel: string; url: string }

// Pull the first YouTube video id out of message text. Anchored on YouTube
// hosts so a stray "v=..." elsewhere can't false-positive.
function extractYouTubeId(text: string): string | null {
  const patterns = [
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/(?:watch\?(?:[^\s]*&)?v=|embed\/|shorts\/|live\/|v\/)([A-Za-z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

// Titles/channels are immutable once known, so we cache only fully-populated
// hits forever. A partial hit (title but no channel yet — e.g. an old analysis
// row predating the channel capture) is returned but NOT cached, so a later
// re-analysis can still surface the channel.
const videoMetaCache = new Map<string, VideoMeta>();

async function lookupVideoMeta(videoId: string): Promise<VideoMeta | null> {
  const cached = videoMetaCache.get(videoId);
  if (cached) return cached;
  let title = "", channel = "", url = "";
  try {
    // youtubeAnalysis covers interactively pulled/pasted videos (the app's main
    // case); youtubeVideos backfills title/channel for discover-surfaced picks.
    const an = await convexClient.query(convexApi.youtubeAnalysis.get, { videoId });
    if (an) { title = an.title || ""; channel = an.channelTitle || ""; url = an.url || ""; }
    if (!title || !channel) {
      const vid = await convexClient.query(convexApi.youtubeVideos.get, { videoId });
      if (vid) {
        title = title || vid.title || "";
        channel = channel || vid.channelTitle || "";
        url = url || vid.url || "";
      }
    }
  } catch {
    return null;
  }
  if (!title) return null;
  const meta: VideoMeta = { id: videoId, title, channel, url: url || `https://www.youtube.com/watch?v=${videoId}` };
  if (title && channel) videoMetaCache.set(videoId, meta);
  return meta;
}

// Attach `video` to a message that surfaces a YouTube watch URL, if the server
// has metadata for it. The link can sit on either side — Chief's proactive
// "worth a watch" line or Charlie's "pull this <url>" — and the app renders the
// card on whichever message carries it, so we don't gate on role. Returns the
// message untouched when there's no link or no known metadata.
async function attachVideo<T extends { content: string }>(
  msg: T,
): Promise<T | (T & { video: VideoMeta })> {
  const id = extractYouTubeId(msg.content);
  if (!id) return msg;
  const video = await lookupVideoMeta(id);
  return video ? { ...msg, video } : msg;
}

// Human label for a draft message's `kind` (the block header in the app's draft
// card). New draft kinds add an entry; unknown ones fall back to "draft".
const DRAFT_LABELS: Record<string, string> = {
  "draft.application": "application framing",
};

// Enrich a message for the app: a copyable draft (kind="draft.*") becomes a
// "draft" card the app renders with a one-tap copy; a YouTube message gets video
// metadata; otherwise a message with plain URL(s) gets a rich link card. All are
// additive — the message `content` is unchanged.
async function enrichMessage<T extends { content: string }>(msg: T): Promise<object> {
  const kind = (msg as { kind?: string }).kind;
  if (kind && kind.startsWith("draft")) {
    return {
      ...msg,
      card: { type: "draft", title: DRAFT_LABELS[kind] ?? "draft", text: msg.content },
    };
  }
  const withVideo = await attachVideo(msg);
  if ("video" in withVideo) return withVideo;
  const card = await linkCardFor(msg.content);
  return card ? { ...msg, card } : msg;
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(1);
});
