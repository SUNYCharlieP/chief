import { CONTACT_BOOK, type ContactBook } from "./contacts.js";
import { screenOutbound } from "./outbound-screen.js";
import { resolveChat, sendViaApplescript, noteChiefSend } from "./imessage.js";
import { stripEmDashes } from "./text-style.js";

// Outbound-only iMessage send to an allowlisted recipient (JAR-26). Distinct
// from sendImessage(): that path is Charlie-locked (a module-global chatGuid) and
// wired into the receive/echo poll loop. This one resolves the recipient's chat
// PER CALL and sends through the stateless AppleScript helper, so it never
// touches — and is never confused by — the Charlie loop. We do NOT poll the
// recipient's thread; this is send-only.
//
// Every call is screened first (allowlist + credential backstop). A reject
// returns a safe REASON (label or pattern name), never the body. `dryRun` stops
// before the actual AppleScript send — used in tests and to prove the path
// without firing a real text.

export type SendResult =
  | { ok: true; recipient: string; dryRun: boolean }
  | { ok: false; reason: string; recipient?: string };

export async function sendToContact(
  name: string,
  text: string,
  opts: { dryRun?: boolean; book?: ContactBook } = {},
): Promise<SendResult> {
  const book = opts.book ?? CONTACT_BOOK;
  const screen = screenOutbound(book, name, text);
  if (!screen.ok) return { ok: false, reason: screen.reason };

  const { display, handle } = screen.contact;
  if (opts.dryRun) return { ok: true, recipient: display, dryRun: true };

  const chat = await resolveChat(handle);
  if (!chat) return { ok: false, reason: "no-chat-for-recipient", recipient: display };

  // Same outbound cleanup as the Charlie path: strip em/en dashes deterministically.
  const body = stripEmDashes(text);
  // Register the send for echo suppression BEFORE dispatching: if this recipient's
  // chat happens to be the one the poller watches (e.g. a self-target), the
  // is_from_me=0 receive echo must be skipped, not re-processed as an inbound
  // message. For any other recipient the poller never watches that chat, so this
  // is a harmless no-op. (NOTE: emoji/non-ASCII bodies can still slip through due
  // to a separate, pre-existing chat.db read-garble bug in the matcher.)
  noteChiefSend(body);
  await sendViaApplescript(chat.guid, body);
  return { ok: true, recipient: display, dryRun: false };
}
