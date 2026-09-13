#!/usr/bin/env bash
# Watch GitHub PR checks; emit one line per check as it reaches a terminal state.
#
# Usage:  watch-pr-checks.sh <pr> [<pr> ...]
# Env:    POLL_SECONDS (default 20), MAX_POLLS (default 90 per PR)
#
# Designed for the Monitor tool: every line on stdout is one event, and it emits on
# EVERY terminal bucket (pass/fail/skipping/cancel), never only on success — a
# filter that stays silent through a failure looks identical to "still running".
# Exits after all named PRs settle, so the watch ends rather than idling.
set -uo pipefail

POLL=${POLL_SECONDS:-20}
MAX_POLLS=${MAX_POLLS:-90}

for pr in "$@"; do
  prev=""
  polls=0
  settled=0

  while ((polls < MAX_POLLS)); do
    polls=$((polls + 1))

    # A transient gh/network failure must not kill the watch.
    if ! state=$(gh pr checks "$pr" --json name,bucket 2>/dev/null); then
      sleep "$POLL"
      continue
    fi

    # No checks registered yet (or the workflow failed to parse — which is how a
    # broken workflow file presents: an empty array, not an error).
    if ! jq -e 'type=="array" and length>0' <<<"$state" >/dev/null 2>&1; then
      sleep "$POLL"
      continue
    fi

    current=$(jq -r --arg p "$pr" \
      '.[] | select(.bucket!="pending") | "PR#\($p) \(.name): \(.bucket)"' \
      <<<"$state" | sort)

    # Only the newly-terminal checks, so each is reported exactly once.
    comm -13 <(printf '%s\n' "$prev") <(printf '%s\n' "$current")
    prev=$current

    if jq -e 'all(.[]; .bucket!="pending")' <<<"$state" >/dev/null 2>&1; then
      echo "PR#$pr settled"
      settled=1
      break
    fi

    sleep "$POLL"
  done

  if ((settled == 0)); then
    echo "PR#$pr TIMED OUT after $((MAX_POLLS * POLL))s — checks never settled"
  fi
done

echo "watch complete: $*"
