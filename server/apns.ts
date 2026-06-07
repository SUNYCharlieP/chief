import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";

// Server-side APNs push (token-based .p8 auth over HTTP/2 via apns2). This is the
// future transport for briefings/proactive pings; built ALONGSIDE iMessage, not
// wired into the briefing/proactive paths yet (no cutover).
//
// The .p8 key is read from APNS_KEY_PATH and passed to apns2; it is NEVER logged.
// apns2 signs and rotates the ES256 JWT internally (the 20-60min refresh rule).

const KEY_PATH = process.env.APNS_KEY_PATH;
const KEY_ID = process.env.APNS_KEY_ID;
const TEAM_ID = process.env.APNS_TEAM_ID;
const BUNDLE_ID = process.env.APNS_BUNDLE_ID;
const APNS_ENV = (process.env.APNS_ENV ?? "sandbox").toLowerCase();

// One device token (single-user). The iOS app POSTs it to /push/register, which
// writes it here. CHIEF_DEVICE_TOKEN env overrides for quick manual testing.
const TOKEN_FILE =
  process.env.CHIEF_DEVICE_TOKEN_FILE ?? resolve(homedir(), ".config/chief/device-token.json");

export function apnsConfigured(): boolean {
  return Boolean(KEY_PATH && KEY_ID && TEAM_ID && BUNDLE_ID);
}

// Lazily build the client so the server still boots if APNs isn't configured.
let clientPromise: Promise<import("apns2").ApnsClient> | null = null;
async function getClient() {
  if (!apnsConfigured()) throw new Error("APNs not configured");
  if (!clientPromise) {
    clientPromise = (async () => {
      const signingKey = await readFile(KEY_PATH!, "utf8"); // secret: never logged
      const { ApnsClient, Host } = await import("apns2");
      return new ApnsClient({
        team: TEAM_ID!,
        keyId: KEY_ID!,
        signingKey,
        defaultTopic: BUNDLE_ID!, // apns-topic = app bundle id
        host: APNS_ENV === "production" ? Host.production : Host.development,
      });
    })();
  }
  return clientPromise;
}

interface DeviceTokenRecord {
  token: string;
  platform?: string;
  env?: string;
  updatedAt: number;
}

export async function storeDeviceToken(
  token: string,
  platform?: string,
  env?: string,
): Promise<void> {
  await mkdir(dirname(TOKEN_FILE), { recursive: true });
  const rec: DeviceTokenRecord = { token, platform, env, updatedAt: Date.now() };
  await writeFile(TOKEN_FILE, JSON.stringify(rec, null, 2), { mode: 0o600 });
}

async function readStoredToken(): Promise<string | null> {
  if (process.env.CHIEF_DEVICE_TOKEN) return process.env.CHIEF_DEVICE_TOKEN;
  try {
    const rec = JSON.parse(await readFile(TOKEN_FILE, "utf8")) as DeviceTokenRecord;
    return rec.token ?? null;
  } catch {
    return null;
  }
}

export interface PushResult {
  ok: boolean;
  configured: boolean;
  statusCode?: number;
  reason?: string;
  token?: string; // masked
  env?: string;
  error?: string;
}

function maskToken(t: string): string {
  return t.length <= 12 ? t : `${t.slice(0, 8)}…${t.slice(-4)}`;
}

// Send an ALERT push (apns-push-type=alert, apns-priority=10) to the device
// token. tokenOverride lets /push/test probe with a placeholder before a real
// device has registered. Returns the APNs outcome (incl. reason on failure).
export async function sendPush(
  title: string,
  body: string,
  tokenOverride?: string,
  data?: Record<string, unknown>,
): Promise<PushResult> {
  if (!apnsConfigured()) return { ok: false, configured: false, error: "APNs not configured" };
  const token = tokenOverride ?? (await readStoredToken());
  if (!token) return { ok: false, configured: true, error: "no device token registered" };
  try {
    const client = await getClient();
    const { Notification, Priority, PushType } = await import("apns2");
    // `data` is merged into the payload top-level (alongside aps), so the app
    // reads it from the notification's userInfo. Used to mark turn completion.
    const notification = new Notification(token, {
      type: PushType.alert,
      priority: Priority.immediate, // 10
      alert: { title, body },
      sound: "default",
      ...(data ? { data } : {}),
    });
    await client.send(notification);
    return { ok: true, configured: true, statusCode: 200, token: maskToken(token), env: APNS_ENV };
  } catch (err) {
    const e = err as { statusCode?: number; reason?: string; message?: string };
    return {
      ok: false,
      configured: true,
      statusCode: e.statusCode,
      reason: e.reason,
      token: maskToken(token),
      env: APNS_ENV,
      error: e.message ?? String(err),
    };
  }
}
