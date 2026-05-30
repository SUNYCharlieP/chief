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
import { linearStatusProbe } from "./integrations/linear.js";
import { startSkillDigest, stopSkillDigest, runSkillDigest } from "./skill-digest.js";
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
import { readCalendar } from "./integrations/calendar.js";
import { api as convexApi } from "../convex/_generated/api.js";
import { convex as convexClient } from "./convex-client.js";
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
  app.use(express.json({ limit: "2mb" }));

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
      const line = await pickProactiveYoutubeLine({ commit: false });
      res.json({ line });
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

  // Chat endpoint for local testing and the debug dashboard
  app.post("/chat", async (req, res) => {
    const { conversationId, content } = req.body ?? {};
    if (!conversationId || !content) {
      res.status(400).json({ error: "conversationId and content required" });
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

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    addClient(ws);
    ws.send(JSON.stringify({ event: "hello", data: { ok: true }, at: Date.now() }));
  });

  const port = Number(process.env.PORT ?? 3456);
  server.listen(port, () => {
    console.log(`chief server listening on :${port}`);
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

  startSkillDigest().catch((err) =>
    console.error("[skill-digest] scheduler failed to start", err),
  );

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
      stopSkillDigest();
      stopYoutubeDiscover();
      void stopBrainWatcher();
      closeLocalBrowser()
        .catch(() => undefined)
        .finally(() => process.exit(signalExitCodes[sig]));
    });
  }
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(1);
});
