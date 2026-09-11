// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

// Four projects, one gate (DESIGN.md §9): unit + property (Hegel) + contract run
// under plain Node (Hegel's native core cannot run inside workerd); the workers
// project runs the same contract suite against real D1 bindings in workerd.
export default defineConfig({
  test: {
    // Coverage gate: collected by the Node-side projects (`npm run check` passes
    // --coverage); thresholds fail the gate if coverage drops. Ratchet-only: raise
    // them as milestones land, never lower (AGENTS.md: don't weaken the verifier).
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: [
        // Workerd-only driver: exercised by the workers project, which cannot
        // emit v8 coverage (no coverage hooks inside workerd).
        "src/db/d1.ts",
        // Drizzle codegen input: its behavior ships as generated SQL, covered
        // by the contract suite on both drivers.
        "src/db/schema.ts",
      ],
      reporter: ["text", "lcov"],
      thresholds: {
        statements: 55,
        branches: 65,
        functions: 55,
        lines: 55,
      },
    },
    projects: [
      {
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"] },
      },
      {
        test: {
          name: "property",
          include: ["tests/property/**/*.test.ts"],
          // Gate vs soak (DESIGN.md §9). `npm run soak` sets SOAK=1, which raises
          // Hegel's budget to 5000 cases (tests/property/budget.ts) — at that
          // budget the DST wall-clock property needs ~15s, so vitest's 5s default
          // killed it before it could finish. The soak had therefore never once
          // passed since it was written; it reported a timeout, not a property
          // violation, every night.
          //
          // This is NOT loosening the verifier: the gate keeps the 5s default
          // (pinned explicitly below), and the property budget is untouched in
          // both modes. Only the nightly long run gets a clock long enough to
          // actually reach the budget it was configured with.
          testTimeout: process.env.SOAK === undefined ? 5_000 : 300_000,
        },
      },
      {
        test: { name: "contract", include: ["tests/contract/**/*.test.ts"] },
      },
      "./vitest.workers.config.ts",
    ],
  },
});
