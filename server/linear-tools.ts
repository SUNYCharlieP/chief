import { z } from "zod";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "./runtimes/types.js";
import { getIssueDetail, isLinearConnected } from "./integrations/linear.js";

// On-demand heavy tier: fetch a specific ticket's full detail. Kept OUT of the
// standing observation log so descriptions/comments never bloat per-turn
// context; only loaded when Charlie asks for a specific ticket.
export function createLinearTools(): RuntimeTool[] {
  return [
    defineRuntimeTool(
      "boop-linear",
      "get_linear_ticket",
      'Fetch full detail (description + comments + status) for a specific Linear ticket by identifier, e.g. "ARC-42". Use when Charlie asks to see a ticket or its detail ("show me ARC-42", "what\'s the detail on X"). The standing observation log only carries status+title, so reach for this when he wants the actual content. Do not call it just to know a ticket\'s status (recall_activity already has that).',
      { identifier: z.string().describe('Linear ticket identifier, e.g. "ARC-42".') },
      async ({ identifier }) => {
        if (!(await isLinearConnected())) {
          return runtimeText("Linear isn't connected via Composio.", false);
        }
        const d = await getIssueDetail(identifier);
        if (!d) return runtimeText(`No Linear ticket found matching "${identifier}".`, false);
        return runtimeText(
          JSON.stringify(
            {
              identifier: d.issue.identifier,
              title: d.issue.title,
              status: d.issue.status,
              project: d.issue.project,
              url: d.issue.url,
              description: d.description,
              comments: d.comments,
            },
            null,
            2,
          ),
        );
      },
    ),
  ];
}
