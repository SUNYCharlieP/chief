import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { handleUserMessage } from "./interaction-agent.js";
import { broadcast } from "./broadcast.js";
import { stripEmDashes } from "./text-style.js";

// node:sqlite is dynamic-imported inside openDb() so vitest doesn't trip on
// it when tests transitively pull this module via interaction-agent imports.
// Vite's transformer strips the `node:` prefix during resolution and then
// fails to load `sqlite`; deferring the import to first use sidesteps that.
type DatabaseSync = import("node:sqlite").DatabaseSync;

const CHAT_DB_PATH = `${homedir()}/Library/Messages/chat.db`;
const POLL_INTERVAL_MS = Number(process.env.CHIEF_POLL_INTERVAL_MS ?? 5000);
const CHIEF_CONTACT = process.env.CHIEF_CONTACT ?? "";

const MAX_CHUNK = 2900;
// Echo window has to outlast the slowest realistic turn between when Chief
// pushes a send (e.g. send_ack at T+2s) and when the poll cycle that picks
// up the receive row actually fires (poll is BLOCKED on the in-flight turn,
// not on a clock). Research turns routinely run 100+ seconds; a per-turn
// burst of 6+ web fetches has been observed at ~140s. 10 minutes is well
// above the longest observed and short enough that stale state from a
// dropped delivery doesn't poison future matches indefinitely.
const ECHO_WINDOW_MS = 600_000;
// FIFO cap on recentSends to bound memory if Messages ever silently drops
// a delivery (no receive row arrives to consume the entry). 100 is well
// above the most acks/replies one turn could ever produce.
const MAX_RECENT_SENDS = 100;
const SEND_TIMEOUT_MS = 15_000;
const POLL_BATCH_LIMIT = 100;

let db: DatabaseSync | null = null;
let chatId: number | null = null;
let chatGuid: string | null = null;
let lastSeenRowid = 0;
let polling = false;
let pollTimer: NodeJS.Timeout | null = null;

// Self-thread disambiguation: every Chief send produces a receive-side row in
// the same chat with a different guid. We can't match by guid, so we track
// (text, sentAt) for recent sends and skip the next matching receive within
// the echo window.
const recentSends: Array<{ text: string; sentAt: number }> = [];

async function openDb(): Promise<DatabaseSync> {
  if (db) return db;
  const { DatabaseSync } = await import("node:sqlite");
  db = new DatabaseSync(CHAT_DB_PATH, { readOnly: true });
  return db;
}

// Exported for the outbound-only send path (JAR-26). Stateless: it opens the
// shared read-only db and looks up a chat by handle without touching any of the
// poll-loop globals (chatGuid/chatId/recentSends), so resolving a non-Charlie
// recipient never disturbs the Charlie receive loop.
export async function resolveChat(handle: string): Promise<{ rowid: number; guid: string } | null> {
  const d = await openDb();
  const row = d
    .prepare("SELECT ROWID, guid FROM chat WHERE chat_identifier = ?")
    .get(handle) as { ROWID: number | bigint; guid: string } | undefined;
  if (!row) return null;
  return { rowid: Number(row.ROWID), guid: row.guid };
}

async function getMaxRowidForChat(cid: number): Promise<number> {
  const d = await openDb();
  const row = d
    .prepare(
      `SELECT MAX(m.ROWID) as max_rowid
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       WHERE cmj.chat_id = ?`,
    )
    .get(cid) as { max_rowid: number | bigint | null } | undefined;
  return row?.max_rowid ? Number(row.max_rowid) : 0;
}

interface PolledRow {
  ROWID: number | bigint;
  guid: string;
  text: string | null;
  is_from_me: number | bigint;
  associated_message_type: number | bigint;
  service: string | null;
}

async function pollNew(cid: number, sinceRowid: number): Promise<PolledRow[]> {
  const d = await openDb();
  // NOTE: m.date is Apple's ns-since-2001 (e.g. 8.0e17) which overflows JS
  // Number, so node:sqlite throws ERR_OUT_OF_RANGE on read. The poller
  // doesn't need date — ROWID ordering is sufficient — so we just omit it.
  // If we ever need the timestamp, switch the prepared statement to
  // setReadBigInts(true) and surface as BigInt or ISO string.
  return d
    .prepare(
      `SELECT m.ROWID, m.guid, m.text, m.is_from_me, m.associated_message_type, m.service
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       WHERE cmj.chat_id = ? AND m.ROWID > ?
       ORDER BY m.ROWID ASC
       LIMIT ?`,
    )
    .all(cid, sinceRowid, POLL_BATCH_LIMIT) as unknown as PolledRow[];
}

function pruneRecentSends(now: number): void {
  while (recentSends.length > 0 && now - recentSends[0].sentAt > ECHO_WINDOW_MS) {
    recentSends.shift();
  }
}

function isChiefEcho(text: string, now: number): boolean {
  pruneRecentSends(now);
  for (let i = 0; i < recentSends.length; i++) {
    if (recentSends[i].text === text) {
      recentSends.splice(i, 1);
      return true;
    }
  }
  return false;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?|```/g, ""))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)")
    .trim();
}

function chunk(text: string, size = MAX_CHUNK): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split(/\n/)) {
    if ((buf + "\n" + line).length > size) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// Exported for the outbound-only send path (JAR-26). Stateless: takes an explicit
// chat guid + text, so it sends to whichever chat the caller resolved without
// reading or writing the Charlie-locked module globals.
export function sendViaApplescript(guid: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // JXA's app.chats.byId() and app.chats.whose() were both removed from
    // Messages.app's scripting API in recent macOS releases. AppleScript
    // classic's `chat id "..."` accessor still works. Pass the message
    // body and chat guid via env vars so we don't have to escape quotes,
    // backslashes, or newlines into the AppleScript source.
    const script = [
      'set msgText to system attribute "CHIEF_MSG_TEXT"',
      'set chatGuid to system attribute "CHIEF_CHAT_GUID"',
      'tell application "Messages" to send msgText to chat id chatGuid',
    ].join("\n");
    execFile(
      "osascript",
      ["-e", script],
      {
        timeout: SEND_TIMEOUT_MS,
        env: { ...process.env, CHIEF_MSG_TEXT: text, CHIEF_CHAT_GUID: guid },
      },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`osascript: ${stderr?.trim() || err.message}`));
        } else {
          resolve();
        }
      },
    );
  });
}

// Returns true only when every chunk was handed to iMessage successfully.
// Returns false on no resolvable chat or any send failure, so callers that
// commit state on delivery (proactive markSurfaced/ration, morning surface
// candidate marking) can avoid recording a send that never went out.
export async function sendImessage(toNumber: string, text: string): Promise<boolean> {
  // Resolve chat lazily so callers from automations / proactive paths still
  // work even if the poller hasn't started yet.
  if (!chatGuid) {
    const resolved = await resolveChat(toNumber);
    if (!resolved) {
      console.error(`[imessage] no chat found for ${toNumber}`);
      return false;
    }
    chatId = resolved.rowid;
    chatGuid = resolved.guid;
  }
  // Last transform before send: strip em/en dashes deterministically so the
  // no-em-dash rule holds regardless of model compliance. Covers every
  // iMessage caller (interaction replies, morning surface, automations,
  // proactive) since they all funnel through here.
  const plain = stripEmDashes(stripMarkdown(text));
  let allSent = true;
  for (const part of chunk(plain)) {
    // Record BEFORE invoking osascript: the receive-side row can land in
    // chat.db within milliseconds, and the poller can run between the send
    // and the recording.
    if (recentSends.length >= MAX_RECENT_SENDS) {
      recentSends.shift();
    }
    recentSends.push({ text: part, sentAt: Date.now() });
    try {
      await sendViaApplescript(chatGuid, part);
      console.log(`[imessage] → sent ${part.length} chars to ${toNumber}`);
    } catch (err) {
      console.error(`[imessage] send failed:`, err);
      allSent = false;
    }
  }
  return allSent;
}

async function pollOnce(): Promise<void> {
  if (chatId === null) return;
  const rows = await pollNew(chatId, lastSeenRowid);
  if (rows.length === 0) return;

  const now = Date.now();
  let newMax = lastSeenRowid;

  for (const row of rows) {
    const rowid = Number(row.ROWID);
    newMax = Math.max(newMax, rowid);

    // Skip reactions, edits, retractions (anything non-zero).
    if (Number(row.associated_message_type) !== 0) continue;

    // We're in a self-thread: every message lands twice (is_from_me=1 send,
    // is_from_me=0 receive). Only process the receive side.
    if (Number(row.is_from_me) === 1) continue;

    const text = (row.text ?? "").trim();
    if (!text) continue;

    if (isChiefEcho(text, now)) continue;

    const conversationId = `sms:${CHIEF_CONTACT}`;
    const turnTag = Math.random().toString(36).slice(2, 8);
    const preview = text.length > 100 ? text.slice(0, 100) + "…" : text;
    console.log(`[turn ${turnTag}] ← ${CHIEF_CONTACT}: ${JSON.stringify(preview)}`);

    broadcast("message_in", {
      conversationId,
      content: text,
      from_number: CHIEF_CONTACT,
      handle: row.guid,
    });

    const start = Date.now();
    try {
      const reply = await handleUserMessage({
        conversationId,
        content: text,
        turnTag,
        onThinking: (t) => broadcast("thinking", { conversationId, t }),
      });
      if (reply) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const replyPreview = reply.length > 100 ? reply.slice(0, 100) + "…" : reply;
        console.log(
          `[turn ${turnTag}] → reply (${elapsed}s, ${reply.length} chars): ${JSON.stringify(replyPreview)}`,
        );
        await sendImessage(CHIEF_CONTACT, reply);
        await convex.mutation(api.messages.send, {
          conversationId,
          role: "assistant",
          content: reply,
        });
      } else {
        console.log(`[turn ${turnTag}] → (no reply)`);
      }
    } catch (err) {
      console.error(`[turn ${turnTag}] handler error`, err);
    }
  }

  lastSeenRowid = newMax;
}

function scheduleNextTick(): void {
  if (!polling) return;
  pollTimer = setTimeout(async () => {
    try {
      await pollOnce();
    } catch (err) {
      console.error("[imessage] poll error", err);
    } finally {
      scheduleNextTick();
    }
  }, POLL_INTERVAL_MS);
}

export async function startImessagePoller(): Promise<void> {
  if (polling) {
    console.warn("[imessage] poller already running");
    return;
  }
  if (!CHIEF_CONTACT) {
    console.error("[imessage] CHIEF_CONTACT is not set — poller disabled. Add it to .env.local.");
    return;
  }
  const resolved = await resolveChat(CHIEF_CONTACT);
  if (!resolved) {
    console.error(
      `[imessage] no chat found for CHIEF_CONTACT=${CHIEF_CONTACT}. Send yourself a message from the iPhone first so the thread exists in Messages.app, then restart.`,
    );
    return;
  }
  chatId = resolved.rowid;
  chatGuid = resolved.guid;
  // Skip backlog: start from the current max so a restart doesn't replay
  // history. (We can persist this to Convex later for true continuity.)
  lastSeenRowid = await getMaxRowidForChat(chatId);
  polling = true;
  console.log(
    `[imessage] poller started: chat ${chatId} (${CHIEF_CONTACT}), startRowid=${lastSeenRowid}, interval=${POLL_INTERVAL_MS}ms`,
  );
  scheduleNextTick();
}

export function stopImessagePoller(): void {
  polling = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}
