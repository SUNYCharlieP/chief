import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { createClaudeMcpServer } from "./runtimes/claude.js";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "./runtimes/types.js";

const NAMESPACE = "observations";

// recall_activity: read path for the observation log. Lets the dispatcher
// answer "what have I been working on / spending time on" from observed git
// activity (and competes-flags) rather than from Memory.md alone.
export function createObservationTools(): RuntimeTool[] {
  return [
    defineRuntimeTool(
      NAMESPACE,
      "recall_activity",
      "Read Charlie's recently OBSERVED activity: git commits across his repos, Linear ticket status/changes across all his projects, plus competes-flags from the morning scan. Use this to answer 'what have I been working on lately' or 'what's <project>'s state', and to ground proposals in what he's actually been doing. To judge real state, contrast the two signals where a project has both: open/blocking Linear tickets vs what the commits actually moved (the git-vs-plan gap, e.g. 'blocking bugs still open, you shipped around them'). Distinct from recall(), which reads saved memories. Returns observations newest first.",
      {
        sinceHours: z
          .number()
          .positive()
          .optional()
          .describe("Only return activity from the last N hours. Omit for the default 7-day window."),
        kind: z
          .enum([
            "git-commit",
            "competes-flag",
            "self-report",
            "linear-ticket",
            "github-issue",
            "github-pr",
            "github-release",
            "github-push",
          ])
          .optional()
          .describe("Filter to one observation kind. Omit for all kinds."),
        limit: z.number().int().positive().max(200).optional().describe("Max items (default 60)."),
      },
      async ({ sinceHours, kind, limit }) => {
        const windowHours = sinceHours ?? 24 * 7;
        const sinceMs = Date.now() - windowHours * 60 * 60 * 1000;
        const rows = await convex.query(api.observations.recent, {
          sinceMs,
          kind,
          limit: limit ?? 60,
        });
        if (rows.length === 0) {
          return runtimeText(
            JSON.stringify({
              window: `last ${windowHours}h`,
              count: 0,
              note: "No observed activity in this window. The git observer may not have recorded anything yet, or there were no commits.",
            }),
          );
        }
        const items = rows.map((r) => ({
          kind: r.kind,
          source: r.source,
          summary: r.summary,
          observedAt: new Date(r.observedAt).toISOString(),
        }));
        return runtimeText(JSON.stringify({ window: `last ${windowHours}h`, count: items.length, items }));
      },
    ),
  ];
}

export function createObservationMcp() {
  return createClaudeMcpServer(NAMESPACE, createObservationTools());
}
