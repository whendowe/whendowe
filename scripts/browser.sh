#!/bin/sh
# Run the browser tier (DESIGN §9 rc16) inside the pinned Playwright image — the only
# place reference screenshots may come from, since fonts and anti-aliasing differ
# between machines. Arguments go to `playwright test`, e.g. --update-snapshots
# (what `npm run test:browser:update` passes). Needs `npm ci` to have run.
#
# The image is the one CI's `browser` job uses; keep both in step with the
# @playwright/test version in package.json.
set -eu
IMAGE="mcr.microsoft.com/playwright@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea" # v1.64.1-noble

if command -v podman >/dev/null 2>&1; then
  runtime=podman
  as_me="--userns=keep-id"
elif command -v docker >/dev/null 2>&1; then
  runtime=docker
  as_me="--user=$(id -u):$(id -g)"
else
  echo "browser tests need podman or docker" >&2
  exit 1
fi

# A full run (no arguments) is measured against the picker's coverage thresholds
# (DESIGN §9 rc17); a filtered or updating run only reports. SOAK raises the state
# machine's budget, as it does for the property suite.
gate=0
[ "$#" -eq 0 ] && gate=1

exec "$runtime" run --rm --ipc=host "$as_me" -e HOME=/tmp -e COVERAGE_THRESHOLDS="$gate" \
  ${SOAK:+-e SOAK="$SOAK"} -v "$PWD:/work" -w /work "$IMAGE" \
  npm run -s test:browser:run -- "$@"
