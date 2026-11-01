// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

// What `npm run mutate` (StrykerJS) runs against each mutant: the unit and contract
// projects, on Node. Not the gate's config: no coverage thresholds (Stryker measures
// coverage per test itself), no property project (Hegel's budgets make every mutant
// slow; the nightly soak covers it), and no workers project (Stryker drives Node
// only — D1-specific behaviour stays covered by the gate's workers project).
export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["tests/unit/**/*.test.ts"] } },
      { test: { name: "contract", include: ["tests/contract/**/*.test.ts"] } },
    ],
  },
});
