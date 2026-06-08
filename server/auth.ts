import type { Request, Response, NextFunction } from "express";
import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";

// KISS single-user bearer auth — defense-in-depth BEHIND Tailscale, NOT
// internet-facing auth. One shared secret (CHIEF_AUTH_TOKEN in .env.local),
// checked on every request via the `Authorization: Bearer <token>` header. No
// accounts, no sessions, no OAuth.
//
// Three modes (CHIEF_AUTH_MODE), so it can roll out without a lockout:
//   off     — no checking (escape hatch if something goes wrong).
//   accept  — SOFT LAUNCH: never rejects; logs whether each request carried a
//             valid token, so the app can be updated and confirmed BEFORE the
//             server starts rejecting. This is the default.
//   require — rejects any request without a valid token (401).
//
// Flip accept -> require by editing CHIEF_AUTH_MODE in .env.local and restarting
// the server (launchctl kickstart). The token is read fresh per request, so it
// is never captured at import time before env-setup has loaded .env.local.

export type AuthMode = "off" | "accept" | "require";

function currentToken(): string {
  return process.env.CHIEF_AUTH_TOKEN?.trim() ?? "";
}

export function authMode(): AuthMode {
  const m = (process.env.CHIEF_AUTH_MODE ?? "accept").trim().toLowerCase();
  return m === "off" || m === "require" ? m : "accept";
}

// Paths that must NOT require the token:
//  - /health: liveness probe (returns only {ok:true}); the app validates the
//    server URL here before a token may be set, and launchd/monitoring ping it.
//  - /composio/webhook: external Composio calls it and can't send our token; it
//    is already authenticated by HMAC signature verification in its own handler.
function isExempt(path: string): boolean {
  return path === "/health" || path.startsWith("/composio/webhook");
}

function presentedToken(req: Request): string | null {
  const h = req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

// Constant-time compare so a wrong token can't be guessed by timing.
function isValid(presented: string | null): boolean {
  const token = currentToken();
  if (!token || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// One-line startup summary. NEVER prints the token itself.
export function authStartupSummary(): string {
  const mode = authMode();
  const configured = currentToken() ? "yes" : "NO";
  const warn =
    mode === "require" && !currentToken()
      ? " · WARNING: require mode with no token set — EVERY request will 401"
      : "";
  return `[auth] mode=${mode} · token configured: ${configured}${warn}`;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const mode = authMode();
  if (mode === "off" || isExempt(req.path)) {
    next();
    return;
  }

  const presented = presentedToken(req);
  const ok = isValid(presented);
  const state = presented ? (ok ? "valid" : "INVALID") : "missing";

  const ip = req.ip ?? req.socket.remoteAddress ?? "?";
  if (mode === "require") {
    if (!ok) {
      // Log the path + token state + client IP (never the token value).
      console.warn(`[auth] 401 ${req.method} ${req.path} — token ${state} (${ip})`);
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
    return;
  }

  // accept (soft launch): allow through, but log so the app's auth can be
  // confirmed before flipping to require.
  console.log(`[auth] soft ${req.method} ${req.path} — token ${state} (${ip})`);
  next();
}

// WebSocket (/ws) guard, mode-aware like the HTTP middleware. The app can send
// the bearer on the WS handshake's Authorization header. accept = allow + log;
// require = reject the upgrade unless the token is valid.
export function wsAuthAllowed(req: IncomingMessage): boolean {
  const mode = authMode();
  if (mode === "off") return true;
  const h = (req.headers["authorization"] as string | undefined) ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const presented = m ? m[1].trim() : null;
  const ok = isValid(presented);
  const state = presented ? (ok ? "valid" : "INVALID") : "missing";
  const ip = req.socket.remoteAddress ?? "?";
  if (mode === "require") {
    if (!ok) console.warn(`[auth] WS reject — token ${state} (${ip})`);
    return ok;
  }
  console.log(`[auth] soft WS — token ${state} (${ip})`);
  return true;
}
