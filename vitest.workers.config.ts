// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Adapter/contract tests against real D1/DO bindings inside workerd (DESIGN.md §6/§9).
// Migrations are read here (Node side) and applied by tests/workers/apply-migrations.ts.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrationsPath = fileURLToPath(new URL("./migrations", import.meta.url));
      const migrations = await readD1Migrations(migrationsPath);
      return {
        wrangler: { configPath: "./deploy/cloudflare/wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      };
    }),
  ],
  test: {
    name: "workers",
    include: ["tests/workers/**/*.test.ts"],
    setupFiles: ["./tests/workers/apply-migrations.ts"],
  },
});
