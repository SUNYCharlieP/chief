import { Cron } from "croner";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { sendImessage } from "./imessage.js";
import { getUserTimezone } from "./timezone-config.js";
import { runSkillDetector, type DetectReport } from "./skill-detector.js";

// Stage B weekly digest. One job: sweep last cycle's un-picked candidates to
// declined, run detection, then surface up to MAX collected candidates as a
// short numbered iMessage. The user's reply (picking numbers) is handled by the
// dispatcher, which feeds each pick into the Stage A flow.

const DIGEST_CRON = process.env.CHIEF_SKILL_DIGEST_CRON ?? "0 18 * * 0"; // Sun 18:00
const MAX_CANDIDATES = Number(process.env.CHIEF_SKILL_MAX_CANDIDATES ?? 5);

let digestCron: Cron | null = null;

export interface DigestReport {
  swept: number;
  detection: DetectReport;
  surfaced: number;
  sentTo: string | null;
  message: string | null;
  reason?: string;
}

export async function runSkillDigest(): Promise<DigestReport> {
  // 1. Prior-cycle surfaced-but-not-picked -> declined (suppress resurfacing).
  const { swept } = await convex.mutation(api.skillCandidates.sweepSurfaced, {});

  // 2. Detect (upserts collected; dedupes against Skills.md internally).
  const detection = await runSkillDetector();

  // 3. Take collected, cap, surface.
  const collected = await convex.query(api.skillCandidates.listByStatus, {
    status: "collected",
    limit: 50,
  });
  const toSurface = collected.slice(0, MAX_CANDIDATES);

  if (toSurface.length === 0) {
    return {
      swept,
      detection,
      surfaced: 0,
      sentTo: null,
      message: null,
      reason:
        detection.observationsScanned === 0
          ? "no non-excluded git observations in window"
          : "no new patterns cleared the bar (or all covered by existing skills)",
    };
  }

  const now = Date.now();
  for (let i = 0; i < toSurface.length; i++) {
    await convex.mutation(api.skillCandidates.setStatus, {
      candidateId: toSurface[i].candidateId,
      status: "surfaced",
      surfaceOrder: i + 1,
      surfacedAt: now,
    });
  }

  const lines = toSurface.map((c, i) => `${i + 1}. ${c.rationale}`);
  const message = `Skill candidates I noticed this week:\n\n${lines.join("\n")}\n\nReply with the numbers to draft (e.g. "1, 3"), or "none".`;

  const contact = process.env.CHIEF_CONTACT ?? "";
  if (contact) {
    await sendImessage(contact, message);
    // Persist so the dispatcher has the numbered list in history when the user
    // replies with picks.
    await convex.mutation(api.messages.send, {
      conversationId: `sms:${contact}`,
      role: "assistant",
      content: message,
    });
  }

  return {
    swept,
    detection,
    surfaced: toSurface.length,
    sentTo: contact || null,
    message,
  };
}

export async function startSkillDigest(): Promise<void> {
  if (digestCron) {
    console.warn("[skill-digest] already started");
    return;
  }
  const timezone = (await getUserTimezone()) ?? "UTC";
  digestCron = new Cron(DIGEST_CRON, { timezone }, async () => {
    try {
      const report = await runSkillDigest();
      console.log(
        `[skill-digest] tick: swept=${report.swept} detected=${report.detection.created} surfaced=${report.surfaced}`,
      );
    } catch (err) {
      console.error("[skill-digest] tick error", err);
    }
  });
  console.log(`[skill-digest] scheduled: cron=${DIGEST_CRON} tz=${timezone}`);
}

export function stopSkillDigest(): void {
  if (digestCron) {
    digestCron.stop();
    digestCron = null;
  }
}
