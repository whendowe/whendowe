// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

// Four projects, one gate (DESIGN.md §9): unit + property (Hegel) + contract run
// under plain Node (Hegel's native core cannot run inside workerd); the workers
// project runs the same contract suite against real D1 bindings in workerd.
export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"] },
      },
      {
        test: { name: "property", include: ["tests/property/**/*.test.ts"] },
      },
      {
        test: { name: "contract", include: ["tests/contract/**/*.test.ts"] },
      },
      "./vitest.workers.config.ts",
    ],
  },
});
