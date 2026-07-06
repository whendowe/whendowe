// SPDX-License-Identifier: AGPL-3.0-or-later

// Typed bindings for workers-pool tests: `env` from "cloudflare:test" is typed as
// Cloudflare.Env, which this augments (see vitest.workers.config.ts for the bindings).
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
