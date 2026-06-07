import { sendImessage } from "./imessage.js";
import { sendPush } from "./apns.js";
import { convex } from "./convex-client.js";
import { api } from "../convex/_generated/api.js";

// Outbound delivery for already-composed messages (morning briefing, proactive
// pings). Phase-1 cutover to the iOS app: deliver through the channels selected
// by CHIEF_DELIVERY, defaulting to BOTH so the app path runs ALONGSIDE iMessage
// (flip to "app" to drop iMessage, "imessage" to keep only the old path — one
// setting, no code change).
//
// The app path = persist the message to the app:charlie conversation (so the
// app's GET /messages returns it) + fire an APNs alert so the phone is notified.
// This reuses the same sendPush the /push path already proved.

export type DeliveryTarget = "app" | "imessage" | "both";

export function deliveryTarget(): DeliveryTarget {
  const v = (process.env.CHIEF_DELIVERY ?? "both").trim().toLowerCase();
  return v === "app" || v === "imessage" ? (v as DeliveryTarget) : "both";
}

const APP_CONVERSATION = process.env.CHIEF_APP_CONVERSATION ?? "app:charlie";

// Short single-line push body; the app pulls the full message from GET /messages.
function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "New from Chief.";
  return flat.length > 180 ? `${flat.slice(0, 177)}…` : flat;
}

export interface DeliveryResult {
  target: DeliveryTarget;
  delivered: boolean; // reached the user on at least one configured channel
  imessageSent?: boolean;
  appPersisted?: boolean;
  pushed?: boolean;
  pushReason?: string;
}

export async function deliverOutbound(opts: {
  contact: string;
  body: string;
  pushTitle?: string;
}): Promise<DeliveryResult> {
  const target = deliveryTarget();
  const res: DeliveryResult = { target, delivered: false };

  if (target === "imessage" || target === "both") {
    try {
      res.imessageSent = await sendImessage(opts.contact, opts.body);
    } catch (err) {
      res.imessageSent = false;
      console.error(`[delivery] imessage threw: ${String(err)}`);
    }
  }

  if (target === "app" || target === "both") {
    // Persist first so the app shows it on open even if the push drops.
    try {
      await convex.mutation(api.messages.send, {
        conversationId: APP_CONVERSATION,
        role: "assistant",
        content: opts.body,
      });
      res.appPersisted = true;
    } catch (err) {
      res.appPersisted = false;
      console.error(`[delivery] app persist failed: ${String(err)}`);
    }
    try {
      const push = await sendPush(opts.pushTitle ?? "Chief", preview(opts.body));
      res.pushed = push.ok;
      res.pushReason = push.ok ? "ok" : (push.reason ?? push.error);
      if (!push.ok) console.error(`[delivery] push failed: ${res.pushReason}`);
    } catch (err) {
      res.pushed = false;
      res.pushReason = String(err);
      console.error(`[delivery] push threw: ${String(err)}`);
    }
  }

  // App delivery counts as delivered once persisted (the app surfaces it on
  // open regardless of the push); iMessage counts on a confirmed send.
  res.delivered =
    target === "imessage"
      ? !!res.imessageSent
      : target === "app"
        ? !!res.appPersisted
        : !!res.imessageSent || !!res.appPersisted;

  return res;
}
