// SPDX-License-Identifier: AGPL-3.0-or-later
import { applyD1Migrations, env } from "cloudflare:test";

// Setup file for the workers project: apply the same plain-SQL migrations to the
// test D1 database that `wrangler d1 migrations apply` would run in production.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
