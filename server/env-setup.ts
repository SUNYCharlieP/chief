// Loads .env.local (priority) then .env (fallback) from the project root.
// Imported for side effects — must run before any module reads process.env.
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

for (const name of [".env.local", ".env"]) {
  const path = resolve(root, name);
  if (existsSync(path)) config({ path });
}

// Defensive: if ANTHROPIC_API_KEY is set to a non-key value (e.g. when chief
// is spawned from inside a Claude Code session, which injects
// ANTHROPIC_API_KEY=PUT_YOUR_KEY_HERE to discourage child processes from
// using subscription auth via env), the claude-agent-sdk's child claude
// process will try to authenticate with the bogus key and exit 1 on every
// turn. Real Anthropic keys start with "sk-ant-"; anything else is junk and
// we'd rather fall through to ~/.claude subscription auth.
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (apiKey && !apiKey.startsWith("sk-ant-")) {
  console.warn(
    `[env-setup] ANTHROPIC_API_KEY is set to "${apiKey}" which doesn't look like a real Anthropic key — unsetting so claude-agent-sdk falls back to Claude Code subscription auth.`,
  );
  delete process.env.ANTHROPIC_API_KEY;
}
