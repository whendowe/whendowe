#!/bin/sh
# Mutation-test only the source files this branch changes (StrykerJS): what to run on
# a PR before asking for review. `npm run mutate` does the whole of src/ (nightly).
# Usage: npm run mutate:changed [-- <base>]   (base defaults to origin/main)
set -eu
base="${1:-origin/main}"
files=$(git diff --name-only --diff-filter=AM "$base"...HEAD -- 'src/*.ts' \
  | grep -v -e '^src/db/schema\.ts$' -e '^src/db/d1\.ts$' || true)
if [ -z "$files" ]; then
  echo "No changed source files since $base: nothing to mutate."
  exit 0
fi
echo "Mutating:"; echo "$files" | sed 's/^/  /'
exec npx stryker run --mutate "$(echo "$files" | paste -sd, -)"
