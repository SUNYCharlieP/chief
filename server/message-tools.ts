import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "./runtimes/types.js";
import { CONTACT_BOOK } from "./contacts.js";
import { screenOutbound } from "./outbound-screen.js";
import { stakesForKind } from "../convex/pendingActionKinds.js";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Draft-and-ask tool for sending an iMessage to someone OTHER than Charlie
// (JAR-26). High-stakes: it goes to a real third party, so it requires explicit
// approval and renders as a modal. The recipient must be on the allowlist —
// that is the ONLY path, enforced here at stage time and again at execute.
export function createMessageTools(conversationId: string): RuntimeTool[] {
  return [
    defineRuntimeTool(
      "boop-message",
      "stage_message",
      `Stage an iMessage to send to someone OTHER than Charlie (e.g. his wife). HIGH-STAKES: it goes to a real person, requires Charlie's explicit approval, and sends ONLY on his yes. Address the recipient BY NAME (e.g. "wife"); they must be on Charlie's allowlist — you cannot text arbitrary people, and an off-allowlist name is refused. Draft the exact message text. After staging, show Charlie the recipient + exact text and ask for a yes. Never claim it was sent before he confirms.`,
      {
        recipient: z.string().describe('Who to send to, by name — must be on the allowlist, e.g. "wife".'),
        text: z.string().describe("The exact message body to send."),
      },
      async ({ recipient, text }) => {
        // Screen at stage: the allowlist (only path) + the credential backstop. A
        // miss is rejected AND logged (append-only, reason only), and NO card is
        // created — we never surface an approvable action for a refused recipient.
        const screen = screenOutbound(CONTACT_BOOK, recipient, text);
        if (!screen.ok) {
          await convex
            .mutation(api.auditLog.recordDecision, {
              source: "message.send",
              outcome: "rejected",
              reason: screen.reason,
              recipient,
            })
            .catch(() => {});
          const why =
            screen.reason === "recipient-not-allowlisted"
              ? `"${recipient}" isn't on Charlie's allowlist, so I can't text them. Only people he has added can be messaged.`
              : `that message looks like it contains a credential (${screen.reason}); I won't send it.`;
          return runtimeText(`Not staged: ${why}`, false);
        }
        const actionId = randomId("pa");
        const now = Date.now();
        // Persist the recipient NAME + display + text — never the raw handle. The
        // handle is re-resolved through the allowlist at execute time.
        await convex.mutation(api.pendingActions.create, {
          actionId,
          conversationId,
          kind: "message.send",
          stakes: stakesForKind("message.send"),
          pitch: "",
          entry: JSON.stringify({ recipientName: recipient, display: screen.contact.display, text }),
          targetFile: "",
          sha256: "",
          createdAt: now,
          expiresAt: now + 30 * 60 * 1000,
        });
        return runtimeText(
          `Staged message (HIGH-STAKES, needs explicit approval). Show Charlie this exact draft and ask for a yes:\n  To: ${screen.contact.display}\n  Message: ${text}\nThen end with: Reply "yes" to send it (anything else cancels). Do NOT claim it's sent; it goes only on his yes.`,
        );
      },
    ),
  ];
}
