#!/usr/bin/env node
// One command to run Chief locally: server + convex + debug dashboard.
// Optionally launches ngrok if NGROK_DOMAIN or COMPOSIO_API_KEY is set
// (used for Composio webhook delivery; the iMessage transport is local and
// doesn't need a public URL).
// Prefixes each child's output so you can tell who's saying what.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// --- preflight: Convex types must exist ----------------------------------
if (!existsSync(resolve(root, "convex/_generated/api.js"))) {
  console.error(`
┌─────────────────────────────────────────────────────────────┐
│  Convex types haven't been generated yet.                   │
│                                                             │
│  Run this first:                                            │
│    npm run setup           (full interactive setup)         │
│    npx convex dev --once   (just generate types)            │
└─────────────────────────────────────────────────────────────┘
`);
  process.exit(1);
}

// --- read PORT from .env.local ------------------------------------------
function readEnv() {
  const p = resolve(root, ".env.local");
  if (!existsSync(p)) return {};
  const env = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*?)(?:\s+#.*)?$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const envVars = readEnv();
const port = envVars.PORT || "3456";
const ngrokDomain = envVars.NGROK_DOMAIN || "";
const publicUrl = envVars.PUBLIC_URL || "";
const hasStaticUrl =
  publicUrl && !publicUrl.includes("localhost") && !publicUrl.includes("127.0.0.1");
// ngrok is only needed for Composio webhooks. The iMessage poller is local.
const needsPublicUrl = Boolean(envVars.COMPOSIO_API_KEY);
const useNgrok = needsPublicUrl && (!hasStaticUrl || Boolean(ngrokDomain));
let convexEnvFile = null;

function writeConvexDevEnvFile() {
  const convexUrl = envVars.VITE_CONVEX_URL || envVars.CONVEX_URL;
  const lines = [];
  if (envVars.CONVEX_DEPLOYMENT) {
    lines.push(`CONVEX_DEPLOYMENT=${envVars.CONVEX_DEPLOYMENT}`);
  }
  if (convexUrl) {
    // Convex CLI warns when both CONVEX_URL and VITE_CONVEX_URL are active.
    // The debug UI is Vite-based, and the server falls back to this value.
    lines.push(`VITE_CONVEX_URL=${convexUrl}`);
  }
  if (!lines.length) return null;
  const path = resolve(tmpdir(), `boop-convex-${process.pid}.env.local`);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

// --- binary detection ---------------------------------------------------
function hasBinary(name) {
  return new Promise((ok) => {
    const lookup = process.platform === "win32" ? "where" : "which";
    const child = spawn(lookup, [name], { stdio: "ignore" });
    child.on("exit", (code) => ok(code === 0));
    child.on("error", () => ok(false));
  });
}

// --- color-prefixed child runner ----------------------------------------
const C = {
  server: "\x1b[36m",
  convex: "\x1b[35m",
  debug: "\x1b[33m",
  ngrok: "\x1b[32m",
  upstream: "\x1b[34m",
  banner: "\x1b[1;32m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};
let dashboardUrl = "http://localhost:5173";

// Vite's http-proxy attaches its own socket error logger that can't be removed
// via configure(). EPIPE on WS reconnects is harmless — filter it at the
// stream level so the logs stay readable.
const NOISE_TRIGGERS = [
  /\[vite\] ws proxy socket error/,
  /\[vite\] ws proxy error/,
  /Error: write EPIPE/,
  /Error: read ECONNRESET/,
  /AggregateError \[ECONNREFUSED\]/,
];
const STACK_LINE = /^\s+at\s/;

function run(name, cmd, args, readyPattern) {
  const child = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  const prefix = `${C[name]}${name.padEnd(6)}${C.reset} │ `;
  let buf = "";
  let suppressing = false;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const feed = (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);

      // ANSI-strip for matching without disturbing the display output.
      const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
      if (name === "debug") {
        const localMatch = plain.match(/Local:\s+(http:\/\/\S+)/);
        if (localMatch) dashboardUrl = localMatch[1].replace(/\/$/, "");
      }

      if (NOISE_TRIGGERS.some((r) => r.test(plain))) {
        suppressing = true;
        continue;
      }
      if (suppressing) {
        if (STACK_LINE.test(plain) || plain.trim() === "") continue;
        suppressing = false;
      }

      if (line.trim()) process.stdout.write(prefix + line + "\n");
      if (readyPattern && readyPattern.test(plain)) resolveReady();
    }
  };
  child.stdout.on("data", feed);
  child.stderr.on("data", feed);
  child.ready = ready;
  return child;
}

// --- ngrok URL banner: poll local API after launch ----------------------
async function waitForNgrokUrl(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch("http://127.0.0.1:4040/api/tunnels");
      if (res.ok) {
        const data = await res.json();
        const https = data.tunnels?.find((t) => t.proto === "https")?.public_url;
        if (https) return https;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function showBanner(url, stable) {
  const line = "═".repeat(68);
  const contact = envVars.CHIEF_CONTACT || "<CHIEF_CONTACT not set>";
  const headline = stable
    ? `stable public URL is live (Composio webhooks).`
    : `ngrok tunnel is live (Composio webhooks).`;
  console.log(`
${C.banner}${line}
  Chief is ready — ${headline}

  💬 iMessage poller:              ${contact}
  📋 Debug dashboard:              ${dashboardUrl}
  🌐 Public URL (Composio):        ${url}
${line}${C.reset}`);
}

function showLocalOnlyBanner() {
  const line = "═".repeat(68);
  const contact = envVars.CHIEF_CONTACT || "<CHIEF_CONTACT not set>";
  console.log(`
${C.banner}${line}
  Chief is running locally.

  💬 iMessage poller:              ${contact}
  📋 Debug dashboard:              ${dashboardUrl}

  ${C.dim}No public tunnel — Composio webhooks (if used) won't fire.${C.reset}
${line}${C.reset}
`);
}

// --- main ---------------------------------------------------------------
let ngrokInstalled = false;
if (useNgrok) {
  ngrokInstalled = await hasBinary("ngrok");
  if (!ngrokInstalled) {
    console.log(`
${C.ngrok}! ngrok is not installed — running without a public tunnel.${C.reset}
${C.dim}  Install:   brew install ngrok         (macOS)
             or download from https://ngrok.com/download
  Auth:      ngrok config add-authtoken <token>
             (free token at https://dashboard.ngrok.com)
  Without ngrok you can still use the debug dashboard at http://localhost:5173.
  Composio webhooks won't fire until ngrok or a stable PUBLIC_URL is set.${C.reset}
`);
  }
}

console.log(`\nChief dev starting on port ${port}. Ctrl-C to stop everything.\n`);

// Background "new-version available?" check. Runs concurrently with the
// child services; output is prefixed with `upstream │ ` by run() so it
// won't collide with startup logs. Silent on the happy path. Not added to
// the `children` array because it exits on its own — we don't want its
// non-zero exit (which shouldn't happen but hedge anyway) to tear down dev.
run("upstream", "node", ["scripts/check-upstream.mjs"]);

const serverChild = run(
  "server",
  "npx",
  ["tsx", "watch", "server/index.ts"],
  /listening on :/,
);
convexEnvFile = writeConvexDevEnvFile();
const convexArgs = ["convex", "dev"];
if (convexEnvFile) convexArgs.push("--env-file", convexEnvFile);
const convexChild = run(
  "convex",
  "npx",
  convexArgs,
  /Convex functions ready/,
);
const debugChild = run(
  "debug",
  "npx",
  ["vite", "--config", "debug/vite.config.ts"],
  /Local:\s+http/,
);
const children = [serverChild, convexChild, debugChild];

let ngrokUrlReady = Promise.resolve(null);
if (useNgrok && ngrokInstalled) {
  const args = ngrokDomain
    ? ["http", port, `--domain=${ngrokDomain}`, "--log=stdout", "--log-format=term", "--log-level=info"]
    : ["http", port, "--log=stdout", "--log-format=term", "--log-level=info"];
  const ngrokChild = run("ngrok", "ngrok", args);
  children.push(ngrokChild);
  ngrokUrlReady = waitForNgrokUrl().catch(() => null);
}

// Wait for all the core services to be ready before printing the banner,
// so the URL isn't dangled in front of the user while Convex is still booting.
async function autoRegisterComposioWebhook(publicUrl) {
  if (envVars.COMPOSIO_AUTO_WEBHOOK === "false") return;
  if (!envVars.COMPOSIO_API_KEY) return;
  const prefix = `${C.ngrok}composio${C.reset} │ `;
  const child = spawn("npx", ["tsx", "scripts/composio-webhook.ts", publicUrl], {
    cwd: root,
    env: { ...process.env },
  });
  child.stdout.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) process.stdout.write(prefix + line + "\n");
    }
  });
  child.stderr.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) process.stdout.write(prefix + line + "\n");
    }
  });
  await new Promise((r) => child.on("exit", r));
}

Promise.all([
  serverChild.ready,
  convexChild.ready,
  debugChild.ready,
  ngrokUrlReady,
])
  .then(async ([, , , ngrokUrl]) => {
    if (useNgrok && ngrokInstalled) {
      if (ngrokUrl) {
        // Composio webhook subscription is fully programmatic (PATCHable),
        // so we refresh it on every restart regardless of whether the
        // domain is reserved.
        await autoRegisterComposioWebhook(ngrokUrl);
        showBanner(ngrokUrl, Boolean(ngrokDomain));
      } else {
        console.log(
          `${C.ngrok}ngrok${C.reset} │ could not read tunnel URL from http://127.0.0.1:4040 — check ngrok output above.`,
        );
      }
    } else if (hasStaticUrl) {
      showBanner(publicUrl, true);
    } else {
      showLocalOnlyBanner();
    }
  })
  .catch(() => {});

let shuttingDown = false;
const shutdown = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (convexEnvFile) {
    try {
      unlinkSync(convexEnvFile);
    } catch {
      /* ignore */
    }
  }
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), 500);
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
for (const c of children) {
  c.on("exit", (code) => {
    if (!shuttingDown && code !== null && code !== 0) {
      console.error(`\nA child process exited with code ${code}. Shutting down.`);
      shutdown(code);
    }
  });
}
