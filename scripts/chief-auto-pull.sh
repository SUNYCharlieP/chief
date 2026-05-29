#!/bin/bash
# Chief-side auto-pull deploy agent. Polls origin/main and fast-forwards the
# local clone when it's behind, so pushes from the charlie clone deploy without
# a manual user switch. tsx watch + convex dev (already running) auto-reload
# after the pull, exactly as on a manual pull.
#
# HARD BOUNDARY: pull-only. This never commits, never resets, never force-
# updates, and never touches local drift. It is deployment automation, not
# self-modification. If the clone has diverged, it logs and leaves it alone.
#
# Self-locating (repo = parent of this script's dir) so it carries no absolute
# user path. Run by launchd as the Chief user every 60s.

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${CHIEF_AUTOPULL_LOG:-$HOME/Library/Logs/chief-auto-pull.log}"
LOCK="${TMPDIR:-/tmp}/chief-auto-pull.lock"
GIT=/usr/bin/git

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

# Single-instance guard (mkdir is atomic); released on exit.
mkdir "$LOCK" 2>/dev/null || exit 0
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

cd "$REPO" || { log "repo dir missing: $REPO"; exit 0; }

# Fetch only; never touches the working tree. Bail quietly on network failure.
"$GIT" fetch --quiet origin main 2>>"$LOG" || { log "fetch failed; skipping"; exit 0; }

LOCAL="$("$GIT" rev-parse HEAD)"
REMOTE="$("$GIT" rev-parse origin/main)"

# Up to date: do nothing, no log spam (this is the common 60s case).
[ "$LOCAL" = "$REMOTE" ] && exit 0

# Only fast-forward if local is strictly behind remote (an ancestor of it).
# If local has diverged (local commits / drift), this is false -> we do NOT
# pull, we log a conflict and leave the clone untouched for manual resolution.
if "$GIT" merge-base --is-ancestor "$LOCAL" "$REMOTE"; then
  if "$GIT" merge --ff-only origin/main >>"$LOG" 2>&1; then
    log "auto-pulled $LOCAL -> $("$GIT" rev-parse HEAD): $("$GIT" log -1 --pretty=%s)"
  else
    log "ff-only merge failed unexpectedly; clone left at $LOCAL"
  fi
else
  log "CONFLICT/DRIFT: local $LOCAL is not behind origin/main $REMOTE (diverged or local commits). NOT pulling; resolve manually."
fi
