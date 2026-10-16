#!/usr/bin/env bash
# Watch GitHub PR checks; emit one line per check as it reaches a terminal state.
#
# Usage:  watch-pr-checks.sh <pr> [<pr> ...]
# Env:    POLL_SECONDS (default 20), MAX_POLLS (default 90 per PR)
#         REQUIRED_CHECKS (default "check gitleaks"): names that must be PRESENT and
#           terminal before a PR counts as settled. Set to "" to disable.
#
# Why REQUIRED_CHECKS exists: the first version declared a PR settled as soon as
# every check GitHub *listed* was terminal. GitHub can briefly list a subset, so a
# PR with only `gitleaks` visible settled early and the real `check` — pass or fail —
# was never reported. Settling now also requires the same terminal set on two
# consecutive polls, and the final line names every check so a gap is visible.
#
# Designed for the Monitor tool: every line on stdout is one event, and it emits on
# EVERY terminal bucket (pass/fail/skipping/cancel), never only on success — a
# filter that stays silent through a failure looks identical to "still running".
# Exits after all named PRs settle, so the watch ends rather than idling.
set -uo pipefail

POLL=${POLL_SECONDS:-20}
MAX_POLLS=${MAX_POLLS:-90}
REQUIRED=${REQUIRED_CHECKS-check gitleaks}

for pr in "$@"; do
  prev=""
  last_terminal=""
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

    all_terminal=0
    jq -e 'all(.[]; .bucket!="pending")' <<<"$state" >/dev/null 2>&1 && all_terminal=1

    missing=""
    for name in $REQUIRED; do
      jq -e --arg n "$name" 'any(.[]; .name==$n)' <<<"$state" >/dev/null 2>&1 || missing="$missing $name"
    done

    # Settled = all listed checks terminal, every required check present, and the
    # same terminal set seen on two consecutive polls (guards a momentary subset).
    if ((all_terminal == 1)) && [ -z "$missing" ] && [ "$current" = "$last_terminal" ]; then
      echo "PR#$pr settled: $(jq -r '[.[] | "\(.name)=\(.bucket)"] | sort | join(" ")' <<<"$state")"
      settled=1
      break
    fi
    if ((all_terminal == 1)) && [ -z "$missing" ]; then
      last_terminal=$current
    else
      last_terminal=""
    fi

    sleep "$POLL"
  done

  if ((settled == 0)); then
    echo "PR#$pr TIMED OUT after $((MAX_POLLS * POLL))s — checks never settled${missing:+ (never saw:$missing)}"
  fi
done

echo "watch complete: $*"
