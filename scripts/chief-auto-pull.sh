#!/bin/bash
# Auto-pull deploy agent. Polls origin/main and fast-forwards the local clone
# when it's behind, so an out-of-band push to origin (e.g. from a remote agent)
# deploys without a manual restart. The managed server (com.chief.server) runs
# plain tsx with NO file watcher, so after a successful pull this restarts it via
# `launchctl kickstart -k` to load the new code. kickstart and the service's
# KeepAlive are both launchd ops on the same job, so launchd serializes them:
# single instance, no race.
#
# HARD BOUNDARY: pull-only. This never commits, never resets, never force-
# updates, and never touches local drift. It is deployment automation, not
# self-modification. If the clone has diverged (e.g. unpushed local dev commits),
# it logs and leaves it alone -- local work is never clobbered.
#
# Self-locating (repo = parent of this script's dir) so it carries no absolute
# user path. Run by launchd as the charlie (production) user every 60s.

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${CHIEF_AUTOPULL_LOG:-$HOME/Library/Logs/chief-auto-pull.log}"
LOCK="${TMPDIR:-/tmp}/chief-auto-pull.lock"
GIT=/usr/bin/git
LAUNCHCTL=/bin/launchctl
# launchd job to restart into the new code after a successful pull. Override
# CHIEF_SERVER_LABEL to "" to disable the restart (e.g. for a watch-mode dev box).
SERVER_LABEL="${CHIEF_SERVER_LABEL:-com.chief.server}"

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
    # Restart the managed server into the new code. Plain tsx has no watcher, so
    # without this the pulled code sits on disk unused until the next restart.
    # kickstart -k is launchd's own kill+restart on the job; KeepAlive does not
    # double-start because launchd guarantees one instance per job.
    if [ -n "$SERVER_LABEL" ]; then
      if "$LAUNCHCTL" kickstart -k "gui/$(id -u)/$SERVER_LABEL" 2>>"$LOG"; then
        log "kickstarted $SERVER_LABEL into new code"
      else
        log "kickstart of $SERVER_LABEL FAILED (is the service loaded?); new code on disk but server NOT restarted"
      fi
    fi
  else
    log "ff-only merge failed unexpectedly; clone left at $LOCAL"
  fi
else
  log "CONFLICT/DRIFT: local $LOCAL is not behind origin/main $REMOTE (diverged or local commits). NOT pulling; resolve manually."
fi
